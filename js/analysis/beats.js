// Seguidor de beats definitivo (puro, sin DOM).
//
// Se usa el tracker de programación dinámica con tempo variable (beats-dp.js). Elegido con el benchmark
// (tools/bench.js + validación ampliada: suite oficial, 28 casos de estrés, 21 casos extra de compases y 5 clips
// reales): frente al tracker DBN acierta la octava en las canciones lentas (rock a 76, balada a 58, donde el DBN
// daba ×2), sigue mejor los cambios de tempo grandes (cuerdas reales) y, con un tempo indicado (botones ×2 / ÷2),
// recupera material sin ataques (pads, voz). La combinación de ambos (elegir por canción) no mejoró el corte.
//
// refineBeats() lleva cada beat al inicio real del ataque cercano (refineToTransients) sin dejar que un beat se
// retrase: el tracker coloca el beat en el pico de la envolvente de onsets, que llega 0–12 ms DESPUÉS del ataque,
// así que un "ataque" varios ms más tarde es casi siempre la nota siguiente (arpegios, rasgueos). Para el corte
// es más seguro caer un poco antes del golpe que dejar que suene su principio.
import { refineToTransients } from './bounds.js';

export { trackBeats, DP_DEFAULTS as BEAT_DEFAULTS } from './beats-dp.js';

export const REFINE_WINDOW = 0.03; // s: búsqueda del ataque a ±30 ms del beat
export const REFINE_MAX_LATER = 0.005; // s: como mucho 5 ms más tarde que el beat del tracker
const MIN_GAP = 0.001; // s entre beats consecutivos tras afinar

/**
 * Afina los beats al inicio del transitorio más cercano.
 * @param {Float32Array} samples señal mono (la misma del análisis)
 * @param {number} sampleRate
 * @param {number[]} beats tiempos (s) ascendentes
 * @param {object} [opts] { window, maxLater, musicStart, musicEnd } (musicStart/musicEnd acotan el resultado)
 * @returns {number[]} tiempos nuevos (misma longitud), estrictamente ascendentes
 */
export function refineBeats(samples, sampleRate, beats, opts = {}) {
  const src = Array.from(beats || []);
  if (!src.length || !samples || !samples.length || !(sampleRate > 0)) return src;
  const window = opts.window ?? REFINE_WINDOW;
  const maxLater = opts.maxLater ?? REFINE_MAX_LATER;
  const lo = Number.isFinite(opts.musicStart) ? opts.musicStart : 0;
  const hi = Number.isFinite(opts.musicEnd) ? opts.musicEnd : samples.length / sampleRate;
  const ref = refineToTransients(samples, sampleRate, src, { window });
  const out = ref.map((t, i) => {
    const v = Number.isFinite(t) && t - src[i] <= maxLater ? t : src[i];
    return Math.min(hi, Math.max(lo, v));
  });
  // orden estricto (dos beats no pueden caer en el mismo ataque)
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1] + MIN_GAP) out[i] = Math.max(src[i], out[i - 1] + MIN_GAP);
  }
  return out;
}
