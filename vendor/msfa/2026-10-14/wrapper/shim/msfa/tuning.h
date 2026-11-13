/*
 * AudioSaw shim for msfa's tuning.h (written for this build, AGPL-3.0-or-later
 * like the rest of the site; not taken from Dexed).
 *
 * Why: Dexed's own tuning.h/tuning.cc need JUCE and the Surge tuning library
 * for .scl/.kbm microtuning, and carry no licence header. dx7note.cc only needs
 * "MIDI note -> log frequency", so this gives it 12-tone equal temperament,
 * A4 = 440 Hz, and nothing else.
 */
#ifndef __SYNTH_TUNING_H
#define __SYNTH_TUNING_H

#include "synth.h"
#include <memory>

class TuningState {
public:
    // Q24 log2 of the frequency in Hz: (1 << 24) * (log2(440) - 69/12) at
    // note 0, one twelfth of an octave per note.
    int32_t midinote_to_logfreq(int midinote) {
        return 50857777 + ((1 << 24) / 12) * midinote;
    }
    bool is_standard_tuning() { return true; }
};

#endif
