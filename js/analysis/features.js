// Extracción de características para el análisis rítmico (puro, sin DOM).
//
// Convención de tiempo: tramas CENTRADAS. La trama i está centrada en la muestra i*hop (se rellena con ceros
// frameSize/2 a cada lado), así que time(i) = i * hop / sampleRate y frameOf(t) = round(t * sampleRate / hop).
//
// @typedef {object} Features
// @property {number} version      FEATURES_VERSION
// @property {number} sampleRate   Hz de la entrada (normalmente 22050)
// @property {number} hop          muestras entre tramas (256)
// @property {number} frameSize    muestras por trama del espectro (1024, ventana de Hann)
// @property {number} fps          tramas por segundo = sampleRate / hop (≈ 86.13)
// @property {number} numFrames    floor(samples.length / hop) + 1
// @property {number} duration     s = samples.length / sampleRate
// @property {number} peak         pico absoluto de la entrada (la señal se normaliza a pico 1 antes del espectro)
// @property {Float32Array} onset  flujo espectral tipo SuperFlux (≥ 0), dividido por su percentil 99:
//                                 ~1 % de las tramas supera 1; golpes fuertes ≈ 1–3, ruido de fondo ≈ 0.01–0.05
//                                 (≈ 0.2–0.4 en material sostenido: pads, cuerdas)
// @property {Float32Array} onsetLow  lo mismo sólo con bandas < 200 Hz (bombo/bajo), dividido por SU percentil 99
// @property {number} onsetScale      divisor aplicado a onset (unidades brutas: suma de log10 por banda)
// @property {number} onsetLowScale   divisor aplicado a onsetLow (compara onsetLow*onsetLowScale con onset*onsetScale)
// @property {number} numBands, numLowBands   bandas del banco log-frecuencia (≈125) y cuántas son < 200 Hz
// @property {Float32Array} chroma numFrames*12, fila i = chroma[i*12 .. i*12+11] (clase 0 = Do, 9 = La);
//                                 máximo de cada trama = 1 (0 en tramas a < -60 dB de la más fuerte);
//                                 calculado con ventana de 2048 y salto hop*4, interpolado linealmente a cada trama
// @property {Float32Array} rms    RMS por trama sin ventana sobre [i*hop - frameSize/2, i*hop + frameSize/2),
//                                 en la escala ORIGINAL de la señal (no normalizada)
import { getRealFFT, hannWindow } from './fft.js';

export const FEATURES_VERSION = 1;

export const FEATURE_DEFAULTS = {
  frameSize: 1024, // ~46 ms a 22050 Hz
  hop: 256, // ~11.6 ms (≈ 86.13 tramas/s a 22050 Hz)
  bandsPerOctave: 24,
  fmin: 30,
  fmax: 11000,
  lowCutoff: 200, // Hz: bandas incluidas en onsetLow
  logMul: 1, // compresión log10(1 + logMul * |X|) sobre señal normalizada a pico 1
  maxFilterBands: 3, // filtro de máximo en frecuencia (SuperFlux) sobre la trama de referencia
  lag: 1, // tramas entre la trama actual y la de referencia
  refFrames: 3, // la referencia es el máximo de estas tramas (terminando en i-lag): menos flujo espurio en sonidos sostenidos
  chromaFrameSize: 2048, // ~93 ms
  chromaHopFactor: 4, // salto del croma = hop * chromaHopFactor (~46 ms)
  chromaFmin: 100,
  chromaFmax: 4000,
  normQuantile: 0.99, // onset y onsetLow se dividen por este cuantil
  whitenTau: 1, // s; >0 activa el blanqueo por banda de la diferencia (atenúa bandas que fluctúan siempre)
  whitenFloor: 0.02, // unidades log10: fluctuación típica por debajo de esto no atenúa
};

/** Filtros triangulares log-frecuencia con bins únicos (estilo madmom), normalizados en área. */
function buildLogFilterbank(fftSize, sampleRate, { bandsPerOctave, fmin, fmax }) {
  const binHz = sampleRate / fftSize;
  const nBins = fftSize / 2 + 1;
  const top = Math.min(fmax, sampleRate / 2);
  const bins = [];
  for (let j = 0; ; j++) {
    const f = fmin * Math.pow(2, j / bandsPerOctave);
    if (f > top) break;
    const b = Math.round(f / binHz);
    if (b >= 1 && b < nBins && (bins.length === 0 || bins[bins.length - 1] !== b)) bins.push(b);
  }
  const filters = [];
  for (let k = 1; k + 1 < bins.length; k++) {
    const lo = bins[k - 1];
    const c = bins[k];
    const hi = bins[k + 1];
    // triángulo [lo, c, hi) con pico en c; si es muy estrecho queda un solo bin
    const start = c - lo > 1 ? lo + 1 : c;
    const stop = hi - c > 1 ? hi - 1 : c;
    const w = new Float32Array(stop - start + 1);
    for (let b = start; b <= stop; b++) {
      w[b - start] = b <= c ? (c === lo ? 1 : (b - lo) / (c - lo)) : (hi === c ? 1 : (hi - b) / (hi - c));
    }
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i];
    for (let i = 0; i < w.length; i++) w[i] /= s;
    filters.push({ start, weights: w, centerHz: c * binHz });
  }
  return filters;
}

/** Mapa bin -> clase de altura con peso triangular (1 en el centro del semitono, 0 a ±½ semitono). */
function buildChromaMap(fftSize, sampleRate, fmin, fmax) {
  const binHz = sampleRate / fftSize;
  const b0 = Math.max(1, Math.ceil(fmin / binHz));
  const b1 = Math.min(fftSize / 2, Math.floor(fmax / binHz));
  const pc = new Uint8Array(b1 - b0 + 1);
  const w = new Float32Array(b1 - b0 + 1);
  for (let b = b0; b <= b1; b++) {
    const p = 69 + 12 * Math.log2((b * binHz) / 440);
    const r = Math.round(p);
    pc[b - b0] = ((r % 12) + 12) % 12;
    w[b - b0] = Math.max(0, 1 - 2 * Math.abs(p - r));
  }
  return { b0, b1, pc, w };
}

function quantile(arr, q) {
  const n = arr.length;
  if (!n) return 0;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
}

/**
 * Calcula las características de una señal mono.
 * @param {Float32Array} samples mono
 * @param {number} sampleRate normalmente 22050
 * @param {object} [opts] ver FEATURE_DEFAULTS (los valores por defecto son los evaluados en el benchmark)
 * @returns {Features} ver el typedef al principio del archivo
 */
export function computeFeatures(samples, sampleRate, opts = {}) {
  const o = { ...FEATURE_DEFAULTS, ...opts };
  const { frameSize, hop, lag } = o;
  const n = samples.length;
  const numFrames = Math.floor(n / hop) + 1;
  const half = frameSize / 2;

  // normalización de nivel: la compresión log no depende del volumen de la grabación
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  const gain = peak > 0 ? 1 / peak : 1;

  const fft = getRealFFT(frameSize);
  const win = hannWindow(frameSize);
  const frame = new Float64Array(frameSize);
  const mag = new Float64Array(frameSize / 2 + 1);
  const filters = buildLogFilterbank(frameSize, sampleRate, o);
  const nb = filters.length;
  let nLow = 0;
  while (nLow < nb && filters[nLow].centerHz < o.lowCutoff) nLow++;

  const onset = new Float32Array(numFrames);
  const onsetLow = new Float32Array(numFrames);
  const rms = new Float32Array(numFrames);
  // anillo de espectros log filtrados (sólo lag+1 tramas en memoria)
  const refFrames = Math.max(1, o.refFrames | 0);
  const R = lag + refFrames;
  const ring = Array.from({ length: R }, () => new Float32Array(nb));
  const refT = new Float32Array(nb);
  const refMax = new Float32Array(nb);
  const mfr = Math.floor(o.maxFilterBands / 2);
  const logMul = o.logMul;
  const wTau = o.whitenTau;
  const wFloor = o.whitenFloor;
  const wA = wTau > 0 ? Math.exp(-hop / sampleRate / wTau) : 0;
  const fluct = new Float32Array(nb);

  // banco de filtros aplanado (acceso rápido)
  const fbStart = new Int32Array(nb);
  const fbLen = new Int32Array(nb);
  const fbOff = new Int32Array(nb);
  let totalW = 0;
  for (let f = 0; f < nb; f++) {
    fbStart[f] = filters[f].start;
    fbLen[f] = filters[f].weights.length;
    fbOff[f] = totalW;
    totalW += fbLen[f];
  }
  const fbW = new Float32Array(totalW);
  for (let f = 0; f < nb; f++) fbW.set(filters[f].weights, fbOff[f]);
  const LOG10E = Math.LOG10E;
  const re = fft.re;
  const im = fft.im;

  for (let i = 0; i < numFrames; i++) {
    const c = i * hop;
    const s0 = c - half;
    let sq = 0;
    if (s0 >= 0 && s0 + frameSize <= n) {
      for (let k = 0; k < frameSize; k++) {
        const v = samples[s0 + k];
        sq += v * v;
        frame[k] = v * gain * win[k];
      }
    } else {
      for (let k = 0; k < frameSize; k++) {
        const idx = s0 + k;
        const v = idx >= 0 && idx < n ? samples[idx] : 0;
        sq += v * v;
        frame[k] = v * gain * win[k];
      }
    }
    rms[i] = Math.sqrt(sq / frameSize);
    fft.forward(frame);
    for (let k = 0; k <= half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const cur = ring[i % R];
    for (let f = 0; f < nb; f++) {
      let s = 0;
      const off = fbOff[f];
      const st = fbStart[f];
      const len = fbLen[f];
      for (let k = 0; k < len; k++) s += fbW[off + k] * mag[st + k];
      cur[f] = LOG10E * Math.log(1 + logMul * s);
    }
    if (i >= lag) {
      // referencia: máximo de las tramas i-lag-(refFrames-1) .. i-lag
      let ref = ring[(i - lag) % R];
      if (refFrames > 1) {
        refT.set(ref);
        for (let q = 1; q < refFrames && i - lag - q >= 0; q++) {
          const r2 = ring[(i - lag - q) % R];
          for (let f = 0; f < nb; f++) if (r2[f] > refT[f]) refT[f] = r2[f];
        }
        ref = refT;
      }
      // filtro de máximo en frecuencia sobre la referencia (suprime vibrato)
      for (let f = 0; f < nb; f++) {
        let m = ref[f];
        for (let d = 1; d <= mfr; d++) {
          if (f - d >= 0 && ref[f - d] > m) m = ref[f - d];
          if (f + d < nb && ref[f + d] > m) m = ref[f + d];
        }
        refMax[f] = m;
      }
      let sum = 0;
      let sumLow = 0;
      for (let f = 0; f < nb; f++) {
        let d = cur[f] - refMax[f];
        if (wTau > 0) {
          // blanqueo: divide por la fluctuación típica reciente de la banda
          const ad = Math.abs(cur[f] - ref[f]);
          const sc = wFloor / (wFloor + fluct[f]);
          fluct[f] = wA * fluct[f] + (1 - wA) * ad;
          d *= sc;
        }
        if (d > 0) {
          sum += d;
          if (f < nLow) sumLow += d;
        }
      }
      onset[i] = sum;
      onsetLow[i] = sumLow;
    }
  }

  const onsetScale = Math.max(1e-9, quantile(onset, o.normQuantile));
  const onsetLowScale = Math.max(1e-9, quantile(onsetLow, o.normQuantile));
  for (let i = 0; i < numFrames; i++) {
    onset[i] /= onsetScale;
    onsetLow[i] /= onsetLowScale;
  }

  const chroma = computeChroma(samples, sampleRate, gain, numFrames, o);

  return {
    version: FEATURES_VERSION,
    sampleRate,
    hop,
    frameSize,
    fps: sampleRate / hop,
    numFrames,
    duration: n / sampleRate,
    peak,
    onset,
    onsetLow,
    onsetScale,
    onsetLowScale,
    numBands: nb,
    numLowBands: nLow,
    chroma,
    rms,
  };
}

/** Croma a salto hop*chromaHopFactor con ventana larga, interpolado linealmente a la rejilla de tramas. */
function computeChroma(samples, sampleRate, gain, numFrames, o) {
  const N = o.chromaFrameSize;
  const hopC = o.hop * o.chromaHopFactor;
  const n = samples.length;
  const nC = Math.floor(n / hopC) + 1;
  const fft = getRealFFT(N);
  const win = hannWindow(N);
  const frame = new Float64Array(N);
  const map = buildChromaMap(N, sampleRate, o.chromaFmin, o.chromaFmax);
  const cC = new Float32Array(nC * 12);
  const energy = new Float32Array(nC);
  const half = N / 2;
  let maxE = 0;
  for (let j = 0; j < nC; j++) {
    const s0 = j * hopC - half;
    for (let k = 0; k < N; k++) {
      const idx = s0 + k;
      frame[k] = idx >= 0 && idx < n ? samples[idx] * gain * win[k] : 0;
    }
    fft.forward(frame);
    const re = fft.re;
    const im = fft.im;
    const acc = new Float64Array(12);
    let e = 0;
    for (let b = map.b0; b <= map.b1; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      const i = b - map.b0;
      acc[map.pc[i]] += map.w[i] * m;
      e += m;
    }
    energy[j] = e;
    if (e > maxE) maxE = e;
    let mx = 0;
    for (let p = 0; p < 12; p++) if (acc[p] > mx) mx = acc[p];
    if (mx > 0) for (let p = 0; p < 12; p++) cC[j * 12 + p] = acc[p] / mx;
  }
  // tramas prácticamente silenciosas (< -60 dB de la más fuerte) => croma 0
  const th = maxE * 1e-3;
  for (let j = 0; j < nC; j++) if (energy[j] < th) cC.fill(0, j * 12, j * 12 + 12);
  const chroma = new Float32Array(numFrames * 12);
  const r = o.chromaHopFactor;
  for (let i = 0; i < numFrames; i++) {
    const j = Math.floor(i / r);
    const f = (i - j * r) / r;
    const j1 = Math.min(nC - 1, j + 1);
    for (let p = 0; p < 12; p++) chroma[i * 12 + p] = (1 - f) * cC[j * 12 + p] + f * cC[j1 * 12 + p];
  }
  return chroma;
}

export function frameTime(features, i) {
  return (i * features.hop) / features.sampleRate;
}

export function timeToFrame(features, t) {
  return Math.max(0, Math.min(features.numFrames - 1, Math.round((t * features.sampleRate) / features.hop)));
}

/**
 * Selección de picos estilo madmom sobre una envolvente (p. ej. features.onset).
 * Pico en i si env[i] es el máximo en [i-preMax, i+postMax] y env[i] >= media([i-preAvg, i+postAvg]) + threshold.
 * Luego se combinan picos a menos de `combine` s (se queda el primero).
 * @returns {number[]} índices de trama
 */
export function pickPeaks(env, fps, { threshold = 0.02, relThreshold = 1, preMax = 0.03, postMax = 0.03, preAvg = 0.1, postAvg = 0.07, combine = 0.03, minValue = 0 } = {}) {
  const n = env.length;
  const pM = Math.max(0, Math.round(preMax * fps));
  const qM = Math.max(0, Math.round(postMax * fps));
  const pA = Math.max(0, Math.round(preAvg * fps));
  const qA = Math.max(0, Math.round(postAvg * fps));
  const comb = combine * fps;
  // media móvil con sumas acumuladas
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + env[i];
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = env[i];
    if (v <= minValue) continue;
    let isMax = true;
    for (let k = Math.max(0, i - pM); k <= Math.min(n - 1, i + qM); k++) {
      if (env[k] > v || (env[k] === v && k < i)) { isMax = false; break; }
    }
    if (!isMax) continue;
    const a = Math.max(0, i - pA);
    const b = Math.min(n - 1, i + qA);
    const mean = (cs[b + 1] - cs[a]) / (b - a + 1);
    if (v < mean * (1 + relThreshold) + threshold) continue;
    if (i - last <= comb) continue;
    out.push(i);
    last = i;
  }
  return out;
}

/** Onsets (s) por selección de picos sobre features.onset. */
export function detectOnsets(features, opts = {}) {
  const idx = pickPeaks(features.onset, features.fps, opts);
  return idx.map((i) => (i * features.hop) / features.sampleRate);
}
