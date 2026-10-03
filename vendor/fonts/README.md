# Noto Sans fonts (SIL Open Font License 1.1, OFL.txt)

Hinted TTFs from notofonts/notofonts.github.io, used by
/add-subtitles-to-video: libass in the ffmpeg core draws burned-in captions
with them (written into ffmpeg's filesystem next to the SRT, `fontsdir=.`).
FreeType there reads TTF, not the site's WOFF2. The core's libass shapes
with HarfBuzz, so Devanagari conjuncts and joined right-to-left Arabic
render correctly (checked by eye on burned frames, 3 Oct 2026).

- `NotoSans-SemiBold.ttf` 2.015: Latin, Greek, Cyrillic
- `NotoSansDevanagari-SemiBold.ttf` 2.007: Hindi, Marathi, Nepali
- `NotoSansArabic-SemiBold.ttf` 2.013: Arabic, Persian, Urdu (naskh style)

The page picks one font per video by the captions' main script
(`pickFont` in subtitle-page.js). Bump the `?v=` there with the version.
