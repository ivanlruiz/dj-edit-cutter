// Modelo de compases y cálculos del corte (puro, sin DOM). Tiempos en segundos sobre la canción original.
//
// Entrada: un AnalysisResult (o cualquier objeto con { beats, downbeats | positions, lastOnset, musicEnd, bpm }).
// Los beats anteriores al primer downbeat (anacrusa) no pertenecen a ningún compás.

export const LAST_BAR_TOLERANCE = 0.08; // s

const ON_GRID_SEC = 0.001; // a menos de esto un tiempo "está" sobre un beat

function beatsOf(result) {
  const b = result && result.beats;
  return b && b.length ? b : [];
}

/** Índices de downbeat válidos, ascendentes y sin repetir (de result.downbeats o, si falta, de positions === 0). */
function downbeatsOf(result) {
  const beats = beatsOf(result);
  const n = beats.length;
  let src = result && result.downbeats;
  if (!src || !src.length) {
    const pos = result && result.positions;
    src = [];
    if (pos) for (let i = 0; i < Math.min(n, pos.length); i++) if (pos[i] === 0) src.push(i);
  }
  const out = [];
  for (const v of Array.from(src).sort((a, b) => a - b)) {
    if (Number.isInteger(v) && v >= 0 && v < n && (out.length === 0 || out[out.length - 1] !== v)) out.push(v);
  }
  return out;
}

function medianIbi(beats, bpm) {
  const d = [];
  for (let i = 1; i < beats.length; i++) {
    const x = beats[i] - beats[i - 1];
    if (x > 0) d.push(x);
  }
  if (!d.length) return bpm > 0 ? 60 / bpm : 0;
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * Compases: [{ index, number, beatIndex, start, end, beatCount }].
 * end = inicio del compás siguiente; el último termina en último beat + IBI mediano (tope musicEnd).
 */
export function getBars(result) {
  const beats = beatsOf(result);
  const db = downbeatsOf(result);
  const bars = [];
  if (!db.length) return bars;
  const lastBeat = beats[beats.length - 1];
  let finalEnd = lastBeat + medianIbi(beats, result.bpm);
  const musicEnd = result.musicEnd;
  if (Number.isFinite(musicEnd)) finalEnd = Math.min(finalEnd, Math.max(musicEnd, lastBeat));
  for (let k = 0; k < db.length; k++) {
    const bi = db[k];
    const next = k + 1 < db.length ? db[k + 1] : beats.length;
    bars.push({
      index: k,
      number: k + 1,
      beatIndex: bi,
      start: beats[bi],
      end: k + 1 < db.length ? beats[next] : finalEnd,
      beatCount: next - bi,
    });
  }
  return bars;
}

function lastBarIndexOf(bars, lastOnset) {
  if (!bars.length) return -1;
  if (!Number.isFinite(lastOnset)) return bars.length - 1;
  let idx = -1;
  for (let k = 0; k < bars.length; k++) if (bars[k].start <= lastOnset + LAST_BAR_TOLERANCE) idx = k;
  return idx;
}

/**
 * El último compás cuyo inicio <= lastOnset + LAST_BAR_TOLERANCE (el que contiene el golpe final).
 * -1 si no hay compases (o si todos empiezan después del último onset). Sin lastOnset: el último compás.
 */
export function findLastBarIndex(result) {
  return lastBarIndexOf(getBars(result), result && result.lastOnset);
}

/**
 * Corte para quitar n compases del final: al inicio del compás (último − n + 1), dejando al menos 1 compás.
 * @returns {{ barIndex, beatIndex, time, barsRemoved } | null}  time = beats[beatIndex] (sin pre-roll);
 *   barsRemoved = compases que se quitan de verdad tras limitar (<= n). null si n < 1 o no se puede quitar nada.
 */
export function cutForBarsRemoved(result, n) {
  const k = Math.floor(Number(n));
  if (!(k >= 1)) return null;
  const bars = getBars(result);
  const last = lastBarIndexOf(bars, result && result.lastOnset);
  if (last < 1) return null; // hace falta al menos un compás que quede
  const barIndex = Math.max(1, last - k + 1);
  const bar = bars[barIndex];
  return { barIndex, beatIndex: bar.beatIndex, time: bar.start, barsRemoved: last - barIndex + 1 };
}

/**
 * Compases (con decimales, redondeado a 0.1) entre `time` y el final del último compás. Dentro de un compás
 * la fracción se mide en beats (interpolando entre beats), no en segundos. La anacrusa no cuenta.
 */
export function barsRemovedAt(result, time) {
  const beats = beatsOf(result);
  const bars = getBars(result);
  const last = lastBarIndexOf(bars, result && result.lastOnset);
  if (last < 0 || !Number.isFinite(time)) return 0;
  let total = 0;
  for (let k = 0; k <= last; k++) {
    const bar = bars[k];
    if (time <= bar.start) {
      total += 1;
      continue;
    }
    if (time >= bar.end) continue;
    // beat j del compás que contiene time
    let j = bar.beatIndex;
    const jEnd = bar.beatIndex + bar.beatCount - 1;
    while (j < jEnd && beats[j + 1] <= time) j++;
    const next = j < jEnd ? beats[j + 1] : bar.end;
    const frac = next > beats[j] ? Math.min(1, (time - beats[j]) / (next - beats[j])) : 0;
    total += 1 - (j - bar.beatIndex + frac) / bar.beatCount;
  }
  return Math.round(total * 10) / 10;
}

/** Primer índice i con arr[i] >= t (búsqueda binaria). */
function lowerBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestIn(times, t) {
  if (!times.length) return -1;
  const i = lowerBound(times, t);
  if (i === 0) return 0;
  if (i >= times.length) return times.length - 1;
  return t - times[i - 1] <= times[i] - t ? i - 1 : i;
}

export function nearestBeatIndex(result, time) {
  return nearestIn(beatsOf(result), time);
}

/**
 * Paso sobre una lista de tiempos: desde el más cercano a `time`; si `time` no está sobre la rejilla, +1 va al
 * siguiente tiempo posterior y −1 al anterior (no se salta el vecino). delta = 0 ajusta al más cercano.
 */
function stepIn(times, time, delta) {
  if (!times.length) return time;
  const d = Math.trunc(Number(delta)) || 0;
  let base = nearestIn(times, time);
  if (d !== 0 && Math.abs(times[base] - time) > ON_GRID_SEC) {
    if (d > 0 && times[base] > time) base -= 1; // el siguiente tiempo cuenta como +1
    if (d < 0 && times[base] < time) base += 1; // el anterior cuenta como −1
  }
  const i = Math.max(0, Math.min(times.length - 1, base + d));
  return times[i];
}

/** Tiempo del beat a `delta` beats del beat más cercano a `time` (limitado a los beats existentes). */
export function stepBeat(result, time, delta) {
  return stepIn(beatsOf(result), time, delta);
}

/** Igual que stepBeat pero sobre los inicios de compás (downbeats). */
export function stepBar(result, time, delta) {
  const beats = beatsOf(result);
  const db = downbeatsOf(result);
  if (!db.length) return stepBeat(result, time, (Math.trunc(Number(delta)) || 0) * (result.beatsPerBar || 4));
  return stepIn(db.map((i) => beats[i]), time, delta);
}
