/*
 * Serves Hugging Face model files to a headless page from a local mirror, so
 * a check never depends on the network or on the browser's per-origin model
 * cache (the harness picks a new port each run, and Cache Storage is keyed
 * by origin, so a cached model was downloaded again every time).
 *
 *   ~/.cache/audiosaw/hf/<org>/<repo>/<path>   mirrors   huggingface.co/<org>/<repo>/resolve/<rev>/<path>
 *
 *   const mirror = require('./model-mirror');
 *   mirror.fetch('onnx-community/whisper-base', ['config.json', ...]);   // once, curl, resumable
 *   await withPage({ routes: mirror.routes(['onnx-community/whisper-base']) }, async (page) => {
 *     await mirror.attach(page, ['onnx-community/whisper-base']);
 *   });
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(os.homedir(), '.cache', 'audiosaw', 'hf');

const WHISPER_BASE = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx'];

function has(repo, files) { return files.every((f) => fs.existsSync(path.join(ROOT, repo, f))); }

function fetchRepo(repo, files, rev) {
  for (const f of files) {
    const dest = path.join(ROOT, repo, f);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    execFileSync('curl', ['-sL', '-C', '-', '--retry', '5', '-o', dest + '.part', 'https://huggingface.co/' + repo + '/resolve/' + (rev || 'main') + '/' + f]);
    fs.renameSync(dest + '.part', dest);
  }
}

function routes(repos) {
  const r = {};
  repos.forEach((repo) => {
    const base = path.join(ROOT, repo);
    if (!fs.existsSync(base)) return;
    (function walk(d, pre) {
      fs.readdirSync(d).forEach((f) => {
        const full = path.join(d, f);
        if (fs.statSync(full).isDirectory()) walk(full, pre + f + '/');
        else if (!/\.part$/.test(f)) r['/__hf/' + repo + '/' + pre + f] = () => fs.readFileSync(full);
      });
    })(base, '');
  });
  return r;
}

// Rewrites the page's (and its workers') requests for those repos to the
// routes. Call before the page loads the model.
async function attach(page, repos) {
  page.listen('Fetch.requestPaused', (p) => {
    const m = /huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/([^?]+)/.exec(p.request.url);
    if (m && repos.includes(m[1])) page.send('Fetch.continueRequest', { requestId: p.requestId, url: page.url('/__hf/' + m[1] + '/' + m[2]) });
    else page.send('Fetch.continueRequest', { requestId: p.requestId });
  });
  await page.send('Fetch.enable', { patterns: repos.map((r) => ({ urlPattern: '*huggingface.co/' + r + '/*' })) });
}

module.exports = { ROOT, WHISPER_BASE, has, fetch: fetchRepo, routes, attach };
