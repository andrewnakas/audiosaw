/* Force-included into every engine file: the "audio driver" each replayer
** expects is four functions, and headless they have nothing to do. */
#pragma once
#include <stdint.h>
#include <stdbool.h>
void lockMixer(void);
void unlockMixer(void);
bool openMixer(int32_t mixingFrequency, int32_t mixingBufferSize);
void closeMixer(void);

/* The loaders leave the tail of a sample that the file cuts short
** unwritten. Zeroed memory makes that silence, and the same silence on
** every render. */
#include <stdlib.h>
#define malloc(n) calloc(1, (n))
