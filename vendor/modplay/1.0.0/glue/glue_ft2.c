/* ft2play (XM, and MODs of more than four channels) driven tick by tick. Includes pmp_mix.c so the static
** mixer helpers are reachable without changing that file. */
#include <string.h>
#include "mp_glue.h"
#include "../ft2play/pmp_mix.c"

#define FT2_AMP 10 /* what ft2play itself renders with; output is float, so it cannot clip */

uint32_t mp_ft2_orderEntries; /* bumped by the one-line patch in getNextPos() */

static int32_t rate;
static uint16_t initSpeed, initTempo;
static uint32_t lastEntries, numPatterns;
static bool isMod, ended;
static const uint8_t *file;
static char nameBuf[32];

static bool ft2_load(const uint8_t *d, uint32_t len, int32_t r)
{
	rate = r;
	file = d;
	isMod = (len < 17 || memcmp(d, "Extended Module: ", 17) != 0);
	if (!isMod && len < 336) return false;

	initMusic(rate, 1024, true, true); /* also frees the previous song */
	if (!loadMusicFromData(d, len)) return false;
	if (song.len == 0 || song.antChn == 0 || song.antChn > 32) return false;

	if (isMod)
	{
		numPatterns = 0;
		for (int32_t i = 0; i < 128; i++)
			if (song.songTab[i] >= numPatterns) numPatterns = song.songTab[i] + 1;
	}
	else
	{
		numPatterns = d[70] | (d[71] << 8);
	}

	/* Fxx rewrites these while playing; a second run must start from the file's */
	initSpeed = song.speed;
	initTempo = song.tempo;
	return true;
}

static void ft2_start(void)
{
	mix_Free();
	mix_Init((rate*5 / 2) + 1); /* longest tick: 1 BPM */

	song.speed = initSpeed;
	song.tempo = initTempo;
	song.timer = 1;
	song.pattDelTime = song.pattDelTime2 = 0;
	song.pBreakFlag = song.posJumpFlag = false;
	song.pBreakPos = 0;
	memset(stm, 0, sizeof (stm));

	setAmp(FT2_AMP);
	dump_Init(rate, FT2_AMP, 0);
	musicPaused = false;

	ended = false;
	lastEntries = mp_ft2_orderEntries;
	mp_seen_reset();
	mp_seen_mark(0);
}

static int32_t ft2_tick(bool mix, const float **fbuf, const int32_t **ibuf, float *scale)
{
	if (ended || song.tempo == 0) return 0; /* F00 stops the song */

	mix_SaveIPVolumes();
	mainPlayer();
	mix_UpdateChannelVolPanFrq();

	const int32_t n = speedVal;
	if (mix)
	{
		memset(CDA_MixBuffer, 0, n * (2 * sizeof (int32_t)));
		CIType *v = CI;
		for (int32_t i = 0; i < song.antChn*2; i++, v++)
			PMPMix32Proc(v, n, 0);
		*ibuf = CDA_MixBuffer;
		*fbuf = NULL;
		*scale = 1.0f / (256.0f * 32768.0f);
	}

	/* getNextPos() ran at the end of this tick; the next one starts the row
	** it chose, so this tick still belongs to the song */
	if (mp_ft2_orderEntries != lastEntries)
	{
		lastEntries = mp_ft2_orderEntries;
		if (mp_seen_mark((uint16_t)song.songPos)) ended = true;
	}
	return n;
}

static void ft2_unload(void)
{
	mix_Free();
	freeMusic();
}

static int32_t ft2_info(int32_t what)
{
	switch (what)
	{
		case MP_CHANNELS: return song.antChn;
		case MP_PATTERNS: return numPatterns;
		case MP_ORDERS: return song.len;
		case MP_INSTRUMENTS: return song.antInstrs;
	}
	return 0;
}

static const char *ft2_name(int32_t i, int32_t *maxLen)
{
	if (i == 0) { *maxLen = 20; return song.name; }
	*maxLen = 22;
	if (isMod) /* empty MOD samples get no instrument, but their names are the song's notes */
	{
		memcpy(nameBuf, &file[20 + (i-1)*30], 22);
		return nameBuf;
	}
	if (i > 128 || instr[i] == NULL) { *maxLen = 0; return ""; }
	return instr[i]->name;
}

const mp_engine_t mp_ft2 = { ft2_load, ft2_start, ft2_tick, ft2_unload, ft2_info, ft2_name };
