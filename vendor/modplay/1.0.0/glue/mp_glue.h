#pragma once
#include <stdint.h>
#include <stdbool.h>

/* One engine = one of these. tick() advances the song by one replayer tick.
** With mix != 0 it leaves that tick's audio, interleaved stereo float at
** *scale = full scale, in *buf. It returns the tick's length in frames, or 0
** when the song has ended. */
typedef struct mp_engine_t
{
	bool (*load)(const uint8_t *data, uint32_t len, int32_t rate);
	void (*start)(void);
	int32_t (*tick)(bool mix, const float **fbuf, const int32_t **ibuf, float *scale);
	void (*unload)(void);
	int32_t (*info)(int32_t what);
	const char *(*name)(int32_t index, int32_t *maxLen); /* index 0 = title */
} mp_engine_t;

enum { MP_CHANNELS = 0, MP_PATTERNS = 1, MP_ORDERS = 2, MP_INSTRUMENTS = 3 };

extern const mp_engine_t mp_pt2, mp_ft2, mp_it2;

int32_t mp_pt2_separation(int32_t percent);

/* Order-list bookkeeping shared by the engines: a song has ended when it
** enters an order it has entered before. The row is deliberately not part
** of the key. FT2 carries a pattern loop's start row into the next pattern
** (its well-known E60 bug), so a one-pattern song with a loop in it wraps to
** row 4, not row 0, and by (order, row) would be played twice. Rows repeated
** by a pattern loop never count, because only order changes are recorded. */
void mp_seen_reset(void);
bool mp_seen_mark(uint32_t order); /* true if already seen */
