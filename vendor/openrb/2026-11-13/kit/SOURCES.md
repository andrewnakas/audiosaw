# AudioSaw kit 1: sources

The drum kit /rebirth-player plays when the visitor has not dropped one of
their own. 45 samples (the startup-sound slot is silence), mono, 44.1 kHz,
16-bit, in the "clear kit" layout that `crate/src/lib.rs` reads.

Every sample is made from a recording its uploader placed in the public
domain on Freesound (Creative Commons 0). Nothing of ReBirth is in the file.
The ReBirth kit was used only as a measuring stick: `build-kit.js measure`
wrote `targets.json` (each slot's length, level, pitch, third-octave
spectrum and 5 ms level envelope; numbers, no audio), and `build-kit.js
build` fitted each CC0 recording to those numbers by trimming, resampling
to pitch, third-octave equalisation, shaping the decay, and levelling.

The 808 side is a Roland TR-08 recorded by Karman_Lyne. The 909 side is a
Roland JD-Xi's 909 kit recorded by GRD-music-, with a 909 kick, snare and
crash from three other uploaders. There is no CC0 recording of 909 toms on
Freesound, so those three slots are the TR-08's toms, retuned and equalised.
A snare is two samples in ReBirth (the drum's tone and the noise over it),
so each snare recording is split at 700 Hz (808) or 900 Hz (909); the extra noise slots are the
same noise with new phases.

**Built from Freesound's preview files** (Ogg Vorbis, about 110 kbit/s), which
need no account. The originals are 16-bit WAV; to rebuild from them, download
each sound below, convert to 44.1 kHz mono WAV under the file name in
`sources.json`, and run:

    node build-kit.js build targets.json DIR sources.json audiosaw-kit-1.orbkit

| Freesound sound | Uploader | Licence | Slots |
|---|---|---|---|
| [TR08_MTom01.WAV](https://freesound.org/people/Karman_Lyne/sounds/520174/) | Karman_Lyne | CC0 1.0 | HT, LT, MT |
| [TR08_Maracas01.WAV](https://freesound.org/people/Karman_Lyne/sounds/520173/) | Karman_Lyne | CC0 1.0 | MA |
| [TR08_RimShot01.WAV](https://freesound.org/people/Karman_Lyne/sounds/520172/) | Karman_Lyne | CC0 1.0 | RS |
| [TR08_Snr01.WAV](https://freesound.org/people/Karman_Lyne/sounds/520171/) | Karman_Lyne | CC0 1.0 | SD1, SD2, SD3, SD4, SD5, N1, N2, N3, N4 |
| [TR08_HTom02.WAV](https://freesound.org/people/Karman_Lyne/sounds/520170/) | Karman_Lyne | CC0 1.0 | ht |
| [TR08_LTom02.WAV](https://freesound.org/people/Karman_Lyne/sounds/520168/) | Karman_Lyne | CC0 1.0 | lt, mt |
| [TR08_MConga01.WAV](https://freesound.org/people/Karman_Lyne/sounds/520167/) | Karman_Lyne | CC0 1.0 | MC |
| [TR08_LConga02.WAV](https://freesound.org/people/Karman_Lyne/sounds/519310/) | Karman_Lyne | CC0 1.0 | LC |
| [TR08_HConga01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519309/) | Karman_Lyne | CC0 1.0 | HC |
| [TR08_HhClosed01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519308/) | Karman_Lyne | CC0 1.0 | CH |
| [TR08_HhOpen01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519307/) | Karman_Lyne | CC0 1.0 | OH |
| [TR08_Kd01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519306/) | Karman_Lyne | CC0 1.0 | BD |
| [Classic_TR_909_HatOpen_JdXi_5](https://freesound.org/people/GRD-music-/sounds/414971/) | GRD-music- | CC0 1.0 | ohh |
| [Classic_TR_909_KICK_JdXi_2](https://freesound.org/people/GRD-music-/sounds/414969/) | GRD-music- | CC0 1.0 | bd4 |
| [Classic_TR_909_HatClosed_JdXi_2](https://freesound.org/people/GRD-music-/sounds/414966/) | GRD-music- | CC0 1.0 | chh |
| [Classic_TR_909_RIM_JdXi_4](https://freesound.org/people/GRD-music-/sounds/414957/) | GRD-music- | CC0 1.0 | rs |
| [Classic_TR_909_Snare_JdXi_2](https://freesound.org/people/GRD-music-/sounds/414955/) | GRD-music- | CC0 1.0 | sd1, sd2, sd3, sd4, sdn1 |
| [Classic_TR_909_Snare_JdXi_1](https://freesound.org/people/GRD-music-/sounds/414954/) | GRD-music- | CC0 1.0 | sd5 |
| [Classic_TR_909_Clap_JdXi_5](https://freesound.org/people/GRD-music-/sounds/414951/) | GRD-music- | CC0 1.0 | hc |
| [TR08_Clap01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519305/) | Karman_Lyne | CC0 1.0 | CP |
| [TR08_CowBell01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519303/) | Karman_Lyne | CC0 1.0 | CB |
| [TR08_Clave01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519304/) | Karman_Lyne | CC0 1.0 | CL |
| [TR08_Cymbal01.WAV](https://freesound.org/people/Karman_Lyne/sounds/519302/) | Karman_Lyne | CC0 1.0 | CY |
| [909 TR Crash Cymbal](https://freesound.org/people/extremonomia/sounds/719048/) | extremonomia | CC0 1.0 | ccy |
| [909 Sn 02a dry.wav](https://freesound.org/people/sakebeats/sounds/176352/) | sakebeats | CC0 1.0 | sdn2, sdn3 |
| [909 kICK.WAV](https://freesound.org/people/ZeSoundResearchInc./sounds/145775/) | ZeSoundResearchInc. | CC0 1.0 | bd1, bd2, bd3 |
| [Normalized 909 Crash Cymbal](https://freesound.org/people/3nderium/sounds/743638/) | 3nderium | CC0 1.0 | rcy |
