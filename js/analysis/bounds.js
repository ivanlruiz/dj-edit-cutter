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

function windowRms(samples, sampleRate, windowSec, hopSec) {
  const win = Math.max(1, Math.round(windowSec * sampleRate));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const n = samples.length;
  const nW = Math.max(1, Math.floor(Math.max(0, n - win) / hop) + 1);
  const rms = new Float32Array(nW);
  for (let w = 0; w < nW; w++) {
    const o = w * hop;
    let s = 0;
    const end = Math.min(n, o + win);
    for (let i = o; i < end; i++) s += samples[i] * samples[i];
    rms[w] = Math.sqrt(s / win);
  }
  return { rms, win, hop };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
}

/**
 * Inicio y fin de la música: RMS en ventanas de 20 ms (salto 10 ms) por encima de máximo − 50 dB.
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
  minRiseDb: 1.5, // la energía tiene que subir (no vale un pico dentro de una cola que decae)
  minContrast: 3, // altura >= minContrast × media de la envolvente en el segundo previo
  contrastSec: 1,
  pick: { threshold: 0.02, relThreshold: 0.5 }, // selección de picos más permisiva que la de detectOnsets
};

/**
 * Último onset significativo (golpe final / última nota tocada) antes de musicEnd.
 * Criterios: pico de features.onset (pickPeaks con opts.pick) con altura >= relHeight × P75(alturas de picos),
 * nivel RMS tras el onset >= máximo + minLevelDb, subida de energía >= minRiseDb frente a los 40 ms previos y
 * contraste >= minContrast frente a la media de la envolvente en el segundo previo (evita colas con batidos).
 * @returns {number} segundos (o musicEnd si no hay ningún onset significativo; 0 si la señal es silencio)
 */
export function findLastOnset(features, musicEnd, opts = {}) {
  const o = { ...LAST_ONSET_DEFAULTS, ...opts };
  const { onset, rms, fps, numFrames } = features;
  const endFrame = Math.min(numFrames - 1, Math.floor((musicEnd + 0.02) * fps));
  const peaks = pickPeaks(onset, fps, o.pick).filter((i) => i <= endFrame);
  if (!peaks.length) return Math.max(0, musicEnd);
  const heights = peaks.map((i) => onset[i]).sort((a, b) => a - b);
  const p75 = heights[Math.floor(0.75 * (heights.length - 1))];
  let maxRms = 0;
  for (let i = 0; i < numFrames; i++) if (rms[i] > maxRms) maxRms = rms[i];
  const levelTh = maxRms * Math.pow(10, o.minLevelDb / 20);
  const after = Math.max(1, Math.round(0.08 * fps));
  const before = Math.max(1, Math.round(0.04 * fps));
  const riseFactor = Math.pow(10, o.minRiseDb / 20);
  const ctxFrames = Math.round(o.contrastSec * fps);
  const gapFrames = Math.max(1, Math.round(0.05 * fps));
  for (let k = peaks.length - 1; k >= 0; k--) {
    const i = peaks[k];
    if (onset[i] < o.relHeight * p75) continue;
    let post = 0;
    for (let j = i; j <= Math.min(numFrames - 1, i + after); j++) if (rms[j] > post) post = rms[j];
    if (post < levelTh) continue;
    const pre = rms[Math.max(0, i - before)];
    if (post < pre * riseFactor) continue;
    // contraste con la envolvente del último segundo (en colas sostenidas con batidos todo es "ruido de flujo")
    const c0 = Math.max(0, i - ctxFrames);
    const c1 = Math.max(c0 + 1, i - gapFrames);
    let m = 0;
    for (let j = c0; j < c1; j++) m += onset[j];
    m /= c1 - c0;
    if (onset[i] < o.minContrast * m) continue;
    return i / fps;
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
