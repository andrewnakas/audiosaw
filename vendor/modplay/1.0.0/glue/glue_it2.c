/* it2play (IT, S3M) driven tick by tick. Includes the HQ driver so its
** float mix buffer can be handed out before it is dithered down to 16 bits. */
#include <string.h>
#include "mp_glue.h"
#include "../it2play/it2drivers/hq.c"
#include "../it2play/it_d_rm.h"

uint32_t mp_it2_orderEntries; /* bumped by the one-line patch in UpdateData() */

static uint32_t lastEntries;
static int32_t numChannels, numOrders;
static bool isS3M, inited;
static uint8_t *copy;

static bool it2_load(const uint8_t *d, uint32_t len, int32_t rate)
{
	isS3M = !(len >= 4 && !memcmp(d, "IMPM", 4));
	if (isS3M)
	{
		/* the S3M loader reads the order list straight into a 256-byte array */
		if (len < 0x60 || memcmp(&d[44], "SCRM", 4) != 0) return false;
		if ((d[0x20] | (d[0x21] << 8)) > 255) return false;
	}
	else if (len < 192) return false;

	if (!Music_Init(rate, 1024, DRIVER_HQ)) return false;
	inited = true;

	/* the loader may unpack MMCMP in place of the pointer it is given */
	copy = (uint8_t *)malloc(len);
	if (copy == NULL) return false;
	memcpy(copy, d, len);
	const uint8_t res = Music_LoadFromData(copy, len);
	free(copy);
	copy = NULL;
	if (res != LOAD_OK || !Song.Loaded) return false;

	/* UpdateData() searches the order list for a pattern without a bound;
	** a list that begins with its end marker would spin for ever */
	int32_t o = 0;
	while (o < MAX_ORDERS && Song.Orders[o] == 0xFE) o++;
	if (o >= MAX_ORDERS || Song.Orders[o] >= 200) return false;

	numOrders = 0;
	for (o = 0; o < MAX_ORDERS && Song.Orders[o] != 0xFF; o++)
		if (Song.Orders[o] < 200) numOrders++;

	/* highest channel that any pattern writes to */
	int32_t highest = -1;
	uint8_t mask[64];
	pattern_t *pat = Song.Patt;
	for (int32_t i = 0; i < MAX_PATTERNS; i++, pat++)
	{
		const uint8_t *p = pat->PackedData;
		if (p == NULL || pat->Rows == 0) continue;
		memset(mask, 0, sizeof (mask));
		for (uint16_t row = 0; row < pat->Rows; )
		{
			const uint8_t b = *p++;
			if (b == 0) { row++; continue; }
			const uint8_t ch = (b - 1) & 63;
			if (ch > highest) highest = ch;
			if (b & 0x80) mask[ch] = *p++;
			if (mask[ch] & 1) p++;
			if (mask[ch] & 2) p++;
			if (mask[ch] & 4) p++;
			if (mask[ch] & 8) p += 2;
		}
	}
	numChannels = highest + 1;

	if (isS3M) /* an S3M says which channels exist; an IT enables all 64 */
	{
		numChannels = 0;
		for (int32_t i = 0; i < 32; i++)
			if (!(Song.Header.ChnlPan[i] & 128)) numChannels++;
	}
	return true;
}

static void it2_start(void)
{
	Music_PrepareWAVRender();
	lastEntries = mp_it2_orderEntries;
	mp_seen_reset();
}

static int32_t it2_tick(bool mix, const float **fbuf, const int32_t **ibuf, float *scale)
{
	Update();
	if (Song.StopSong) /* ran off the end of the order list */
	{
		Song.StopSong = false;
		return 0;
	}

	/* the row this tick belongs to has already been read, so a repeat ends
	** the song before the tick is mixed */
	if (mp_it2_orderEntries != lastEntries)
	{
		lastEntries = mp_it2_orderEntries;
		if (mp_seen_mark(Song.CurrentOrder)) return 0;
	}

	if (mix)
	{
		HQ_MixSamples();
		*fbuf = fMixBuffer;
		*ibuf = NULL;
		*scale = MixGain * (1.0f / 32768.0f);
		return RealBytesToMix;
	}

	/* same tick-length arithmetic as HQ_MixSamples(), without the mixing */
	int32_t n = BytesToMix;
	CurrentFractional += BytesToMixFractional;
	if (CurrentFractional >= BPM_FRAC_SCALE)
	{
		CurrentFractional &= BPM_FRAC_MASK;
		n++;
	}
	return n;
}

static void it2_unload(void)
{
	if (!inited) return;
	Music_FreeSong();
	Music_Close();
	inited = false;
}

static int32_t it2_info(int32_t what)
{
	switch (what)
	{
		case MP_CHANNELS: return numChannels;
		case MP_PATTERNS: return Song.Header.PatNum;
		case MP_ORDERS: return numOrders;
		case MP_INSTRUMENTS:
			return (Song.Header.Flags & ITF_INSTR_MODE) ? Song.Header.InsNum : Song.Header.SmpNum;
	}
	return 0;
}

static const char *it2_name(int32_t i, int32_t *maxLen)
{
	*maxLen = 25;
	if (i == 0) return Song.Header.SongName;
	if (i > 100) { *maxLen = 0; return ""; }
	if (Song.Header.Flags & ITF_INSTR_MODE) return Song.Ins[i-1].InstrumentName;
	return Song.Smp[i-1].SampleName;
}

const mp_engine_t mp_it2 = { it2_load, it2_start, it2_tick, it2_unload, it2_info, it2_name };
