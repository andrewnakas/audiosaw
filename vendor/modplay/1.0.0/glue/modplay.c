/* modplay: the exported surface. One song at a time; the caller copies the
** file into wasm memory with mp_alloc(), loads it, then pulls audio. */
#include <stdlib.h>
#include <string.h>
#include "mp_glue.h"

#define EXPORT(name) __attribute__((export_name(#name))) name

void lockMixer(void) {}
void unlockMixer(void) {}
bool openMixer(int32_t f, int32_t b) { (void)f; (void)b; return true; }
void closeMixer(void) {}

static uint8_t seen[256];

void mp_seen_reset(void) { memset(seen, 0, sizeof (seen)); }

bool mp_seen_mark(uint32_t order)
{
	const bool was = seen[order & 255];
	seen[order & 255] = 1;
	return was;
}

static const mp_engine_t *eng;
static int32_t format; /* 1 MOD, 2 XM, 3 S3M, 4 IT */
static const float *fTick;
static const int32_t *iTick;
static float tickScale;
static int32_t tickLen, tickPos;
static bool songEnded;
static char nameOut[64];

void *EXPORT(mp_alloc)(uint32_t n) { return malloc(n ? n : 1); }
void EXPORT(mp_free)(void *p) { free(p); }

void EXPORT(mp_unload)(void)
{
	if (eng != NULL) eng->unload();
	eng = NULL;
	format = 0;
}

/* Channel count named by a MOD's signature at offset 1080, or 0 for none. */
static int32_t modSignature(const uint8_t *d, uint32_t len)
{
	static const char *four[] = { "M.K.", "M!K!", "NSMS", "LARD", "PATT", "FLT4", "N.T.", "M&K!", "FEST" };
	if (len < 1084+1024) return 0;

	const char *s = (const char *)&d[1080];
	for (int32_t i = 0; i < 9; i++)
		if (!memcmp(s, four[i], 4)) return 4;
	if (!memcmp(s, "OCTA", 4)) return 8;
	if (!memcmp(s+1, "CHN", 3) && s[0] >= '1' && s[0] <= '9') return s[0]-'0';
	if (!memcmp(s+2, "CH", 2) && s[0] >= '1' && s[0] <= '3' && s[1] >= '0' && s[1] <= '9')
		return (s[0]-'0')*10 + (s[1]-'0');
	return 0;
}

static bool printable(const uint8_t *p, int32_t n)
{
	for (int32_t i = 0; i < n; i++)
		if (p[i] != 0 && p[i] < 32) return false;
	return true;
}

/* A 15-sample Soundtracker MOD has no signature, so any file at all "is"
** one. Before a loader is trusted with it, the header has to read like a
** module and every note has to be an Amiga period. */
static bool plausibleMod15(const uint8_t *d, uint32_t len)
{
	if (len < 600+1024 || !printable(d, 20)) return false;

	const uint8_t *h = &d[470];
	if (h[0] < 1 || h[0] > 128 || h[1] > 220) return false;

	uint32_t top = 0, smpBytes = 0;
	for (int32_t i = 0; i < 128; i++)
	{
		if (h[2+i] > 63) return false;
		if (h[2+i] > top) top = h[2+i];
	}
	for (int32_t i = 0; i < 15; i++)
	{
		const uint8_t *s = &d[20 + i*30];
		if (!printable(s, 22) || s[24] != 0 || s[25] > 64) return false;
		smpBytes += 2 * ((s[22] << 8) | s[23]);
	}
	if (smpBytes == 0 || len < 600 + (top+1) * 1024) return false;

	const uint8_t *p = &d[600];
	for (uint32_t i = 0; i < (top+1) * 256; i++, p += 4)
	{
		const uint32_t per = ((p[0] & 0x0F) << 8) | p[1];
		if ((p[0] & 0xF0) || (per != 0 && (per < 28 || per > 3424))) return false;
	}
	return true;
}

/* Returns the format code, or 0 when no engine takes the file. */
int32_t EXPORT(mp_load)(const uint8_t *data, uint32_t len, int32_t rate)
{
	mp_unload();
	if (data == NULL || len < 64) return 0;

	if (!memcmp(data, "IMPM", 4)) { eng = &mp_it2; format = 4; }
	else if (len >= 48 && !memcmp(&data[44], "SCRM", 4)) { eng = &mp_it2; format = 3; }
	else if (!memcmp(data, "Extended Module: ", 17)) { eng = &mp_ft2; format = 2; }
	else
	{
		/* Up to four channels is a ProTracker module and gets Paula. More
		** than four never ran on an Amiga: those are Fasttracker's. */
		const int32_t chans = modSignature(data, len);
		format = 1;
		if (chans == 0) { if (!plausibleMod15(data, len)) return 0; eng = &mp_pt2; }
		else if (chans <= 4) eng = &mp_pt2;
		else if (chans <= 32 && !(chans & 1)) eng = &mp_ft2;
		else return 0;
	}

	if (!eng->load(data, len, rate))
	{
		mp_unload();
		return 0;
	}
	return format;
}

/* which replayer has the loaded song: 1 pt2-clone, 2 ft2play, 3 it2play */
int32_t EXPORT(mp_engine)(void) { return (eng == &mp_pt2) ? 1 : (eng == &mp_ft2) ? 2 : (eng == &mp_it2) ? 3 : 0; }

/* Paula's stereo width for 4-channel MODs: 100 is the Amiga's hard
** left/right, 0 is mono. pt2-clone's own default is 20. */
int32_t EXPORT(mp_separation)(int32_t percent) { return mp_pt2_separation(percent); }

void EXPORT(mp_start)(void)
{
	if (eng == NULL) return;
	eng->start();
	tickLen = tickPos = 0;
	songEnded = false;
}

/* Length in frames at the loaded rate, without mixing. Stops at maxFrames,
** which is what bounds a module that loops inside one pattern for ever.
** Leaves the song needing mp_start() again. */
uint32_t EXPORT(mp_scan)(uint32_t maxFrames)
{
	if (eng == NULL) return 0;
	mp_start();

	uint32_t total = 0;
	float s;
	while (total < maxFrames)
	{
		const int32_t n = eng->tick(false, &fTick, &iTick, &s);
		if (n <= 0) break;
		total += n;
	}
	return (total > maxFrames) ? maxFrames : total;
}

/* Fills up to n frames into left/right; fewer than n means the song ended. */
int32_t EXPORT(mp_render)(float *left, float *right, int32_t n)
{
	int32_t done = 0;
	if (eng == NULL) return 0;

	while (done < n && !songEnded)
	{
		if (tickPos >= tickLen)
		{
			tickLen = eng->tick(true, &fTick, &iTick, &tickScale);
			tickPos = 0;
			if (tickLen <= 0) { songEnded = true; tickLen = 0; break; }
		}

		int32_t todo = tickLen - tickPos;
		if (todo > n - done) todo = n - done;

		if (fTick != NULL)
		{
			const float *src = &fTick[tickPos * 2];
			for (int32_t i = 0; i < todo; i++)
			{
				left[done+i] = src[i*2] * tickScale;
				right[done+i] = src[i*2+1] * tickScale;
			}
		}
		else
		{
			const int32_t *src = &iTick[tickPos * 2];
			for (int32_t i = 0; i < todo; i++)
			{
				left[done+i] = (float)src[i*2] * tickScale;
				right[done+i] = (float)src[i*2+1] * tickScale;
			}
		}

		tickPos += todo;
		done += todo;
	}
	return done;
}

int32_t EXPORT(mp_info)(int32_t what) { return (eng != NULL) ? eng->info(what) : 0; }

/* index 0 is the title, 1..n the instrument (or sample) names; NUL-terminated,
** in the file's own 8-bit character set */
const char *EXPORT(mp_name)(int32_t index)
{
	int32_t maxLen = 0;
	nameOut[0] = '\0';
	if (eng == NULL || index < 0) return nameOut;

	const char *s = eng->name(index, &maxLen);
	if (maxLen > (int32_t)sizeof (nameOut) - 1) maxLen = sizeof (nameOut) - 1;
	memcpy(nameOut, s, maxLen);
	nameOut[maxLen] = '\0';
	return nameOut;
}
