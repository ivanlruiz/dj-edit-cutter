# DJ Edit Cutter — Mode 2: "Cambiar el compás" (meter change) — spec

Read SPEC.md first (same project, conventions and AnalysisResult). This file adds a SECOND feature requested by the user
after the first build started. The app ends up with two independent, combinable operations:

1. "Quitar compases del final" (SPEC.md) — cut at the start of bar (lastBar − N + 1) with a fade-out. N may be 0 (= off).
2. "Cambiar el compás" (this file) — turn e.g. a 4/4 song into 7/8, 3/4, 5/4 or any meter, over the WHOLE song, by removing
   (or repeating) the LAST part of every bar and splicing with short crossfades. No time-stretching: pieces of audio are
   removed/duplicated, like the popular "song X but in 7/8" edits.

User decisions (fixed): presets 7/8, 3/4, 5/4 plus a free meter; what gets removed/repeated is always the END of each bar
(the "1" stays intact); applies to the whole song.

## Musical model

- Source meter: M = result.beatsPerBar beats per bar; the beat is a quarter note (sourceDen = 4). UI shows "Original: M/4".
- Target meter: targetNum / targetDen, targetNum 1..32, targetDen ∈ {2, 4, 8, 16}.
- Grid unit u = 1 / lcm(sourceDen, targetDen) of a whole note. Units per beat k = lcm / sourceDen.
  Source bar length S = beatCount × k units (beatCount is per bar — irregular live bars have their own count).
  Target bar length T = targetNum × (lcm / targetDen) units. Δ = T − S.
  - 4/4 → 7/8: lcm 8, k 2, S 8, T 7, Δ −1 → remove the last eighth ("y" del 4) of each bar.
  - 4/4 → 3/4: k 1, S 4, T 3, Δ −1 → remove beat 4.
  - 4/4 → 5/4: Δ +1 → repeat beat 4 (| 1 2 3 4 4 |).
  - 4/4 → 15/16: k 4, S 16, T 15 → remove the last sixteenth.
- Δ < 0: remove the last |Δ| units of every transformed bar. Requires |Δ| ≤ S − 1 (at least one unit must stay), otherwise
  the plan returns an error (Spanish message: "Ese compás es demasiado corto para esta canción.").
- Δ > 0: the last Δ units of the bar are played again right after the bar (before the next downbeat). Requires Δ ≤ S,
  otherwise error ("Ese compás es demasiado largo: como máximo se puede duplicar el compás.").
- Δ = 0: no-op with an info message ("La canción ya está en ese compás.").
- Unit boundary times inside beat i are interpolated linearly between beats[i] and the next beat (for the last beat of a bar,
  the next downbeat). An optional snap callback may move each internal boundary (never the downbeats) to a nearby transient
  (±25 ms) — e.g. the "&" of a shuffle is not at the midpoint.
- Which bars are transformed: every bar that is complete, i.e. has a following downbeat, and ends at or before `limitTime`
  (limitTime = the Mode-1 cut time when Mode 1 is active, else the start of the last bar). Pickup beats before the first
  downbeat, the final bar (with the final hit / ring-out) and anything after limitTime are left untouched.
- Every splice point is placed CUT_PREROLL_SEC (0.004 s, same constant as edit.js) BEFORE its musical boundary so attacks
  stay intact.

## Modules and interfaces

### js/core/meter.js (pure, no DOM)

```js
export const METER_PRESETS = [ { num: 7, den: 8 }, { num: 3, den: 4 }, { num: 5, den: 4 } ]
export function describeMeterChange(beatsPerBar, targetNum, targetDen, sourceDen = 4)
  -> { unitsPerBeat, sourceUnits, targetUnits, delta, unitName /* 'corchea' | 'semicorchea' | 'negra' | 'blanca' ... */,
       text /* Spanish, e.g. "Se quita la última corchea de cada compás." / "Se repite el último tiempo de cada compás." */,
       error: string | null }
export function planMeterChange(result, { targetNum, targetDen, sourceDen = 4, limitTime = null,
                                          preroll = 0.004, snap = null /* (t:number) => number */ })
  -> { segments: Array<{ start, end }>,   // source seconds, in output order, covering the whole output (from 0 to the
                                          // end of the kept audio: limitTime if given, else result.duration)
       removed: Array<{ start, end }>,    // for drawing (hatched) — Δ < 0
       repeated: Array<{ start, end }>,   // for drawing — Δ > 0
       barsChanged: number, delta, unitsPerBeat, outputDuration, error: string | null, info: string | null }
export function sourceToOutputTime(segments, t) -> number | null   // null if t falls in removed audio
export function outputToSourceTime(segments, t) -> number
```

### js/audio/splice.js (pure, no DOM)

```js
export function renderSegments(channels, sampleRate, segments,
                               { crossfadeSec = 0.010, fadeOutSec = 0, curve = 'smooth' } = {}) -> Float32Array[]
  // Concatenates the source ranges. Sample indices = Math.round(t × sampleRate). Output length = Σ segment lengths
  // (crossfades never change the length). At each discontinuity (seg[i].end ≠ seg[i+1].start, > 1 sample apart) apply an
  // equal-power crossfade of crossfadeSec centred on the splice: A keeps playing past its end, B starts before its start,
  // clamped to the source bounds. Contiguous segments are copied without any processing (bit-exact).
  // Final fade-out over the last max(fadeOutSec, 0.005) s with the same curves as edit.js ('linear' | 'smooth' | 'exp').
  // Never mutates inputs. Mono/stereo/multichannel.
```

Mode 1 alone is `renderSegments(ch, sr, [{ start: 0, end: cutTime }], { fadeOutSec, curve })`, so the app can use one export
path for both modes.

## UI (added later on top of the Mode-1 UI)

- A section "Cambiar el compás" with an on/off switch (off by default), preset chips 7/8 · 3/4 · 5/4 · Otro (numerator +
  denominator inputs), the text from describeMeterChange, "Original: 4/4 → Nuevo: 7/8", a "Suavizado de empalmes" slider
  (5–40 ms, default 10 ms), bars affected count, and errors/info in Spanish.
- "Quitar compases del final" gets an on/off switch too (on by default) so either mode can be used alone or both together.
- Waveform: removed slices hatched in red, repeated slices marked in green, in every bar.
- "Escuchar" preview: render the output (fast: it's copying) and play from the output position corresponding to the playhead
  (sourceToOutputTime), or 8 s before the end when previewing the ending.
- Export applies both: segments = planMeterChange(..., { limitTime: mode1 ? cutTime : null }).segments, then
  renderSegments(..., { fadeOutSec: mode1 ? fade : 0 }). File name adds the meter, e.g. "Canción (7-8, edit -2 compases).mp3".

## Decisions after the engine was built (js/core/meter.js + js/audio/splice.js exist, 28 tests green)

- Crossfade vs preroll: the caller MUST pass `preroll: Math.max(CUT_PREROLL_SEC, crossfadeSec / 2)` to planMeterChange so
  a wide crossfade never reaches into the next attack (measured: with 40 ms and the plain 4 ms preroll, the next "1" bleeds
  into repeated beats). With this, output is bit-exact on all clicks at 10 ms and 40 ms.
- Default limit without Mode 1 = start of the bar containing the final hit (same rule as findLastBarIndex, duplicated in
  meter.js — the integration should import bars.js instead of the copy if it is equivalent).
- splice.js has its own private fadeGain; the integration should make edit.js and splice.js share ONE fadeGain (edit.js's)
  so both modes' fade-outs sound identical.
- Irregular live bars: each bar uses its own beat count (a 3-beat bar in 4/4→7/8 gets one eighth repeated).

## User decisions v2 (after trying v1 online)

- The user's MAIN intent is trimming EVERY bar ("que cada compás del tema se recorte, no solo el final"). So:
  - The per-bar operation is the PRIMARY feature: its section comes first after loading (right after the waveform/review
    controls), is ON by default, and is labelled in the user's words: "Recortar cada compás" (subtitle: "cambia el compás
    de la canción").
  - Selection is by AMOUNT trimmed from each bar, with the resulting meter shown: chips "½ tiempo (corchea) → 7/8",
    "1 tiempo → 3/4", "2 tiempos → 2/4", "¼ tiempo (semicorchea) → 15/16"; plus "Alargar: repetir el último tiempo → 5/4"
    and "Otro compás…" (free numerator/denominator). Labels must adapt to the song's detected meter (e.g. a 3/4 song:
    1 tiempo → 2/4, ½ tiempo → 5/8).
  - DEFAULT = ½ tiempo / última corchea (4/4 → 7/8).
  - "Quitar compases del final" stays available but is OFF by default and placed after it.
