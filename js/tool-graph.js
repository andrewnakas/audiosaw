/*
 * The single source of truth for what tools exist and how they relate.
 *
 * Consumed by:
 *   - tools/build-nav.js  (Node)    -> generates the static footer directory,
 *                                      per-page related-tools blocks, breadcrumbs
 *                                      and /tools. Those must be real HTML, not
 *                                      JS-injected, because the whole point is to
 *                                      make the pages crawlable.
 *   - js/flow.js          (browser) -> post-conversion "next step" suggestions
 *                                      and the file handoff between tools.
 *
 * When you add a page: add it here, then run
 *   node tools/build-nav.js && node tools/build-sitemap.js
 */
(function (root, factory) {
  var g = factory();
  if (typeof module === 'object' && module.exports) module.exports = g;
  else root.AS_GRAPH = g;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Order here is the order they appear in the footer directory and on /tools.
  var CATEGORIES = [
    { id: 'to-mp3',   title: 'Convert to MP3' },
    { id: 'formats',  title: 'Other format conversions' },
    // `also` lists tools whose canonical category is elsewhere but which people
    // look for here too. They appear in both places in the directory and hub.
    { id: 'video',    title: 'Video to audio', also: ['mp4-to-mp3', 'mov-to-mp3'] },
    { id: 'edit',     title: 'Cut, trim & arrange' },
    { id: 'levels',   title: 'Loudness & channels' },
    { id: 'repair',   title: 'Clean up & separate' },
    { id: 'create',   title: 'Record & tag' },
    { id: 'fx',       title: 'Effects & remixes' },
    { id: 'apps',     title: 'For a specific app or device' }
  ];

  // project — set on tools that can work on a clip sent from /audio-editor and
  //          send the result back (project-link.js). 'same': the result is
  //          the same length, so it is lined up and nothing after it moves.
  //          'len': the length changes, so later clips on the track ripple.
  //          'stems': several files come back; the first replaces the clip.
  // label  — short form, used in the footer directory
  // title  — card heading
  // blurb  — one line of card copy; says what it's for, not just what it is
  // next   — related tools, most relevant first. Used for the related-tools block
  //          and the post-conversion suggestions. Give the *reason* in `why`.
  var TOOLS = {
    // ---- Convert to MP3 -------------------------------------------------
    'mp4-to-mp3': {
      cat: 'to-mp3', label: 'mp4 → mp3', title: 'MP4 to MP3',
      blurb: 'Pull the audio track out of a video file as MP3.',
      next: [
        ['audio-cutter', 'Trim it down to the part you actually wanted'],
        ['audio-compressor', 'Shrink it further if it is still too big to send'],
        ['normalize-audio', 'Even out the level if the video audio was quiet'],
        ['mov-to-mp3', 'Same job for a QuickTime or iPhone .mov']
      ]
    },
    'm4a-to-mp3': {
      cat: 'to-mp3', label: 'm4a → mp3', title: 'M4A to MP3',
      blurb: 'iPhone voice memos and Apple audio into universally playable MP3.',
      next: [
        ['silence-remover', 'Cut the dead air out of a voice memo'],
        ['stereo-to-mono', 'Halve the file size — voice does not need stereo'],
        ['aac-to-mp3', 'Same codec, bare .aac file rather than .m4a'],
        ['normalize-audio', 'Bring a quietly recorded memo up to a usable level'],
        ['caf-to-mp3', 'Same job for a GarageBand or Logic recording']
      ]
    },
    'wav-to-mp3': {
      cat: 'to-mp3', label: 'wav → mp3', title: 'WAV to MP3',
      blurb: 'Compress a DAW bounce or recording to a shareable MP3.',
      next: [
        ['mp3-320kbps', 'Run the same WAV again, locked to 320 kbps'],
        ['wav-to-mp3-128kbps', 'Run the same WAV again at 128 kbps for the smallest usable file'],
        ['normalize-audio', 'Match the level to other tracks first'],
        ['fade-in-fade-out', 'Add a clean fade before you send it out']
      ]
    },
    'flac-to-mp3': {
      cat: 'to-mp3', label: 'flac → mp3', title: 'FLAC to MP3',
      blurb: 'Turn a lossless archive into something a phone or car will play.',
      next: [
        ['mp3-320kbps', 'Run the FLAC again at 320 kbps to keep more of it'],
        ['mp3-tag-editor', 'Put the tags back — conversion drops them'],
        ['flac-to-wav', 'Decompress to WAV instead of going lossy'],
        ['audio-compressor', 'Get the whole album under a size limit']
      ]
    },
    'aac-to-mp3': {
      cat: 'to-mp3', label: 'aac → mp3', title: 'AAC to MP3',
      blurb: 'For players and car stereos that never learned to read AAC.',
      next: [
        ['m4a-to-mp3', 'Same codec, .m4a container — start here instead'],
        ['mp3-320kbps', 'Run the original again at 320 kbps — a second encode costs less from high'],
        ['audio-cutter', 'Trim before converting so you re-encode less'],
        ['normalize-audio', 'Match levels across a mixed library']
      ]
    },
    'ogg-to-mp3': {
      cat: 'to-mp3', label: 'ogg → mp3', title: 'OGG to MP3',
      blurb: 'Vorbis audio from Discord, Telegram or game files into MP3.',
      next: [
        ['opus-to-mp3', 'If it is actually Opus — the two get confused constantly'],
        ['audio-cutter', 'Grab just the clip you need'],
        ['normalize-audio', 'Fix a quiet game asset or voice clip'],
        ['discord-audio-compressor', 'Send it back to Discord under the size cap']
      ]
    },
    'opus-to-mp3': {
      cat: 'to-mp3', label: 'opus → mp3', title: 'Opus / WhatsApp voice note to MP3',
      blurb: 'WhatsApp and Signal voice notes into a format anything will open.',
      next: [
        ['audio-to-text-prep', 'Get it ready to be transcribed'],
        ['silence-remover', 'Cut the pauses out of a long voice note'],
        ['stereo-to-mono', 'Voice notes do not need two channels'],
        ['amplify-audio', 'Rescue a note recorded too far from the mic']
      ]
    },
    'wma-to-mp3': {
      cat: 'to-mp3', label: 'wma → mp3', title: 'WMA to MP3',
      blurb: 'Old Windows Media libraries into something a Mac or a phone will play.',
      next: [
        ['mp3-tag-editor', 'WMA tags do not survive the conversion — put them back'],
        ['audio-compressor', 'Shrink a large library further'],
        ['normalize-audio', 'Even out levels across a mixed rip'],
        ['mp3-320kbps', 'Run the WMA again, locked to 320 kbps']
      ]
    },
    'caf-to-mp3': {
      cat: 'to-mp3', label: 'caf → mp3', title: 'CAF to MP3',
      blurb: 'Apple Core Audio files from GarageBand and Logic, made portable.',
      next: [
        ['extract-audio', 'Get WAV instead if you are still editing'],
        ['silence-remover', 'Trim the dead air off a phone recording'],
        ['normalize-audio', 'Lift a quiet GarageBand bounce'],
        ['audio-cutter', 'Keep only the part you want']
      ]
    },
    'ac3-to-mp3': {
      cat: 'to-mp3', label: 'ac3 → mp3', title: 'AC3 / Dolby Digital to MP3',
      blurb: 'DVD and broadcast soundtracks, with 5.1 folded down to stereo.',
      next: [
        ['audio-compressor', 'Make film dialogue audible on headphones'],
        ['extract-audio', 'Pull the track out of a video container yourself'],
        ['audio-cutter', 'Keep one scene rather than the whole soundtrack'],
        ['normalize-audio', 'Set a known ceiling before listening']
      ]
    },
    'mov-to-mp3': {
      cat: 'to-mp3', label: 'mov → mp3', title: 'MOV to MP3',
      blurb: 'Audio out of iPhone and QuickTime recordings.',
      next: [
        ['extract-audio', 'Same job, any container, any output format'],
        ['audio-cutter', 'Keep only the section you need'],
        ['normalize-audio', 'Even out handheld recording levels'],
        ['audio-to-text-prep', 'Send it to a transcription service']
      ]
    },
    'aiff-to-mp3': {
      cat: 'to-mp3', label: 'aiff → mp3', title: 'AIFF to MP3',
      blurb: 'Logic and GarageBand bounces compressed for sharing.',
      next: [
        ['mp3-320kbps', 'Run the AIFF again at 320 kbps to hold more of the master'],
        ['mp3-to-aiff', 'Going the other direction'],
        ['normalize-audio', 'Match the level to a reference track'],
        ['fade-in-fade-out', 'Top and tail the bounce cleanly']
      ]
    },
    'm4b-to-mp3': {
      cat: 'to-mp3', label: 'm4b → mp3', title: 'M4B to MP3',
      blurb: 'Audiobooks out of Apple’s format and onto anything else.',
      next: [
        ['split-audio', 'Split a long book into chapter-sized files automatically'],
        ['audio-speed', 'Speed up narration without chipmunking it'],
        ['wav-to-mp3-128kbps', 'Run the audiobook again at 128 kbps — speech does not need more'],
        ['stereo-to-mono', 'Halve the size of a mono narration']
      ]
    },

    // ---- Other format conversions ---------------------------------------
    'mp3-to-wav': {
      cat: 'formats', label: 'mp3 → wav', title: 'MP3 to WAV',
      blurb: 'Uncompressed PCM for DAW import, CD burning and samplers.',
      next: [
        ['wav-44100-16bit', 'Lock it to the CD spec most software expects'],
        ['change-sample-rate', 'Match your project’s sample rate'],
        ['wav-for-sp404', 'Prep it for a hardware sampler'],
        ['m4a-to-wav-for-audacity', 'Same idea, but from an .m4a, for Audacity'],
        ['wav-to-flac', 'Archive it losslessly at about half the size of WAV']
      ]
    },
    'mp3-to-m4a': {
      cat: 'formats', label: 'mp3 → m4a', title: 'MP3 to M4A',
      blurb: 'AAC in an Apple-friendly container for iTunes and CarPlay.',
      next: [
        ['mp3-to-aiff', 'Uncompressed Apple format instead'],
        ['ringtone-maker', 'Turn it into a 30-second ringtone'],
        ['audio-cutter', 'Trim it first'],
        ['mp3-320kbps', 'Stay in MP3 at maximum quality instead']
      ]
    },
    'mp3-to-aiff': {
      cat: 'formats', label: 'mp3 → aiff', title: 'MP3 to AIFF',
      blurb: 'Apple-native uncompressed audio for Logic and Final Cut.',
      next: [
        ['wav-44100-16bit', 'The cross-platform equivalent'],
        ['aiff-to-mp3', 'Going the other direction'],
        ['change-sample-rate', 'Match the session sample rate'],
        ['normalize-audio', 'Set a consistent level before import']
      ]
    },
    'wav-to-flac': {
      cat: 'formats', label: 'wav → flac', title: 'WAV to FLAC',
      blurb: 'Lossless compression — same audio, roughly half the size.',
      next: [
        ['flac-to-wav', 'Decompress it again, bit for bit'],
        ['flac-to-mp3', 'Make a lossy copy for your phone'],
        ['normalize-audio', 'Set levels before archiving'],
        ['wav-44100-16bit', 'Standardise the spec before you archive']
      ]
    },
    'flac-to-wav': {
      cat: 'formats', label: 'flac → wav', title: 'FLAC to WAV',
      blurb: 'Decompress lossless audio for software that will not read FLAC.',
      next: [
        ['wav-44100-16bit', 'Force the CD spec on import'],
        ['change-sample-rate', 'Resample for your project'],
        ['wav-for-sp404', 'Prep for a hardware sampler'],
        ['flac-to-mp3', 'Make a small copy instead']
      ]
    },
    'wav-44100-16bit': {
      cat: 'formats', label: 'wav 44.1/16', title: 'WAV at 44.1 kHz, 16-bit',
      blurb: 'The CD standard, locked in — what most software assumes.',
      next: [
        ['change-sample-rate', 'Pick a different rate instead'],
        ['wav-for-sp404', 'Sampler-specific specs'],
        ['stereo-to-mono', 'Mono mixdown for one-shots'],
        ['normalize-audio', 'Even out levels across a batch']
      ]
    },
    'wav-to-mp3-128kbps': {
      cat: 'formats', label: 'wav → mp3 128k', title: 'WAV to MP3 at 128 kbps',
      blurb: 'The small-file setting — right for speech, web and email.',
      next: [
        ['stereo-to-mono', 'Halve it again for spoken word'],
        ['podcast-prep', 'Normalize, mono and encode in one pass'],
        ['audio-compressor', 'Hit a specific size target'],
        ['mp3-320kbps', 'Run the same source again at 320 kbps if it is music']
      ]
    },
    'mp3-320kbps': {
      cat: 'formats', label: 'mp3 320k', title: 'MP3 at 320 kbps',
      blurb: 'The MP3 quality ceiling, locked in.',
      next: [
        ['wav-to-mp3', 'Start from an uncompressed bounce'],
        ['normalize-audio', 'Match levels across an album'],
        ['fade-in-fade-out', 'Add clean fades before release'],
        ['wav-to-flac', 'Keep a lossless archive copy too'],
        ['wma-to-mp3', 'Rescue a WMA library at a fixed high bitrate'],
        ['loudness-normalizer', 'Check what Spotify will do to the level']
      ]
    },

    // ---- Video to audio --------------------------------------------------
    'extract-audio': {
      cat: 'video', label: 'video → audio', title: 'Extract audio from video',
      blurb: 'Any video container to any audio format, without uploading the video.',
      next: [
        ['mp4-to-mp3', 'Just MP4 to MP3, with the settings already chosen'],
        ['audio-cutter', 'Trim the extracted track down'],
        ['normalize-audio', 'Even out inconsistent recording levels'],
        ['audio-to-text-prep', 'Prep it for transcription'],
        ['capcut-audio', 'Match what CapCut expects on import'],
        ['ac3-to-mp3', 'Dolby Digital soundtracks, downmixed to stereo']
      ]
    },

    // ---- Cut, trim & arrange ---------------------------------------------
    'audio-editor': {
      cat: 'edit', label: 'editor', title: 'Audio Editor',
      blurb: 'A multitrack timeline with live effects, patches and automation: cut, mix, record and export, on a phone or a laptop.',
      next: [
        ['loudness-normalizer', 'Check the finished mix hits a streaming loudness target'],
        ['mp3-tag-editor', 'Add a title, artist and cover art to the export'],
        ['stem-splitter', 'Split a song into vocals and instrumental, then edit them as tracks'],
        ['voice-recorder', 'Record a quick take on its own, without the timeline'],
        ['audio-compressor', 'Shrink the export if it is too big to send']
      ]
    },
    'audio-cutter': {
      cat: 'edit', label: 'cut', title: 'Audio Cutter',
      blurb: 'Drag handles on a waveform and keep only the part you want.',
      project: 'len',
      next: [
        ['audio-editor', 'Cut out the middle and keep both ends, with undo'],
        ['audio-joiner', 'Stitch the pieces back together'],
        ['fade-in-fade-out', 'Soften the new in and out points'],
        ['ringtone-maker', 'Turn the selection into a ringtone'],
        ['split-audio', 'Chop the whole thing into pieces automatically'],
        ['mp4-to-mp3', 'Pull the audio out of a video before you trim it']
      ]
    },
    'audio-joiner': {
      cat: 'edit', label: 'join', title: 'Audio Joiner',
      blurb: 'Concatenate several files into one, in the order you choose.',
      next: [
        ['audio-editor', 'Arrange, layer and fade the pieces on a timeline instead'],
        ['normalize-audio', 'Match levels so the seams do not jump'],
        ['fade-in-fade-out', 'Fade the ends of the finished piece'],
        ['audio-cutter', 'Trim each part before joining'],
        ['podcast-prep', 'Finish an assembled episode in one pass'],
        ['mp3-to-m4a', 'Repackage the result for Apple devices']
      ]
    },
    'ringtone-maker': {
      cat: 'edit', label: 'ringtone', title: 'Ringtone Maker',
      blurb: 'A 30-second clip from any song, in the format your phone wants.',
      next: [
        ['audio-cutter', 'Pick the exact section by ear'],
        ['fade-in-fade-out', 'Fade so it does not start mid-note'],
        ['amplify-audio', 'Make sure it is loud enough to hear'],
        ['mp3-to-m4a', 'Apple-friendly container'],
        ['m4a-to-wav-for-audacity', 'Edit the source in Audacity first']
      ]
    },
    'audio-speed': {
      cat: 'edit', label: 'speed', title: 'Change audio speed',
      blurb: 'Slow a song or speed a podcast without shifting the pitch.',
      project: 'len',
      next: [
        ['silence-remover', 'Cut the pauses as well as speeding it up'],
        ['audio-reverser', 'The other way to make a file unrecognisable'],
        ['pitch-shifter', 'Change the key instead of the tempo'],
        ['m4b-to-mp3', 'Do the same to an audiobook'],
        ['mov-to-mp3', 'Same job starting from a QuickTime recording'],
        ['bpm-finder', 'Find both tempos before you stretch anything']
      ]
    },
    'audio-reverser': {
      cat: 'edit', label: 'reverse', title: 'Audio Reverser',
      blurb: 'Play a file backwards — for effects, or to hear what is buried.',
      project: 'same',
      next: [
        ['audio-cutter', 'Reverse just a section'],
        ['fade-in-fade-out', 'Shape the reversed tail'],
        ['normalize-audio', 'Level it afterwards'],
        ['amplify-audio', 'Bring up a quiet reversed part']
      ]
    },
    'fade-in-fade-out': {
      cat: 'edit', label: 'fade', title: 'Fade in / fade out',
      blurb: 'Clean fades on both ends without opening an editor.',
      project: 'same',
      next: [
        ['audio-editor', 'Fade several clips and mix them together in one place'],
        ['trim-silence-edges', 'Tighten the ends first'],
        ['audio-cutter', 'Set the exact in and out points'],
        ['normalize-audio', 'Level before fading'],
        ['audio-joiner', 'Fade each part of a longer piece'],
        ['audio-eq', 'Shape the tone as well as the edges']
      ]
    },
    'trim-silence-edges': {
      cat: 'edit', label: 'top & tail', title: 'Trim silence off the ends',
      blurb: 'Top and tail a recording, leaving the middle untouched.',
      project: 'len',
      next: [
        ['silence-remover', 'Also cut the pauses in the middle'],
        ['fade-in-fade-out', 'Soften the newly tight ends'],
        ['normalize-audio', 'Level the trimmed file'],
        ['podcast-prep', 'Finish the episode in one pass'],
        ['audio-reverser', 'Reverse it if you are hunting for a hidden tail'],
        ['auto-cut-silence', 'Tighten the gaps in the middle as well']
      ]
    },
    'auto-cut-silence': {
      cat: 'edit', label: 'auto-cut silence', title: 'Auto-Cut Silence',
      blurb: 'Shorten the pauses between phrases, keeping speech natural.',
      project: 'len',
      next: [
        ['loudness-normalizer', 'Set the level once the timing is right'],
        ['audio-for-whisper', 'Transcribe the tightened file'],
        ['audio-cutter', 'Fix any pause the detector got wrong'],
        ['noise-reduction', 'Clean the room tone the gaps revealed']
      ]
    },
    'silence-remover': {
      cat: 'edit', label: 'cut silence', title: 'Remove silence',
      blurb: 'Strip dead air out of a podcast, voice memo or voiceover.',
      project: 'len',
      next: [
        ['trim-silence-edges', 'Only trim the ends instead'],
        ['normalize-audio', 'Even out what is left'],
        ['podcast-prep', 'Normalize, mono and encode in one step'],
        ['noise-reduction', 'Take the hiss and hum out too'],
        ['voice-recorder', 'Record the next take without leaving the browser'],
        ['auto-cut-silence', 'Shorten the pauses inside the recording too']
      ]
    },

    // ---- Loudness & channels ---------------------------------------------
    'loudness-normalizer': {
      cat: 'levels', label: 'lufs normalize', title: 'LUFS Loudness Normalizer',
      blurb: 'Match the loudness target Spotify, Apple or broadcast expects.',
      project: 'same',
      next: [
        ['audio-compressor', 'Reduce dynamic range when the target will not fit'],
        ['normalize-audio', 'Set a peak ceiling instead of a loudness target'],
        ['audio-joiner', 'Assemble the episode once each part matches'],
        ['podcast-prep', 'Get the rest of the episode spec right too']
      ]
    },
    'normalize-audio': {
      cat: 'levels', label: 'normalize', title: 'Normalize Audio',
      blurb: 'Bring files to a consistent level so nothing jumps out.',
      project: 'same',
      next: [
        ['amplify-audio', 'Push a very quiet file harder'],
        ['audio-compressor', 'Shrink the file after levelling'],
        ['podcast-prep', 'Normalize, mono and encode together'],
        ['fade-in-fade-out', 'Add fades once levels are set'],
        ['wav-to-mp3', 'Turn the levelled WAV into an MP3 for sharing'],
        ['loudness-normalizer', 'Match a streaming loudness target instead of a peak']
      ]
    },
    'amplify-audio': {
      cat: 'levels', label: 'amplify', title: 'Amplify quiet audio',
      blurb: 'Make a too-quiet recording usable without driving it into distortion.',
      project: 'same',
      next: [
        ['normalize-audio', 'Target a consistent level instead of a gain amount'],
        ['noise-reduction', 'Amplifying a quiet file raises its hiss as well'],
        ['silence-remover', 'Cut the pauses that got louder too'],
        ['audio-to-text-prep', 'Now send it to be transcribed'],
        ['loudness-normalizer', 'Use a measured target rather than a gain guess']
      ]
    },
    'audio-compressor': {
      cat: 'levels', label: 'compress', title: 'Compress an audio file',
      blurb: 'Get a file under an email, Discord or upload size limit.',
      next: [
        ['discord-audio-compressor', 'Target Discord’s specific limit'],
        ['wav-to-mp3-128kbps', 'Fixed small-file bitrate'],
        ['stereo-to-mono', 'Halve the size again for speech'],
        ['audio-cutter', 'Shorten it instead of degrading it'],
        ['m4a-to-mp3', 'Convert a voice memo first if it is still .m4a'],
        ['ac3-to-mp3', 'Convert a film soundtrack before compressing it'],
        ['loudness-normalizer', 'Set the final loudness once the range is controlled']
      ]
    },
    'stereo-to-mono': {
      cat: 'levels', label: 'stereo → mono', title: 'Stereo to mono',
      blurb: 'Fix one-sided recordings and halve the size of voice files.',
      project: 'same',
      next: [
        ['mono-to-stereo', 'Going the other direction'],
        ['normalize-audio', 'Level the mixdown'],
        ['audio-compressor', 'Shrink it further'],
        ['wav-for-sp404', 'Mono one-shots for a sampler']
      ]
    },
    'mono-to-stereo': {
      cat: 'levels', label: 'mono → stereo', title: 'Mono to stereo',
      blurb: 'Honest dual-mono for software that insists on two channels.',
      project: 'same',
      next: [
        ['stereo-to-mono', 'Going the other direction'],
        ['change-sample-rate', 'Match the rest of the project spec'],
        ['normalize-audio', 'Level it'],
        ['davinci-resolve-audio', 'Prep it for an NLE that wants stereo'],
        ['aiff-to-mp3', 'Compress a Logic or GarageBand bounce afterwards']
      ]
    },
    'change-sample-rate': {
      cat: 'levels', label: 'sample rate', title: 'Change the sample rate',
      blurb: 'Resample to match a project and stop import warnings.',
      next: [
        ['wav-44100-16bit', 'Jump straight to the CD spec'],
        ['audio-for-whisper', '16 kHz mono for speech recognition'],
        ['wav-for-sp404', 'Sampler-specific rates'],
        ['mono-to-stereo', 'Fix the channel count too'],
        ['caf-to-mp3', 'Apple Core Audio files convert here first']
      ]
    },

    // ---- Clean up & separate ----------------------------------------------
    'vocal-remover': {
      cat: 'repair', label: 'vocal remover', title: 'Vocal remover / karaoke',
      blurb: 'Remove the vocal from a stereo song, or isolate it, by cancelling the centre.',
      project: 'same',
      next: [
        ['stem-splitter', 'The AI version — works on mono and off-centre vocals'],
        ['pitch-shifter', 'Move the karaoke track into your singing range'],
        ['normalize-audio', 'Bring the level back up properly'],
        ['audio-cutter', 'Trim to the section you actually need'],
        ['ogg-to-mp3', 'Convert an OGG export into something universal'],
        ['audio-to-midi', 'Get the melody out as MIDI'],
        ['autotune', 'Tune the vocal once it is isolated']
      ]
    },
    // Not a page in this repo: /stemflipper is proxied to its own app by
    // functions/stemflipper/. It is listed here so it appears in the rails, the footer
    // directory and llms.txt like any other tool.
    'stemflipper': {
      cat: 'repair', label: 'stems, MIDI & samples', title: 'StemFlipper — stems, MIDI and playable instruments',
      external: true,
      blurb: 'Split a song into stems and transcribe each one to MIDI, in your browser with nothing uploaded — or on a free GPU for four stems plus samples and instruments.',
      next: [
        ['stem-splitter', 'Separate vocals from the instrumental in your browser instead'],
        ['audio-to-midi', 'Just the melody as MIDI, with nothing uploaded'],
        ['bpm-finder', 'Read the tempo without separating anything'],
        ['audio-cutter', 'Trim to the section you want before uploading'],
        ['audio-compressor', 'Get a long track under the upload limit'],
        ['autotune', 'Tune a vocal once it is isolated'],
        ['pitch-shifter', 'Move a stem into another key']
      ]
    },
    'stem-splitter': {
      cat: 'repair', label: 'ai vocal remover', title: 'AI vocal remover / stem splitter',
      blurb: 'Neural separation into a clean instrumental and acapella, running on your machine.',
      project: 'stems',
      next: [
        ['stemflipper', 'Stems plus MIDI, in your browser or on a GPU'],
        ['audio-editor', 'Put the stems on separate tracks and remix them'],
        ['vocal-remover', 'The instant version, when centre cancellation is enough'],
        ['audio-cutter', 'Trim to the section you need before separating'],
        ['pitch-shifter', 'Move the finished instrumental into your key'],
        ['split-audio', 'Break a long track into parts first'],
        ['bpm-finder', 'Read the tempo off the isolated drums'],
        ['audio-to-midi', 'Transcribe the part you just isolated'],
        ['autotune', 'Tune the vocal stem you just separated']
      ]
    },
    'noise-reduction': {
      cat: 'repair', label: 'remove noise', title: 'Remove background noise',
      blurb: 'Strip hiss, hum and fan noise out of a recording with spectral gating.',
      project: 'same',
      next: [
        ['normalize-audio', 'Denoising lowers the level — put it back'],
        ['audio-eq', 'Clear up what is left with a little EQ'],
        ['silence-remover', 'Cut the dead air as well'],
        ['audio-to-text-prep', 'Now send it to be transcribed'],
        ['stem-splitter', 'Separate the voice from the background instead of filtering it']
      ]
    },
    'audio-eq': {
      cat: 'repair', label: 'eq / bass boost', title: 'EQ & bass booster',
      blurb: 'Adjust bass, mids and treble, or boost the low end, baked into the file.',
      project: 'same',
      next: [
        ['noise-reduction', 'EQ is the wrong tool for hum — this is the right one'],
        ['normalize-audio', 'Level it after changing the tone'],
        ['amplify-audio', 'Make a quiet file louder instead'],
        ['podcast-prep', 'Finish a voice recording in one pass'],
        ['aac-to-mp3', 'Convert an AAC source before shaping it']
      ]
    },
    'autotune': {
      cat: 'repair', label: 'autotune', title: 'Autotune / Pitch Correction',
      blurb: 'Snap a vocal to a key — subtle tuning or the hard-tuned effect.',
      project: 'same',
      next: [
        ['pitch-shifter', 'Move the whole take to another key instead'],
        ['key-finder', 'Not sure which key to tune to? Find it first'],
        ['stem-splitter', 'Lift the vocal out of a mix before tuning it'],
        ['auto-cut-silence', 'Remove breaths that read as stray notes'],
        ['loudness-normalizer', 'Set the level once the tuning is right']
      ]
    },
    'pitch-shifter': {
      cat: 'repair', label: 'pitch / key', title: 'Pitch & key changer',
      blurb: 'Shift the key up or down by semitones without changing the tempo.',
      project: 'same',
      next: [
        ['slowed-reverb', 'Move pitch and tempo together instead, with a room behind it'],
        ['audio-speed', 'The opposite — change tempo, keep the pitch'],
        ['vocal-remover', 'Make a karaoke track to transpose'],
        ['audio-cutter', 'Trim before shifting'],
        ['normalize-audio', 'Level the result'],
        ['key-finder', 'Find the key it is in now, so you know how far to move it'],
        ['bpm-finder', 'Check the tempo you are working against'],
        ['audio-to-midi', 'Capture the line as notes instead of audio'],
        ['autotune', 'Correct the tuning rather than transpose it']
      ]
    },

    // ---- Effects & remixes ----------------------------------------------
    'slowed-reverb': {
      cat: 'fx', label: 'slowed + reverb', title: 'Slowed + Reverb Maker',
      blurb: 'Slow a song, drop the pitch with it, and put it in a room.',
      project: 'len',
      next: [
        ['nightcore', 'The same effect the other way — faster and brighter'],
        ['8d-audio', 'Move it around your head instead'],
        ['stem-splitter', 'Slow the vocal or the instrumental alone'],
        ['audio-eq', 'Tame the low end if the slowed version came out muddy'],
        ['audio-speed', 'Change the tempo but keep the original pitch'],
        ['pitch-shifter', 'Move the key without changing how long it runs'],
        ['mp3-tag-editor', 'Put the title and artist back on the new file'],
        ['audio-cutter', 'Take a section before slowing it']
      ]
    },
    '8d-audio': {
      cat: 'fx', label: '8d audio', title: '8D Audio Maker',
      blurb: 'Move a track slowly around your head — on headphones, it circles.',
      project: 'len',
      next: [
        ['stem-splitter', 'Move one stem and leave the rest still — a better edit'],
        ['slowed-reverb', 'The other edit everyone asks for'],
        ['nightcore', 'Speed it up instead'],
        ['mono-to-stereo', 'Give a mono file two real channels first'],
        ['audio-eq', 'Fix the tone after the room goes in'],
        ['mp3-tag-editor', 'Put the title and artist back on the new file'],
        ['audio-cutter', 'Take a section before processing it']
      ]
    },
    'nightcore': {
      cat: 'fx', label: 'nightcore', title: 'Nightcore Maker',
      blurb: 'Speed a song up and lift its pitch — nightcore and sped-up edits.',
      project: 'len',
      next: [
        ['slowed-reverb', 'The same effect the other way — slower and deeper'],
        ['8d-audio', 'Move it around your head instead'],
        ['stem-splitter', 'Lift a vocal to lay over a faster instrumental'],
        ['bpm-finder', 'Check the tempo so the speed lands on a round number'],
        ['audio-speed', 'Speed it up without the pitch rising'],
        ['audio-joiner', 'Put the pieces of an edit together'],
        ['mp3-tag-editor', 'Put the title and artist back on the new file'],
        ['audio-eq', 'Cut the sibilance a speed-up brings forward']
      ]
    },

    // ---- Record & tag ------------------------------------------------------
    'voice-recorder': {
      cat: 'create', label: 'voice recorder', title: 'Voice recorder',
      blurb: 'Record from your microphone in the browser — the audio never leaves your device.',
      next: [
        ['audio-editor', 'Record over a backing track and edit the takes'],
        ['noise-reduction', 'Clean up the room tone you just recorded'],
        ['trim-silence-edges', 'Top and tail the recording'],
        ['normalize-audio', 'Bring it to a consistent level'],
        ['audio-to-text-prep', 'Prep it for transcription'],
        ['autotune', 'Tune the take you just recorded']
      ]
    },
    'audio-to-midi': {
      cat: 'create', label: 'audio → midi', title: 'Audio to MIDI',
      blurb: 'Turn a hummed melody or bassline into a MIDI file.',
      next: [
        ['bpm-finder', 'Check the tempo written into the file'],
        ['stem-splitter', 'Isolate one part of a mix before transcribing it'],
        ['auto-cut-silence', 'Remove breaths that register as stray notes'],
        ['pitch-shifter', 'Move the recording into a different key first'],
        ['autotune', 'Fix the tuning before transcribing']
      ]
    },
    'bpm-finder': {
      cat: 'create', label: 'bpm finder', title: 'BPM Finder',
      blurb: 'Detect the tempo of a track, with half and double time shown.',
      next: [
        ['audio-speed', 'Stretch a sample to match another tempo'],
        ['audio-cutter', 'Trim a loop to a whole number of bars'],
        ['pitch-shifter', 'Change the key without moving the tempo'],
        ['stem-splitter', 'Pull the drums out to hear the pulse alone'],
        ['audio-to-midi', 'Turn the same line into notes you can edit'],
        ['key-finder', 'Find the key as well as the tempo']
      ]
    },
    'key-finder': {
      cat: 'create', label: 'key finder', title: 'Key Finder',
      blurb: 'Find the key of a song, with its Camelot code, tuning and BPM.',
      next: [
        ['pitch-shifter', 'Move the song into the key you need'],
        ['autotune', 'Tune a vocal to the key you just found'],
        ['stem-splitter', 'Read the key from the instrumental alone'],
        ['audio-editor', 'Set the tempo and build on it in the editor'],
        ['audio-to-midi', 'Get the melody out as notes'],
        ['chord-finder', 'The chords, bar by bar, not just the key']
      ]
    },
    'chord-finder': {
      cat: 'create', label: 'chord finder', title: 'Chord Finder',
      blurb: 'Get the chords of a song from audio, bar by bar, and follow along.',
      next: [
        ['key-finder', 'The key and Camelot code, for mixing or transposing'],
        ['stem-splitter', 'Analyse the instrumental alone for a cleaner reading'],
        ['pitch-shifter', 'Move the song, and its chords, into your key'],
        ['tuner', 'Tune up before you play along'],
        ['audio-speed', 'Slow it down to learn the changes']
      ]
    },
    'metronome': {
      cat: 'create', label: 'metronome', title: 'Online Metronome',
      blurb: 'A steady click with subdivisions, tap tempo and a speed trainer.',
      next: [
        ['tuner', 'Tune up before you start'],
        ['bpm-finder', 'Find the tempo of the song you are practising'],
        ['audio-speed', 'Slow a recording down to practise along with it'],
        ['audio-editor', 'Record yourself to a click and a count-in']
      ]
    },
    'tuner': {
      cat: 'create', label: 'tuner', title: 'Online Tuner',
      blurb: 'Tune a guitar, bass, ukulele or violin through your microphone.',
      next: [
        ['metronome', 'Practise in time once you are in tune'],
        ['key-finder', 'Find the key and tuning of a song to play along with'],
        ['pitch-shifter', 'Move a song into a key that suits your instrument'],
        ['voice-recorder', 'Record what you play']
      ]
    },
    'split-audio': {
      cat: 'create', label: 'split', title: 'Split an audio file',
      blurb: 'Cut one long recording into equal parts, fixed chunks, or at the silent gaps.',
      next: [
        ['mp3-tag-editor', 'Title the pieces — splitting does not carry tags'],
        ['audio-cutter', 'Pick an exact cut point by eye instead'],
        ['audio-joiner', 'Put pieces back together'],
        ['audio-compressor', 'Get each piece under a size limit'],
        ['m4b-to-mp3', 'Break an audiobook into chapter files'],
        ['auto-cut-silence', 'Tighten the pauses instead of splitting on them']
      ]
    },
    'mp3-tag-editor': {
      cat: 'create', label: 'tag editor', title: 'MP3 tag editor',
      blurb: 'Edit title, artist, album and cover art without re-encoding the audio.',
      next: [
        ['split-audio', 'Split a long file, then title each piece'],
        ['flac-to-mp3', 'Convert an album, then put its tags back'],
        ['ringtone-maker', 'Tag a ringtone so it shows a name'],
        ['mp3-320kbps', 'Re-encode at maximum quality first'],
        ['wma-to-mp3', 'Convert an old Windows Media library first']
      ]
    },

    // ---- For a specific app or device -------------------------------------
    'audio-for-whisper': {
      cat: 'apps', label: 'for Whisper', title: 'Audio for Whisper',
      blurb: '16 kHz mono WAV — exactly what Whisper wants, in one click.',
      next: [
        ['audio-to-text-prep', 'Other transcription services and their formats'],
        ['silence-remover', 'Cut dead air so you transcribe less'],
        ['stereo-to-mono', 'Just the channel fix'],
        ['change-sample-rate', 'Pick a different rate']
      ]
    },
    'audio-to-text-prep': {
      cat: 'apps', label: 'for transcription', title: 'Prep audio for transcription',
      blurb: 'The format each transcription service actually wants.',
      next: [
        ['audio-for-whisper', 'Whisper specifically'],
        ['noise-reduction', 'Clean it up — recognisers do better on clean audio'],
        ['silence-remover', 'Shorten the audio before you pay per minute'],
        ['opus-to-mp3', 'Convert a voice note first'],
        ['auto-cut-silence', 'Shorter audio transcribes faster and cheaper']
      ]
    },
    'podcast-prep': {
      cat: 'apps', label: 'for podcasts', title: 'Podcast prep',
      blurb: 'Normalize, mono mixdown and MP3 encode in a single pass.',
      next: [
        ['silence-remover', 'Cut dead air before prepping'],
        ['voice-recorder', 'Record the episode here in the first place'],
        ['audio-joiner', 'Stitch intro, content and outro first'],
        ['trim-silence-edges', 'Top and tail the recording'],
        ['mp3-to-wav', 'Hand an editor an uncompressed file to work from'],
        ['loudness-normalizer', 'Hit the -16 LUFS podcast platforms expect'],
        ['auto-cut-silence', 'Cut the dead air before you publish']
      ]
    },
    'discord-audio-compressor': {
      cat: 'apps', label: 'for Discord', title: 'Compress audio for Discord',
      blurb: 'Fits under the upload limit without you doing the maths.',
      next: [
        ['audio-compressor', 'Target a different size limit'],
        ['audio-cutter', 'Cut it shorter instead of lower quality'],
        ['stereo-to-mono', 'Halve the size again'],
        ['ogg-to-mp3', 'Convert something Discord gave you']
      ]
    },
    'capcut-audio': {
      cat: 'apps', label: 'for CapCut', title: 'Audio for CapCut',
      blurb: 'The format CapCut imports without complaint.',
      next: [
        ['extract-audio', 'Get audio out of your footage first'],
        ['normalize-audio', 'Level it before it hits the timeline'],
        ['audio-cutter', 'Trim to the clip length'],
        ['davinci-resolve-audio', 'Same job for Resolve']
      ]
    },
    'davinci-resolve-audio': {
      cat: 'apps', label: 'for Resolve', title: 'Audio for DaVinci Resolve',
      blurb: 'The format Resolve always imports, no conform errors.',
      next: [
        ['change-sample-rate', 'Match the timeline sample rate'],
        ['mono-to-stereo', 'Fix a channel-count mismatch'],
        ['extract-audio', 'Pull audio off your source footage'],
        ['capcut-audio', 'Same job for CapCut']
      ]
    },
    'm4a-to-wav-for-audacity': {
      cat: 'apps', label: 'for Audacity', title: 'M4A to WAV for Audacity',
      blurb: 'Skip the FFmpeg install Audacity keeps asking you for.',
      next: [
        ['mp3-to-wav', 'Same thing from an MP3'],
        ['wav-44100-16bit', 'Force the standard spec'],
        ['normalize-audio', 'Level before editing'],
        ['change-sample-rate', 'Match your Audacity project rate']
      ]
    },
    'sample-slicer': {
      cat: 'edit', label: 'sample slicer', title: 'Sample Slicer',
      blurb: 'Chop a break at the hits, play the slices on pads, export for SP-404 or MPC.',
      next: [
        ['wav-for-sp404', 'The exact WAV spec each sampler wants'],
        ['stem-splitter', 'Pull the drums or vocal out of a song to chop'],
        ['bpm-finder', 'Get the tempo before slicing on the beat'],
        ['audio-editor', 'Arrange the slices on a bar grid'],
        ['audio-cutter', 'Trim the loop to whole bars first']
      ]
    },
    'wav-for-sp404': {
      cat: 'apps', label: 'for samplers', title: 'WAV for SP-404 / MPC',
      blurb: 'The exact spec hardware samplers need, or they fail silently.',
      next: [
        ['stereo-to-mono', 'Mono one-shots for pads'],
        ['audio-cutter', 'Chop a sample to length'],
        ['trim-silence-edges', 'Tighten the start so pads trigger instantly'],
        ['normalize-audio', 'Even out a kit of samples'],
        ['bpm-finder', 'Get the tempo before chopping the sample'],
        ['sample-slicer', 'Chop a break into pads before converting'],
        ['audio-to-midi', 'Transcribe a sample rather than chopping it']
      ]
    }
  };

  // The "jump straight to a job" row that sits above the rails. Phrased as the
  // job, not the tool: someone holding an iPhone memo is not searching for
  // "M4A". Kept short deliberately — this row is a shortcut past the rails, and
  // a shortcut with thirty entries is just the rails again.
  //
  // It lives here rather than in index.html because the row used to end in a
  // hardcoded "all 49 tools →" while the site had 57. Generated from the graph,
  // that count cannot drift.
  //
  // The first five are the five most-viewed tool pages in GA4 (21 Sep 2026),
  // not a guess about what people want. The previous row was a guess, and it
  // was wrong in a specific way: it led on format pairs and omitted
  // /voice-recorder, /split-audio, /noise-reduction and /mp3-tag-editor
  // entirely — which between them are four of the five busiest pages on the
  // site. Assistants send traffic to the distinctive tool, not the commodity
  // conversion, and two thirds of arrivals come from an assistant.
  //
  // The last three are here on search intent rather than measured volume:
  // "mp4 to mp3" and "iphone voice memo to mp3" are what the site is looked up
  // for, and cutting a clip is the job people describe when they cannot name a
  // tool. Re-derive the first five from the Pages and Screens report if the mix
  // moves; seven days of data is enough to order a row of eight and not much
  // more than that.
  var HOME_JOBS = [
    ['voice-recorder', 'record something'],
    ['stem-splitter', 'separate the vocals'],
    ['split-audio', 'split a long recording'],
    ['noise-reduction', 'remove background noise'],
    ['mp3-tag-editor', 'fix the track tags'],
    ['m4a-to-mp3', 'voice memo \u2192 mp3'],
    ['mp4-to-mp3', 'video \u2192 mp3'],
    ['audio-cutter', 'cut a clip'],
    ['slowed-reverb', 'slowed + reverb']
  ];

  // Homepage rails — a curation layer sitting on top of CATEGORIES.
  //
  // The homepage groups by what someone is trying to do, which is deliberately
  // not the same cut as the breadcrumb category: the pitch shifter is filed
  // under "clean up & separate" in the directory because that is where people
  // hunt for it, but on the homepage it belongs beside autotune and the BPM
  // finder under "make music". CATEGORIES stays canonical for breadcrumbs,
  // /tools and the footer directory; HOME_RAILS only decides the homepage.
  //
  // Every tool must appear in exactly one rail. build-nav.js fails the build if
  // one is missing or listed twice. The grid this replaced was hand-maintained
  // HTML in index.html rather than generated from here, and had drifted to 39 of
  // 57 tools — the homepage is the strongest internal link a tool page gets, and
  // eighteen of them had silently lost it.
  //
  // style: 'chip' where the label is the whole explanation. A format pair reads
  //        fine as "mp4 → mp3" and gains nothing from a blurb, and 22 full-size
  //        tiles of them were most of what made the old homepage scan as a
  //        directory listing rather than a set of tools.
  //        'tile' where the blurb has to carry the meaning.
  var HOME_RAILS = [
    {
      id: 'convert',
      title: 'Convert a file',
      note: 'Find the pair you have. Nothing is uploaded for any of them.',
      style: 'chip',
      tools: [
        'mp4-to-mp3', 'm4a-to-mp3', 'wav-to-mp3', 'opus-to-mp3', 'mp3-to-wav',
        'flac-to-mp3', 'extract-audio', 'mov-to-mp3', 'aac-to-mp3', 'ogg-to-mp3',
        'aiff-to-mp3', 'wma-to-mp3', 'm4b-to-mp3', 'caf-to-mp3', 'ac3-to-mp3',
        'mp3-to-m4a', 'mp3-to-aiff', 'wav-to-flac', 'flac-to-wav',
        'mp3-320kbps', 'wav-to-mp3-128kbps', 'wav-44100-16bit'
      ]
    },
    {
      id: 'trim',
      title: 'Cut, trim & arrange',
      note: 'Change how long it is or what order it is in, not what format it is.',
      style: 'tile',
      tools: [
        'audio-editor', 'audio-cutter', 'audio-joiner', 'ringtone-maker', 'auto-cut-silence',
        'silence-remover', 'trim-silence-edges', 'fade-in-fade-out'
      ]
    },
    {
      id: 'compress',
      title: 'Compress & clean up',
      note: 'Too big to send, too quiet to hear, or too noisy to use.',
      style: 'tile',
      tools: [
        'audio-compressor', 'normalize-audio', 'loudness-normalizer',
        'amplify-audio', 'noise-reduction', 'audio-eq', 'stereo-to-mono',
        'mono-to-stereo', 'change-sample-rate'
      ]
    },
    {
      id: 'music',
      title: 'Make music',
      note: 'Pull a mix apart, fix the pitch, find the tempo, record a take.',
      style: 'tile',
      tools: [
        'stemflipper', 'stem-splitter', 'vocal-remover', 'autotune', 'audio-to-midi',
        'bpm-finder', 'key-finder', 'chord-finder', 'sample-slicer', 'tuner', 'metronome', 'voice-recorder', 'split-audio', 'mp3-tag-editor'
      ]
    },
    {
      id: 'fx',
      title: 'Speed, pitch & effects',
      note: 'Change how a track moves rather than what format it is in.',
      style: 'tile',
      tools: [
        'slowed-reverb', 'nightcore', '8d-audio', 'audio-speed',
        'pitch-shifter', 'audio-reverser'
      ]
    },
    {
      id: 'apps',
      title: 'For a specific app or device',
      note: 'One program, one spec, already filled in — so the import works first try.',
      style: 'tile',
      tools: [
        'audio-for-whisper', 'podcast-prep', 'discord-audio-compressor',
        'capcut-audio', 'davinci-resolve-audio', 'm4a-to-wav-for-audacity',
        'audio-to-text-prep', 'wav-for-sp404'
      ]
    }
  ];

  // Which tool takes a given input extension. Used by flow.js when someone
  // drops the wrong file on a tool: the rejection message already knows the
  // real extension, so it can name the page that handles it instead of sending
  // them back to the homepage to start the hunt over.
  //
  // Deliberately an explicit table rather than a pattern over the slugs.
  // "<x>-to-<y>" also matches audio-to-midi, mono-to-stereo and
  // stereo-to-mono, and offering somebody "/stereo-to-mono" because their
  // filename ended in ".stereo" is worse than offering nothing at all.
  //
  // Where two pages take the same input (flac goes to both flac-to-mp3 and
  // flac-to-wav) this names the MP3 one: it is the commoner intent, and the
  // other is one click away in the related block on that page.
  var EXT_TOOL = {
    mp3: 'mp3-to-wav', wav: 'wav-to-mp3', m4a: 'm4a-to-mp3', m4r: 'm4a-to-mp3',
    aac: 'aac-to-mp3', flac: 'flac-to-mp3', ogg: 'ogg-to-mp3', oga: 'ogg-to-mp3',
    opus: 'opus-to-mp3', wma: 'wma-to-mp3', caf: 'caf-to-mp3', ac3: 'ac3-to-mp3',
    aiff: 'aiff-to-mp3', aif: 'aiff-to-mp3', m4b: 'm4b-to-mp3',
    mp4: 'mp4-to-mp3', mov: 'mov-to-mp3',
    // Containers with no page of their own. The general extractor demuxes all
    // of these, so it is a real answer rather than a shrug.
    webm: 'extract-audio', mkv: 'extract-audio', avi: 'extract-audio',
    m4v: 'extract-audio', '3gp': 'extract-audio', mpeg: 'extract-audio',
    mpg: 'extract-audio', wmv: 'extract-audio', flv: 'extract-audio'
  };

  // Returns null rather than a guess for anything unrecognised — a wrong
  // suggestion costs more than no suggestion, because the person has already
  // had one thing not work.
  function toolForExt(ext) {
    var slug = EXT_TOOL[String(ext || '').toLowerCase().replace(/^\./, '')];
    return slug && TOOLS[slug] ? slug : null;
  }

  function bySlug(slug) { return TOOLS[slug] || null; }

  function inCategory(catId) {
    return Object.keys(TOOLS).filter(function (s) { return TOOLS[s].cat === catId; });
  }

  // What the directory and hub actually display for a category: its own tools
  // plus any cross-listed ones.
  function listFor(catId) {
    var cat = CATEGORIES.filter(function (c) { return c.id === catId; })[0] || {};
    var own = inCategory(catId);
    var extra = (cat.also || []).filter(function (s) { return own.indexOf(s) === -1; });
    return own.concat(extra);
  }

  return {
    CATEGORIES: CATEGORIES,
    HOME_JOBS: HOME_JOBS,
    HOME_RAILS: HOME_RAILS,
    TOOLS: TOOLS,
    bySlug: bySlug,
    EXT_TOOL: EXT_TOOL,
    toolForExt: toolForExt,
    inCategory: inCategory,
    listFor: listFor,
    slugs: function () { return Object.keys(TOOLS); }
  };
}));
