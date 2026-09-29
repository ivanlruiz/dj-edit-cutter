// Seguimiento de beats por programación dinámica (estilo Ellis 2007) con tempo VARIABLE (puro, sin DOM).
//
// 1. Envolvente de beat: onset + lowWeight·onsetLow dividida por su media local (los pasajes suaves cuentan igual que
//    los fuertes) y suavizada con una gaussiana corta (puntuación local del DP).
// 2. Camino de tempo: Viterbi sobre log2(tempo) (paseo aleatorio gaussiano entre ventanas + atracción débil al tempo
//    global de estimateTempo) con un rango de menos de una octava a cada lado del tempo global: sigue derivas,
//    acelerandos y el ritardando final, pero no puede saltar a ×2 / ÷2 a mitad de canción. La observación es un peine
//    métrico sobre tempogramas de autocorrelación: ACF(L) + subdivisión (L/2 o L/3) en ventana corta + 2L y compás
//    (3L o 4L, elegido una vez para toda la canción) en ventana larga; así una figura rítmica 5:4 o 3:2 repetida no
//    se confunde con un cambio de tempo. En los últimos compases el camino se relaja (ritardando, fermata).
//    Si aun así el camino pasa la mayor parte de la canción en otro nivel métrico (×2/3 o ×4/3 del tempo global: una
//    hemiolia, un 3/4 sentido en 6/8), se decodifica otra vez limitado a [0.785, 1.27] × tempo global salvo en la zona
//    final; un cambio de tempo real en una sección no llega a activarlo. Al revés, un tramo a < 0.71× el tempo global
//    (fuera de la zona final) cuyos contratiempos suenan como beats es la MITAD de una sección más rápida (92 → 115:
//    el camino cabe en 57): se decodifica otra vez sin ese nivel (ver sectionCheck).
// 3. DP de Ellis con periodo local τ(t): cum[i] = local[i] + max_j (cum[j] − α·ln²((i−j)/τ(i))), j ∈ [i−2τ, i−τ/2].
//    Segunda pasada con τ(t) re-estimado de los intervalos de la primera.
// 4. Octava: si los beats alternos son sistemáticamente flojos (→ mitad) o los contratiempos igual de fuertes que los
//    beats (→ doble), se compara con un prior log-normal y se vuelve a decodificar. Sin pulso claro (pads, voz) se
//    usa una rejilla de tempo constante y la confianza sale baja.
// 5. Bordes: nada fuera de [musicStart, musicEnd]; el último beat decodificado se elige en el último onset
//    significativo (o el beat anterior si el golpe es anticipado); después se extrapola por la cola resonante mientras
//    suene (no tras un corte seco ni en silencio, ni sobre los aplausos de un directo); los beats débiles del principio
//    se recortan.
// 6. Posición fina por interpolación parabólica del pico de onset más cercano (±2 tramas).
import { estimateTempo, tempogram } from './tempo.js';
import { findMusicBounds, findLastOnset, findNoiseTail } from './bounds.js';
import { pickPeaks } from './features.js';

export const DP_DEFAULTS = {
  minBpm: 50,
  maxBpm: 220,
  // envolvente
  lowWeight: 0.5,
  normSec: 3, // media local en ±normSec
  normFloor: 0.15, // suelo de la media local, relativo a la media de la zona con música
  smoothSigma: 1, // tramas (≈ 12 ms) de suavizado gaussiano de la puntuación local
  // camino de tempo
  tempoWindowBeats: 8, // ventana del tempograma en beats del tempo global
  tempoWindowMin: 4, // s
  tempoWindowMax: 8, // s
  tempoHopSec: 0.25,
  pathLo: -0.75, // octavas respecto al tempo global (ritardando hasta ≈ 0.6×)
  pathHi: 0.5, // (acelerando hasta ≈ 1.4×); ambos lejos de ×2 y ÷2
  pathStep: 1 / 96, // octavas entre estados (≈ 0.7 %)
  pathWeight: 4, // peso de la observación (ACF normalizada)
  combSub: 1, // peine métrico: peso de la subdivisión (máx. de L/2 y L/3); distingue el pulso de figuras 5:4, 3:2...
  combDouble: 0.5, // peso de 2L
  combBar: 0.5, // peso del compás (3L o 4L según el metro global)
  barThreeBias: 1.1, // 3/4 sólo si la ACF global en 3τ supera en un 10 % a la de 4τ
  combWindowBeats: 16, // ventana larga (apoyo de 2L, 3L, 4L) en beats del tempo global
  combWindowMax: 12, // s
  pathSigma: 0.05, // octavas/√s: desviación del paseo aleatorio del log-tempo
  pathPrior: 1, // atracción hacia el tempo global: −pathPrior·½·(d/0.5)² por segundo
  endBeats: 8, // en los últimos endBeats beats antes del último onset el camino se relaja (ritardando final):
  endSigmaMult: 2, // σ × endSigmaMult y sin atracción al tempo global
  pathCore: 'auto', // 'auto' | 'always' | 'off': núcleo del camino de tempo (ver pathCoreLo / pathCoreMaxOff)
  pathCoreLo: -0.35, // núcleo: [0.785, 1.27] × el tempo global fuera de la zona final (ritardando); deja fuera con
  pathCoreHi: 0.35, //   margen los niveles ×3/4 y ×4/3 (±0.415 octavas) y cubre derivas y acelerandos reales
  pathCoreMaxOff: 0.5, // 'auto': si más de la mitad de los beats (fuera de la zona final) quedan fuera del núcleo, el
  //                      camino se ha ido a otro nivel métrico (×2/3, ×4/3: hemiolias, 6/8) y se decodifica con núcleo
  sectionCheck: true, // tramo lento (< sectionLo octavas durante >= sectionMinBeats beats, fuera de la zona final)
  sectionLo: -0.5, //     con evidencia de doble: se decodifica otra vez con el camino >= sectionCoreLo octavas
  sectionMinBeats: 8, //  fuera de la zona final (la mitad de una sección más rápida no cabe)
  sectionCoreLo: -0.45,
  hintLo: -0.52, // con bpmHint (strict o no): tempo local en [0.7, 1.3] × el tempo de partida
  hintHi: 0.38,
  strictLo: 0.8, // strict: tempo local en [strictLo, strictHi] × bpmHint salvo en la zona final (ritardando)
  strictHi: 1.25,
  // DP
  tightness: 300,
  passes: 2,
  ibiSmoothBeats: 2, // segunda pasada: mediana de los IBI en ±ibiSmoothBeats beats
  // bordes
  edgeRatio: 0.3, // se recortan los primeros beats con saliencia < edgeRatio × mediana
  maxTailBeats: 8, // como mucho estos beats extrapolados tras el último onset (acorde que resuena)
  tailDropDb: 24, // ... y sólo mientras el nivel quede a menos de 24 dB del golpe final
  tailCutDb: 8, // ... y sin una caída brusca (> 8 dB entre antes y después del beat: el sonido se cortó ahí)
  refineFrames: 2,
  refineMinSal: 1.5, // sólo se afina hacia picos que superan 1.5× la media local
  strengthHalf: 3, // strength = s / (s + strengthHalf): 0.5 cuando el pico vale 3× la media local
  // octava (mitad / doble): log-odds = k·ln(evidencia / umbral) + prior(nuevo) − prior(actual)
  octaveCheck: true,
  octaveHalfThreshold: 0.48, // mitad si la paridad (beats alternos flojos / fuertes) queda por debajo
  octaveDoubleThreshold: 0.5, // doble si los contratiempos superan esta fracción de los beats. Con 0.45 / 0.45 el
  //   funk se doblaba en masters limitados (el limitador iguala las semicorcheas): medido con tools/bench.js --analyze,
  //   0.48 / 0.5 corrige 8 casos (funk, balada y acústica masterizados, x3_funk sin masterizar) y estropea 1 (rock a
  //   165 con limit12, que ya partía de un tempo global a la mitad y ahora no se dobla)
  octaveEvidenceWeight: 3,
  octavePriorCenter: 115,
  octavePriorSigma: 0.8, // octavas
  octaveMinBeats: 16,
  steadyBelowContrast: 2, // con contraste < 2 (sin pulso claro) se usa tempo constante,
  steadyTightnessMult: 10, // un DP mucho más rígido y sin afinado hacia picos (serían ruido)
  octaveMinContrast: 2, // sin pulso claro (contraste < 2) la evidencia de paridad es ruido: no se toca la octava
  confidenceContrast: [1.5, 4], // confianza = ln(contraste/1.5)/ln(4/1.5), acotada a 0..1
};

function movingMean(x, half) {
  const n = x.length;
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (cs[b + 1] - cs[a]) / (b - a + 1);
  }
  return out;
}

function gaussianSmooth(x, sigma) {
  if (!(sigma > 0)) return Float32Array.from(x);
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let j = -r; j <= r; j++) s += k[j + r] = Math.exp((-0.5 * j * j) / (sigma * sigma));
  for (let j = 0; j < k.length; j++) k[j] /= s;
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      const q = i + j;
      if (q >= 0 && q < n) acc += k[j + r] * x[q];
    }
    out[i] = acc;
  }
  return out;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Límites por RMS de las tramas (si no llegan musicStart/musicEnd ni muestras). */
function boundsFromRms(features) {
  const { rms, fps, numFrames } = features;
  let mx = 0;
  for (let i = 0; i < numFrames; i++) if (rms[i] > mx) mx = rms[i];
  if (!(mx > 0)) return { musicStart: 0, musicEnd: 0 };
  const th = mx * Math.pow(10, -50 / 20);
  let a = 0;
  while (a < numFrames && rms[a] < th) a++;
  let b = numFrames - 1;
  while (b > a && rms[b] < th) b--;
  return { musicStart: a / fps, musicEnd: Math.min(features.duration, (b + 1) / fps) };
}

/**
 * Envolvente de beat en las tramas [f0, f1]: onset + lowWeight·onsetLow dividido por su media local (con suelo).
 * @returns {{ env: Float32Array, score: Float32Array }} env normalizada (media local ≈ 1) y su versión suavizada
 */
export function beatEnvelope(features, f0, f1, opts = {}) {
  const o = { ...DP_DEFAULTS, ...opts };
  const { onset, onsetLow, fps } = features;
  const n = f1 - f0 + 1;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = onset[f0 + i] + o.lowWeight * (onsetLow ? onsetLow[f0 + i] : 0);
  let tot = 0;
  for (let i = 0; i < n; i++) tot += raw[i];
  const gMean = tot / Math.max(1, n);
  const mean = movingMean(raw, Math.max(1, Math.round(o.normSec * fps)));
  const floor = Math.max(1e-6, o.normFloor * gMean);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = raw[i] / Math.max(mean[i], floor);
  return { env, score: gaussianSmooth(env, o.smoothSigma) };
}

function acfAt(row, lag) {
  const i = Math.floor(lag);
  if (i < 0 || i + 1 >= row.length) return 0;
  const f = lag - i;
  return row[i] * (1 - f) + row[i + 1] * f;
}

/**
 * Camino de tempo suave: Viterbi sobre un tempograma de ventanas cortas. Estados = log2(bpm / bpm0) en [lo, hi].
 * Con opts.coreLo / opts.coreHi (octavas) el camino queda dentro de [coreLo, coreHi] salvo en la zona final
 * (ritardando, fermata: opts.endFrame), donde el rango se abre de forma gradual hasta [lo, hi].
 * @param {Float32Array} env envolvente (tramas de la zona)
 * @returns {Float64Array} periodo local en tramas, una entrada por trama de env
 */
export function tempoPath(env, fps, bpm0, opts = {}) {
  const o = { ...DP_DEFAULTS, ...opts };
  const n = env.length;
  const lo = o.lo ?? o.pathLo;
  const hi = o.hi ?? o.pathHi;
  const tau0 = (60 * fps) / bpm0;
  const out = new Float64Array(n).fill(tau0);
  const nS = Math.max(1, Math.round((hi - lo) / o.pathStep) + 1);
  const lags = new Float64Array(nS);
  for (let s = 0; s < nS; s++) lags[s] = tau0 * Math.pow(2, -(lo + s * o.pathStep));
  const maxLagState = lags[0];
  // envolvente para periodicidad: menos su media local, rectificada
  const m = movingMean(env, Math.max(1, Math.round(0.25 * fps)));
  const pe = new Float32Array(n);
  for (let i = 0; i < n; i++) pe[i] = Math.max(0, env[i] - m[i]);
  // ventana corta (L, L/2, L/3) y ventana larga (2L, 3L, 4L: apoyo del compás)
  const winS = Math.min(o.tempoWindowMax, Math.max(o.tempoWindowMin, (o.tempoWindowBeats * 60) / bpm0, (2.5 * maxLagState) / fps));
  const winL = Math.max(winS, Math.min(o.combWindowMax, (o.combWindowBeats * 60) / bpm0));
  if (n < 3 * maxLagState) return out;
  const tgS = tempogram(pe, fps, { windowSec: winS, hopSec: o.tempoHopSec, maxLag: Math.ceil(maxLagState) + 2 });
  const useLong = o.combBar > 0 || o.combDouble > 0;
  const tgL = useLong ? tempogram(pe, fps, { windowSec: winL, hopSec: o.tempoHopSec, maxLag: Math.ceil(4 * maxLagState) + 2 }) : null;
  const rows = tgS.rows;
  const nW = rows.length;
  if (!nW) return out;
  const hopSec = Math.max(1, Math.round(o.tempoHopSec * fps)) / fps;
  // coste de transición: paseo aleatorio gaussiano en log2(tempo) con varianza pathSigma² por segundo
  // cerca del final (ritardando, fermata) el tempo puede cambiar más deprisa y alejarse más del global
  const endF = Number.isFinite(o.endFrame) ? o.endFrame : Infinity;
  const endSpan = (o.endBeats * 60 * fps) / bpm0;
  const endRamp = (w) => Math.min(1, Math.max(0, (tgS.centers[w] - (endF - endSpan)) / (0.5 * endSpan)));
  const sigmaMax = o.pathSigma * Math.max(1, o.endSigmaMult);
  const maxJump = Math.max(1, Math.ceil((4 * sigmaMax * Math.sqrt(hopSec)) / o.pathStep));
  const prior = new Float64Array(nS);
  for (let s = 0; s < nS; s++) {
    const d = lo + s * o.pathStep;
    prior[s] = -o.pathPrior * hopSec * 0.5 * (d / 0.5) * (d / 0.5); // por ventana, × (1 − rampa final)
  }
  // compás global: 3 o 4 beats según la ACF media de la ventana larga (el metro no cambia a mitad de canción)
  let barMult = 4;
  if (useLong) {
    let a3 = 0;
    let a4 = 0;
    for (const rl of tgL.rows) {
      if (rl[0] <= 0) continue;
      a3 += acfAt(rl, 3 * tau0);
      a4 += acfAt(rl, 4 * tau0);
    }
    barMult = a3 > a4 * o.barThreeBias ? 3 : 4;
  }
  const obs = (w, s) => {
    const row = rows[w];
    if (row[0] <= 0) return 0;
    const L = lags[s];
    let v = acfAt(row, L) + o.combSub * Math.max(acfAt(row, L / 2), acfAt(row, L / 3));
    if (useLong) {
      const rl = longRows[w];
      if (rl[0] > 0) v += o.combDouble * acfAt(rl, 2 * L) + o.combBar * acfAt(rl, barMult * L);
    }
    return Math.max(0, v);
  };
  // fila de la ventana larga con el centro más cercano a cada ventana corta (centros crecientes en ambas)
  const longRows = [];
  if (useLong) {
    let k = 0;
    for (let w = 0; w < nW; w++) {
      const c = tgS.centers[w];
      while (k + 1 < tgL.centers.length && Math.abs(tgL.centers[k + 1] - c) <= Math.abs(tgL.centers[k] - c)) k++;
      longRows.push(tgL.rows[k]);
    }
  }
  let prev = new Float64Array(nS);
  let cur = new Float64Array(nS);
  const back = new Array(nW);
  // rango permitido por ventana (núcleo fuera de la zona final)
  const useCore = Number.isFinite(o.coreLo) && Number.isFinite(o.coreHi);
  const outside = (w, s) => {
    if (!useCore) return false;
    const r = endRamp(w);
    const d = lo + s * o.pathStep;
    return d < o.coreLo + (lo - o.coreLo) * r - 1e-9 || d > o.coreHi + (hi - o.coreHi) * r + 1e-9;
  };
  const BANNED = -1e12;
  for (let s = 0; s < nS; s++) prev[s] = outside(0, s) ? BANNED : o.pathWeight * obs(0, s) + prior[s];
  back[0] = null;
  for (let w = 1; w < nW; w++) {
    const bk = new Int16Array(nS);
    const r = endRamp(w);
    const sig = o.pathSigma * (1 + (o.endSigmaMult - 1) * r);
    const inv2var = 1 / (2 * sig * sig * hopSec);
    const pw = 1 - r;
    for (let s = 0; s < nS; s++) {
      let best = -Infinity;
      let bi = s;
      const a = Math.max(0, s - maxJump);
      const b = Math.min(nS - 1, s + maxJump);
      for (let k = a; k <= b; k++) {
        const d = (k - s) * o.pathStep;
        const v = prev[k] - d * d * inv2var;
        if (v > best) { best = v; bi = k; }
      }
      cur[s] = outside(w, s) ? BANNED : best + o.pathWeight * obs(w, s) + pw * prior[s];
      bk[s] = bi;
    }
    back[w] = bk;
    const t = prev; prev = cur; cur = t;
  }
  let s = 0;
  for (let k = 1; k < nS; k++) if (prev[k] > prev[s]) s = k;
  const pathLag = new Float64Array(nW);
  for (let w = nW - 1; w >= 0; w--) {
    pathLag[w] = lags[s];
    if (w > 0) s = back[w][s];
  }
  // interpolación a cada trama (centros de ventana)
  const centers = tgS.centers;
  let w = 0;
  for (let i = 0; i < n; i++) {
    while (w + 1 < nW && centers[w + 1] <= i) w++;
    if (i <= centers[0]) out[i] = pathLag[0];
    else if (w + 1 >= nW) out[i] = pathLag[nW - 1];
    else {
      const f = (i - centers[w]) / (centers[w + 1] - centers[w]);
      out[i] = pathLag[w] * (1 - f) + pathLag[w + 1] * f;
    }
  }
  return out;
}

/**
 * DP de Ellis con periodo local. score: puntuación local (≥ 0); period: tramas por beat en cada trama.
 * alwaysLink: enlaza siempre con el mejor predecesor (si no, sólo cuando suma; con puntuación ≈ 0 en todas
 * partes la cadena se rompería y no saldría ningún beat).
 * @returns {{ cum: Float64Array, back: Int32Array }}
 */
export function dpForward(score, period, tightness, alwaysLink = false) {
  const n = score.length;
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const tau = period[i];
    const jLo = Math.max(0, i - Math.round(2 * tau));
    const jHi = i - Math.max(1, Math.round(tau / 2));
    let best = -Infinity;
    let bj = -1;
    for (let j = jHi; j >= jLo; j--) {
      const r = Math.log((i - j) / tau);
      const v = cum[j] - tightness * r * r;
      if (v > best) { best = v; bj = j; }
    }
    if (bj >= 0 && (best > 0 || alwaysLink)) {
      cum[i] = score[i] + best;
      back[i] = bj;
    } else {
      cum[i] = score[i];
    }
  }
  return { cum, back };
}

function backtrace(back, end) {
  const out = [];
  for (let i = end; i >= 0; i = back[i]) out.push(i);
  return out.reverse();
}

/** Periodo por trama a partir de beats (tramas): mediana de IBI en ±k beats, interpolada. */
function periodFromBeats(beats, n, k, fallback) {
  const out = new Float64Array(n).fill(fallback);
  if (beats.length < 3) return out;
  const ibi = [];
  for (let i = 1; i < beats.length; i++) ibi.push(beats[i] - beats[i - 1]);
  const mids = [];
  const vals = [];
  for (let i = 0; i < ibi.length; i++) {
    const a = Math.max(0, i - k);
    const b = Math.min(ibi.length - 1, i + k);
    vals.push(median(ibi.slice(a, b + 1)));
    mids.push(0.5 * (beats[i] + beats[i + 1]));
  }
  let w = 0;
  for (let i = 0; i < n; i++) {
    while (w + 1 < mids.length && mids[w + 1] <= i) w++;
    if (i <= mids[0]) out[i] = vals[0];
    else if (w + 1 >= mids.length) out[i] = vals[vals.length - 1];
    else {
      const f = (i - mids[w]) / (mids[w + 1] - mids[w]);
      out[i] = vals[w] * (1 - f) + vals[w + 1] * f;
    }
  }
  return out;
}

/**
 * Fracción de beats (antes de la trama endF) cuyo tempo local (mediana de 4 IBI) queda fuera de [lo, hi] octavas
 * respecto a bpm0.
 */
export function offCoreFraction(beatsF, bpm0, fps, endF, lo, hi) {
  let n = 0;
  let off = 0;
  for (let i = 1; i < beatsF.length; i++) {
    if (beatsF[i] > endF) break;
    const ibis = [];
    for (let k = Math.max(1, i - 2); k <= Math.min(beatsF.length - 1, i + 1); k++) ibis.push(beatsF[k] - beatsF[k - 1]);
    const d = Math.log2((60 * fps) / median(ibis) / bpm0);
    n++;
    if (d < lo || d > hi) off++;
  }
  return n ? off / n : 0;
}

/**
 * Tramo más largo de beats (antes de la trama endF) cuyo tempo local (mediana de 4 IBI) queda por debajo de lo
 * octavas respecto a bpm0. @returns {{ from:number, to:number } | null} índices de beat
 */
export function slowRun(beatsF, bpm0, fps, endF, lo) {
  let best = null;
  let from = -1;
  for (let i = 1; i < beatsF.length && beatsF[i] <= endF; i++) {
    const ibis = [];
    for (let k = Math.max(1, i - 2); k <= Math.min(beatsF.length - 1, i + 1); k++) ibis.push(beatsF[k] - beatsF[k - 1]);
    const slow = Math.log2((60 * fps) / median(ibis) / bpm0) < lo;
    if (slow && from < 0) from = i;
    if ((!slow || i + 1 >= beatsF.length || beatsF[i + 1] > endF) && from >= 0) {
      const to = slow ? i : i - 1;
      if (!best || to - from > best.to - best.from) best = { from, to };
      from = -1;
    }
  }
  return best;
}

/** Log-prior log-normal del tempo (octavas). */
function logPrior(bpm, center, sigma) {
  const z = Math.log2(bpm / center) / sigma;
  return -0.5 * z * z;
}

/**
 * Evidencia de octava sobre una secuencia de beats (tramas) y la envolvente: fuerza media de la paridad débil frente
 * a la fuerte (¿los beats alternos son sistemáticamente flojos? → el pulso real es la mitad) y de los puntos medios
 * frente a los beats (¿los contratiempos son tan fuertes como los beats? → el pulso real es el doble).
 * @returns {{ parity:number, mid:number, n:number }} cocientes 0..1 (NaN con pocos beats)
 */
export function octaveEvidence(beatsF, salAt) {
  const n = beatsF.length;
  if (n < 8) return { parity: NaN, mid: NaN, n };
  let e = 0;
  let od = 0;
  let ne = 0;
  let no = 0;
  let b = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = salAt(beatsF[i]);
    b += v;
    if (i % 2 === 0) { e += v; ne++; } else { od += v; no++; }
    if (i > 0) m += salAt(Math.round(0.5 * (beatsF[i] + beatsF[i - 1])));
  }
  e /= ne;
  od /= no;
  b /= n;
  m /= n - 1;
  return { parity: Math.max(e, od) > 0 ? Math.min(e, od) / Math.max(e, od) : NaN, mid: b > 0 ? Math.min(1, m / b) : NaN, n };
}

/**
 * Contraste de los beats: saliencia media en los beats / saliencia media en cualquier trama entre el primero y el
 * último. ≈ 1 si los beats no coinciden con la envolvente más que cualquier posición (sin pulso claro).
 */
export function beatContrast(beatsF, salAt) {
  if (beatsF.length < 2) return 0;
  let bs = 0;
  for (const f of beatsF) bs += salAt(f);
  let as = 0;
  let an = 0;
  for (let f = beatsF[0]; f <= beatsF[beatsF.length - 1]; f++) { as += salAt(f); an++; }
  return as > 0 ? bs / beatsF.length / (as / an) : 0;
}

/**
 * Sigue los beats.
 * @param {object} features resultado de computeFeatures
 * @param {object} opts { minBpm, maxBpm, bpmHint, strict, musicStart, musicEnd, samples, sampleRate, tempo, ...DP_DEFAULTS }
 * @returns {{ beats:number[], bpm:number, strength:number[], tempi:number[], confidence:number, contrast:number,
 *   extrapolated:number, octave: { from:number, to:number, parity:number, mid:number } | null }}
 *   beats en s (ascendentes, dentro de [musicStart, musicEnd]); bpm = mediana de 60/IBI; strength 0..1 por beat
 *   (pico de la envolvente cerca del beat relativo a su media local: s/(s+3), 0.5 = 3× la media local);
 *   tempi = BPM local por beat; contrast = beatContrast (sin la cola extrapolada); confidence = 0..1 a partir del
 *   contraste (1.5 → 0, ≥ 4 → 1; < 0.5 ≈ "revisa la cuadrícula");
 *   extrapolated = cuántos de los últimos beats se extrapolaron por la cola resonante (sin onsets);
 *   octave = corrección de octava aplicada (null si ninguna; nunca con bpmHint);
 *   metricLevel = { offCore, bpmBefore } si el camino se volvió a decodificar dentro del núcleo (null si no);
 *   section = { from, to, mid, bpm } si un tramo lento era la mitad de una sección más rápida (null si no).
 */
export function trackBeats(features, opts = {}) {
  const o = { ...DP_DEFAULTS };
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null) o[k] = v;
  const empty = (bpm = 0) => ({ beats: [], bpm, strength: [], tempi: [], confidence: 0, contrast: 0, extrapolated: 0, octave: null, metricLevel: null, section: null });
  if (!features || !(features.numFrames > 0) || !(features.fps > 0) || !features.onset) return empty();
  const fps = features.fps;
  const hint = Number.isFinite(o.bpmHint) && o.bpmHint > 0 ? o.bpmHint : null;
  const strict = !!(hint && o.strict);
  const minBpm = Math.max(20, Number(o.minBpm) || DP_DEFAULTS.minBpm);
  const maxBpm = Math.max(minBpm * 1.1, Number(o.maxBpm) || DP_DEFAULTS.maxBpm);

  // zona con música
  let { musicStart, musicEnd } = o;
  if (!(Number.isFinite(musicStart) && Number.isFinite(musicEnd))) {
    const b = o.samples && o.samples.length ? findMusicBounds(o.samples, o.sampleRate || features.sampleRate) : boundsFromRms(features);
    musicStart = b.musicStart;
    musicEnd = b.musicEnd;
  }
  musicStart = Math.max(0, musicStart);
  musicEnd = Math.min(features.duration, musicEnd);
  if (!(musicEnd > musicStart)) return empty();
  // tramas válidas: la ventana cae entera dentro del archivo (features ya pone a 0 el flujo de las demás; se mantiene
  // aquí por si llegan características de otra versión)
  const half = (features.frameSize || 1024) / 2;
  const hop = features.hop || 256;
  const firstValid = Math.ceil(half / hop);
  const lastValid = Math.floor((features.duration * features.sampleRate - half) / hop);
  const f0 = Math.max(firstValid, Math.floor(musicStart * fps));
  const f1 = Math.min(features.numFrames - 1, lastValid, Math.ceil(musicEnd * fps));
  if (f1 - f0 < Math.round(0.5 * fps)) return empty();

  // tempo global
  let tempo = o.tempo;
  if (hint || !tempo || !(tempo.bpm > 0)) tempo = estimateTempo(features, { minBpm, maxBpm, bpmHint: hint || undefined, strict });
  let bpm0 = tempo.bpm > 0 ? tempo.bpm : hint || 115;
  if (strict) bpm0 = Math.min(hint * 1.25, Math.max(hint * 0.8, bpm0));

  const { env, score } = beatEnvelope(features, f0, f1, o);
  const n = env.length;
  let envMax = 0;
  for (let i = 0; i < n; i++) if (env[i] > envMax) envMax = env[i];
  if (!(envMax > 0)) return empty(bpm0);

  // fin de la evidencia: último onset significativo
  // (sólo tramas válidas; findLastOnset mira hasta musicEnd + 20 ms: se deja ese margen dentro de ellas)
  const endSearch = Math.min(musicEnd, (f1 - 2) / fps);
  let lastOnset = findLastOnset(features, endSearch);
  // si ningún pico pasa sus criterios (material sin ataques claros) devuelve el propio límite: entonces
  // vale el último pico de onset con altura ≥ 0.2 × P75 de las alturas (su mismo criterio de altura)
  if (lastOnset >= endSearch - 1e-6) {
    const peaks = pickPeaks(features.onset, fps, { threshold: 0.02, relThreshold: 0.5 }).filter((i) => i >= f0 && i <= f1 - 2);
    if (peaks.length) {
      const h = peaks.map((i) => features.onset[i]).sort((a, b) => a - b);
      const th = 0.2 * h[Math.floor(0.75 * (h.length - 1))];
      for (let q = peaks.length - 1; q >= 0; q--) if (features.onset[peaks[q]] >= th) { lastOnset = peaks[q] / fps; break; }
    }
  }
  const fLast = Math.min(n - 1, Math.max(0, Math.round(lastOnset * fps) - f0));
  const R = o.refineFrames;
  const salAt = (f) => {
    let m = 0;
    for (let k = Math.max(0, f - R); k <= Math.min(n - 1, f + R); k++) if (env[k] > m) m = env[k];
    return m;
  };

  let useCore = !hint && o.pathCore === 'always';
  // strict (botones ×2 / ÷2, tempo manual): fuera de la zona final el camino queda en [0.8, 1.25] × el tempo pedido;
  // con sólo [0.7, 1.3] × bpm0 un tempo pedido un 25–35 % lejos del real acababa en el nivel métrico real (×2/3, ×3/2)
  const strictCore = strict
    ? { coreLo: Math.log2((o.strictLo * hint) / bpm0), coreHi: Math.log2((o.strictHi * hint) / bpm0) }
    : {};
  let coreOverride = null;
  const decode = (bpmC, steady = false) => {
    // con un tempo indicado por el usuario el camino no se aleja más de ±30 % (se queda en ese nivel métrico)
    const pathOpts = hint ? { lo: o.hintLo, hi: o.hintHi, ...strictCore } : coreOverride || (useCore ? { coreLo: o.pathCoreLo, coreHi: o.pathCoreHi } : {});
    let period = steady ? new Float64Array(n).fill((60 * fps) / bpmC) : tempoPath(env, fps, bpmC, { ...o, ...pathOpts, endFrame: fLast });
    let beatsF = [];
    for (let pass = 0; pass < Math.max(1, o.passes); pass++) {
      // rejilla estable (sin pulso claro): siempre encadenada, aunque la envolvente sea ~0 en tramos largos
      const { cum, back } = dpForward(score, period, steady ? o.tightness * o.steadyTightnessMult : o.tightness, steady);
      // último beat: máximo de cum cerca del último onset (un golpe anticipado cae en el beat anterior)
      const tauE = period[fLast];
      const a = Math.max(0, Math.round(fLast - 0.9 * tauE));
      const b = Math.min(n - 1, fLast + o.refineFrames + 1); // cum no decrece: más allá sólo habría beats sin evidencia
      let e = a;
      for (let i = a; i <= b; i++) if (cum[i] > cum[e]) e = i;
      beatsF = backtrace(back, e);
      if (!steady && pass + 1 < o.passes && beatsF.length >= 4) period = periodFromBeats(beatsF, n, o.ibiSmoothBeats, (60 * fps) / bpmC);
    }
    return beatsF;
  };

  let beatsF = decode(bpm0);
  // nivel métrico: el camino puede asentarse en ×2/3 o ×4/3 del tempo global (una figura de 3 contra 4, un 3/4 sentido
  // en 6/8) con mucha confianza. El tempo global sólo se equivoca de octava (eso lo corrige la comprobación de octava),
  // así que si la mayor parte de la canción (fuera del ritardando final) queda fuera de [0.785, 1.27] × tempo global, se
  // vuelve a decodificar con el camino limitado a ese núcleo. Un cambio de tempo real en una sección no lo activa.
  let metricLevel = null;
  if (!hint && o.pathCore === 'auto' && beatsF.length >= 8) {
    const off = offCoreFraction(beatsF, bpm0, fps, fLast - (o.endBeats * 60 * fps) / bpm0, o.pathCoreLo, o.pathCoreHi);
    if (off > o.pathCoreMaxOff) {
      useCore = true;
      const alt = decode(bpm0);
      if (alt.length >= 4) {
        metricLevel = { offCore: off, bpmBefore: (60 * fps * (beatsF.length - 1)) / (beatsF[beatsF.length - 1] - beatsF[0]) };
        beatsF = alt;
      } else useCore = false;
    }
  }
  // tramo lento a mitad de canción (fuera de la zona final): el camino admite hasta ≈ 0.6× el tempo global, así que
  // también cabe la MITAD de una sección más rápida (92 → 115 BPM: 57). Si los contratiempos de ese tramo suenan como
  // beats (misma evidencia y prior que la comprobación de octava) se decodifica otra vez sin ese nivel lento. Un tramo
  // lento de verdad (cuerdas reales a 0.56×) tiene contratiempos flojos y no se toca
  let section = null;
  if (!hint && o.sectionCheck && !useCore && beatsF.length >= 16) {
    const run = slowRun(beatsF, bpm0, fps, fLast - (o.endBeats * 60 * fps) / bpm0, o.sectionLo);
    if (run && run.to - run.from + 1 >= o.sectionMinBeats) {
      const seg = beatsF.slice(run.from, run.to + 1);
      const ev = octaveEvidence(seg, salAt);
      const bpmRun = (60 * fps * (seg.length - 1)) / (seg[seg.length - 1] - seg[0]);
      const lp = (b) => logPrior(b, o.octavePriorCenter, o.octavePriorSigma);
      const dbl = o.octaveEvidenceWeight * Math.log(Math.max(1e-3, ev.mid) / o.octaveDoubleThreshold) + lp(2 * bpmRun) - lp(bpmRun);
      if (dbl > 0) {
        coreOverride = { coreLo: o.sectionCoreLo, coreHi: o.pathHi };
        const alt = decode(bpm0);
        coreOverride = null;
        if (alt.length > beatsF.length) {
          section = { from: run.from, to: run.to, mid: ev.mid, bpm: bpmRun };
          beatsF = alt;
        }
      }
    }
  }
  // sin pulso claro (pads, voz) el camino de tempo sólo seguiría ruido: rejilla estable al tempo global
  // (con un tempo indicado por el usuario, ese tempo exacto: el afinado de estimateTempo sería ruido)
  const lowEvidence = beatContrast(beatsF, salAt) < o.steadyBelowContrast;
  if (lowEvidence) {
    if (hint) bpm0 = hint;
    beatsF = decode(bpm0, true);
  }

  // octava: ¿mitad o doble? evidencia de paridad/contratiempos frente a un prior log-normal
  let octave = null;
  if (!hint && o.octaveCheck) {
    const ev = octaveEvidence(beatsF, salAt);
    const bpmNow = beatsF.length > 1 ? (60 * fps * (beatsF.length - 1)) / (beatsF[beatsF.length - 1] - beatsF[0]) : bpm0;
    if (ev.n >= o.octaveMinBeats && beatContrast(beatsF, salAt) >= o.octaveMinContrast) {
      const lp = (b) => logPrior(b, o.octavePriorCenter, o.octavePriorSigma);
      const k = o.octaveEvidenceWeight;
      // log-odds a favor de cada alternativa frente a quedarse
      const half = bpmNow / 2 >= minBpm ? k * Math.log(o.octaveHalfThreshold / Math.max(1e-3, ev.parity)) + lp(bpmNow / 2) - lp(bpmNow) : -Infinity;
      const dbl = bpmNow * 2 <= maxBpm ? k * Math.log(Math.max(1e-3, ev.mid) / o.octaveDoubleThreshold) + lp(bpmNow * 2) - lp(bpmNow) : -Infinity;
      const mult = half > 0 && half >= dbl ? 0.5 : dbl > 0 ? 2 : 1;
      if (mult !== 1) {
        const alt = decode(bpm0 * mult, lowEvidence);
        if (alt.length >= 4) {
          octave = { from: bpmNow, to: bpmNow * mult, parity: ev.parity, mid: ev.mid };
          beatsF = alt;
          bpm0 *= mult;
        }
      }
    }
  }

  // recorte de beats débiles al principio (ruido o notas sueltas antes de que empiece el pulso)
  let sal = beatsF.map(salAt);
  const medSal = median(sal);
  let s0 = 0;
  while (s0 < beatsF.length - 1 && sal[s0] < o.edgeRatio * medSal) s0++;
  beatsF = beatsF.slice(s0);
  sal = sal.slice(s0);

  // extrapolación por la cola (acorde que resuena) mientras quede al menos medio beat de música y el nivel no haya caído
  // más de tailDropDb respecto al golpe final (tras un corte seco sólo queda reverberación: no es tiempo musical).
  // Tampoco sobre los aplausos del final de un directo (findNoiseTail): tapan la cola y no son tiempo musical
  const noise = findNoiseTail(features, endSearch);
  const fEnd = Math.floor(Math.min(musicEnd, noise ? noise.coreStart : Infinity) * fps) - f0;
  let extrapolated = 0;
  if (beatsF.length >= 2) {
    const rms = (k) => features.rms[k]; // RMS por trama sin componente continua (features.js)
    // nivel máximo en [g + skip, g + skip + sec] (tramas de ±23 ms: con skip = 50 ms no se mezcla lo anterior al beat)
    const rmsAfter = (g, sec, skip) => {
      let m = 0;
      const a = g + Math.round(skip * fps);
      for (let k = Math.max(0, a); k <= Math.min(features.numFrames - 1, a + Math.round(sec * fps)); k++) m = Math.max(m, rms(k));
      return m;
    };
    const ref = rmsAfter(fLast + f0, 0.2, 0);
    const minLevel = ref * Math.pow(10, -o.tailDropDb / 20);
    const k = Math.min(3, beatsF.length - 1);
    const ibis = [];
    for (let i = beatsF.length - k; i < beatsF.length; i++) ibis.push(beatsF[i] - beatsF[i - 1]);
    const step = median(ibis);
    let t = beatsF[beatsF.length - 1] + step;
    const cutFactor = Math.pow(10, -o.tailCutDb / 20);
    const sounding = (g) => {
      const post = rmsAfter(g, 0.1, 0.05);
      return post >= minLevel && post >= cutFactor * rmsAfter(g, 0.1, -0.15); // caída brusca justo en el beat = corte
    };
    while (step > 0 && t + 0.5 * step <= fEnd && extrapolated < o.maxTailBeats && sounding(Math.round(t) + f0)) {
      beatsF.push(Math.round(t));
      sal.push(salAt(Math.min(n - 1, Math.round(t))));
      t += step;
      extrapolated++;
    }
  }

  // posición fina: interpolación parabólica del pico de onset cercano
  const beats = [];
  const onset = features.onset;
  for (let q = 0; q < beatsF.length; q++) {
    const g = beatsF[q] + f0;
    let p = g;
    for (let k = Math.max(0, g - R); k <= Math.min(features.numFrames - 1, g + R); k++) if (onset[k] > onset[p]) p = k;
    let pos = g;
    if (!lowEvidence && sal[q] >= o.refineMinSal && p > 0 && p < features.numFrames - 1 && onset[p] >= onset[p - 1] && onset[p] >= onset[p + 1]) {
      const y0 = onset[p - 1];
      const y1 = onset[p];
      const y2 = onset[p + 1];
      const d = y0 - 2 * y1 + y2;
      pos = p + (d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0);
    }
    beats.push(Math.min(musicEnd, Math.max(musicStart, pos / fps)));
  }
  for (let i = 1; i < beats.length; i++) if (beats[i] <= beats[i - 1]) beats[i] = beats[i - 1] + 1e-3;
  const ibi = [];
  for (let i = 1; i < beats.length; i++) ibi.push(beats[i] - beats[i - 1]);
  const bpm = ibi.length ? 60 / median(ibi) : bpm0;
  const strength = sal.map((v) => v / (v + o.strengthHalf));
  const tempi = beats.map((_, i) => {
    const a = Math.max(0, i - 2);
    const b = Math.min(ibi.length - 1, i + 1);
    return b >= a ? 60 / median(ibi.slice(a, b + 1)) : bpm;
  });
  if (beats.length < 2) return empty(bpm0);
  const contrast = beatContrast(beatsF.slice(0, beatsF.length - extrapolated), salAt);
  const [c0, c1] = o.confidenceContrast;
  const confidence = Math.min(1, Math.max(0, Math.log(contrast / c0) / Math.log(c1 / c0)));
  return { beats, bpm, strength, tempi, confidence, extrapolated, octave, metricLevel, section, contrast };
}
