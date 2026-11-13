/*
 * dx7_wasm.cc: the C interface AudioSaw's /dx7-synth uses around the MSFA
 * FM engine (Apache-2.0, as carried in Dexed's Source/msfa).
 *
 * Copyright 2026 AudioSaw. AGPL-3.0-or-later. Written for this build: the
 * voice allocator, MIDI handling and sysex unpacking here are not Dexed's
 * (its PluginProcessor and PluginData are GPL-3.0 and are not compiled).
 *
 * One synth per wasm instance: msfa keeps its sample-rate tables in statics.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <new>

#include "synth.h"
#include "freqlut.h"
#include "exp2.h"
#include "sin.h"
#include "env.h"
#include "pitchenv.h"
#include "lfo.h"
#include "porta.h"
#include "controllers.h"
#include "fm_core.h"
#include "dx7note.h"

#define EXPORT(name) __attribute__((export_name(#name)))

static const int POLY = 16;
static const int VOICE_LEN = 156;

// Upper bound of each of the 145 numeric voice parameters. msfa indexes
// tables with several of them unchecked (lfo rate, algorithm, levels), so a
// corrupt .syx must be clamped before it gets there.
static const uint8_t OP_MAX[21] = {
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14
};
static const uint8_t GLOBAL_MAX[19] = {
    99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48
};

struct Voice {
    Dx7Note *note;
    int midi;        // the key as played, before the patch's transpose
    bool keydown;
    bool sustained;  // key is up, pedal is holding it
    bool live;
    uint32_t seq;
};

static bool tables_ready = false;
static FmCore *core = 0;
static Controllers ctl;
static Lfo lfo;
static Voice voices[POLY];
static uint8_t patch[VOICE_LEN];
static uint32_t seq_counter;
static bool pedal;
static float gain;
// A block of N is rendered whole; what the caller did not take waits here.
static float carry[N];
static int carry_len;
static int carry_pos;
static AlignedBuf<int32_t, N> mixbuf;

static void sanitize(uint8_t *p) {
    for (int op = 0; op < 6; op++)
        for (int i = 0; i < 21; i++)
            if (p[op * 21 + i] > OP_MAX[i]) p[op * 21 + i] = OP_MAX[i];
    for (int i = 0; i < 19; i++)
        if (p[126 + i] > GLOBAL_MAX[i]) p[126 + i] = GLOBAL_MAX[i];
    for (int i = 145; i < 155; i++) p[i] &= 0x7f;
    p[155] &= 0x3f;
}

// A plain sine on operator 1, so the synth is never silent before a voice is
// loaded.
static void init_voice(uint8_t *p) {
    memset(p, 0, VOICE_LEN);
    for (int op = 0; op < 6; op++) {
        uint8_t *o = p + op * 21;
        o[0] = o[1] = o[2] = o[3] = 99;
        o[4] = o[5] = o[6] = 99;
        o[18] = 1;
        o[20] = 7;
    }
    p[5 * 21 + 16] = 99;  // operator 1 is stored last
    for (int i = 0; i < 4; i++) { p[126 + i] = 99; p[130 + i] = 50; }
    p[136] = 1;
    p[137] = 35;
    p[141] = 1;
    p[144] = 24;
    memcpy(p + 145, "INIT VOICE", 10);
    p[155] = 0x3f;
}

EXPORT(dx7_all_notes_off) void dx7_all_notes_off() {
    for (int i = 0; i < POLY; i++) {
        // Rebuilt, not reset: the feedback history is private to Dx7Note and
        // nothing clears it, so the next note would start from the last one's.
        if (voices[i].note) {
            voices[i].note->~Dx7Note();
            memset((void *)voices[i].note, 0, sizeof(Dx7Note));
            new (voices[i].note) Dx7Note(std::shared_ptr<TuningState>(new TuningState), 0);
        }
        voices[i].live = false;
        voices[i].keydown = false;
        voices[i].sustained = false;
    }
    carry_len = carry_pos = 0;
}

EXPORT(dx7_init) void dx7_init(double sample_rate) {
    if (!tables_ready) {
        Exp2::init();
        Tanh::init();
        Sin::init();
        tables_ready = true;
    }
    Freqlut::init(sample_rate);
    Lfo::init(sample_rate);
    PitchEnv::init(sample_rate);
    Env::init_sr(sample_rate);
    Porta::init_sr(sample_rate);

    if (!core) core = new FmCore;
    ctl.core = core;
    ctl.pitch_cc = 8192;
    ctl.pitch_range_up = 2;
    ctl.pitch_range_dn = 2;
    ctl.pitch_step = 0;
    ctl.aftertouch_cc = 0;
    ctl.breath_cc = 0;
    ctl.foot_cc = 0;
    ctl.modwheel_cc = 0;
    ctl.portamento_enable_cc = false;
    ctl.portamento_cc = 0;
    ctl.portamento_gliss_cc = false;
    ctl.masterTune = 0;
    ctl.mpeEnabled = false;
    // The DX7 keeps "what the wheel does" in function memory, not in the
    // voice. Here it is fixed: pitch modulation, so the wheel brings in the
    // patch's LFO as vibrato, scaled by its pitch sensitivity. A third of the
    // range: at 99 a sensitivity of 3 swung 295 cents, which is a siren.
    ctl.wheel.range = 33;
    ctl.wheel.pitch = true;
    ctl.wheel.amp = false;
    ctl.wheel.eg = false;
    ctl.refresh();

    for (int i = 0; i < POLY; i++) {
        if (!voices[i].note) {
            voices[i].note = (Dx7Note *)malloc(sizeof(Dx7Note));
            memset((void *)voices[i].note, 0, sizeof(Dx7Note));
            new (voices[i].note) Dx7Note(std::shared_ptr<TuningState>(new TuningState), 0);
        }
        voices[i].seq = 0;
        voices[i].midi = -1;
    }
    seq_counter = 0;
    pedal = false;
    gain = 0.5f;
    memset((void *)&lfo, 0, sizeof(lfo));
    init_voice(patch);
    lfo.reset(patch + 137);
    dx7_all_notes_off();
}

// len is 155 (a voice as it travels in sysex) or 156 (with Dexed's operator
// on/off byte). Notes already sounding keep the voice they started with.
EXPORT(dx7_load_voice) int dx7_load_voice(const uint8_t *data, int len) {
    if (len != 155 && len != 156) return 0;
    memcpy(patch, data, len);
    if (len == 155) patch[155] = 0x3f;
    sanitize(patch);
    lfo.reset(patch + 137);
    return 1;
}

static void unpack_voice(const uint8_t *b, uint8_t *v) {
    for (int op = 0; op < 6; op++) {
        const uint8_t *s = b + op * 17;
        uint8_t *d = v + op * 21;
        memcpy(d, s, 11);
        d[11] = s[11] & 3;
        d[12] = (s[11] >> 2) & 3;
        d[13] = s[12] & 7;
        d[20] = (s[12] >> 3) & 15;
        d[14] = s[13] & 3;
        d[15] = (s[13] >> 2) & 7;
        d[16] = s[14];
        d[17] = s[15] & 1;
        d[18] = (s[15] >> 1) & 31;
        d[19] = s[16];
    }
    memcpy(v + 126, b + 102, 8);
    v[134] = b[110] & 31;
    v[135] = b[111] & 7;
    v[136] = (b[111] >> 3) & 1;
    memcpy(v + 137, b + 112, 4);
    v[141] = b[116] & 1;
    v[142] = (b[116] >> 1) & 7;
    v[143] = (b[116] >> 4) & 7;
    v[144] = b[117];
    memcpy(v + 145, b + 118, 10);
}

static int checksum(const uint8_t *p, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum += p[i];
    return (-sum) & 0x7f;
}

// One dump: a 4104-byte 32-voice bulk or a 163-byte single voice. Writes
// 155-byte voices (name at 145..154) to out, which must hold 32 of them.
// Returns the number of voices, 0 for anything that is not a DX7 voice dump,
// -1 for a bad checksum.
EXPORT(dx7_unpack_syx) int dx7_unpack_syx(const uint8_t *syx, int len, uint8_t *out) {
    if (len < 6 || syx[0] != 0xf0 || syx[1] != 0x43 || (syx[2] & 0xf0) != 0) return 0;
    if (len == 4104 && syx[3] == 9 && syx[4] == 0x20 && syx[5] == 0) {
        if (checksum(syx + 6, 4096) != syx[4102]) return -1;
        for (int i = 0; i < 32; i++) {
            unpack_voice(syx + 6 + i * 128, out + i * 155);
            uint8_t tmp[VOICE_LEN];
            memcpy(tmp, out + i * 155, 155);
            tmp[155] = 0x3f;
            sanitize(tmp);
            memcpy(out + i * 155, tmp, 155);
        }
        return 32;
    }
    if (len == 163 && syx[3] == 0 && syx[4] == 1 && syx[5] == 0x1b) {
        if (checksum(syx + 6, 155) != syx[161]) return -1;
        uint8_t tmp[VOICE_LEN];
        memcpy(tmp, syx + 6, 155);
        tmp[155] = 0x3f;
        sanitize(tmp);
        memcpy(out, tmp, 155);
        return 1;
    }
    return 0;
}

static int played_note(int midi) {
    int n = midi + patch[144] - 24;
    return n < 0 ? 0 : n > 127 ? 127 : n;
}

EXPORT(dx7_note_on) void dx7_note_on(int midi, int velocity) {
    if (midi < 0 || midi > 127) return;
    if (velocity < 1) velocity = 1;
    if (velocity > 127) velocity = 127;

    // Order of preference: the voice already playing this key, a silent
    // voice, the oldest released voice, the oldest held voice.
    int pick = -1, rank = -1;
    bool any_down = false;
    for (int i = 0; i < POLY; i++) {
        Voice &v = voices[i];
        if (v.live && !v.note->isPlaying()) v.live = false;
        if (v.live && v.keydown) any_down = true;
        int r = (v.live && v.midi == midi && (v.keydown || v.sustained)) ? 4
              : !v.live ? 3
              : (!v.keydown && !v.sustained) ? 2
              : !v.keydown ? 1 : 0;
        if (r > rank || (r == rank && v.seq < voices[pick].seq)) { rank = r; pick = i; }
    }
    Voice &v = voices[pick];
    // The LFO is one per instrument: its delay and key sync restart only
    // when a key goes down with no other key held.
    if (!any_down) lfo.keydown();
    // A stolen voice carries on from its phase, so the cut is not a click
    // from a waveform jump as well; a fresh one starts where the patch says.
    if (!v.live || patch[136]) v.note->oscSync();
    v.note->init(patch, played_note(midi), velocity, 1, &ctl);
    v.midi = midi;
    v.keydown = true;
    v.sustained = false;
    v.live = true;
    v.seq = ++seq_counter;
}

EXPORT(dx7_note_off) void dx7_note_off(int midi) {
    for (int i = 0; i < POLY; i++) {
        Voice &v = voices[i];
        if (!v.live || !v.keydown || v.midi != midi) continue;
        v.keydown = false;
        if (pedal) v.sustained = true;
        else v.note->keyup();
    }
}

EXPORT(dx7_sustain) void dx7_sustain(int on) {
    pedal = on != 0;
    if (pedal) return;
    for (int i = 0; i < POLY; i++) {
        Voice &v = voices[i];
        if (v.live && v.sustained) { v.sustained = false; v.note->keyup(); }
    }
}

// 0..16383, centre 8192, as on the wire.
EXPORT(dx7_pitch_bend) void dx7_pitch_bend(int value14) {
    ctl.pitch_cc = value14 < 0 ? 0 : value14 > 16383 ? 16383 : value14;
}

EXPORT(dx7_bend_range) void dx7_bend_range(int semitones) {
    if (semitones < 0) semitones = 0;
    if (semitones > 12) semitones = 12;
    ctl.pitch_range_up = semitones;
    ctl.pitch_range_dn = semitones;
}

EXPORT(dx7_mod_wheel) void dx7_mod_wheel(int value7) {
    ctl.modwheel_cc = value7 < 0 ? 0 : value7 > 127 ? 127 : value7;
    ctl.refresh();
}

EXPORT(dx7_gain) void dx7_gain(float g) { gain = g; }

EXPORT(dx7_active_voices) int dx7_active_voices() {
    int n = 0;
    for (int i = 0; i < POLY; i++) if (voices[i].live && voices[i].note->isPlaying()) n++;
    return n;
}

static void render_block() {
    int32_t *buf = mixbuf.get();
    int32_t lfovalue = lfo.getsample();
    int32_t lfodelay = lfo.getdelay();
    for (int j = 0; j < N; j++) carry[j] = 0;
    for (int i = 0; i < POLY; i++) {
        Voice &v = voices[i];
        if (!v.live) continue;
        for (int j = 0; j < N; j++) buf[j] = 0;
        v.note->compute(buf, lfovalue, lfodelay, &ctl);
        // One carrier at output level 99 peaks near 2^26; 2^28 is where
        // msfa's own hosts put full scale, which leaves the 12 dB a
        // six-carrier algorithm needs. Each voice is held to +-1 there, as a
        // host of this engine does, then the voices are summed unclipped. The
        // default gain of 0.5 puts 16 such carriers in phase at exactly 1.
        for (int j = 0; j < N; j++) {
            float f = (float)buf[j] * (1.0f / 268435456.0f);
            carry[j] += f > 1.0f ? 1.0f : f < -1.0f ? -1.0f : f;
        }
        if (!v.note->isPlaying()) v.live = false;
    }
    carry_len = N;
    carry_pos = 0;
}

EXPORT(dx7_render) void dx7_render(float *out, int nframes) {
    int i = 0;
    while (i < nframes) {
        if (carry_pos >= carry_len) render_block();
        int n = carry_len - carry_pos;
        if (n > nframes - i) n = nframes - i;
        for (int j = 0; j < n; j++) out[i + j] = carry[carry_pos + j] * gain;
        carry_pos += n;
        i += n;
    }
}
