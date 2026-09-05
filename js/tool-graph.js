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
    { id: 'apps',     title: 'For a specific app or device' }
  ];

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
        ['normalize-audio', 'Bring a quietly recorded memo up to a usable level']
      ]
    },
    'wav-to-mp3': {
      cat: 'to-mp3', label: 'wav → mp3', title: 'WAV to MP3',
      blurb: 'Compress a DAW bounce or recording to a shareable MP3.',
      next: [
        ['mp3-320kbps', 'Lock the bitrate to 320 kbps for the best quality'],
        ['wav-to-mp3-128kbps', 'Go the other way — smallest usable file'],
        ['normalize-audio', 'Match the level to other tracks first'],
        ['fade-in-fade-out', 'Add a clean fade before you send it out']
      ]
    },
    'flac-to-mp3': {
      cat: 'to-mp3', label: 'flac → mp3', title: 'FLAC to MP3',
      blurb: 'Turn a lossless archive into something a phone or car will play.',
      next: [
        ['mp3-320kbps', 'Keep as much of the FLAC quality as MP3 allows'],
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
        ['mp3-320kbps', 'Minimise what the second encode costs you'],
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
        ['mp3-320kbps', 'Preserve as much of the master as MP3 can hold'],
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
        ['wav-to-mp3-128kbps', 'Spoken word does not need a high bitrate'],
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
        ['mp3-320kbps', 'Go the other way for music']
      ]
    },
    'mp3-320kbps': {
      cat: 'formats', label: 'mp3 320k', title: 'MP3 at 320 kbps',
      blurb: 'The MP3 quality ceiling, locked in.',
      next: [
        ['wav-to-mp3', 'Start from an uncompressed bounce'],
        ['normalize-audio', 'Match levels across an album'],
        ['fade-in-fade-out', 'Add clean fades before release'],
        ['wav-to-flac', 'Keep a lossless archive copy too']
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
        ['capcut-audio', 'Match what CapCut expects on import']
      ]
    },

    // ---- Cut, trim & arrange ---------------------------------------------
    'audio-cutter': {
      cat: 'edit', label: 'cut', title: 'Audio Cutter',
      blurb: 'Drag handles on a waveform and keep only the part you want.',
      next: [
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
      next: [
        ['silence-remover', 'Cut the pauses as well as speeding it up'],
        ['audio-reverser', 'The other way to make a file unrecognisable'],
        ['pitch-shifter', 'Change the key instead of the tempo'],
        ['m4b-to-mp3', 'Do the same to an audiobook'],
        ['mov-to-mp3', 'Same job starting from a QuickTime recording']
      ]
    },
    'audio-reverser': {
      cat: 'edit', label: 'reverse', title: 'Audio Reverser',
      blurb: 'Play a file backwards — for effects, or to hear what is buried.',
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
      next: [
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
      next: [
        ['silence-remover', 'Also cut the pauses in the middle'],
        ['fade-in-fade-out', 'Soften the newly tight ends'],
        ['normalize-audio', 'Level the trimmed file'],
        ['podcast-prep', 'Finish the episode in one pass'],
        ['audio-reverser', 'Reverse it if you are hunting for a hidden tail']
      ]
    },
    'silence-remover': {
      cat: 'edit', label: 'cut silence', title: 'Remove silence',
      blurb: 'Strip dead air out of a podcast, voice memo or voiceover.',
      next: [
        ['trim-silence-edges', 'Only trim the ends instead'],
        ['normalize-audio', 'Even out what is left'],
        ['podcast-prep', 'Normalize, mono and encode in one step'],
        ['noise-reduction', 'Take the hiss and hum out too'],
        ['voice-recorder', 'Record the next take without leaving the browser']
      ]
    },

    // ---- Loudness & channels ---------------------------------------------
    'normalize-audio': {
      cat: 'levels', label: 'normalize', title: 'Normalize Audio',
      blurb: 'Bring files to a consistent level so nothing jumps out.',
      next: [
        ['amplify-audio', 'Push a very quiet file harder'],
        ['audio-compressor', 'Shrink the file after levelling'],
        ['podcast-prep', 'Normalize, mono and encode together'],
        ['fade-in-fade-out', 'Add fades once levels are set'],
        ['wav-to-mp3', 'Turn the levelled WAV into an MP3 for sharing']
      ]
    },
    'amplify-audio': {
      cat: 'levels', label: 'amplify', title: 'Amplify quiet audio',
      blurb: 'Make a too-quiet recording usable without driving it into distortion.',
      next: [
        ['normalize-audio', 'Target a consistent level instead of a gain amount'],
        ['noise-reduction', 'Amplifying a quiet file raises its hiss as well'],
        ['silence-remover', 'Cut the pauses that got louder too'],
        ['audio-to-text-prep', 'Now send it to be transcribed']
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
        ['m4a-to-mp3', 'Convert a voice memo first if it is still .m4a']
      ]
    },
    'stereo-to-mono': {
      cat: 'levels', label: 'stereo → mono', title: 'Stereo to mono',
      blurb: 'Fix one-sided recordings and halve the size of voice files.',
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
        ['mono-to-stereo', 'Fix the channel count too']
      ]
    },

    // ---- Clean up & separate ----------------------------------------------
    'vocal-remover': {
      cat: 'repair', label: 'vocal remover', title: 'Vocal remover / karaoke',
      blurb: 'Remove the vocal from a stereo song, or isolate it, by cancelling the centre.',
      next: [
        ['stem-splitter', 'The AI version — works on mono and off-centre vocals'],
        ['pitch-shifter', 'Move the karaoke track into your singing range'],
        ['normalize-audio', 'Bring the level back up properly'],
        ['audio-cutter', 'Trim to the section you actually need'],
        ['ogg-to-mp3', 'Convert an OGG export into something universal']
      ]
    },
    'stem-splitter': {
      cat: 'repair', label: 'ai vocal remover', title: 'AI vocal remover / stem splitter',
      blurb: 'Neural separation into a clean instrumental and acapella, running on your machine.',
      next: [
        ['vocal-remover', 'The instant version, when centre cancellation is enough'],
        ['audio-cutter', 'Trim to the section you need before separating'],
        ['pitch-shifter', 'Move the finished instrumental into your key'],
        ['split-audio', 'Break a long track into parts first']
      ]
    },
    'noise-reduction': {
      cat: 'repair', label: 'remove noise', title: 'Remove background noise',
      blurb: 'Strip hiss, hum and fan noise out of a recording with spectral gating.',
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
      next: [
        ['noise-reduction', 'EQ is the wrong tool for hum — this is the right one'],
        ['normalize-audio', 'Level it after changing the tone'],
        ['amplify-audio', 'Make a quiet file louder instead'],
        ['podcast-prep', 'Finish a voice recording in one pass'],
        ['aac-to-mp3', 'Convert an AAC source before shaping it']
      ]
    },
    'pitch-shifter': {
      cat: 'repair', label: 'pitch / key', title: 'Pitch & key changer',
      blurb: 'Shift the key up or down by semitones without changing the tempo.',
      next: [
        ['audio-speed', 'The opposite — change tempo, keep the pitch'],
        ['vocal-remover', 'Make a karaoke track to transpose'],
        ['audio-cutter', 'Trim before shifting'],
        ['normalize-audio', 'Level the result']
      ]
    },

    // ---- Record & tag ------------------------------------------------------
    'voice-recorder': {
      cat: 'create', label: 'voice recorder', title: 'Voice recorder',
      blurb: 'Record from your microphone in the browser — the audio never leaves your device.',
      next: [
        ['noise-reduction', 'Clean up the room tone you just recorded'],
        ['trim-silence-edges', 'Top and tail the recording'],
        ['normalize-audio', 'Bring it to a consistent level'],
        ['audio-to-text-prep', 'Prep it for transcription']
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
        ['m4b-to-mp3', 'Break an audiobook into chapter files']
      ]
    },
    'mp3-tag-editor': {
      cat: 'create', label: 'tag editor', title: 'MP3 tag editor',
      blurb: 'Edit title, artist, album and cover art without re-encoding the audio.',
      next: [
        ['split-audio', 'Split a long file, then title each piece'],
        ['flac-to-mp3', 'Convert an album, then put its tags back'],
        ['ringtone-maker', 'Tag a ringtone so it shows a name'],
        ['mp3-320kbps', 'Re-encode at maximum quality first']
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
        ['opus-to-mp3', 'Convert a voice note first']
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
        ['mp3-to-wav', 'Hand an editor an uncompressed file to work from']
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
    'wav-for-sp404': {
      cat: 'apps', label: 'for samplers', title: 'WAV for SP-404 / MPC',
      blurb: 'The exact spec hardware samplers need, or they fail silently.',
      next: [
        ['stereo-to-mono', 'Mono one-shots for pads'],
        ['audio-cutter', 'Chop a sample to length'],
        ['trim-silence-edges', 'Tighten the start so pads trigger instantly'],
        ['normalize-audio', 'Even out a kit of samples']
      ]
    }
  };

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
    TOOLS: TOOLS,
    bySlug: bySlug,
    inCategory: inCategory,
    listFor: listFor,
    slugs: function () { return Object.keys(TOOLS); }
  };
}));
