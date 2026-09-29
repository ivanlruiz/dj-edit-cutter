// Tracker de referencia trivial para probar el benchmark: rejilla de tempo fijo alineada en fase con la
// envolvente de onsets. No sigue derivas ni ritardandos (sirve de piso de comparación).
import { estimateTempo } from '../js/analysis/tempo.js';

export function trackBeats(features, opts = {}) {
  const { fps, onset, numFrames } = features;
  const tempo = opts.tempo || estimateTempo(features, { minBpm: opts.minBpm, maxBpm: opts.maxBpm });
  const bpm = tempo.bpm;
  const period = (60 * fps) / bpm;
  const f0 = Math.max(0, Math.floor((opts.musicStart ?? 0) * fps));
  const f1 = Math.min(numFrames - 1, Math.ceil((opts.musicEnd ?? features.duration) * fps));
  // fase que maximiza la suma de la envolvente sobre la rejilla (con resolución de 1/4 de trama)
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let ph = 0; ph < period; ph += 0.25) {
    let s = 0;
    for (let t = f0 + ph; t <= f1; t += period) {
      const i = Math.round(t);
      s += onset[i] + 0.5 * (onset[i - 1] || 0) + 0.5 * (onset[i + 1] || 0);
    }
    if (s > bestScore) {
      bestScore = s;
      bestPhase = ph;
    }
  }
  const beats = [];
  for (let t = f0 + bestPhase; t <= f1; t += period) beats.push(t / fps);
  return { beats, bpm };
}
