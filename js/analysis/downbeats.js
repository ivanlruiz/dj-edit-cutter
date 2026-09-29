// Etiquetado de compases: posición de cada beat dentro del compás (0 = "1").
//
// 1. Características por beat (sincronizadas con los beats): subida del onset de graves (bombo/bajo), onset total,
//    cambio armónico hacia el beat (croma del tramo del beat frente al anterior, a 1 y 2 beats) y acento de nivel.
//    Se normalizan con media y desviación locales (±12 beats) para que la dinámica de la canción no pese.
// 2. Compás automático (3 o 4): fracción de varianza de esas características que explica un patrón que se repite
//    cada 3 o cada 4 beats, en ventanas de 24 beats (no depende de la fase ni de dónde esté el "1").
// 3. HMM sobre los beats: estado = posición en el compás; transiciones regulares con una probabilidad pequeña de
//    compás irregular (un beat menos, o uno más con posición === beatsPerBar) y una muy pequeña de reinicio
//    (compás de 2+ beats menos). La evidencia de "1" es una combinación lineal de las características; luego se
//    aprende por canción una plantilla por posición (entrenamiento Viterbi) y se vuelve a decodificar. Qué posición
//    es el "1" lo sigue decidiendo la evidencia a priori.
// 4. forcedDownbeats son restricciones duras (esos beats son "1"); con ellas los compases irregulares cuestan más
//    para que la rejilla se realinee alrededor en vez de esquivarlas.
// 5. confidence: separación de la evidencia de "1" frente a la mejor alternativa (en desviaciones típicas), su
//    significación, los compases irregulares y, si el compás es automático, su margen.

export const DOWNBEAT_DEFAULTS = {
  // características
  onsetWin: 2, // tramas a cada lado del beat para el máximo de onset / onsetLow
  chromaSkip: 0.06, // s tras el beat que se saltan al promediar el croma (la ventana del croma es de 93 ms)
  chromaSkipFrac: 0.3,
  chromaTail: 0.02,
  logFloor: 0.05,
  normHalf: 12, // beats a cada lado para la normalización local
  stdFloorRel: 0.5, // suelo de la desviación local, relativo a la mediana de las desviaciones locales
  // evidencia de "1" (a priori): pesos sobre las características normalizadas
  weights: { low: 0.6, ons: 0, hc1: 0.5, hc2: 0.5, acc: 0.15 },
  // compás automático
  meterWindow: 24,
  meterHop: 12,
  meterBias: 0.25, // se elige 3 sólo si su puntuación supera a la de 4 en más de esto
  meterConfSpan: 0.75, // margen sobre el umbral con el que la confianza del compás llega a 1
  // HMM
  emissionScale: 1,
  shortBarLog: -5, // compás con un beat menos
  longBarLog: -5, // compás con un beat más
  resetLog: -14, // compás con 2+ beats menos
  forcedPenaltyMul: 3, // multiplicador de las penalizaciones de irregularidad si hay forcedDownbeats
  templateIters: 2, // iteraciones de aprendizaje de plantillas por canción (0 = sólo evidencia a priori)
  templateShrink: 8, // beats "virtuales" de la plantilla a priori al promediar
  templateScale: 1,
  // confianza
  confEffectLow: 0.2, // separación (en desviaciones típicas) con confianza 0
  confEffectHigh: 1, // … y con confianza 1
  confIrregularFactor: 0.93, // por cada compás irregular
};

const FEATURE_KEYS = ['low', 'ons', 'hc1', 'hc2', 'acc'];
const NEG = -1e30;

function medianOf(arr) {
  const v = Array.from(arr).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Normaliza una secuencia por beat con media y desviación locales (±half beats). NaN -> 0. */
export function localStandardize(x, half, stdFloorRel = 0.5) {
  const n = x.length;
  const out = new Float64Array(n);
  const stds = new Float64Array(n);
  const means = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let s2 = 0;
    let c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const v = x[j];
      if (!Number.isFinite(v)) continue;
      s += v;
      s2 += v * v;
      c++;
    }
    const m = c ? s / c : 0;
    means[i] = m;
    stds[i] = c > 1 ? Math.sqrt(Math.max(0, s2 / c - m * m)) : 0;
  }
  const floor = Math.max(1e-6, stdFloorRel * medianOf(stds));
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(x[i]) ? (x[i] - means[i]) / Math.max(stds[i], floor) : 0;
  return out;
}

/**
 * Características sincronizadas con los beats (sin normalizar):
 *   low = log(máx onsetLow cerca del beat), ons = log(máx onset), hc1 / hc2 = cambio de croma hacia el beat
 *   (1 − coseno entre el beat y el anterior / entre los 2 siguientes y los 2 anteriores), acc = subida de nivel (dB).
 */
export function beatSyncFeatures(features, beats, opts = {}) {
  const o = { ...DOWNBEAT_DEFAULTS, ...opts };
  const { fps, onset, onsetLow, chroma, rms, numFrames } = features;
  const n = beats.length;
  const fr = (t) => Math.max(0, Math.min(numFrames - 1, Math.round(t * fps)));
  const ibis = [];
  for (let i = 1; i < n; i++) ibis.push(beats[i] - beats[i - 1]);
  const medIbi = ibis.length ? medianOf(ibis) : 0.5;
  const low = new Float64Array(n);
  const ons = new Float64Array(n);
  const acc = new Float64Array(n);
  const C = new Float64Array(n * 12);
  for (let i = 0; i < n; i++) {
    const t = beats[i];
    const dur = i + 1 < n ? Math.max(1e-3, beats[i + 1] - t) : medIbi;
    const f = fr(t);
    let ml = 0;
    let mo = 0;
    for (let k = f - o.onsetWin; k <= f + o.onsetWin; k++) {
      if (k < 0 || k >= numFrames) continue;
      if (onsetLow[k] > ml) ml = onsetLow[k];
      if (onset[k] > mo) mo = onset[k];
    }
    low[i] = Math.log(o.logFloor + ml);
    ons[i] = Math.log(o.logFloor + mo);
    // croma medio del tramo del beat
    const a = fr(t + Math.min(o.chromaSkip, o.chromaSkipFrac * dur));
    const b = Math.max(a, fr(t + dur - Math.min(o.chromaTail, 0.1 * dur)));
    let norm = 0;
    for (let k = a; k <= b; k++) for (let p = 0; p < 12; p++) C[i * 12 + p] += chroma[k * 12 + p];
    for (let p = 0; p < 12; p++) norm += C[i * 12 + p] * C[i * 12 + p];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let p = 0; p < 12; p++) C[i * 12 + p] /= norm;
    // acento de nivel: primera mitad del beat frente a la mitad previa
    const h = 0.5 * dur;
    const f1 = fr(t + h);
    const f0 = fr(t - h);
    let e1 = 0;
    let e0 = 0;
    for (let k = f; k <= f1; k++) e1 += rms[k] * rms[k];
    for (let k = f0; k < f; k++) e0 += rms[k] * rms[k];
    e1 /= Math.max(1, f1 - f + 1);
    e0 /= Math.max(1, f - f0);
    acc[i] = 10 * Math.log10((e1 + 1e-10) / (e0 + 1e-10));
  }
  const cosine = (x, y) => {
    let s = 0;
    let nx = 0;
    let ny = 0;
    for (let p = 0; p < 12; p++) {
      s += x[p] * y[p];
      nx += x[p] * x[p];
      ny += y[p] * y[p];
    }
    return nx > 0 && ny > 0 ? s / Math.sqrt(nx * ny) : NaN;
  };
  const row = (i) => C.subarray(i * 12, i * 12 + 12);
  const sum2 = (i, j) => {
    const r = new Float64Array(12);
    for (let p = 0; p < 12; p++) r[p] = C[i * 12 + p] + C[j * 12 + p];
    return r;
  };
  const hc1 = new Float64Array(n).fill(NaN);
  const hc2 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) hc1[i] = 1 - cosine(row(i), row(i - 1));
  for (let i = 2; i + 1 < n; i++) hc2[i] = 1 - cosine(sum2(i, i + 1), sum2(i - 1, i - 2));
  return { n, low, ons, hc1, hc2, acc, medIbi };
}

/** Matriz N×K de características normalizadas localmente (orden FEATURE_KEYS), recortadas a ±4. */
function standardizedMatrix(bf, o) {
  const n = bf.n;
  const K = FEATURE_KEYS.length;
  const Z = new Float64Array(n * K);
  FEATURE_KEYS.forEach((key, k) => {
    const z = localStandardize(bf[key], o.normHalf, o.stdFloorRel);
    for (let i = 0; i < n; i++) Z[i * K + k] = Math.max(-4, Math.min(4, z[i]));
  });
  return Z;
}

/**
 * Periodicidad de compás: para cada característica, fracción de varianza (ajustada por azar) que explica la
 * clase i mod M dentro de ventanas de W beats; se suma sobre características. No depende de la fase.
 */
export function meterPeriodicity(Z, n, K, M, W = 24, hop = 12) {
  if (n < 2 * M) return 0;
  const win = Math.min(W, n - (n % M));
  const chance = (M - 1) / (win - 1);
  let total = 0;
  for (let k = 0; k < K; k++) {
    let acc = 0;
    let cnt = 0;
    for (let s = 0; s + win <= n; s += hop) {
      let mean = 0;
      for (let i = s; i < s + win; i++) mean += Z[i * K + k];
      mean /= win;
      let ss = 0;
      const sum = new Float64Array(M);
      const num = new Float64Array(M);
      for (let i = s; i < s + win; i++) {
        const v = Z[i * K + k] - mean;
        ss += v * v;
        sum[i % M] += v;
        num[i % M]++;
      }
      if (ss <= 1e-9) continue;
      let bs = 0;
      for (let p = 0; p < M; p++) if (num[p]) bs += (sum[p] * sum[p]) / num[p];
      acc += (bs / ss - chance) / (1 - chance);
      cnt++;
    }
    if (cnt) total += acc / cnt;
  }
  return total;
}

/** Transiciones (log) para M posiciones + estado extra M. trans[from][to]. */
function buildTransitions(M, o, mul) {
  const S = M + 1;
  const T = Array.from({ length: S }, () => new Float64Array(S).fill(NEG));
  const reset = o.resetLog * mul;
  for (let p = 0; p < M; p++) T[p][0] = reset; // reinicio: compás más corto
  for (let p = 0; p + 1 < M; p++) T[p][p + 1] = 0;
  if (M >= 2) T[M - 2][0] = Math.max(T[M - 2][0], o.shortBarLog * mul);
  T[M - 1][0] = 0;
  T[M - 1][M] = o.longBarLog * mul;
  T[M][0] = 0;
  return T;
}

/** Viterbi. E: N×S log-emisiones; el estado extra no puede empezar. Devuelve el camino de estados. */
function viterbi(E, n, S, T) {
  let prev = new Float64Array(S);
  let cur = new Float64Array(S);
  const back = new Int8Array(n * S);
  for (let s = 0; s < S; s++) prev[s] = (s < S - 1 ? 0 : NEG) + E[s];
  for (let i = 1; i < n; i++) {
    for (let t = 0; t < S; t++) {
      let best = NEG;
      let arg = 0;
      for (let s = 0; s < S; s++) {
        const v = prev[s] + T[s][t];
        if (v > best) {
          best = v;
          arg = s;
        }
      }
      cur[t] = best + E[i * S + t];
      back[i * S + t] = arg;
    }
    [prev, cur] = [cur, prev];
  }
  let best = NEG;
  let arg = 0;
  for (let s = 0; s < S; s++) {
    if (prev[s] > best) {
      best = prev[s];
      arg = s;
    }
  }
  const path = new Array(n);
  path[n - 1] = arg;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i * S + path[i]];
  return path;
}

/** Emisiones a partir de la evidencia de "1" (sólo el estado 0 la recibe). */
function priorEmissions(d, n, S, scale) {
  const E = new Float64Array(n * S);
  for (let i = 0; i < n; i++) E[i * S] = scale * d[i];
  return E;
}

/** Emisiones gaussianas (varianza 1) con plantillas por posición: z·T − |T|²/2. */
function templateEmissions(Z, n, K, M, tmpl, scale) {
  const S = M + 1;
  const E = new Float64Array(n * S);
  const tn = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    let q = 0;
    for (let k = 0; k < K; k++) q += tmpl[s * K + k] * tmpl[s * K + k];
    tn[s] = q / 2;
  }
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < S; s++) {
      let v = 0;
      for (let k = 0; k < K; k++) v += Z[i * K + k] * tmpl[s * K + k];
      E[i * S + s] = scale * (v - tn[s]);
    }
  }
  return E;
}

/** Plantillas por posición a partir de una decodificación, encogidas hacia la plantilla a priori. */
function learnTemplates(Z, n, K, M, path, prior, shrink) {
  const S = M + 1;
  const sum = new Float64Array(S * K);
  const cnt = new Float64Array(S);
  for (let i = 0; i < n; i++) {
    const s = path[i];
    cnt[s]++;
    for (let k = 0; k < K; k++) sum[s * K + k] += Z[i * K + k];
  }
  const tmpl = new Float64Array(S * K);
  for (let s = 0; s < S; s++) {
    for (let k = 0; k < K; k++) tmpl[s * K + k] = (sum[s * K + k] + shrink * prior[s * K + k]) / (cnt[s] + shrink);
  }
  return tmpl;
}

function applyForced(E, n, S, forced) {
  for (const i of forced) for (let s = 1; s < S; s++) E[i * S + s] = NEG;
}

/** Índices enteros válidos, sin repetir, ascendentes (lo demás se ignora). */
function sanitizeForced(forced, n) {
  const out = [];
  for (const v of Array.from(forced || [])) {
    if (Number.isInteger(v) && v >= 0 && v < n && !out.includes(v)) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/** Posición (0..M-1) con mayor evidencia de "1" media según una decodificación. */
function bestClass(d, path, M) {
  const sum = new Float64Array(M);
  const cnt = new Float64Array(M);
  for (let i = 0; i < path.length; i++) {
    if (path[i] >= M) continue;
    sum[path[i]] += d[i];
    cnt[path[i]]++;
  }
  let best = 0;
  for (let p = 1; p < M; p++) if (cnt[p] && (!cnt[best] || sum[p] / cnt[p] > sum[best] / cnt[best])) best = p;
  return best;
}

/** Plantillas rotadas: el estado s pasa a usar la plantilla de la posición (s + r) mod M; el extra no cambia. */
function rotateTemplates(tmpl, K, M, r) {
  const S = M + 1;
  const rot = new Float64Array(S * K);
  for (let s = 0; s < M; s++) {
    const q = (s + r) % M;
    rot.set(tmpl.subarray(q * K, q * K + K), s * K);
  }
  rot.set(tmpl.subarray(M * K, S * K), M * K);
  return rot;
}

/** Rotación que convierte en "1" a un beat forzado: su posición en la decodificación automática (extra = M − 1). */
function rotationOf(path, i, M) {
  return path[i] === M ? M - 1 : path[i];
}

/**
 * Decodifica con M posiciones: Viterbi con la evidencia a priori y luego con plantillas aprendidas por canción.
 * Con beats forzados: cada beat usa las plantillas rotadas según el forzado más cercano, de modo que el patrón de
 * la canción queda alineado con ellos (la rejilla se desplaza de forma coherente, no sólo junto al forzado), y se
 * decodifica con los forzados como restricción dura; entre forzados incompatibles aparecen compases irregulares.
 */
function decodeMeter(Z, d, n, K, M, forced, o) {
  const S = M + 1;
  const T = buildTransitions(M, o, 1);
  let path = viterbi(priorEmissions(d, n, S, o.emissionScale), n, S, T);
  // plantilla a priori: la evidencia de "1" en la posición 0 y su opuesto repartido en el resto
  const w = FEATURE_KEYS.map((k) => o.weights[k] || 0);
  const prior = new Float64Array(S * K);
  for (let k = 0; k < K; k++) {
    prior[k] = w[k];
    for (let s = 1; s < S; s++) prior[s * K + k] = -w[k] / Math.max(1, M - 1);
  }
  let tmpl = null;
  let rotated = false;
  for (let it = 0; it < o.templateIters; it++) {
    tmpl = learnTemplates(Z, n, K, M, path, prior, o.templateShrink);
    path = viterbi(templateEmissions(Z, n, K, M, tmpl, o.templateScale), n, S, T);
    // las plantillas sólo afinan el patrón: qué posición es el "1" lo decide la evidencia a priori
    const r = rotated ? 0 : bestClass(d, path, M);
    if (r !== 0) {
      rotated = true;
      tmpl = rotateTemplates(tmpl, K, M, r);
      path = viterbi(templateEmissions(Z, n, K, M, tmpl, o.templateScale), n, S, T);
    }
  }
  if (!forced.length) return path;
  if (!tmpl) tmpl = learnTemplates(Z, n, K, M, path, prior, o.templateShrink);
  const byRot = new Map();
  const emissionsFor = (r) => {
    if (!byRot.has(r)) byRot.set(r, templateEmissions(Z, n, K, M, rotateTemplates(tmpl, K, M, r), o.templateScale));
    return byRot.get(r);
  };
  const E = new Float64Array(n * S);
  let f = 0; // forzado más cercano (a igual distancia, el posterior)
  for (let i = 0; i < n; i++) {
    while (f + 1 < forced.length && Math.abs(forced[f + 1] - i) <= Math.abs(forced[f] - i)) f++;
    const Er = emissionsFor(rotationOf(path, forced[f], M));
    for (let s = 0; s < S; s++) E[i * S + s] = Er[i * S + s];
  }
  applyForced(E, n, S, forced);
  return viterbi(E, n, S, buildTransitions(M, o, o.forcedPenaltyMul));
}

/**
 * Separación de la evidencia de "1" entre la posición 0 y la mejor alternativa, en desviaciones típicas dentro
 * de clase (effect size), sobre los beats [from, to). También devuelve el número de compases usados.
 */
function phaseMargin(d, positions, M, from, to) {
  const sum = new Float64Array(M);
  const sq = new Float64Array(M);
  const cnt = new Float64Array(M);
  for (let i = from; i < to; i++) {
    const p = positions[i];
    if (p >= M) continue;
    sum[p] += d[i];
    sq[p] += d[i] * d[i];
    cnt[p]++;
  }
  let within = 0;
  let dof = 0;
  for (let p = 0; p < M; p++) {
    if (!cnt[p]) continue;
    within += sq[p] - (sum[p] * sum[p]) / cnt[p];
    dof += cnt[p] - 1;
  }
  const sw = Math.sqrt(Math.max(1e-9, within / Math.max(1, dof)));
  if (!cnt[0]) return { effect: 0, bars: 0 };
  let alt = -Infinity;
  for (let p = 1; p < M; p++) if (cnt[p]) alt = Math.max(alt, sum[p] / cnt[p]);
  const effect = Number.isFinite(alt) ? (sum[0] / cnt[0] - alt) / sw : 0;
  return { effect, bars: cnt[0] };
}

/**
 * Etiqueta los compases.
 * @param {object} features  de computeFeatures
 * @param {number[]} beats   tiempos (s) ascendentes
 * @param {object} opts      { beatsPerBar: 'auto' | 2..7, forcedDownbeats: number[] (índices de beats que son "1") }
 * @returns {{ beatsPerBar, meterAuto, positions, downbeats, confidence, meterScores }}
 */
export function labelBars(features, beats, opts = {}) {
  const o = { ...DOWNBEAT_DEFAULTS, ...opts, weights: { ...DOWNBEAT_DEFAULTS.weights, ...(opts.weights || {}) } };
  const b = Array.from(beats || []);
  const n = b.length;
  const reqM = Number(opts.beatsPerBar);
  const auto = !(Number.isInteger(reqM) && reqM >= 2 && reqM <= 7);
  const forced = sanitizeForced(opts.forcedDownbeats, n);
  if (n === 0) {
    return { beatsPerBar: auto ? 4 : reqM, meterAuto: auto, positions: [], downbeats: [], confidence: 0, meterScores: {} };
  }
  const K = FEATURE_KEYS.length;
  const bf = beatSyncFeatures(features, b, o);
  const Z = standardizedMatrix(bf, o);
  const d = new Float64Array(n);
  const w = FEATURE_KEYS.map((k) => o.weights[k] || 0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < K; k++) s += w[k] * Z[i * K + k];
    d[i] = s;
  }

  const meterScores = {};
  for (const m of [3, 4]) meterScores[m] = meterPeriodicity(Z, n, K, m, o.meterWindow, o.meterHop);
  let M = reqM;
  let meterConf = 1;
  if (auto) {
    const diff = meterScores[3] - meterScores[4];
    M = diff > o.meterBias ? 3 : 4;
    const margin = M === 3 ? diff - o.meterBias : o.meterBias - diff;
    meterConf = Math.min(1, Math.max(0, margin / o.meterConfSpan));
  }
  const positions = decodeMeter(Z, d, n, K, M, forced, o);
  const downbeats = [];
  for (let i = 0; i < n; i++) if (positions[i] === 0) downbeats.push(i);

  // confianza
  const g = phaseMargin(d, positions, M, 0, n);
  const tl = phaseMargin(d, positions, M, Math.max(0, n - 12 * M), n);
  const effect = 0.5 * (g.effect + tl.effect);
  const tStat = effect * Math.sqrt(g.bars / 2);
  let irregular = 0;
  for (let i = 1; i < n; i++) if (positions[i] === 0 && positions[i - 1] < M - 1) irregular++; // compás corto
  for (let i = 0; i < n; i++) if (positions[i] === M) irregular++; // compás largo
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const phaseConf = Math.min(
    clamp01((effect - o.confEffectLow) / (o.confEffectHigh - o.confEffectLow)),
    clamp01((tStat - 1) / 2),
  );
  let confidence = phaseConf * Math.pow(o.confIrregularFactor, irregular);
  if (auto) confidence *= 0.5 + 0.5 * meterConf;
  const out = { beatsPerBar: M, meterAuto: auto, positions, downbeats, confidence, meterScores };
  if (opts.debug) out.debug = { eG: g.effect, eT: tl.effect, tG: tStat, irr: irregular, meterConf, mdiff: meterScores[3] - meterScores[4] };
  return out;
}
