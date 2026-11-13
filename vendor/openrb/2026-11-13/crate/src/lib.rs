//! openrb.wasm: OpenRB-338's engine (crates `rbs`, `orb-engine`, `rbm`) behind a plain C ABI,
//! for AudioSaw's js/rebirth-play.js. One song at a time, one thread, no imports.
//!
//! What it renders is what `orb render` renders: the original's "Export Loop as Audio File"
//! (`orb_engine::frame::export`), i.e. the song's loop, or a range of bars given instead. The
//! steps of `export::export` are repeated here so that the audio comes out a few chunks per
//! call rather than as one vector; the chunk maths is `export::chunk_sizes`, run lazily, because
//! a file may name a tempo and a loop that make it billions of chunks long.
//!
//! Nothing of ReBirth is in this file or in the wasm. The drum samples arrive at run time
//! (`orb_set_kit`, `orb_set_mod`), either as a recrypted `.rbm` together with the 2047 key
//! bytes it is scrambled against (`orb_set_key`), or as a "clear kit" (below), which needs no
//! key.
//!
//! Parts follow orb-cli (`render.rs`: `drums_playing`, the choice of samples; `info.rs`: the
//! song facts), which cannot be a dependency: it pulls in the audio device and the encoders.
//!
//! The clear kit, written by `orb_export_kit` and read by `orb_set_kit` / `orb_set_mod`:
//! ```text
//! "ORBKIT1\0"
//! u16 LE n, n bytes        the kit's name, UTF-8 (a mod's INFO name)
//! 46 times, slots 1000..=1045:
//!   u32 LE frames          0xFFFFFFFF = the kit has no such sample (a mod; the standard one plays)
//!   frames * i16 LE        mono, 44.1 kHz, as `Sample::audio`
//! ```

use std::cell::UnsafeCell;
use std::fmt::Write as _;
use std::sync::Arc;

use orb_engine::frame::export::{CHUNK_FRAMES, ExportRange, REALTIME_FRAMES};
use orb_engine::frame::{Activation, Devices, Engine};
use orb_engine::samples::{self, Sample, SampleSet};
use orb_engine::song::{DrumPattern, MAX_TICK, Song, TICKS_PER_BAR};
use orb_engine::tables::Tables;
use rbm::{KeyTable, Rbm};
use rbs::rb1x::{Block, Kind, Song1x};

/// The name songs give the built-in kit (`rbm::standard::NAME`).
const STANDARD: &str = rbm::standard::NAME;
const KIT_MAGIC: &[u8; 8] = b"ORBKIT1\0";
const NO_SAMPLE: u32 = u32::MAX;
/// The engine's rate: fixed, the original's.
const RATE: u32 = 44100;

// orb_begin's flags
const F_KIT: i32 = 1;
const F_MOD: i32 = 2;
/// A drum machine plays and there are no samples for it: it is silent.
const F_DRUMS_SILENT: i32 = 4;
/// The song names a mod and none was given.
const F_MOD_MISSING: i32 = 8;
/// The mod lacks samples that the standard kit would supply, and there is no kit.
const F_MOD_INCOMPLETE: i32 = 16;
/// The mod given is not the one the song names.
const F_MOD_OTHER: i32 = 32;

enum Parsed {
    Rbs(Box<rbs::Song>),
    Rb1x(Box<Song1x>),
}

/// Drum samples as they were handed in.
enum Kit {
    /// By slot; `None` where the kit has no sample.
    Clear(String, Vec<Option<Arc<Sample>>>),
    Rbm(Box<Rbm>, KeyTable),
}

impl Kit {
    fn name(&self) -> String {
        match self {
            Kit::Clear(n, _) => n.clone(),
            Kit::Rbm(r, _) => r.info().map(|i| i.name.clone()).unwrap_or_default(),
        }
    }

    /// The 46 slots, `None` where this kit has none.
    fn slots(&self) -> Result<Vec<Option<Arc<Sample>>>, String> {
        match self {
            Kit::Clear(_, v) => Ok(v.clone()),
            Kit::Rbm(r, t) => {
                // rbm's own loader, over stand-ins that are told apart afterwards: it also
                // refuses a mod whose audio descrambles to noise (`dat::check_audio`)
                let blank = SampleSet::from_samples(
                    (0..samples::COUNT).map(|_| Sample::from_audio(&[])).collect(),
                );
                let l = r.load_samples(t, &blank).map_err(|e| e.to_string())?;
                Ok((samples::FIRST_ID..=samples::LAST_ID)
                    .map(|id| l.is_from_mod(id).then(|| l.set.shared(id)))
                    .collect())
            }
        }
    }
}

/// `export::chunk_sizes` one chunk at a time (the same operations in the same order).
#[derive(Clone)]
struct Chunks {
    tempo: f64,
    end: f64,
    pos: f64,
    done: bool,
}

const PPQ: f64 = 192.0;
const FRAMES_MILLI_MINUTE: f64 = 2_646_000_000.0;

impl Chunks {
    fn new(r: ExportRange) -> Self {
        Chunks {
            tempo: r.tempo as i32 as f64,
            end: r.loop_end as i32 as f64,
            pos: r.loop_start as i32 as f64,
            done: false,
        }
    }
}

impl Iterator for Chunks {
    type Item = usize;

    fn next(&mut self) -> Option<usize> {
        if self.done {
            return None;
        }
        let mut n =
            ((self.end - self.pos) / (self.tempo * (PPQ / FRAMES_MILLI_MINUTE))) as i64 as i32;
        let last = n < CHUNK_FRAMES;
        if !last {
            n = CHUNK_FRAMES;
        }
        let step = (self.tempo * n as f64) * (PPQ / FRAMES_MILLI_MINUTE);
        self.pos += step;
        self.done = last;
        Some(n.max(0) as usize)
    }
}

struct Run {
    engine: Engine,
    chunks: Chunks,
    /// One buffer for the idle calls and every chunk, never cleared, as `export::export` has
    /// it: a chunk whose render call faults repeats what the buffer held.
    buf: Vec<i16>,
}

#[derive(Default)]
struct State {
    key: Option<Vec<u8>>,
    parsed: Option<Parsed>,
    song: Option<Song>,
    kit: Option<Kit>,
    module: Option<Kit>,
    run: Option<Run>,
    tables: Option<Arc<Tables>>,
    /// The last error, or the text an export asked for; NUL-terminated.
    message: Vec<u8>,
    out: Vec<u8>,
}

struct Cell(UnsafeCell<Option<State>>);
// One thread: the build has no threads and the page calls from one place.
unsafe impl Sync for Cell {}
static STATE: Cell = Cell(UnsafeCell::new(None));

fn state() -> &'static mut State {
    // SAFETY: single-threaded, and no export keeps the reference across a call.
    unsafe { (*STATE.0.get()).get_or_insert_with(State::default) }
}

/// A panic is a trap for the caller; its text is left here, where the caller can still read it
/// out of the memory afterwards.
static mut PANIC: [u8; 512] = [0; 512];

fn hook() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let s = info.to_string();
            let b = s.as_bytes();
            let n = b.len().min(511);
            // SAFETY: single-threaded; the last byte stays 0.
            unsafe {
                let p = &raw mut PANIC as *mut u8;
                std::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
                *p.add(n) = 0;
            }
        }));
    });
}

fn fail(st: &mut State, msg: impl Into<String>) -> i32 {
    st.message = msg.into().into_bytes();
    st.message.push(0);
    0
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn orb_alloc(len: usize) -> *mut u8 {
    hook();
    let mut v = Vec::<u8>::new();
    if v.try_reserve_exact(len.max(1)).is_err() {
        return std::ptr::null_mut();
    }
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` are those of an `orb_alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orb_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn orb_rate() -> u32 {
    RATE
}

/// The text of the last failure (NUL-terminated UTF-8).
#[unsafe(no_mangle)]
pub extern "C" fn orb_message() -> *const u8 {
    let st = state();
    if st.message.is_empty() {
        st.message.push(0);
    }
    st.message.as_ptr()
}

/// Where a panic's text is written (512 bytes, NUL-terminated).
#[unsafe(no_mangle)]
pub extern "C" fn orb_panic_text() -> *const u8 {
    &raw const PANIC as *const u8
}

/// The key bytes recrypted mods are scrambled against: `RB20FUL.DAT[118280160..][..2047]`
/// (upstream's `crates/rbm/src/rb20ful_window.bin`). 1 = taken.
///
/// # Safety
/// `ptr..ptr+len` is readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orb_set_key(ptr: *const u8, len: usize) -> i32 {
    hook();
    let st = state();
    if len != rbm::embedded::WINDOW_LEN {
        return fail(
            st,
            format!("the key is {len} bytes, not {}", rbm::embedded::WINDOW_LEN),
        );
    }
    st.key = Some(unsafe { bytes(ptr, len) }.to_vec());
    1
}

/// 1 = an RBS 4.x song, 2 = a ReBirth 1.x song, 0 = refused (`orb_message` says why).
///
/// # Safety
/// `ptr..ptr+len` is readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orb_load_song(ptr: *const u8, len: usize) -> i32 {
    hook();
    let st = state();
    st.run = None;
    st.song = None;
    st.parsed = None;
    let data = unsafe { bytes(ptr, len) };
    // orb-cli's `read_song`
    if rbs::rb1x::is_1x(data) {
        let parsed = match Song1x::parse(data) {
            Ok(p) => p,
            Err(e) => return fail(st, format!("not a valid ReBirth 1.x song: {e}")),
        };
        let song = match orb_engine::load::convert_1x(&parsed) {
            Ok(s) => s,
            Err(e) => return fail(st, format!("cannot load the song: {e}")),
        };
        st.parsed = Some(Parsed::Rb1x(Box::new(parsed)));
        st.song = Some(song);
        return 2;
    }
    let parsed = match rbs::Song::parse(data) {
        Ok(p) => p,
        Err(e) => return fail(st, format!("not a valid .rbs song: {e}")),
    };
    let song = match orb_engine::load::convert(&parsed) {
        Ok(s) => s,
        Err(e) => return fail(st, format!("cannot load the song: {e}")),
    };
    st.parsed = Some(Parsed::Rbs(Box::new(parsed)));
    st.song = Some(song);
    1
}

fn read_kit(st: &State, data: &[u8]) -> Result<Kit, String> {
    if data.starts_with(KIT_MAGIC) {
        return read_clear(data);
    }
    let r = Rbm::parse(data.to_vec()).map_err(|e| e.to_string())?;
    let Some(key) = &st.key else {
        return Err("this .rbm is scrambled and no key was given".into());
    };
    let key: &[u8; rbm::embedded::WINDOW_LEN] = key.as_slice().try_into().expect("checked");
    // as orb-cli's `load_mod`: only a recrypted mod loads
    let Some(table) = KeyTable::with_window(&r, key).filter(|t| r.slots_covered(t)) else {
        return Err(
            "this mod is not recrypted (it needs the ReBirth CD's RB20FUL.DAT; `orb mod recrypt` \
             converts it)"
                .into(),
        );
    };
    Ok(Kit::Rbm(Box::new(r), table))
}

fn read_clear(data: &[u8]) -> Result<Kit, String> {
    let short = || "the kit file is cut short".to_string();
    let mut p = KIT_MAGIC.len();
    let mut take = |n: usize| -> Result<&[u8], String> {
        let end = p.checked_add(n).ok_or_else(short)?;
        let s = data.get(p..end).ok_or_else(short)?;
        p = end;
        Ok(s)
    };
    let n = u16::from_le_bytes(take(2)?.try_into().expect("2")) as usize;
    let name = String::from_utf8_lossy(take(n)?).into_owned();
    let mut slots = Vec::with_capacity(samples::COUNT);
    for _ in 0..samples::COUNT {
        let frames = u32::from_le_bytes(take(4)?.try_into().expect("4"));
        if frames == NO_SAMPLE {
            slots.push(None);
            continue;
        }
        let raw = take((frames as usize).checked_mul(2).ok_or_else(short)?)?;
        let audio: Vec<i16> = raw
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        slots.push(Some(Arc::new(Sample::from_audio(&audio))));
    }
    Ok(Kit::Clear(name, slots))
}

/// The standard kit: `Standard.rbm` (with `orb_set_key` first) or a clear kit. 1 = taken.
///
/// # Safety
/// `ptr..ptr+len` is readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orb_set_kit(ptr: *const u8, len: usize) -> i32 {
    hook();
    let st = state();
    match read_kit(st, unsafe { bytes(ptr, len) }) {
        Ok(k) => {
            st.kit = Some(k);
            1
        }
        Err(e) => fail(st, e),
    }
}

/// The song's mod, in either form. 1 = taken.
///
/// # Safety
/// `ptr..ptr+len` is readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orb_set_mod(ptr: *const u8, len: usize) -> i32 {
    hook();
    let st = state();
    match read_kit(st, unsafe { bytes(ptr, len) }) {
        Ok(k) => {
            st.module = Some(k);
            1
        }
        Err(e) => fail(st, e),
    }
}

/// Writes the kit (`which` 0) or the mod (1) as a clear kit; returns its length, 0 on failure.
/// `orb_out` is where it is.
#[unsafe(no_mangle)]
pub extern "C" fn orb_export_kit(which: i32) -> usize {
    let st = state();
    let Some(kit) = (if which == 0 { &st.kit } else { &st.module }) else {
        return fail(st, "no kit is loaded") as usize;
    };
    let slots = match kit.slots() {
        Ok(s) => s,
        Err(e) => return fail(st, e) as usize,
    };
    let name = kit.name();
    let mut out = KIT_MAGIC.to_vec();
    out.extend_from_slice(&(name.len().min(65535) as u16).to_le_bytes());
    out.extend_from_slice(&name.as_bytes()[..name.len().min(65535)]);
    for s in &slots {
        match s {
            None => out.extend_from_slice(&NO_SAMPLE.to_le_bytes()),
            Some(s) => {
                out.extend_from_slice(&(s.frames() as u32).to_le_bytes());
                for v in s.audio() {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }
    st.out = out;
    st.out.len()
}

#[unsafe(no_mangle)]
pub extern "C" fn orb_out() -> *const u8 {
    state().out.as_ptr()
}

/// orb-cli's `drums_playing` (render.rs): a drum machine is audible when it is enabled, by its
/// chunk or by any enable event, and a pattern it plays (the initial selection or one a track
/// event selects) has a step.
fn drums_playing(song: &Song) -> Vec<&'static str> {
    let plays = |params: &[u8], track: usize, patterns: &[DrumPattern]| {
        (params[0] != 0
            || song.tracks[track]
                .iter()
                .any(|e| e.ctrl == 0 && e.value != 0))
            && std::iter::once(params[1])
                .chain(
                    song.tracks[track]
                        .iter()
                        .filter(|e| e.ctrl == 1)
                        .map(|e| e.value),
                )
                .filter_map(|p| patterns.get(p as usize))
                .any(|p| p.steps.iter().any(|s| s.iter().any(|&c| c != 0)))
    };
    let mut v = Vec::new();
    if plays(&song.tr808.params, 3, &song.tr808.patterns) {
        v.push("TR-808");
    }
    if plays(&song.tr909.params, 4, &song.tr909.patterns) {
        v.push("TR-909");
    }
    v
}

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// orb-cli's `usri_copy` (info.rs): a 1.x song's information string as the original copies it.
fn usri_copy(raw: &[u8], off: usize, max: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    let mut i = off;
    while n < max {
        let c = raw.get(i).copied().unwrap_or(0);
        if c == 0 {
            break;
        }
        out.push(c as char);
        n += 1;
        if c == 0x0d && n < max {
            out.push('\n');
            n += 1;
        }
        i += 1;
    }
    out
}

fn newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// The song's facts as JSON (NUL-terminated UTF-8), the fields of orb-cli's `SongFacts`; null
/// without a song.
#[unsafe(no_mangle)]
pub extern "C" fn orb_info() -> *const u8 {
    let st = state();
    let (Some(parsed), Some(song)) = (&st.parsed, &st.song) else {
        st.out = b"null\0".to_vec();
        return st.out.as_ptr();
    };
    let g = &song.globals;
    let (rb1x, version, title, text, web, copyright, ftp, www, last_tick);
    match parsed {
        Parsed::Rbs(s) => {
            rb1x = false;
            version = s.head.version();
            title = s.usri.window_title.clone();
            text = newlines(&s.usri.text);
            web = s.usri.web_page.clone();
            copyright = s.head.copyright.clone();
            ftp = s.glob.mod_ftp.clone();
            www = s.glob.mod_www.clone();
            // a file position is in 32nd notes: 24 ticks
            last_tick = s
                .tracks
                .iter()
                .flat_map(|t| &t.events)
                .map(|e| e.pos.saturating_mul(24))
                .max();
        }
        Parsed::Rb1x(s) => {
            // info.rs `Usri1x::of`: the title, text and web page at 0x3160 of the song sysex
            const AT: usize = 0x3160;
            let block = s.tracks.iter().flatten().find_map(|e| match &e.kind {
                Kind::Sysex(d) => Block::decode(d).ok(),
                _ => None,
            });
            rb1x = true;
            version = format!("{}.{}", s.version.0, s.version.1);
            match &block {
                Some(b) => {
                    let b = b.bytes();
                    title = usri_copy(b, AT, 0x28);
                    text = newlines(&usri_copy(b, AT + 0x29, 0xC8));
                    web = usri_copy(b, AT + 0xF2, 0x64);
                }
                None => {
                    title = String::new();
                    text = String::new();
                    web = String::new();
                }
            }
            copyright = String::new();
            ftp = String::new();
            www = String::new();
            last_tick = song.tracks.iter().flatten().map(|e| e.tick).max();
        }
    }
    let mut o = String::from("{");
    let field = |o: &mut String, k: &str, s: &str| {
        let _ = write!(o, "\"{k}\":");
        json_str(o, s);
        o.push(',');
    };
    let format = if rb1x {
        format!("ReBirth 1.x MIDI file (file version {version})")
    } else {
        format!("RBS {version}")
    };
    field(&mut o, "format", &format);
    field(&mut o, "version", &version);
    field(&mut o, "title", &title);
    field(&mut o, "text", &text);
    field(&mut o, "webPage", &web);
    field(&mut o, "copyright", &copyright);
    field(&mut o, "modName", &song.mod_name);
    field(&mut o, "modFtp", &ftp);
    field(&mut o, "modWww", &www);
    let drums = drums_playing(song);
    let _ = write!(
        o,
        "\"rb1x\":{rb1x},\"usesMod\":{},\"tempo\":{},\"songMode\":{},\"looping\":{},\
         \"loopStartTick\":{},\"loopEndTick\":{},\"shuffle\":{},\"vintage\":{},\
         \"lastEventTick\":{},\"ticksPerBar\":{TICKS_PER_BAR},\"maxBars\":{},\"drums\":[{}]}}",
        song.mod_name != STANDARD,
        g.tempo,
        g.song_mode != 0,
        g.loop_on != 0,
        g.loop_start,
        g.loop_end,
        g.shuffle,
        g.vintage != 0,
        last_tick.map_or("null".to_string(), |t| t.to_string()),
        MAX_TICK / TICKS_PER_BAR,
        drums
            .iter()
            .map(|d| format!("\"{d}\""))
            .collect::<Vec<_>>()
            .join(","),
    );
    st.out = o.into_bytes();
    st.out.push(0);
    st.out.as_ptr()
}

fn range_of(song: &Song, start: u32, end: u32) -> ExportRange {
    let mut r = ExportRange::from(&song.globals);
    // u32::MAX twice = the song's own loop; else ticks, as `orb render --range` sets them
    if !(start == u32::MAX && end == u32::MAX) {
        r.loop_start = start;
        r.loop_end = end;
    }
    r
}

/// The frames an export of the range has, counted up to `cap` and no further (the count is the
/// sum of the chunks, which has no closed form that is exact). -1 without a song.
#[unsafe(no_mangle)]
pub extern "C" fn orb_frames(start: u32, end: u32, cap: f64) -> f64 {
    let st = state();
    let Some(song) = &st.song else { return -1.0 };
    let mut total = 0f64;
    for n in Chunks::new(range_of(song, start, end)) {
        total += n as f64;
        if total >= cap {
            break;
        }
    }
    total
}

/// The name of the kit (`which` 0) or the mod (1), NUL-terminated.
#[unsafe(no_mangle)]
pub extern "C" fn orb_kit_name(which: i32) -> *const u8 {
    let st = state();
    let name = (if which == 0 { &st.kit } else { &st.module })
        .as_ref()
        .map(Kit::name)
        .unwrap_or_default();
    st.out = name.into_bytes();
    st.out.push(0);
    st.out.as_ptr()
}

/// The samples the song plays with, and the flags that say how they were chosen. As
/// orb-cli's `Renderer::samples`, except that a kit that is not there is not an error: the drum
/// machines are then the engine's silent placeholders.
fn choose(st: &State, song: &Song) -> Result<(Option<Arc<SampleSet>>, i32), String> {
    let mut flags = 0;
    let names_mod = song.mod_name != STANDARD;
    if names_mod && st.module.is_none() {
        flags |= F_MOD_MISSING;
    }
    if let Some(m) = &st.module
        && !m.name().eq_ignore_ascii_case(&song.mod_name)
    {
        flags |= F_MOD_OTHER;
    }
    // a 303-only song renders without samples, and upstream gives it none
    if drums_playing(song).is_empty() {
        return Ok((None, flags));
    }
    let kit = st.kit.as_ref().map(Kit::slots).transpose()?;
    let module = st.module.as_ref().map(Kit::slots).transpose()?;
    if kit.is_none() && module.is_none() {
        return Ok((None, flags | F_DRUMS_SILENT));
    }
    let mut incomplete = false;
    let mut set = Vec::with_capacity(samples::COUNT);
    for i in 0..samples::COUNT {
        let from_mod = module.as_ref().and_then(|m| m[i].clone());
        let from_kit = kit.as_ref().and_then(|k| k[i].clone());
        set.push(from_mod.or(from_kit).unwrap_or_else(|| {
            incomplete = true;
            Arc::new(Sample::from_audio(&[]))
        }));
    }
    if kit.is_some() {
        flags |= F_KIT;
    }
    if module.is_some() {
        flags |= F_MOD;
    }
    if incomplete {
        flags |= F_MOD_INCOMPLETE;
    }
    Ok((Some(Arc::new(SampleSet::from_shared(set))), flags))
}

/// Starts an export: a new engine, the song loaded and activated, `idle_blocks` idle blocks,
/// stop, locate, play (`export::export_song` up to its chunk loop). `start` and `end` are ticks,
/// or both `u32::MAX` for the song's loop. Returns the flags (>= 0), or -1 (`orb_message`).
#[unsafe(no_mangle)]
pub extern "C" fn orb_begin(start: u32, end: u32, idle_blocks: u32) -> i32 {
    hook();
    let st = state();
    st.run = None;
    let Some(song) = &st.song else {
        fail(st, "no song is loaded");
        return -1;
    };
    // as `orb render --range`: the range becomes the song's loop before the load, so that a
    // song with its loop switched on does not jump back inside the range
    let range = range_of(song, start, end);
    let mut ranged = song.clone();
    ranged.globals.loop_start = range.loop_start;
    ranged.globals.loop_end = range.loop_end;
    let song = &ranged;
    let (set, flags) = match choose(st, song) {
        Ok(v) => v,
        Err(e) => {
            fail(st, e);
            return -1;
        }
    };
    let tables = st.tables.get_or_insert_with(|| Arc::new(Tables::new())).clone();
    let mut engine = Engine::new(tables, Devices::implemented(set));
    if let Err(e) = engine.load(song) {
        fail(st, e.to_string());
        return -1;
    }
    engine.activate(Activation::ReplacesCurrent {
        current_playing: false,
    });
    let mut buf = vec![0i16; 2 * CHUNK_FRAMES as usize];
    // `export::render_idle_into`
    for _ in 0..idle_blocks / 16 {
        engine.render(&mut buf, REALTIME_FRAMES);
    }
    let rest = (idle_blocks % 16) as usize * 64;
    if rest > 0 {
        engine.render(&mut buf, rest);
    }
    engine.stop();
    engine.render(&mut [], 0);
    engine.locate(range.loop_start);
    engine.play();
    engine.render(&mut [], 0);
    st.run = Some(Run {
        engine,
        chunks: Chunks::new(range),
        buf,
    });
    flags
}

/// Renders whole chunks into `out` (interleaved int16 stereo) while another full chunk still
/// fits in `frames`; `frames` must be at least 2048. Returns the frames written; 0 = the export
/// is over (or none is running).
///
/// # Safety
/// `out` holds `2 * frames` int16.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn orb_render(out: *mut i16, frames: usize) -> usize {
    let st = state();
    let Some(run) = &mut st.run else { return 0 };
    if out.is_null() {
        return 0;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out, 2 * frames) };
    let mut done = 0usize;
    while done + CHUNK_FRAMES as usize <= frames {
        let Some(n) = run.chunks.next() else { break };
        run.engine.render(&mut run.buf, n);
        out[2 * done..2 * (done + n)].copy_from_slice(&run.buf[..2 * n]);
        done += n;
    }
    done
}

/// Ends the export as `export::export` does and drops the engine. Returns the number of render
/// calls that faulted (calls the original would have left unwritten, upstream's warning); the
/// first fault's text is in `orb_message`.
#[unsafe(no_mangle)]
pub extern "C" fn orb_end() -> u32 {
    let st = state();
    let Some(mut run) = st.run.take() else { return 0 };
    run.engine.stop();
    run.engine.reset();
    run.engine.render(&mut [], 0);
    match run.engine.fault() {
        Some(f) => {
            let (calls, text) = (
                f.calls,
                format!("{}; the first in block {}", f.first, f.block),
            );
            fail(st, text);
            calls as u32
        }
        None => 0,
    }
}

/// Writes an empty RBS 4.x song (`rbs::Song::empty`) to `orb_out` and returns its length: a
/// valid file for the check that has to run without any song at hand.
#[unsafe(no_mangle)]
pub extern "C" fn orb_blank_song() -> usize {
    hook();
    let st = state();
    match rbs::Song::empty().write() {
        Ok(b) => {
            st.out = b;
            st.out.len()
        }
        Err(e) => fail(st, e.to_string()) as usize,
    }
}
