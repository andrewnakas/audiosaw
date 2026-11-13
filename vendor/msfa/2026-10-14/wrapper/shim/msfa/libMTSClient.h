/*
 * AudioSaw shim for ODDSound's libMTSClient.h (written for this build,
 * AGPL-3.0-or-later; not ODDSound's code). There is no MTS-ESP master in a
 * browser, so "is there a master" is always no and dx7note.cc takes its
 * standard-tuning path.
 */
#ifndef AS_MTS_SHIM_H
#define AS_MTS_SHIM_H
struct MTSClient;
static inline bool MTS_HasMaster(MTSClient *) { return false; }
static inline double MTS_NoteToFrequency(MTSClient *, char, char) { return 0; }
#endif
