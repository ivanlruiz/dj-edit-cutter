// Variantes de "masterización" para el benchmark: masters de la guerra del volumen (limitador brick-wall muy
// apretado, recorte duro). La verdad rítmica no cambia (mismos beats, compases y golpe final); sólo el audio.

/** Pico absoluto de la señal. */
function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Recorte duro: normaliza a pico 1, multiplica por `gain` y recorta a ±1 (×4 ≈ 12 dB, ×8 ≈ 18 dB de recorte).
 * @returns {Float32Array} nueva
 */
export function hardClip(x, gain = 4) {
  const p = peakOf(x) || 1;
  const k = gain / p;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * k;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/**
 * Limitador brick-wall con anticipación (tipo "L2"): normaliza a pico 1 (0 dBFS); la ganancia necesaria para que
 * ninguna muestra pase de `thresholdDb` se mantiene durante la anticipación, se suaviza (ataque = anticipación) y se
 * recupera con `releaseMs`; recorte final al umbral (pared de verdad) y ganancia de compensación hasta `ceilingDb`.
 * Con −12 dB todo lo que supera −12 dBFS se aplasta: la envolvente queda casi plana, como en un master moderno.
 * @returns {Float32Array} nueva
 */
export function brickwallLimit(x, sampleRate, { thresholdDb = -12, ceilingDb = -0.3, lookaheadMs = 3, releaseMs = 60 } = {}) {
  const n = x.length;
  const p = peakOf(x) || 1;
  const th = Math.pow(10, thresholdDb / 20);
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  // ganancia requerida por muestra
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]) / p;
    req[i] = a > th ? th / a : 1;
  }
  // mínimo en [i, i + L] (cola monótona)
  const held = new Float32Array(n);
  const dq = new Int32Array(n + 1);
  let h = 0;
  let t = 0;
  for (let j = n - 1; j >= 0; j--) {
    while (t > h && req[dq[t - 1]] >= req[j]) t--;
    dq[t++] = j;
    while (dq[h] > j + L) h++;
    held[j] = req[dq[h]];
  }
  // ataque suave: media móvil de L muestras hacia atrás (llega al mínimo cuando llega el pico)
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const out = new Float32Array(n);
  let acc = 0;
  let g = 1;
  const makeup = Math.pow(10, ceilingDb / 20) / th;
  for (let i = 0; i < n; i++) {
    acc += held[i];
    if (i >= L) acc -= held[i - L];
    const target = acc / Math.min(i + 1, L);
    g = target < g ? target : rel * g + (1 - rel) * target;
    let v = (x[i] / p) * g;
    if (v > th) v = th;
    else if (v < -th) v = -th;
    out[i] = v * makeup;
  }
  return out;
}

/**
 * Variantes con nombre. apply(samples, sampleRate) -> Float32Array nueva.
 *   limit12: limitador brick-wall a −12 dB + compensación (master "de la guerra del volumen")
 *   clip4 / clip8: recorte duro tras ×4 (12 dB) / ×8 (18 dB)
 */
export const MASTERING_VARIANTS = {
  limit12: { description: 'limitador brick-wall −12 dB + compensación', apply: (x, sr) => brickwallLimit(x, sr, { thresholdDb: -12 }) },
  clip4: { description: 'recorte duro ×4', apply: (x) => hardClip(x, 4) },
  clip8: { description: 'recorte duro ×8', apply: (x) => hardClip(x, 8) },
};
