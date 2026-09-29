// Estimación de tempo global y local a partir de la envolvente de onsets (puro, sin DOM).
import { getComplexFFT, nextPow2 } from './fft.js';

export const TEMPO_DEFAULTS = {
  minBpm: 50,
  maxBpm: 220,
  priorCenter: 115, // BPM, centro del prior log-normal
  priorSigma: 1.2, // octavas
  windowSec: 8, // ventana de la autocorrelación local
  hopSec: 1, // salto entre ventanas
  localRange: 0.45, // el tempo local puede apartarse ±45 % (en log) del global
  localPenalty: 18, // penalización de cambio de tempo entre ventanas (por unidad de log2)
  strictRange: [0.8, 1.25], // con strict=true el tempo queda en [0.8, 1.25] × bpmHint
  w2: 0.5,
  w4: 0.25,
  method: 'hybrid', // 'acf' | 'hybrid' (ACF × espectro de modulación: reduce errores de octava)
  dftPower: 0.25,
};

/** Envolvente para periodicidad: onset menos su media local, rectificada. */
export function periodicityEnvelope(features, smoothSec = 0.5) {
  const { onset, onsetLow, fps } = features;
  const n = onset.length;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = onset[i] + 0.5 * (onsetLow ? onsetLow[i] : 0);
  const w = Math.max(1, Math.round((smoothSec * fps) / 2));
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + e[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n - 1, i + w);
    const m = (cs[b + 1] - cs[a]) / (b - a + 1);
    const v = e[i] - m;
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/**
 * Autocorrelaciones por ventanas (tempograma). Cada fila está normalizada por su energía (lag 0) y corregida
 * por el sesgo (W/(W-L)). Filas de ventanas casi silenciosas quedan a 0.
 * @returns {{ rows: Float32Array[], centers: number[] (tramas), maxLag: number }}
 */
export function tempogram(env, fps, { windowSec = 8, hopSec = 1, maxLag, maxSpecHz = 8 }) {
  const n = env.length;
  const W = Math.min(n, Math.max(16, Math.round(windowSec * fps)));
  const H = Math.max(1, Math.round(hopSec * fps));
  const size = nextPow2(2 * W);
  const fft = getComplexFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const L = Math.min(maxLag, W - 1);
  const rows = [];
  const specs = [];
  const nSpec = Math.min(size / 2, Math.ceil((maxSpecHz * size) / fps) + 2);
  const centers = [];
  let totalE = 0;
  for (let i = 0; i < n; i++) totalE += env[i] * env[i];
  const meanE = totalE / Math.max(1, n);
  for (let s = 0; ; s += H) {
    const start = Math.min(s, Math.max(0, n - W));
    re.fill(0);
    im.fill(0);
    let e0 = 0;
    for (let i = 0; i < W && start + i < n; i++) {
      const v = env[start + i];
      re[i] = v;
      e0 += v * v;
    }
    const row = new Float32Array(L + 1);
    const spec = new Float32Array(nSpec);
    if (e0 > 1e-3 * meanE * W && e0 > 0) {
      fft.transform(re, im, false);
      for (let k = 0; k < size; k++) {
        re[k] = re[k] * re[k] + im[k] * im[k];
        im[k] = 0;
      }
      // espectro de modulación (magnitud normalizada por la energía de la ventana)
      for (let k = 0; k < nSpec; k++) spec[k] = Math.sqrt(re[k] / e0);
      fft.transform(re, im, true);
      const r0 = re[0];
      for (let l = 0; l <= L; l++) row[l] = (re[l] / r0) * (W / (W - l));
    }
    rows.push(row);
    specs.push(spec);
    centers.push(start + W / 2);
    if (start + W >= n) break;
  }
  return { rows, specs, specSize: size, centers, maxLag: L, window: W };
}

function lagToBpm(lag, fps) {
  return (60 * fps) / lag;
}

/** Interpolación parabólica del máximo alrededor de i. Devuelve [posición, valor]. */
function parabolic(arr, i) {
  if (i <= 0 || i >= arr.length - 1) return [i, arr[i]];
  const a = arr[i - 1];
  const b = arr[i];
  const c = arr[i + 1];
  const d = a - 2 * b + c;
  if (d >= 0) return [i, b];
  const p = (0.5 * (a - c)) / d;
  return [i + p, b - 0.25 * (a - c) * p];
}

/** Valor de la ACF en un retardo fraccional (interpolación lineal). */
function acfAt(acf, lag) {
  const i = Math.floor(lag);
  if (i < 0 || i + 1 >= acf.length) return 0;
  const f = lag - i;
  return acf[i] * (1 - f) + acf[i + 1] * f;
}

/** Saliencia por retardo: ACF en L más los múltiplos 2L y 4L (refuerza el pulso, no sus subdivisiones). */
function salience(acf, lag, w2 = 0.5, w4 = 0.25) {
  return acfAt(acf, lag) + w2 * acfAt(acf, 2 * lag) + w4 * acfAt(acf, 4 * lag);
}

function logPrior(bpm, center, sigma) {
  const x = Math.log2(bpm / center) / sigma;
  return Math.exp(-0.5 * x * x);
}

/**
 * Estima el tempo global y la curva de tempo local.
 * Método: envolvente = onset + 0.5·onsetLow menos su media móvil (0.5 s), rectificada; autocorrelaciones en ventanas
 * de 8 s (salto 1 s); saliencia(L) = [ACF(L) + 0.5·ACF(2L) + 0.25·ACF(4L)] × DFT(1/L)^0.25 × prior log-normal
 * (centro 115 BPM, σ = 1.2 octavas). Con bpmHint (sin strict) el prior se centra en bpmHint con σ = 0.5 octavas;
 * con bpmHint + strict la búsqueda se limita a [0.8, 1.25] × bpmHint.
 * @param {object} features resultado de computeFeatures
 * @param {{minBpm?:number, maxBpm?:number, bpmHint?:number, strict?:boolean}} opts
 * @returns {{ bpm:number, candidates: {bpm:number, score:number}[], localBpm: Float32Array, globalAcf: Float32Array,
 *   globalDft: Float32Array, lagRange:[number,number] }}
 *   bpm sin redondear; candidates ordenados por score (el primero = 1, máx. 8, sin duplicados a < 2 %);
 *   localBpm: una entrada por trama de features (Viterbi sobre ventanas cerca del tempo global, ±45 %, interpolado).
 */
export function estimateTempo(features, opts = {}) {
  const o = { ...TEMPO_DEFAULTS, ...opts };
  const fps = features.fps;
  let minBpm = o.minBpm;
  let maxBpm = o.maxBpm;
  const hint = o.bpmHint > 0 ? o.bpmHint : null;
  if (hint && o.strict) {
    minBpm = Math.max(20, hint * o.strictRange[0]);
    maxBpm = Math.min(400, hint * o.strictRange[1]);
  }
  const env = periodicityEnvelope(features);
  const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm));
  const maxLagSearch = Math.ceil((60 * fps) / minBpm);
  // necesitamos hasta 4× el retardo más largo para la saliencia; y ±45 % para el tempo local
  const acfMaxLag = Math.ceil(maxLagSearch * 4 + 2);
  const tg = tempogram(env, fps, { windowSec: Math.max(o.windowSec, (acfMaxLag / fps) * 1.25), hopSec: o.hopSec, maxLag: acfMaxLag });
  const L = tg.maxLag;
  const globalAcf = new Float32Array(L + 1);
  let nRows = 0;
  for (const row of tg.rows) {
    if (row[0] <= 0) continue;
    nRows++;
    for (let l = 0; l <= L; l++) globalAcf[l] += row[l];
  }
  if (nRows) for (let l = 0; l <= L; l++) globalAcf[l] /= nRows;
  const nSpec = tg.specs.length ? tg.specs[0].length : 0;
  const globalDft = new Float32Array(nSpec);
  for (let w = 0; w < tg.rows.length; w++) {
    if (tg.rows[w][0] <= 0) continue;
    for (let k = 0; k < nSpec; k++) globalDft[k] += tg.specs[w][k];
  }
  if (nRows) for (let k = 0; k < nSpec; k++) globalDft[k] /= nRows;
  // valor del espectro de modulación en la frecuencia del retardo (bin = size / lag)
  const dftAt = (lag) => {
    const x = tg.specSize / lag;
    const i = Math.floor(x);
    if (i + 1 >= nSpec) return 0;
    const f = x - i;
    return globalDft[i] * (1 - f) + globalDft[i + 1] * f;
  };

  // saliencia por retardo con prior
  const sal = new Float32Array(maxLagSearch + 2);
  for (let lag = minLag; lag <= Math.min(maxLagSearch + 1, L); lag++) {
    const bpm = lagToBpm(lag, fps);
    const prior = hint && !o.strict ? logPrior(bpm, hint, 0.5) : logPrior(bpm, o.priorCenter, o.priorSigma);
    const a = Math.max(0, salience(globalAcf, lag, o.w2, o.w4));
    sal[lag] = (o.method === 'acf' ? a : a * Math.pow(dftAt(lag), o.dftPower)) * prior;
  }
  // candidatos: máximos locales
  const cands = [];
  for (let lag = Math.max(minLag, 1); lag <= Math.min(maxLagSearch, sal.length - 2); lag++) {
    if (sal[lag] > 0 && sal[lag] >= sal[lag - 1] && sal[lag] >= sal[lag + 1]) {
      const [p, v] = parabolic(sal, lag);
      const bpm = lagToBpm(p, fps);
      if (bpm >= minBpm * 0.98 && bpm <= maxBpm * 1.02) cands.push({ lag: p, bpm, score: v });
    }
  }
  if (!cands.length) {
    const bpm = hint || o.priorCenter;
    return { bpm, candidates: [{ bpm, score: 0 }], localBpm: new Float32Array(features.numFrames).fill(bpm), globalAcf, globalDft, lagRange: [minLag, maxLagSearch] };
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0].score || 1;
  // precisión: afinar con los picos de la ACF en 1×, 2× y 4× el periodo
  const lagBest = refineLag(globalAcf, cands[0].lag);
  const bpm = lagToBpm(lagBest, fps);
  const candidates = [];
  for (const c of cands) {
    const b = round2(lagToBpm(refineLag(globalAcf, c.lag), fps));
    if (candidates.some((x) => Math.abs(x.bpm / b - 1) < 0.02)) continue;
    candidates.push({ bpm: b, score: c.score / top });
    if (candidates.length >= 8) break;
  }

  const localBpm = localTempo(tg, fps, lagBest, features.numFrames, o);
  return {
    bpm,
    candidates,
    localBpm,
    globalAcf,
    globalDft,
    lagRange: [minLag, maxLagSearch],
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** Afinado del periodo usando el pico en 2× y 4× el retardo (más resolución relativa). */
function refineLag(acf, lag) {
  let est = [];
  for (const m of [1, 2, 4]) {
    const target = lag * m;
    const i = Math.round(target);
    if (i + 2 >= acf.length) break;
    // máximo local en ±max(1, 4 % del retardo)
    const r = Math.max(1, Math.round(target * 0.04));
    let bi = i;
    for (let k = Math.max(1, i - r); k <= Math.min(acf.length - 2, i + r); k++) if (acf[k] > acf[bi]) bi = k;
    const [p, v] = parabolic(acf, bi);
    if (v > 0) est.push([p / m, v * m]);
  }
  if (!est.length) return lag;
  // media ponderada (los múltiplos pesan más: más resolución)
  let s = 0;
  let w = 0;
  for (const [l, v] of est) {
    s += l * v;
    w += v;
  }
  return s / w;
}

/** Tempo local por ventana con Viterbi (continuidad) cerca del periodo global; interpolado a cada trama. */
function localTempo(tg, fps, lagGlobal, numFrames, o) {
  const rows = tg.rows;
  const nW = rows.length;
  const out = new Float32Array(numFrames);
  const lagMin = Math.max(2, Math.floor(lagGlobal * Math.pow(2, -o.localRange)));
  const lagMax = Math.min(tg.maxLag - 1, Math.ceil(lagGlobal * Math.pow(2, o.localRange)));
  if (nW === 0 || lagMax <= lagMin) return out.fill(lagToBpm(lagGlobal, fps));
  const nS = lagMax - lagMin + 1;
  const logLag = new Float64Array(nS);
  for (let s = 0; s < nS; s++) logLag[s] = Math.log2(lagMin + s);
  const score = new Float64Array(nS);
  const prev = new Float64Array(nS);
  const back = rows.map(() => new Int32Array(nS));
  const obs = (row, lag) => {
    if (row[0] <= 0) return 0;
    const v = row[lag] + 0.5 * (2 * lag <= tg.maxLag ? row[2 * lag] : 0);
    return Math.max(0, v);
  };
  const lg0 = Math.log2(lagGlobal);
  for (let s = 0; s < nS; s++) prev[s] = obs(rows[0], lagMin + s) - 2 * Math.abs(logLag[s] - lg0);
  for (let w = 1; w < nW; w++) {
    for (let s = 0; s < nS; s++) {
      let bestV = -Infinity;
      let bestK = s;
      // transiciones limitadas a ±8 % por ventana
      const kr = Math.max(1, Math.round((lagMin + s) * 0.08));
      for (let k = Math.max(0, s - kr); k <= Math.min(nS - 1, s + kr); k++) {
        const v = prev[k] - o.localPenalty * Math.abs(logLag[s] - logLag[k]);
        if (v > bestV) { bestV = v; bestK = k; }
      }
      score[s] = bestV + obs(rows[w], lagMin + s) - 0.3 * Math.abs(logLag[s] - lg0);
      back[w][s] = bestK;
    }
    prev.set(score);
  }
  let s = 0;
  for (let k = 1; k < nS; k++) if (prev[k] > prev[s]) s = k;
  const path = new Float64Array(nW);
  for (let w = nW - 1; w >= 0; w--) {
    path[w] = lagMin + s;
    if (w > 0) s = back[w][s];
  }
  // afinado parabólico por ventana y suavizado (mediana de 3)
  const bpmW = new Float64Array(nW);
  for (let w = 0; w < nW; w++) {
    const row = rows[w];
    const l = path[w];
    const [p] = row[0] > 0 ? parabolic(row, l) : [l];
    bpmW[w] = lagToBpm(Math.abs(p - l) <= 1 ? p : l, fps);
  }
  const sm = new Float64Array(nW);
  for (let w = 0; w < nW; w++) {
    const a = bpmW[Math.max(0, w - 1)];
    const b = bpmW[w];
    const c = bpmW[Math.min(nW - 1, w + 1)];
    sm[w] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  const centers = tg.centers;
  let w = 0;
  for (let i = 0; i < numFrames; i++) {
    while (w + 1 < nW && centers[w + 1] <= i) w++;
    if (i <= centers[0]) out[i] = sm[0];
    else if (w + 1 >= nW) out[i] = sm[nW - 1];
    else {
      const f = (i - centers[w]) / (centers[w + 1] - centers[w]);
      out[i] = sm[w] * (1 - f) + sm[w + 1] * f;
    }
  }
  return out;
}
