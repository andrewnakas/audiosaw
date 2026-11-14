#!/usr/bin/env python3
"""Applies the web-build changes to a Pro Wave v0.2.2 checkout (argv[1])."""
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])
def edit(rel, fn):
    p = root / rel
    s = p.read_text()
    t = fn(s)
    assert t != s, "no change in " + rel
    p.write_text(t)
def must(s, a, b, n=1):
    assert s.count(a) >= 1, "missing: " + a[:60]
    return s.replace(a, b, n)

# --- shim for rfd (native dialogs do not exist in a tab): every dialog is "cancelled"
shim = root / "crates/web-shims/rfd"
(shim / "src").mkdir(parents=True, exist_ok=True)
(shim / "Cargo.toml").write_text('[package]\nname = "rfd-shim"\nversion = "0.0.0"\nedition = "2021"\nlicense = "GPL-3.0-or-later"\n')
(shim / "src/lib.rs").write_text('''//! Web stand-in for the `rfd` crate: no native dialogs in a browser tab, so each one answers
//! as if it had been cancelled.
use std::path::PathBuf;
#[derive(Default)]
pub struct FileDialog;
impl FileDialog {
    pub fn new() -> Self { Self }
    pub fn add_filter(self, _name: impl Into<String>, _ext: &[impl ToString]) -> Self { self }
    pub fn set_file_name(self, _n: impl Into<String>) -> Self { self }
    pub fn set_directory<P: AsRef<std::path::Path>>(self, _p: P) -> Self { self }
    pub fn set_title(self, _t: impl Into<String>) -> Self { self }
    pub fn pick_file(self) -> Option<PathBuf> { None }
    pub fn pick_files(self) -> Option<Vec<PathBuf>> { None }
    pub fn pick_folder(self) -> Option<PathBuf> { None }
    pub fn save_file(self) -> Option<PathBuf> { None }
}
''')

# --- manifests
edit("Cargo.toml", lambda s: must(s, '"xtask"]', '"xtask"]\nexclude = ["crates/web-shims"]'))
def engine_toml(s):
    s = must(s, 'rustysynth = "1.3.8"\n', 'rustysynth = "1.3.8"\nweb-time = "1"\n')
    return s + '\n[target.\'cfg(target_arch = "wasm32")\'.dependencies]\ncpal = { version = "0.18.2", features = ["wasm-bindgen"] }\n'
edit("crates/prowave-engine/Cargo.toml", engine_toml)
def app_toml(s):
    for name in ("human-panic", "rfd", "ureq", "rhai"):
        m = re.search(r'^%s = .*\n' % re.escape(name), s, re.M)
        assert m, name
        s = s.replace(m.group(0), '')
    s = must(s, '[target.\'cfg(target_os = "macos")\'.dependencies]', '''[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
human-panic = "2.0.8"
rfd = "0.17.2"
ureq = { version = "3.4.2", default-features = false, features = ["rustls", "platform-verifier"] }
rhai = { version = "1", features = ["no_module"] }

[target.'cfg(target_arch = "wasm32")'.dependencies]
rfd-shim = { path = "../web-shims/rfd" }
# Without ahash's runtime-rng: getrandom has no wasm32-unknown-unknown backend by default.
rhai = { version = "1", default-features = false, features = ["std", "no_module"] }
wasm-bindgen-futures = "0.4"
web-time = "1"

[target.'cfg(target_os = "macos")'.dependencies]''')
    return must(s, 'tracing = "0.1.44"\n', 'tracing = "0.1.44"\nweb-time = "1"\n')
edit("crates/prowave-app/Cargo.toml", app_toml)

# --- std::time::Instant panics on wasm32-unknown-unknown; web-time is std on native
def instants(s):
    s = s.replace("use std::time::{Duration, Instant};", "use web_time::{Duration, Instant};")
    s = s.replace("use std::time::Instant;", "use web_time::Instant;")
    s = s.replace("std::time::Instant", "web_time::Instant")
    s = s.replace("std::time::SystemTime", "web_time::SystemTime")
    return s
for crate in ("prowave-engine", "prowave-app"):
    for p in (root / "crates" / crate / "src").rglob("*.rs"):
        if p.name in ("mapped.rs", "wasapi.rs"): continue
        s = p.read_text(); t = instants(s)
        if t != s: p.write_text(t)

# --- std::env::temp_dir panics on wasm32-unknown-unknown
for p in (root / "crates/prowave-app/src").rglob("*.rs"):
    s = p.read_text(); t = s.replace("std::env::temp_dir()", "crate::temp_dir()")
    if p.name == "main.rs":
        t = t.replace("\nfn init_logging() {", '''
/// The temporary folder; a fixed path on the web, where std has none (and no files either).
pub(crate) fn temp_dir() -> std::path::PathBuf {
    #[cfg(target_arch = "wasm32")]
    {
        std::path::PathBuf::from("/tmp")
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::temp_dir()
    }
}

fn init_logging() {''', 1)
        assert "pub(crate) fn temp_dir" in t
    if t != s: p.write_text(t)

# --- engine: build the recording module on the web too (it opens no device there)
def lib(s):
    s = must(s, '#[cfg(not(target_arch = "wasm32"))]\nmod capture;', 'mod capture;')
    return must(s, '#[cfg(not(target_arch = "wasm32"))]\npub use crate::capture::{', 'pub use crate::capture::{')
edit("crates/prowave-engine/src/lib.rs", lib)

# --- updater: no network client on the web
def upd(s):
    s = must(s, ".duration_since(std::time::UNIX_EPOCH)", ".duration_since(web_time::UNIX_EPOCH)")
    s = must(s, "fn agent(timeout: Duration) -> ureq::Agent {", '#[cfg(not(target_arch = "wasm32"))]\nfn agent(timeout: Duration) -> ureq::Agent {')
    s = must(s, "fn fetch_latest() -> Result<Option<Release>, String> {", '''#[cfg(target_arch = "wasm32")]
fn fetch_latest() -> Result<Option<Release>, String> {
    Err("the web build does not update itself".into())
}

#[cfg(target_arch = "wasm32")]
fn download(_asset: &Asset, _to: &Path, _progress: &Progress) -> Result<String, String> {
    Err("the web build does not update itself".into())
}

#[cfg(not(target_arch = "wasm32"))]
fn fetch_latest() -> Result<Option<Release>, String> {''')
    return must(s, "fn download(asset: &Asset, to: &Path, progress: &Progress) -> Result<String, String> {", '#[cfg(not(target_arch = "wasm32"))]\nfn download(asset: &Asset, to: &Path, progress: &Progress) -> Result<String, String> {')
edit("crates/prowave-app/src/updater.rs", upd)

# --- main: the app creator is shared; native runs a window, the web a canvas
def main(s):
    s = must(s, "    tracing_subscriber::fmt().with_env_filter(filter).init();", '''    // The log line's timestamp is SystemTime::now, which panics on wasm32-unknown-unknown.
    #[cfg(target_arch = "wasm32")]
    tracing_subscriber::fmt().with_env_filter(filter).without_time().with_ansi(false).init();
    #[cfg(not(target_arch = "wasm32"))]
    tracing_subscriber::fmt().with_env_filter(filter).init();''')
    s = must(s, "    bench::mark_start();", '''    // Panics go to the browser console (eframe installs its own handler once it starts).
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        eframe::web_sys::console::error_1(&info.to_string().into());
    }));
    bench::mark_start();''')
    i = s.index("\nmod ")
    s = s[:i] + '\n#[cfg(target_arch = "wasm32")]\nextern crate rfd_shim as rfd;\n' + s[i:]
    s = must(s, '''    human_panic::setup_panic!(human_panic::Metadata::new(
        "Pro Wave",
        env!("CARGO_PKG_VERSION")
    ));''', '''    #[cfg(not(target_arch = "wasm32"))]
    human_panic::setup_panic!(human_panic::Metadata::new(
        "Pro Wave",
        env!("CARGO_PKG_VERSION")
    ));
    // The web build keeps no settings and opens no MIDI ports or update check, like a
    // measuring run, and starts on the demo project so there is something to play.
    #[cfg(target_arch = "wasm32")]
    let measuring = true;''')
    s = must(s, "    project_io::remove_stale_media(", '    #[cfg(not(target_arch = "wasm32"))]\n    project_io::remove_stale_media(')
    s = must(s, '''    if cfg!(target_os = "macos") {
        viewport = viewport.with_icon(egui::IconData::default());
    } else {''', '''    #[cfg(target_arch = "wasm32")]
    let _ = &mut viewport;
    #[cfg(not(target_arch = "wasm32"))]
    if cfg!(target_os = "macos") {
        viewport = viewport.with_icon(egui::IconData::default());
    } else {''')
    a = s.index("    let wgpu_options = graphics::config();")
    b = s.index("        Box::new(|cc| {", a) + len("        Box::new(|cc| {")
    native_head = s[a:b]
    assert "eframe::run_native(" in native_head
    s = s[:a] + '''    let bench_for_app = bench_out.clone();
    let creator: eframe::AppCreator<'static> = Box::new(move |cc| {
            let bench_out = bench_for_app;''' + s[b:]
    s = must(s, "            let project = if shots_dir.is_some() {", '            let project = if shots_dir.is_some() || cfg!(target_arch = "wasm32") {')
    s = must(s, '''            Ok(Box::new(app))
        }),
    );
''', '''            Ok(Box::new(app))
        });
    #[cfg(target_arch = "wasm32")]
    {
        let _ = viewport;
        web_start(creator);
        Ok(())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
    let wgpu_options = graphics::config();
    let started_backends = graphics::started_backends(&wgpu_options);
    let opts = eframe::NativeOptions {
        viewport,
        wgpu_options,
        ..Default::default()
    };
    let result = eframe::run_native("Pro Wave", opts, creator);
''')
    tail = '''        return Ok(());
    }
    result
}
'''
    assert s.count(tail) == 1
    s = s.replace(tail, tail[:-2] + '''    }
}

/// Starts the app on the page's `<canvas id="prowave_canvas">`.
#[cfg(target_arch = "wasm32")]
fn web_start(creator: eframe::AppCreator<'static>) {
    use eframe::wasm_bindgen::JsCast as _;
    wasm_bindgen_futures::spawn_local(async move {
        let canvas = eframe::web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("prowave_canvas"))
            .and_then(|e| e.dyn_into::<eframe::web_sys::HtmlCanvasElement>().ok());
        let Some(canvas) = canvas else {
            return;
        };
        let started = eframe::WebRunner::new()
            .start(canvas, eframe::WebOptions::default(), creator)
            .await;
        if let Err(e) = started {
            eframe::web_sys::console::error_1(&e);
        }
    });
}
''')
    return s
edit("crates/prowave-app/src/main.rs", main)
print("applied")
