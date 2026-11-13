#!/usr/bin/env node
/*
 * make-kit.js: a recrypted .rbm -> a clear kit (the 46 drum-sample slots as
 * plain 16-bit PCM, no panel pictures, no scrambling), which openrb.wasm
 * loads without the key bytes.
 *
 *   node make-kit.js Standard.rbm rb20ful_window.bin Standard.orbkit
 *
 * The .rbm and the key are ReBirth's material and are not in this
 * repository; neither is what this writes. Upstream has both files:
 * assets/Standard.rbm and crates/rbm/src/rb20ful_window.bin.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ASRebirth = require('../../../js/rebirth-play.js');

var args = process.argv.slice(2);
if (args.length !== 3) {
  console.error('usage: node make-kit.js MOD.rbm rb20ful_window.bin OUT.orbkit');
  process.exit(2);
}

ASRebirth.load(path.join(__dirname, 'openrb.wasm')).then(function () {
  var kit = ASRebirth.clearKit(new Uint8Array(fs.readFileSync(args[0])), new Uint8Array(fs.readFileSync(args[1])));
  fs.writeFileSync(args[2], kit);
  console.log(args[2] + ': ' + kit.length + ' bytes');
}).catch(function (e) {
  console.error(String(e && e.message || e));
  process.exit(1);
});
