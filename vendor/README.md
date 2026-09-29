# vendor/

Third-party code shipped as-is (no build step).

| File | What | Licence |
| --- | --- | --- |
| `lame.min.js` | [lamejs](https://github.com/zhuker/lamejs) 1.2.1 — the unmodified `lame.min.js` from the npm package `lamejs@1.2.1` (sha256 `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`). A JavaScript port of [LAME](https://lame.sourceforge.net/). | GNU LGPL — see `LICENSE-lamejs.txt` (LGPL-3.0 text) and `GPL-3.0.txt` |

## How it is used

`js/audio/mp3-worker.js` is a classic Web Worker that loads the encoder with
`importScripts('../../vendor/lame.min.js')` (path relative to the worker, so it works from a GitHub Pages sub-path).
The library stays a separate, replaceable file: any build that exposes a global `lamejs.Mp3Encoder(channels,
sampleRate, kbps)` with `encodeBuffer(left, right)` / `flush()` can be dropped in.

Why this build: `lame.min.js` 1.2.1 runs in a classic worker as-is. The npm `src/` build has the
"MPEGMode is not defined" bug, and `@breezystack/lamejs` 1.2.7 (IIFE/ESM) has the same encoder settings
(stereo L/R, quality 3, no bit reservoir, no Xing tag) with no advantage here.

Notes about the encoder (measured):

- Mode: plain L/R stereo (lamejs hard-codes `MPEGMode.STEREO`). A one-token patch to joint stereo improved SNR by
  only 0.1–0.9 dB on real music at 192/320 kbps and was ~20 % slower, so the file is kept unmodified.
- Bit reservoir disabled → every frame is self-contained. `js/audio/export.js` uses this to encode segments in
  parallel workers and join them frame by frame (global SNR identical to a single-worker encode).
- lamejs writes no Xing/LAME header; `export.js` adds an "Info" frame with the LAME extension (encoder delay 576,
  padding, CRC) so decoders trim the encoder delay (Chrome and libmpg123 decode the exact original length).

## Updating

```sh
npm pack lamejs@1.2.1 && tar xzf lamejs-1.2.1.tgz && cp package/lame.min.js vendor/
```

If a different build is used, update the checksum above and rerun `node --test tests/audio-*.test.js`
and `node tests/audio-browser.e2e.mjs`.

The LAME project asks for acknowledgement: the app should mention that MP3 export uses LAME (lamejs, LGPL) with a
link to https://lame.sourceforge.net/.
