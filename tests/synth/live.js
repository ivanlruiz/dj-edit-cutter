// Variantes "en directo" para el benchmark y los tests: aplausos (y ruido de sala) después del golpe final. La verdad
// rítmica no cambia (el aplauso empieza después del golpe final); el audio se alarga lo que dure el aplauso.
import { Rng } from './prng.js';

function rmsOf(x, a = 0, b = x.length) {
  let s = 0;
  const lo = Math.max(0, a);
  const hi = Math.min(x.length, b);
  for (let i = lo; i < hi; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, hi - lo));
}

/** Ruido rosa aproximado (filtro de Paul Kellet) con RMS 1. */
export function pinkNoise(n, rng) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  const out = new Float32Array(n);
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = v;
    s2 += v * v;
  }
  const r = Math.sqrt(s2 / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= r;
  return out;
}

/**
 * Palmas: ráfagas de ruido de 4–10 ms (paso alto suave, caída exponencial) con densidad `rate` por segundo entre t0
 * y t1, con subida de 0.6 s y bajada de 1.5 s. Sin escalar (el llamador ajusta el nivel).
 */
export function applauseClaps(n, sampleRate, t0, t1, rate, rng) {
  const out = new Float32Array(n);
  const count = Math.round((t1 - t0) * rate);
  for (let c = 0; c < count; c++) {
    const t = t0 + rng.next() * (t1 - t0);
    const env = Math.min(1, (t - t0) / 0.6) * Math.min(1, (t1 - t) / 1.5);
    const len = Math.round(sampleRate * (0.004 + 0.006 * rng.next()));
    const st = Math.round(t * sampleRate);
    const a = env * (0.5 + 0.5 * rng.next());
    let lp = 0;
    for (let i = 0; i < len && st + i < n; i++) {
      const w = rng.next() * 2 - 1;
      lp = 0.6 * lp + 0.4 * w;
      out[st + i] += a * (w - lp) * Math.exp(-i / (0.3 * len));
    }
  }
  return out;
}

/**
 * Directo: aplauso desde `delaySec` después del golpe final (truth.finalHit, o truth.lastOnset) durante `seconds` s,
 * a `applauseDb` dB respecto al RMS de la música, más ruido de sala rosa a `noiseDb` dB en toda la grabación.
 * @param {Float32Array} x señal mono
 * @param {number} sampleRate
 * @param {object} truth verdad del generador (musicStart, musicEnd, finalHit / lastOnset; sin ellos: todo el audio)
 * @returns {Float32Array} nueva (más larga si el aplauso pasa del final)
 */
export function addApplause(x, sampleRate, truth, { applauseDb = -14, delaySec = 1, seconds = 6, noiseDb = -40, rate = 260, seed = 7 } = {}) {
  const rng = new Rng(seed);
  const t = truth || {};
  const mStart = Number.isFinite(t.musicStart) ? t.musicStart : 0;
  const mEnd = Number.isFinite(t.musicEnd) ? t.musicEnd : x.length / sampleRate;
  const musicRms = rmsOf(x, Math.round(mStart * sampleRate), Math.round(mEnd * sampleRate)) || rmsOf(x) || 1e-3;
  const end = [t.finalHit, t.lastOnset, mEnd].find(Number.isFinite);
  const a0 = end + delaySec;
  const a1 = a0 + seconds;
  const n = Math.max(x.length, Math.ceil((a1 + 1.5) * sampleRate));
  const out = new Float32Array(n);
  out.set(x);
  if (Number.isFinite(noiseDb)) {
    const pn = pinkNoise(n, rng.fork('sala'));
    const g = musicRms * Math.pow(10, noiseDb / 20);
    for (let i = 0; i < n; i++) out[i] += g * pn[i];
  }
  const ap = applauseClaps(n, sampleRate, a0, a1, rate, rng.fork('palmas'));
  const ar = rmsOf(ap, Math.round((a0 + 1) * sampleRate), Math.round((a1 - 2) * sampleRate)) || 1;
  const ga = (musicRms * Math.pow(10, applauseDb / 20)) / ar;
  for (let i = 0; i < n; i++) out[i] += ga * ap[i];
  return out;
}

/**
 * Variantes con nombre para tools/bench.js (--variants). apply(samples, sampleRate, truth) -> Float32Array nueva.
 *   applause: aplauso a −14 dB del RMS de la música, 1 s después del golpe final, 6 s, con ruido de sala a −40 dB
 */
export const LIVE_VARIANTS = {
  applause: { description: 'aplauso a −14 dB, 1 s tras el golpe final', apply: (x, sr, truth) => addApplause(x, sr, truth) },
};
