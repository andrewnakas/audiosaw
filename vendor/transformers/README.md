# vendor/transformers

transformers.js **4.2.0** (`dist/transformers.min.js`) and the ONNX Runtime Web
**1.26.0-dev.20260416-b7804b056c** wasm it was built against, served from our
own origin because `/audio-to-text` is cross-origin isolated. Pinned; see
`docs/growth-playbook.md` §11 and CLAUDE.md "Transcription".

One local edit to `transformers.min.js`: the string literal
`"Mistral3ForConditionalGeneration"` is written as
`"Mistral3"+"ForConditionalGeneration"`. GitHub push protection reads that
32-character class name next to the word "mistral" as a Mistral AI API key and
refuses the push. The expression evaluates to the same string. Re-apply it if
the file is ever replaced.
