// Límites de la música (silencio inicial/final), último onset significativo y ajuste fino a transitorios.
import { pickPeaks } from './features.js';

export const BOUNDS_DEFAULTS = {
  thresholdDb: -50, // relativo al máximo RMS (ventanas de 20 ms)
  maxThresholdDb: -35, // con ruido de fondo el umbral sube, pero nunca por encima de esto
  noiseMarginDb: 10, // umbral >= ruido de fondo + margen
  windowSec: 0.02,
  hopSec: 0.01,
  minActiveSec: 0.03, // actividad sostenida para contar (ignora clics aislados)
};

/**
 * RMS en ventanas de `windowSec` (salto `hopSec`) sin componente continua: desviación típica de las muestras de la
 * ventana (un offset DC no cuenta como música; nunca supera al RMS normal, así que el silencio sigue siendo silencio).
 */
function windowRms(samples, sampleRate, windowSec, hopSec) {
  const win = Math.max(1, Math.round(windowSec * sampleRate));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const n = samples.length;
  const nW = Math.max(1, Math.floor(Math.max(0, n - win) / hop) + 1);
  const rms = new Float32Array(nW);
  for (let w = 0; w < nW; w++) {
    const o = w * hop;
    const end = Math.min(n, o + win);
    let s = 0;
    let s2 = 0;
    for (let i = o; i < end; i++) {
      const v = samples[i];
      s += v;
      s2 += v * v;
    }
    const cnt = end - o;
    rms[w] = cnt > 0 ? Math.sqrt(Math.max(0, s2 - (s * s) / cnt) / win) : 0;
  }
  return { rms, win, hop };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
}

/**
 * Inicio y fin de la música: RMS en ventanas de 20 ms (salto 10 ms, sin DC) por encima de máximo − 50 dB.
 * Si hay ruido de fondo en los extremos, el umbral sube a ruido + 10 dB (tope −35 dB). Se exige actividad
 * sostenida (≥ 30 ms en 50 ms) para que un clic aislado no cuente.
 * @returns {{ musicStart:number, musicEnd:number, thresholdDb:number, noiseFloorDb:number, peakRms:number }}
 *   musicStart = inicio de la primera ventana activa (s); musicEnd = fin de la última ventana activa (s).
 *   En una señal sin música (todo silencio) devuelve musicStart = 0, musicEnd = 0.
 */
export function findMusicBounds(samples, sampleRate, opts = {}) {
  const o = { ...BOUNDS_DEFAULTS, ...opts };
  const { rms, win, hop } = windowRms(samples, sampleRate, o.windowSec, o.hopSec);
  const nW = rms.length;
  let peak = 0;
  for (let w = 0; w < nW; w++) if (rms[w] > peak) peak = rms[w];
  if (peak <= 1e-9) return { musicStart: 0, musicEnd: 0, thresholdDb: o.thresholdDb, noiseFloorDb: -Infinity, peakRms: 0 };
  // ruido de fondo: mediana de los primeros/últimos 300 ms (el más bajo de los dos)
  const edge = Math.max(1, Math.round(0.3 / o.hopSec));
  const head = median(Array.from(rms.subarray(0, Math.min(nW, edge))));
  const tail = median(Array.from(rms.subarray(Math.max(0, nW - edge))));
  const floor = Math.min(head, tail);
  const floorDb = floor > 0 ? 20 * Math.log10(floor / peak) : -Infinity;
  const thDb = Math.min(o.maxThresholdDb, Math.max(o.thresholdDb, floorDb + o.noiseMarginDb));
  const th = peak * Math.pow(10, thDb / 20);
  const need = Math.max(1, Math.round(o.minActiveSec / o.hopSec));
  const span = need + 2;
  const active = (w, dir) => {
    // ¿hay actividad sostenida empezando en w hacia dir (+1 adelante, -1 atrás)?
    let c = 0;
    for (let k = 0; k < span; k++) {
      const j = w + dir * k;
      if (j < 0 || j >= nW) break;
      if (rms[j] >= th) c++;
    }
    return c >= Math.min(need, nW);
  };
  let a = -1;
  for (let w = 0; w < nW; w++) {
    if (rms[w] >= th && active(w, 1)) { a = w; break; }
  }
  if (a < 0) return { musicStart: 0, musicEnd: 0, thresholdDb: thDb, noiseFloorDb: floorDb, peakRms: peak };
  let b = a;
  for (let w = nW - 1; w >= a; w--) {
    if (rms[w] >= th && active(w, -1)) { b = w; break; }
  }
  const musicStart = (a * hop) / sampleRate;
  const musicEnd = Math.min(samples.length, b * hop + win) / sampleRate;
  return { musicStart, musicEnd, thresholdDb: thDb, noiseFloorDb: floorDb, peakRms: peak };
}

export const LAST_ONSET_DEFAULTS = {
  relHeight: 0.2, // altura mínima del pico relativa al percentil 75 de los picos de la canción
  minLevelDb: -38, // RMS tras el onset relativo al máximo RMS de la canción
  minContrast: 3, // altura >= minContrast × media de la envolvente en el segundo previo
  contrastSec: 1,
  contextSec: 4, // contexto: el pico más alto de los contextSec previos (el golpe final, si estamos en su cola)
  minContextRel: 0.08, // altura >= 8 % de ese pico (fluctuaciones de la cola de un golpe mucho más fuerte no cuentan)
  // ataque (vale cualquiera de las tres; no vale un pico dentro de una cola que decae):
  minRiseDb: 1.5, // a) el RMS total sube frente a los 40 ms previos
  minHighRiseDb: 6, // b) … o sube el RMS de la banda > 2 kHz (con un limitador el total queda plano, los agudos no)
  highRiseContrast: 5, //    con contraste >= 5 (en la cola saturada de un platillo los agudos también fluctúan)
  strongContrast: 5, // c) … o es un onset claramente fuerte: contraste >= strongContrast,
  strongRel: 0.5, //       altura >= strongRel × el pico más alto del contexto
  strongLevelDb: -12, //   y nivel >= máximo − 12 dB (acorde de piano o pad + voz sin subida de nivel en un master
  //                        limitado; en la cola de un golpe más fuerte no pasa: el golpe queda en el contexto)
  pick: { threshold: 0.02, relThreshold: 0.5 }, // selección de picos más permisiva que la de detectOnsets
  noise: null, // opciones de findNoiseTail (se mezclan con NOISE_TAIL_DEFAULTS); false = sin zona de ruido
};

/**
 * Zona de ruido final (aplausos y público en una grabación en directo): cada palmada es un onset con ataque, así
 * que sin esto el "último onset" cae segundos después del golpe final. Se marca un punto de la rejilla (cada `step`
 * s) cuando el sonido es ruido de banda ancha (planitud media en ±flatHalf s >= minFlatness), con onsets densos
 * (>= minDensity picos/s en ±densHalf s) y sin pulso (ACF normalizada de onset + ½ onsetLow en una ventana de
 * periodWin s, máximo en retardos de 0.25–1.5 s, < maxPeriodicity). Medido con palmas sintéticas (aplauso de −8 a
 * −26 dB respecto a la música) frente a las suites: la música con batería tiene pulso, los pads, la voz y las
 * baladas no son planos y la resonancia de un platillo no tiene onsets densos.
 */
export const NOISE_TAIL_DEFAULTS = {
  step: 0.25,
  flatHalf: 0.5,
  minFlatness: 0.5,
  densHalf: 0.75,
  minDensity: 6,
  periodWin: 3,
  maxPeriodicity: 0.35,
  maxGap: 1, // s sin marcar dentro de la racha
  minRun: 1, // s de racha mínima de ruido de banda ancha…
  minTotal: 2, // … o de racha total contando la extensión por puntos densos y sin pulso (palmas bajo un acorde largo)
  tailSlack: 2.5, // la racha tiene que empezar a menos de esto antes del último pico (llega hasta el final)
  weakExtend: true, // hacia atrás la zona sigue por puntos sin pulso que son planos o densos (las primeras palmas,
  //                   bajo el acorde final que resuena), con huecos de hasta maxGap s…
  maxExtend: 3, //     … y como mucho maxExtend s antes de la racha
  margin: 0.75, // s: la zona empieza esto antes de la racha
  outstanding: 4, // dentro de la zona sólo cuenta un onset >= outstanding × P75 de los picos de la racha. Medido:
  //                 golpe final >= 5.0× y palmas <= 3.2× en todos los casos con aplauso sintético
};

/** Máximo de la ACF normalizada (sin media) de env en [c − win/2, c + win/2] para retardos de lagLo a lagHi s. */
function periodicityAt(env, fps, c, win, lagLo = 0.25, lagHi = 1.5) {
  const a = Math.max(0, Math.round(c - (win * fps) / 2));
  const b = Math.min(env.length, Math.round(c + (win * fps) / 2));
  const n = b - a;
  if (n < 20) return 0;
  let m = 0;
  for (let i = a; i < b; i++) m += env[i];
  m /= n;
  let r0 = 0;
  for (let i = a; i < b; i++) r0 += (env[i] - m) * (env[i] - m);
  if (!(r0 > 0)) return 0;
  let best = 0;
  for (let L = Math.round(lagLo * fps); L <= Math.min(n - 10, Math.round(lagHi * fps)); L++) {
    let s = 0;
    for (let i = a; i + L < b; i++) s += (env[i] - m) * (env[i + L] - m);
    const v = ((s / r0) * n) / (n - L);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Zona de ruido al final de la canción (aplausos): racha de puntos marcados (ver NOISE_TAIL_DEFAULTS) que llega
 * hasta el último pico de onset. Hace falta features.flatness.
 * @param {number[]} [peaks] picos de onset (índices de trama, ascendentes) hasta musicEnd; si faltan se calculan
 * @returns {{ start:number, coreStart:number, end:number, peakRef:number, minHeight:number } | null} tiempos en s:
 *   start = inicio de la zona (con margen), coreStart = inicio de la racha de ruido de banda ancha, end = último punto
 *   marcado; peakRef = P75 de la altura de los picos (features.onset) de la racha; minHeight = outstanding × peakRef
 *   (altura mínima de un onset de verdad dentro de la zona). null si no hay zona de ruido.
 */
export function findNoiseTail(features, musicEnd, opts = {}, peaks = null) {
  const o = { ...NOISE_TAIL_DEFAULTS, ...(opts || {}) };
  const { onset, onsetLow, flatness, fps, numFrames } = features;
  if (!flatness || !onset || !(fps > 0)) return null;
  const endFrame = Math.min(numFrames - 1, Math.floor((musicEnd + 0.02) * fps));
  const pk = peaks || pickPeaks(onset, fps, LAST_ONSET_DEFAULTS.pick).filter((i) => i <= endFrame);
  if (pk.length < 8) return null;
  const env = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) env[i] = onset[i] + 0.5 * (onsetLow ? onsetLow[i] : 0);
  // primer índice de pk con trama >= f
  const lower = (f) => {
    let lo = 0;
    let hi = pk.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pk[mid] < f) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const fh = Math.round(o.flatHalf * fps);
  const dh = o.densHalf * fps;
  // marca de un punto: DENSE | FLAT si no tiene pulso (0 si lo tiene o no es ni denso ni plano); ruido de banda
  // ancha = las dos. Al principio del aplauso el acorde final aún tapa la planitud o las palmas aún no son densas
  const DENSE = 1;
  const FLAT = 2;
  const memo = new Map();
  const mark = (t) => {
    const c = Math.round(t * fps);
    if (memo.has(c)) return memo.get(c);
    const m = markAt(c);
    memo.set(c, m);
    return m;
  };
  const markAt = (c) => {
    const dense = (lower(c + dh + 1e-9) - lower(c - dh)) / (2 * o.densHalf) >= o.minDensity;
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, c - fh); i <= Math.min(numFrames - 1, c + fh); i++) {
      s += flatness[i];
      n++;
    }
    const flat = n > 0 && s / n >= o.minFlatness;
    if (!dense && !flat) return 0;
    if (periodicityAt(env, fps, c, o.periodWin) >= o.maxPeriodicity) return 0;
    return (dense ? DENSE : 0) | (flat ? FLAT : 0);
  };
  const noise = (t) => mark(t) === (DENSE | FLAT);
  const lastPeak = pk[pk.length - 1] / fps;
  let end = -1;
  for (let t = lastPeak; t >= Math.max(0, lastPeak - o.tailSlack); t -= o.step) {
    if (noise(t)) {
      end = t;
      break;
    }
  }
  if (end < 0) return null;
  let core = end;
  for (let t = end - o.step; t >= 0; t -= o.step) {
    if (noise(t)) core = t;
    else if (core - t > o.maxGap) break;
  }
  // racha válida: minRun s de ruido de banda ancha, o minTotal s contando los puntos densos y sin pulso de antes
  let dense = core;
  while (dense - o.step >= 0 && mark(dense - o.step) & DENSE) dense -= o.step;
  if (end - core < o.minRun && end - dense < o.minTotal) return null;
  // inicio de la zona: hacia atrás por puntos sin pulso densos o planos (con huecos de hasta maxGap s)
  let start = core;
  if (o.weakExtend) {
    for (let t = core - o.step; t >= Math.max(0, core - o.maxExtend); t -= o.step) {
      if (mark(t)) start = t;
      else if (start - t > o.maxGap) break;
    }
  }
  const h = [];
  for (let k = lower(Math.round(core * fps)); k < pk.length && pk[k] <= Math.round(end * fps); k++) h.push(onset[pk[k]]);
  h.sort((x, y) => x - y);
  const peakRef = h.length ? h[Math.floor(0.75 * (h.length - 1))] : 0;
  return { start: Math.max(0, start - o.margin), coreStart: core, end, peakRef, minHeight: o.outstanding * peakRef };
}

/**
 * Último onset significativo (golpe final / última nota tocada) antes de musicEnd.
 * Criterios: pico de features.onset (pickPeaks con opts.pick) con altura >= relHeight × P75(alturas de picos),
 * nivel RMS tras el onset (80 ms) >= máximo + minLevelDb, contraste >= minContrast frente a la media de la envolvente
 * en el segundo previo (evita colas con batidos), altura >= minContextRel × el pico más alto de los contextSec previos
 * y un ataque: subida del RMS total >= minRiseDb frente a 40 ms antes, o subida del RMS > 2 kHz (features.rmsHigh)
 * >= minHighRiseDb con contraste >= highRiseContrast, o un onset fuerte (contraste >= strongContrast, altura >=
 * strongRel × el pico más alto del contexto, nivel >= máximo + strongLevelDb). Las dos últimas vías hacen falta en
 * masters muy limitados o saturados (el nivel total no sube en el golpe final) y en acordes finales de ataque lento
 * (pad + voz: el RMS tampoco sube en 250 ms, los agudos sí). Medido con tools/bench.js --analyze (limit12 / clip4 /
 * clip8); el contexto evita que la cola de un acorde final (balada con pad) cuente como último onset.
 * @returns {number} segundos (o musicEnd si no hay ningún onset significativo; 0 si la señal es silencio)
 */
export function findLastOnset(features, musicEnd, opts = {}) {
  const o = { ...LAST_ONSET_DEFAULTS, ...opts };
  const { onset, rms, fps, numFrames } = features;
  const high = features.rmsHigh || null;
  const endFrame = Math.min(numFrames - 1, Math.floor((musicEnd + 0.02) * fps));
  const peaks = pickPeaks(onset, fps, o.pick).filter((i) => i <= endFrame);
  if (!peaks.length) return Math.max(0, musicEnd);
  // aplausos al final: sus palmas no cuentan (sólo un golpe muy por encima de ellas)
  const zone = o.noise === false ? null : findNoiseTail(features, musicEnd, o.noise, peaks);
  const zoneFrom = zone ? Math.ceil(zone.start * fps) : Infinity;
  const zoneMin = zone ? zone.minHeight : 0;
  const heights = peaks.map((i) => onset[i]).sort((a, b) => a - b);
  const p75 = heights[Math.floor(0.75 * (heights.length - 1))];
  let maxRms = 0;
  for (let i = 0; i < numFrames; i++) if (rms[i] > maxRms) maxRms = rms[i];
  const levelTh = maxRms * Math.pow(10, o.minLevelDb / 20);
  const strongLevelTh = maxRms * Math.pow(10, o.strongLevelDb / 20);
  const after = Math.max(1, Math.round(0.08 * fps));
  const before = Math.max(1, Math.round(0.04 * fps));
  const riseFactor = Math.pow(10, o.minRiseDb / 20);
  const highRiseFactor = Math.pow(10, o.minHighRiseDb / 20);
  const ctxFrames = Math.round(o.contrastSec * fps);
  const gapFrames = Math.max(1, Math.round(0.05 * fps));
  const contextFrames = Math.round(o.contextSec * fps);
  const postMax = (env, i) => {
    let m = 0;
    for (let j = i; j <= Math.min(numFrames - 1, i + after); j++) if (env[j] > m) m = env[j];
    return m;
  };
  for (let k = peaks.length - 1; k >= 0; k--) {
    const i = peaks[k];
    if (i >= zoneFrom && onset[i] < zoneMin) continue;
    if (onset[i] < o.relHeight * p75) continue;
    const post = postMax(rms, i);
    if (post < levelTh) continue;
    // contraste con la envolvente del último segundo (en colas sostenidas con batidos todo es "ruido de flujo")
    const c0 = Math.max(0, i - ctxFrames);
    const c1 = Math.max(c0 + 1, i - gapFrames);
    let m = 0;
    for (let j = c0; j < c1; j++) m += onset[j];
    m /= c1 - c0;
    const contrast = m > 0 ? onset[i] / m : Infinity;
    if (contrast < o.minContrast) continue;
    let ctxMax = 0;
    for (let j = Math.max(0, i - contextFrames); j < i - gapFrames; j++) if (onset[j] > ctxMax) ctxMax = onset[j];
    if (onset[i] < o.minContextRel * ctxMax) continue;
    // ataque
    const pre = rms[Math.max(0, i - before)];
    let attack = post >= pre * riseFactor;
    if (!attack && high && contrast >= o.highRiseContrast) attack = postMax(high, i) >= high[Math.max(0, i - before)] * highRiseFactor;
    if (!attack && contrast >= o.strongContrast && post >= strongLevelTh) attack = onset[i] >= o.strongRel * ctxMax;
    if (attack) return i / fps;
  }
  return Math.max(0, musicEnd);
}

export const REFINE_DEFAULTS = {
  window: 0.04, // s: búsqueda ±window
  blockSec: 0.001, // resolución de la envolvente de energía
  minRiseDb: 6, // subida mínima para considerar un transitorio
  relRise: 0.5, // candidatos con subida >= relRise × la mayor subida de la ventana
  maxBelowPeakDb: 12, // el nivel tras la subida debe quedar a menos de 12 dB del máximo de la ventana
  smoothBlocks: 2, // media móvil de la energía (bloques) para no reaccionar a fluctuaciones de ruido
  preBlocks: 6,
  postBlocks: 3,
  preEmphasis: 0.95,
};

/**
 * Mueve cada tiempo al inicio de la subida de energía significativa más cercana dentro de ±window.
 * Envolvente: energía en bloques de 1 ms de la señal con pre-énfasis (x[n] − 0.95·x[n−1]), media móvil de 2 bloques,
 * en dB (L). Subida en el bloque j = max(L[j..j+3]) − min(L[j−6..j−1]); cuenta si es >= 6 dB y el nivel alcanzado
 * queda a menos de 12 dB del máximo de la ventana. Inicio = retrocediendo desde ese máximo, primer bloque contiguo por
 * encima del mínimo previo + 3 dB (resolución 1 ms; tiende a caer ~1 ms antes del ataque real).
 * Entre candidatos (subida >= relRise × la mayor) gana el más cercano al tiempo original.
 * Si no hay subida significativa, el tiempo queda igual. Devuelve un array nuevo (misma longitud y orden).
 */
export function refineToTransients(samples, sampleRate, times, opts = {}) {
  const o = { ...REFINE_DEFAULTS, ...opts };
  const B = Math.max(1, Math.round(o.blockSec * sampleRate));
  const n = samples.length;
  const out = new Array(times.length);
  const preBlocks = o.preBlocks;
  const postBlocks = o.postBlocks;
  const pe = o.preEmphasis;
  for (let q = 0; q < times.length; q++) {
    const t = times[q];
    out[q] = t;
    if (!Number.isFinite(t)) continue;
    const s0 = Math.max(1, Math.floor((t - o.window) * sampleRate) - (preBlocks + 2) * B);
    const s1 = Math.min(n, Math.ceil((t + o.window) * sampleRate) + (postBlocks + 2) * B);
    const nb = Math.floor((s1 - s0) / B);
    if (nb < preBlocks + postBlocks + 2) continue;
    const L = new Float64Array(nb);
    let maxE = 0;
    for (let b = 0; b < nb; b++) {
      let e = 0;
      const o0 = s0 + b * B;
      for (let i = o0; i < o0 + B; i++) {
        const d = samples[i] - pe * samples[i - 1];
        e += d * d;
      }
      L[b] = e;
      if (e > maxE) maxE = e;
    }
    if (maxE <= 0) continue;
    const floor = maxE * 1e-9;
    // suavizado (media móvil de `smooth` bloques, centrada hacia adelante) para no reaccionar al ruido
    if (o.smoothBlocks > 1) {
      const S = new Float64Array(nb);
      const h = o.smoothBlocks;
      for (let b = 0; b < nb; b++) {
        let acc = 0;
        let c = 0;
        for (let k = b; k < Math.min(nb, b + h); k++) { acc += L[k]; c++; }
        S[b] = acc / c;
      }
      L.set(S);
      maxE = 0;
      for (let b = 0; b < nb; b++) if (L[b] > maxE) maxE = L[b];
    }
    for (let b = 0; b < nb; b++) L[b] = 10 * Math.log10(L[b] + floor);
    const Lmax = 10 * Math.log10(maxE + floor);
    // subida por bloque
    const cands = [];
    let bestRise = 0;
    const bLo = preBlocks;
    const bHi = nb - postBlocks - 1;
    for (let b = bLo; b <= bHi; b++) {
      let mn = Infinity;
      for (let k = b - preBlocks; k < b; k++) if (L[k] < mn) mn = L[k];
      let mx = -Infinity;
      for (let k = b; k <= b + postBlocks; k++) if (L[k] > mx) mx = L[k];
      const rise = mx - mn;
      if (rise < o.minRiseDb || mx < Lmax - o.maxBelowPeakDb) continue;
      // inicio: desde el máximo posterior, retroceder mientras el nivel siga >= mínimo previo + 3 dB
      let m = b;
      for (let k = b; k <= b + postBlocks; k++) if (L[k] > L[m]) m = k;
      let st = m;
      while (st - 1 >= b - preBlocks && L[st - 1] >= mn + 3) st--;
      const time = (s0 + st * B) / sampleRate;
      if (Math.abs(time - t) > o.window) continue;
      cands.push({ time, rise });
      if (rise > bestRise) bestRise = rise;
    }
    if (!cands.length) continue;
    let best = null;
    for (const c of cands) {
      if (c.rise < o.relRise * bestRise) continue;
      if (!best || Math.abs(c.time - t) < Math.abs(best.time - t)) best = c;
    }
    if (best) out[q] = best.time;
  }
  return out;
}
