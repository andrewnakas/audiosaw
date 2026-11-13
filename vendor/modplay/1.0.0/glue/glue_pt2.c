/* pt2-clone's ProTracker replayer and Paula emulation (4-channel MOD),
** driven tick by tick.
**
** pt2-clone is a whole tracker. What is compiled from it is the replayer,
** the Paula/BLEP/filter mixer, the 2x downsampler, the tables and the two
** MOD loaders. This file stands in for pt2_audio.c (SDL output), which is
** where the tick clock and the final stereo stage live, and for the handful
** of UI calls the replayer makes. The parts marked "from pt2-clone" follow
** that project's code (BSD-3-Clause, Olav Sorensen) so that the result is
** what its MOD2WAV writes, before the 16-bit dither.
*/
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "mp_glue.h"
#include "../pt2-clone/src/pt2_header.h"
#include "../pt2-clone/src/pt2_structs.h"
#include "../pt2-clone/src/pt2_config.h"
#include "../pt2-clone/src/pt2_audio.h"
#include "../pt2-clone/src/pt2_replayer.h"
#include "../pt2-clone/src/pt2_paula.h"
#include "../pt2-clone/src/pt2_downsample2x.h"
#include "../pt2-clone/src/pt2_textout.h"
#include "../pt2-clone/src/pt2_visuals.h"
#include "../pt2-clone/src/pt2_visuals_sync.h"
#include "../pt2-clone/src/pt2_mouse.h"
#include "../pt2-clone/src/modloaders/pt2_load_mod31.h"
#include "../pt2-clone/src/modloaders/pt2_load_mod15.h"

/* globals that pt2_main.c, pt2_audio.c and pt2_config.c own in the tracker */
module_t *song = NULL;
audio_t audio;
config_t config;

/* the replayer reports to a UI that is not there */
void lockAudio(void) { audio.locked = true; }
void unlockAudio(void) { audio.locked = false; }
void resetAudioDither(void) {}
void displayErrorMsg(const char *msg) { (void)msg; }
void statusOutOfMemory(void) {}
void pointerSetModeThreadSafe(uint8_t pointerMode, bool carry) { (void)pointerMode; (void)carry; }
void setSyncTickTimeLen(uint32_t timeLenInt, uint64_t timeLenFrac) { (void)timeLenInt; (void)timeLenFrac; }
void setVisualsDMACON(uint16_t bits) { (void)bits; }
void setVisualsVolume(int32_t ch, uint16_t vol) { (void)ch; (void)vol; }
void setVisualsPeriod(int32_t ch, uint16_t period) { (void)ch; (void)period; }
void setVisualsLength(int32_t ch, uint16_t len) { (void)ch; (void)len; }
void setVisualsDataPtr(int32_t ch, const int8_t *src) { (void)ch; (void)src; }

/* Worst case the loaders can read: they trust the header, and walk 100
** patterns and 31 full-length samples without looking at the file size. */
#define MAX_SAMPLE_LEN 131070
#define LOADER_REACH (1084 + (MAX_PATTERNS * 1024) + (MOD_SAMPLES * MAX_SAMPLE_LEN) + 4096)

static int32_t rate, numPatterns, numSamples, separation = 20;
static bool ended;
static uint64_t tickFrac;
static float *fL, *fR, *fOut;

int32_t mp_pt2_separation(int32_t percent) /* 0 = mono .. 100 = the Amiga's hard left/right */
{
	if (percent >= 0 && percent <= 100) separation = percent;
	return separation;
}

/* from pt2-clone, pt2_audio.c: generateBpmTable() */
static void bpmTable(double dAudioFreq)
{
	for (int32_t bpm = MIN_BPM; bpm <= MAX_BPM; bpm++)
	{
		const double dSamplesPerTick = dAudioFreq / ciaBpm2Hz(bpm);
		double dInt, dFrac = modf(dSamplesPerTick, &dInt);
		const int32_t i = bpm - MIN_BPM;
		audio.samplesPerTickIntTab[i] = (uint32_t)dInt;
		audio.samplesPerTickFracTab[i] = (uint64_t)(dFrac * BPM_FRAC_SCALE);
	}
}

static void fixZeroes(char *str, int32_t maxLength) /* from pt2-clone, pt2_module_loader.c */
{
	int32_t i;
	for (i = maxLength-1; i >= 0; i--)
		if (str[i] != '\0') break;
	for (int32_t j = 0; j < i; j++)
		if (str[j] == '\0') str[j] = ' ';
}

static void cleanText(char *s, int32_t n)
{
	s[n] = '\0';
	for (int32_t i = 0; i < n; i++)
		if ((s[i] < ' ' || s[i] > '~') && s[i] != '\0') s[i] = ' ';
	fixZeroes(s, n);
}

/* from pt2-clone, pt2_module_loader.c: what modLoad() does to a module once
** a loader has returned it */
static void sanitize(module_t *m)
{
	cleanText(m->header.name, 20);

	moduleSample_t *s = m->samples;
	for (int32_t i = 0; i < MOD_SAMPLES; i++, s++)
	{
		cleanText(s->text, 22);

		if (s->length > config.maxSampleLength) s->length = config.maxSampleLength;
		if ((uint8_t)s->volume > 64) s->volume = 64;
		if (s->loopLength < 2) s->loopLength = 2;

		if (s->loopStart > config.maxSampleLength || s->loopStart+s->loopLength > config.maxSampleLength)
		{
			s->loopStart = 0;
			s->loopLength = 2;
		}

		if (s->length > 0 && s->loopLength > 2 && s->loopStart+s->loopLength > s->length)
		{
			const int32_t over = (s->loopStart + s->loopLength) - s->length;
			if (s->length+over <= config.maxSampleLength)
			{
				s->length += over;
			}
			else
			{
				s->loopStart = 0;
				s->loopLength = 2;
			}
		}

		if (s->length >= 2 && s->loopStart+s->loopLength <= 2)
		{
			m->sampleData[s->offset+0] = 0;
			m->sampleData[s->offset+1] = 0;
		}
	}

	initializeModuleChannels(m);
}

static void pt2_unload(void)
{
	modFree();
	free(fL); free(fR); free(fOut);
	fL = fR = fOut = NULL;
}

/* Takes ProTracker-family MODs of up to four channels. Anything wider is
** left for ft2play, which is what such files were written for. */
static bool pt2_load(const uint8_t *d, uint32_t len, int32_t r)
{
	rate = r;

	memset(&config, 0, sizeof (config));
	config.maxSampleLength = MAX_SAMPLE_LEN; /* pt2-clone's "128K samples" setting: PC-made MODs use it */
	config.amigaModel = MODEL_A1200;
	memset(&editor, 0, sizeof (editor));
	memset(&ui, 0, sizeof (ui));
	memset(&audio, 0, sizeof (audio));

	uint8_t *buf = (uint8_t *)calloc(1, len + LOADER_REACH);
	if (buf == NULL) return false;
	memcpy(buf, d, len);

	const bool is31 = detectMod31(buf, len);
	if (is31)
	{
		/* the loader would read the missing patterns as whatever follows */
		int32_t top = 0;
		for (int32_t i = 0; i < 128; i++)
			if (buf[952+i] > top) top = buf[952+i];
		if (top >= MAX_PATTERNS || len < 1084 + (uint32_t)(top+1) * 1024)
		{
			free(buf);
			return false;
		}
	}
	module_t *m = is31 ? loadMod31(buf, len) : loadMod15(buf, len);
	free(buf);
	if (m == NULL) return false;

	sanitize(m);
	song = m;
	numSamples = is31 ? 31 : 15;

	numPatterns = 0;
	for (int32_t i = 0; i < 128; i++)
		if (song->header.patternTable[i] >= numPatterns) numPatterns = song->header.patternTable[i] + 1;

	/* one tick at the slowest tempo, at the mixer's own (2x) rate */
	const int32_t maxTick = (int32_t)ceil((rate * 2) / (MIN_BPM / 2.5)) + 2;
	fL = (float *)malloc(maxTick * sizeof (float));
	fR = (float *)malloc(maxTick * sizeof (float));
	fOut = (float *)malloc(maxTick * 2 * sizeof (float));
	if (fL == NULL || fR == NULL || fOut == NULL)
	{
		pt2_unload();
		return false;
	}
	return true;
}

/* from pt2-clone: setupAudio(), setupLoadedMod() and restartSong(), less the UI */
static void pt2_start(void)
{
	audio.outputRate = rate;
	audio.oversamplingFlag = (rate < 96000);
	audio.amigaModel = config.amigaModel;
	paulaSetup(audio.oversamplingFlag ? rate*2 : rate, audio.amigaModel);
	bpmTable(rate);
	audio.ledFilterEnabled = false;
	paulaWriteByte(0xBFE001, 0);
	clearDownsample2xStates();

	if (editor.songPlaying) modStop();
	initializeModuleChannels(song);

	editor.timingMode = TEMPO_MODE_CIA;
	editor.playMode = PLAY_MODE_NORMAL;
	editor.mod2WavOngoing = true; /* makes tickReplayer() report the end of the song */
	memset(editor.muted, 0, sizeof (editor.muted));
	memset(editor.rowVisitTable, 0, sizeof (editor.rowVisitTable));

	song->row = song->currRow = 0;
	song->rowsCounter = 0;
	song->currSpeed = 6;
	song->currBPM = song->header.initialTempo;
	modSetSpeed(6);
	modSetTempo(song->header.initialTempo, false);
	modPlay(DONT_SET_PATTERN, 0, 0);

	tickFrac = 0;
	ended = false;
}

static int32_t pt2_tick(bool mix, const float **fbuf, const int32_t **ibuf, float *scale)
{
	if (ended) return 0;

	/* false = the next row has been played before; this tick is the last.
	** F00 stops ProTracker dead, which also ends it here. */
	if (!tickReplayer() || !editor.songPlaying) ended = true;

	int32_t n = audio.samplesPerTickInt;
	tickFrac += audio.samplesPerTickFrac;
	if (tickFrac >= BPM_FRAC_SCALE)
	{
		tickFrac &= BPM_FRAC_MASK;
		n++;
	}
	if (!mix) return n;

	/* from pt2-clone, pt2_audio.c: outputAudio(), with the float kept */
	const float side = (separation / 100.0f) * 0.5f;
	const bool amigaPan = (separation == 100);
	if (audio.oversamplingFlag)
		paulaGenerateSamples(fL, fR, n*2);
	else
		paulaGenerateSamples(fL, fR, n);

	for (int32_t i = 0; i < n; i++)
	{
		float l, r;
		if (audio.oversamplingFlag)
		{
			l = downsample2x_L(fL[i*2], fL[i*2+1]);
			r = downsample2x_R(fR[i*2], fR[i*2+1]);
		}
		else
		{
			l = fL[i];
			r = fR[i];
		}
		if (!amigaPan)
		{
			const float mid = (l + r) * 0.5f, s = (l - r) * side;
			l = mid + s;
			r = mid - s;
		}
		fOut[i*2] = l;
		fOut[i*2+1] = r;
	}

	*fbuf = fOut;
	*ibuf = NULL;
	*scale = 2.0f / PAULA_VOICES; /* pt2-clone's AUDIO_GAIN over four voices */
	return n;
}

static int32_t pt2_info(int32_t what)
{
	switch (what)
	{
		case MP_CHANNELS: return PAULA_VOICES;
		case MP_PATTERNS: return numPatterns;
		case MP_ORDERS: return song->header.songLength;
		case MP_INSTRUMENTS: return numSamples;
	}
	return 0;
}

static const char *pt2_name(int32_t i, int32_t *maxLen)
{
	if (i == 0) { *maxLen = 20; return song->header.name; }
	if (i > MOD_SAMPLES) { *maxLen = 0; return ""; }
	*maxLen = 22;
	return song->samples[i-1].text;
}

const mp_engine_t mp_pt2 = { pt2_load, pt2_start, pt2_tick, pt2_unload, pt2_info, pt2_name };
