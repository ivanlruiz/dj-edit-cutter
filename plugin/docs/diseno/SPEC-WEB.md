# DJ Edit Cutter — build spec (internal)

Project root: `/home/user/dj-edit-cutter` (local git repo, branch `main`; the GitHub remote does not exist yet — do NOT try to push or add remotes).

## What the product is

A static web app (GitHub Pages, no build step, no server) for a DJ. The user loads ONE song (MP3/WAV/FLAC/M4A/OGG — whatever
the browser decodes). The app detects beats and bars (compases), shows the waveform with the beat/bar grid, and lets the user
choose **how many bars to remove from the end of the song** (default 1, quick picks 1/2/4/8/16/32). The new ending gets an
**adjustable fade-out** (0 = hard cut, still with a tiny anti-click ramp). The user can review/fix the detection by ear
(metronome click over playback, preview of the new ending) and by hand (drag the cut marker, nudge it, shift the bar
"1", force tempo ×2/÷2, change beats per bar). Export as **WAV (16/24-bit) or MP3 (320/256/192 kbps)**, chosen at export
time. Everything runs locally in the browser — the song is never uploaded.

User profile (important for the DSP): Spanish-speaking DJ making edits of **rock / pop / live recordings and songs without
drums**. So: tempo is NOT constant (human drummers drift, live bands, ritardandos at the end), onsets can be soft (piano,
strummed guitar, strings, vocals), endings vary (final hit + ring-out, fade-out, ritardando + fermata, abrupt stop).
Auto-detection must be robust but the manual correction UX is equally important.

## Conventions

- Plain ES modules (`<script type="module">`), no bundler, no npm runtime dependencies. Must work when served statically from a
  sub-path (GitHub Pages: `https://ivanlruiz.github.io/dj-edit-cutter/`) → **only relative URLs**. Workers created with
  `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.
- Target browsers: current Chrome/Edge, Firefox, Safari (desktop + iOS/Android). No experimental APIs.
- UI language: **Spanish** (Rioplatense-neutral, use "tú"-neutral imperative forms like "Elige", "Arrastra"). Code identifiers in
  English. Code comments: brief, in Spanish, only where they add information.
- Times are **seconds (float)** on the original song's timeline everywhere in the public APIs.
- Pure logic lives in modules with no DOM access so it runs under `node --test` (Node 22). DOM/WebAudio code is kept thin.
- Tests: `node --test` (built-in runner), files `tests/**/*.test.js`. `package.json` has `"type": "module"` and no dependencies.
- No `console.log` noise in shipped code.

## Directory layout and ownership

```
index.html                    UI  (owner: UI agent)
css/app.css                   UI
js/main.js                    UI — app controller, wires everything
js/ui/waveform.js             UI — WaveformView (canvas)
js/ui/format.js               UI — formatting helpers (pure)
js/audio/decode.js            AUDIO-IO — decode file, sniff sample rate, mono 22.05 kHz for analysis
js/audio/player.js            UI — playback + metronome + preview
js/audio/edit.js              AUDIO-IO — cut + fade render (pure)
js/audio/wav.js               AUDIO-IO — WAV encoder (pure)
js/audio/id3.js               AUDIO-IO — ID3v2 read / rebuild (pure)
js/audio/mp3-worker.js        AUDIO-IO — classic worker, lamejs
js/audio/export.js            AUDIO-IO — exportAudio() orchestrator
vendor/lame.min.js            AUDIO-IO — vendored lamejs (+ vendor/LICENSE-lamejs.txt)
js/analysis/*.js              ANALYSIS — DSP (pure), see below
js/analysis/worker.js         ANALYSIS — module worker
js/analysis/client.js         ANALYSIS — promise wrapper used by main.js
js/core/bars.js               ANALYSIS — bar model + cut computations (pure)
tests/synth/*.js              ANALYSIS — synthetic music generator with ground truth
tools/bench.js                ANALYSIS — benchmark runner
tests/*.test.js               each agent tests its own modules
```

## Interfaces (contract between agents — do not change without updating this file)

### js/analysis/client.js

```js
export class AnalysisClient {
  constructor()                       // spawns js/analysis/worker.js (module worker)
  analyze(samples, sampleRate, options = {}, onProgress = (stage, fraction) => {}) : Promise<AnalysisResult>
      // samples: Float32Array mono (normally 22050 Hz); transferred to the worker (caller must not reuse it)
      // options: { minBpm=50, maxBpm=220, beatsPerBar='auto' }
      // stage: 'features' | 'tempo' | 'beats' | 'bars'   (Spanish labels are the UI's job)
  retrack(options = {}) : Promise<AnalysisResult>
      // re-run beat tracking on cached features. options: { bpmHint:number, strict:boolean } — strict=true
      // constrains the tempo search to roughly [0.8, 1.25] × bpmHint (used for the ×2 / ÷2 buttons).
      // keeps the current beatsPerBar / forcedDownbeats settings unless they no longer make sense.
  relabel(options = {}) : Promise<AnalysisResult>
      // re-run only the bar labelling on the current beats. options: { beatsPerBar: 'auto'|2..7, forcedDownbeats: number[] }
      // forcedDownbeats are beat INDICES that must be bar starts ("1").
  terminate()
}
```

Worker protocol (internal to ANALYSIS, but keep it simple): messages `{id, type, ...}`; responses `{id, type:'progress'|'result'|'error'}`.

### AnalysisResult (plain JSON-serialisable object)

```js
{
  duration: number,            // seconds of analysed audio
  musicStart: number,          // first non-silent time (s)
  musicEnd: number,            // last non-silent time (s) — tail silence excluded
  lastOnset: number,           // time of the last significant onset (the final hit / last played note) (s)
  bpm: number,                 // representative tempo (median of 60/IBI), rounded to 0.1
  bpmRange: [number, number],  // 10th/90th percentile of local tempo (shows drift)
  beats: number[],             // beat times (s), ascending, refined to the transient when one is close; within [musicStart, musicEnd]
  beatStrength: number[],      // 0..1 per beat (onset salience near the beat)
  beatsPerBar: number,         // chosen meter numerator (2..7)
  meterAuto: boolean,          // true if beatsPerBar was chosen automatically
  positions: number[],         // per beat: 0 = bar start ("1"), 1..beatsPerBar-1 normal; may equal beatsPerBar for an
                               // irregular (one-beat-longer) bar in live music
  downbeats: number[],         // indices into beats where positions[i] === 0 (ascending)
  forcedDownbeats: number[],   // echo of the constraint used
  confidence: { beats: number, bars: number },   // 0..1 heuristics; < 0.5 → UI shows "revisa la cuadrícula"
  timingsMs: { [stage]: number }
}
```

### js/core/bars.js (pure)

```js
export const LAST_BAR_TOLERANCE = 0.08   // s
export function getBars(result) -> Array<{ index, number, beatIndex, start, end, beatCount }>
   // index 0-based, number = index+1; end = start of next bar, or for the final bar: last beat + median IBI (capped at musicEnd)
   // beats before the first downbeat (pickup/anacrusis) are not part of any bar.
export function findLastBarIndex(result) -> number
   // the last bar whose start <= result.lastOnset + LAST_BAR_TOLERANCE (the bar containing the final hit). -1 if no bars.
export function cutForBarsRemoved(result, n) -> { barIndex, beatIndex, time } | null
   // n >= 1 bars removed from the end: cut at the start of bar (lastBar - n + 1). Clamp so at least 1 bar remains.
   // time = beats[beatIndex] (the raw downbeat time; edit.js applies the pre-roll).
export function barsRemovedAt(result, time) -> number
   // how many bars (float, 1 decimal ok) lie between `time` and the end of the last bar — for display when the user moved the cut by hand
export function nearestBeatIndex(result, time) -> number
export function stepBeat(result, time, delta) -> number   // time of the beat `delta` beats away from the beat nearest `time`
export function stepBar(result, time, delta) -> number    // same with downbeats
```

### js/audio/edit.js (pure)

```js
export const CUT_PREROLL_SEC = 0.004      // cut this much before a beat/downbeat so its attack is not audible
export const ANTICLICK_SEC = 0.005        // minimum fade length always applied at the cut
export const FADE_CURVES = ['linear', 'smooth', 'exp']   // UI labels: Lineal / Suave / Exponencial
export function fadeGain(x, curve) -> number   // x in [0,1] = progress through the fade; g(0)=1, g(1)=0, monotonic
export function renderEdit(channels, sampleRate, { cutTime, fadeSec = 0, curve = 'smooth', startTime = 0 }) -> Float32Array[]
   // returns NEW arrays covering [startTime, cutTime) of the source with gain ramp over
   // [cutTime - max(fadeSec, ANTICLICK_SEC), cutTime). Never mutates input. Clamps everything to valid ranges.
   // startTime > 0 is used for the "Escuchar el final" preview (render only the last seconds).
```

### js/audio/wav.js, id3.js, export.js, decode.js

```js
// wav.js
export function encodeWav(channels, sampleRate, { bitDepth = 16, id3 = null /* Uint8Array */ } = {}) -> ArrayBuffer
   // PCM RIFF/WAVE; 16-bit uses TPDF dither; 24-bit little-endian; clip to [-1,1]; optional 'id3 ' chunk (word-aligned)
export function parseWav(arrayBuffer) -> { sampleRate, bitDepth, channels: Float32Array[] }   // for tests

// id3.js
export function readId3v2(arrayBuffer) -> { version, frames: Array<{ id, data: Uint8Array }> } | null   // ID3v2.3 / v2.4
export function buildId3v2(frames, { version = 3 } = {}) -> Uint8Array
export function keepPortableFrames(frames) -> frames   // allowlist: text frames T*** except TLEN, TXXX, COMM, APIC, USLT, W***, POPM.
   // drops timing-dependent / DJ-software analysis frames (GEOB, PRIV, TLEN, ETCO, MLLT, SYLT, SEEK, ASPI...)

// export.js
export async function exportAudio({ channels, sampleRate, format /* 'wav'|'mp3' */, bitDepth, kbps,
                                     sourceBytes /* original file ArrayBuffer, for tags */, keepTags = true,
                                     onProgress = (fraction) => {} }) -> Blob
export function suggestFileName(originalName, { barsRemoved, format }) -> string
   // e.g. "Mi canción (edit -4 compases).mp3"; handles missing extension, strips path chars
export function mp3SampleRateFor(sampleRate) -> number   // lamejs-supported rate to encode at (e.g. 96000 -> 48000)

// decode.js
export function sniffSampleRate(arrayBuffer) -> number | null   // WAV fmt, FLAC STREAMINFO, MP3 frame header (skip ID3v2), OGG (Vorbis/Opus id header), M4A (mdhd / esds best effort)
export async function decodeAudioFile(file) -> { buffer: AudioBuffer, bytes: ArrayBuffer, name: string, sampleRate: number }
   // decodes WITHOUT resampling when the native rate is known (OfflineAudioContext at that rate); fallback 44100
export async function toAnalysisMono(audioBuffer, targetRate = 22050) -> Float32Array   // OfflineAudioContext downmix+resample
```

### js/audio/player.js (UI agent)

```js
export class Player extends EventTarget {   // events: 'play', 'pause', 'ended', 'timeupdate'(throttled rAF by the UI)
  constructor()
  setBuffer(audioBuffer)
  get currentTime(); get playing()
  play(fromTime?), pause(), toggle(), seek(time)
  setMetronome({ enabled, beats, downbeatSet /* Set of beat indices */ })   // scheduled clicks (look-ahead scheduler), accent on "1"
  playPreview(channels, sampleRate, startTimeOnTimeline)   // plays a rendered snippet (from renderEdit) and reports
                                                           // currentTime on the ORIGINAL timeline so the playhead is right
  stop()
}
```

## ANALYSIS details (the hard part)

Input: mono Float32Array at 22050 Hz (tests generate directly at 22050).

Suggested pipeline (the analysis agents may improve it if the benchmark proves it):
1. `features.js`: STFT (frame 1024–2048, hop 256 → ~86 fps), log-compressed filterbank (mel or log-frequency ~12–24 bands/octave,
   30 Hz–11 kHz), SuperFlux-style spectral flux (frequency max-filter on the reference frame, positive differences) → onset
   envelope; also a low-frequency (< ~200 Hz) onset envelope; per-frame 12-bin chroma (for harmonic change); RMS envelope.
   Soft-onset material (piano/guitar/strings) must still produce usable onsets.
2. `tempo.js`: tempogram/autocorrelation with a log-normal prior (~120 BPM centre, wide) → global tempo + local tempo curve.
3. `beats.js`: beat tracking that tolerates tempo drift and ritardando: e.g. a DBN/HMM (madmom-style beat-pointer state space,
   Viterbi, tempo-change penalty) or Ellis DP with a time-varying period. Then refine each beat to the nearest real transient
   (±~40 ms, high-resolution energy rise) when one exists.
4. Music bounds: `musicStart`/`musicEnd` from short-term RMS relative to the peak (e.g. −50 dB); no beats in leading/trailing
   silence. `lastOnset` = last significant onset before `musicEnd` (final hit). Beats may continue through a ringing final chord
   up to `musicEnd` (they are real musical time) but do not extrapolate into silence.
5. `downbeats.js`: beat-synchronous features (harmonic/chroma change into the beat, low-frequency onset at the beat, onset
   strength, loudness) → HMM over beats with states = position in bar, strong preference for regular bars, small probability of
   irregular bars (one beat shorter/longer) for live music; supports forced downbeats (hard constraints). Meter 'auto' chooses
   between 3 and 4 (biased to 4 unless 3 is clearly better); 2,5,6,7 only when the user picks them.
6. `analyze.js`: orchestrates, returns AnalysisResult; exports pure functions for tests:
   `computeFeatures`, `estimateTempo`, `trackBeats`, `labelBars`, `findMusicBounds`, `findLastOnset`, `analyze`.

Performance: a 5-minute song must analyse in < ~5 s in desktop Chrome (≈ Node speed) and not blow memory (use typed arrays,
don't keep full-resolution spectrograms longer than needed). Report timings.

Quality bar (on the synthetic benchmark, ±70 ms beat F-measure): ≥ 0.95 on steady band music, ≥ 0.9 with drift/jitter/live,
≥ 0.85 on no-drum piano/guitar material; correct octave (not ×2/÷2) on most cases; downbeat F ≥ 0.85 on band material;
the LAST bar (the one containing the final hit) must be identified correctly in the band + no-drum cases, because that is what the
user's "remove N bars" counts from.

## UI details (UI agent)

Mobile-first responsive single page. Light/dark via `prefers-color-scheme` (tokens on `:root`). Sections:

0. Header: app name "DJ Edit Cutter", tagline "Quita compases del final de una canción", privacy line "Tu música no sale de tu
   dispositivo: todo se procesa en el navegador."
1. File input: big drop zone ("Arrastra una canción aquí o toca para elegirla"), accepts `audio/*` + common extensions.
   Shows file name, duration, decoding/analysis progress with Spanish stage names (Leyendo archivo, Detectando notas,
   Calculando tempo, Buscando beats, Buscando compases). Errors in Spanish (format not supported, etc.).
2. Waveform (canvas, DPR-aware): overview strip of the whole song + zoomed main view (initially showing roughly the last 12–16
   bars before the end). Draw: waveform (min/max peaks from a mipmap), beat lines (thin), downbeat lines (thicker) with bar
   numbers, the cut marker (distinct colour, draggable handle; snaps to beats unless snap is off; Alt/Shift = free), the fade
   region (gradient), the removed region (dimmed/hatched with label "Se quita"), playhead. Click/tap on empty waveform = seek.
   Wheel/pinch = zoom around the pointer; drag/two-finger = pan; overview click = jump. Buttons: acercar / alejar / ver todo /
   ir al corte.
3. Info row: tempo "≈ 124 BPM (118–128)", compás "4/4", bars count, confidence badge; if low confidence: hint text.
4. "Revisa los compases": Play/Pause, "Clic de metrónomo" toggle (accent on 1), "Tempo ×2", "Tempo ÷2", beats-per-bar select
   (Auto, 2–7), "Mover el 1: ◀ ▶" (shift the downbeat nearest the cut by one beat using forcedDownbeats), "Este beat es el 1"
   (force the beat nearest the playhead), "Restablecer".
5. "Elige el corte": stepper "Compases a quitar" [−] N [+] with chips 1 2 4 8 16 32; readout "Corte en 3:41.25 · la canción pasa
   de 3:52 a 3:41"; nudge buttons (beat ◀ ▶, compás ◀ ▶, ±10 ms), snap toggle "Imán a los beats".
6. "Final": fade slider in BEATS (0, ½, 1, 2, 4, 8, 16 — show equivalent seconds), curve select (Lineal / Suave / Exponencial);
   button "Escuchar el final" (plays ~8 s before the cut with the fade applied).
7. "Guardar": format radio WAV (16 / 24 bits) / MP3 (320 / 256 / 192 kbps), checkbox "Conservar etiquetas (título, artista,
   carátula)" (enabled when the source had ID3), "Descargar" with progress; file name from suggestFileName.
Keyboard: Space play/pause; ←/→ move cut by a beat; Shift+←/→ by a bar; + / − zoom; M metronome; P preview.
Accessibility: real buttons/labels, focus styles, aria-live for status messages, 44px touch targets, no horizontal scroll at 360 px.
