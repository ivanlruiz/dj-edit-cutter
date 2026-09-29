// Cambio de compás (modo 2): se quita o se repite el FINAL de cada compás y se empalma,
// sin estirar el tiempo. Lógica pura (sin DOM): todo en segundos sobre la línea de tiempo original.

import { getBars, findLastBarIndex } from './bars.js';
import { CUT_PREROLL_SEC } from '../audio/edit.js';

export const METER_PRESETS = Object.freeze([
  Object.freeze({ num: 7, den: 8 }),
  Object.freeze({ num: 3, den: 4 }),
  Object.freeze({ num: 5, den: 4 }),
]);

const VALID_DENS = [2, 4, 8, 16];
const MAX_NUM = 32;
export const SNAP_MAX_SEC = 0.025;   // el imán solo puede mover un límite menos de 25 ms
const EPS = 1e-6;

const MSG_TOO_SHORT = 'Ese compás es demasiado corto para esta canción.';
const MSG_TOO_LONG = 'Ese compás es demasiado largo: como máximo se puede duplicar el compás.';
const MSG_SAME = 'La canción ya está en ese compás.';
const MSG_BAD_NUM = 'El numerador del compás debe ser un número entero entre 1 y 32.';
const MSG_BAD_DEN = 'El denominador del compás debe ser 2, 4, 8 o 16.';
const MSG_BAD_SOURCE = 'No se conoce el compás original de la canción.';
const MSG_NO_BEATS = 'No hay beats detectados en la canción.';
const MSG_NO_BARS = 'No se detectaron compases en la canción.';
const MSG_NOTHING = 'No hay compases completos que cambiar.';
// Textos que la interfaz necesita reconocer
export const METER_MESSAGES = Object.freeze({ noBeats: MSG_NO_BEATS, noBars: MSG_NO_BARS, nothing: MSG_NOTHING });

// Figura cuya duración es 1/n de redonda.
const NOTE_NAMES = { 1: 'redonda', 2: 'blanca', 4: 'negra', 8: 'corchea', 16: 'semicorchea', 32: 'fusa' };

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}

function toInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) ? n : NaN;
}

// "Se quita la última corchea…", "Se repiten los últimos 2 tiempos…"
function changeText(delta, sourceUnits, isBeat, unitName) {
  const n = Math.abs(delta);
  if (delta > 0 && n === sourceUnits) return 'Se repite cada compás completo.';
  const verb = delta < 0 ? (n === 1 ? 'Se quita' : 'Se quitan') : (n === 1 ? 'Se repite' : 'Se repiten');
  let what;
  if (isBeat) what = n === 1 ? 'el último tiempo' : `los últimos ${n} tiempos`;
  else what = n === 1 ? `la última ${unitName}` : `las últimas ${n} ${unitName}s`;
  return `${verb} ${what} de cada compás.`;
}

export function describeMeterChange(beatsPerBar, targetNum, targetDen, sourceDen = 4) {
  const res = { unitsPerBeat: 0, sourceUnits: 0, targetUnits: 0, delta: 0, unitName: '', text: '', error: null };
  const bpb = toInt(beatsPerBar);
  const sDen = toInt(sourceDen);
  const tDen = toInt(targetDen);
  const tNum = toInt(targetNum);
  if (!(bpb >= 1 && bpb <= MAX_NUM) || !VALID_DENS.includes(sDen)) return { ...res, error: MSG_BAD_SOURCE };
  if (!VALID_DENS.includes(tDen)) return { ...res, error: MSG_BAD_DEN };
  // Numerador 0 o negativo cae en "demasiado corto" (abajo); no entero o > 32 es inválido.
  if (Number.isNaN(tNum) || tNum > MAX_NUM) return { ...res, error: MSG_BAD_NUM };

  const l = lcm(sDen, tDen);
  const k = l / sDen;
  const S = bpb * k;
  const T = tNum * (l / tDen);
  const delta = T - S;
  res.unitsPerBeat = k;
  res.sourceUnits = S;
  res.targetUnits = T;
  res.delta = delta;
  res.unitName = NOTE_NAMES[l] || '';

  if (delta < 0 && -delta > S - 1) res.error = MSG_TOO_SHORT;
  else if (delta > S) res.error = MSG_TOO_LONG;
  else if (delta === 0) res.text = MSG_SAME;
  else res.text = changeText(delta, S, k === 1, res.unitName);
  return res;
}

function isList(a) {
  return Array.isArray(a) || ArrayBuffer.isView(a);
}

function finiteOr(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return 0;
}

// Tiempo del límite de unidad u (0..S) dentro del compás que empieza en el beat b0:
// interpolación lineal dentro del beat; el final del último beat es el siguiente "1".
function unitTime(beats, b0, u, k) {
  const bi = Math.floor(u / k);
  const frac = (u - bi * k) / k;
  const t0 = beats[b0 + bi];
  return frac === 0 ? t0 : t0 + frac * (beats[b0 + bi + 1] - t0);
}

function noopPlan(end, delta, unitsPerBeat, error, info) {
  return {
    segments: end > 0 ? [{ start: 0, end }] : [],
    removed: [],
    repeated: [],
    barsChanged: 0,
    delta,
    unitsPerBeat,
    outputDuration: Math.max(0, end),
    error,
    info,
  };
}

export function planMeterChange(result, options = {}) {
  const { targetNum, targetDen, sourceDen = 4, limitTime = null, preroll = CUT_PREROLL_SEC, snap = null } = options || {};
  const r = result || {};
  const beats = isList(r.beats) ? r.beats : [];
  const nBeats = beats.length;
  const duration = Math.max(0, finiteOr(r.duration, r.musicEnd, nBeats ? beats[nBeats - 1] : 0));
  const hasLimit = limitTime !== null && limitTime !== undefined && Number.isFinite(limitTime);
  const end = hasLimit ? Math.min(Math.max(limitTime, 0), duration) : duration;
  const p = Number.isFinite(preroll) && preroll > 0 ? preroll : 0;

  const desc = describeMeterChange(r.beatsPerBar, targetNum, targetDen, sourceDen);
  const { delta, unitsPerBeat: k } = desc;
  if (!nBeats) return noopPlan(end, delta, k, MSG_NO_BEATS, null);
  if (desc.error) return noopPlan(end, delta, k, desc.error, null);
  if (delta === 0) return noopPlan(end, delta, k, null, MSG_SAME);

  // Mismo modelo de compases que el modo 1 (core/bars.js)
  const bars = getBars(r);
  if (!bars.length) return noopPlan(end, delta, k, MSG_NO_BARS, null);

  // Límite de transformación: el inicio del compás del golpe final (findLastBarIndex) o, si es antes, el corte del
  // modo 1. El compás final y su cola nunca se tocan, aunque el corte del modo 1 esté dentro de la cola.
  const last = findLastBarIndex(r);
  const limit = Math.min(end, bars[last >= 0 ? last : 0].start);

  const T = desc.targetUnits;
  const segments = [];
  const removed = [];
  const repeated = [];
  let barsChanged = 0;
  let cursor = 0;
  const push = (start, stop) => {
    const a = Math.max(0, start);
    const b = Math.min(stop, end);
    if (b - a > 1e-9) segments.push({ start: a, end: b });
  };

  for (let j = 0; j + 1 < bars.length; j++) {
    const b0 = bars[j].beatIndex;
    const b1 = bars[j + 1].beatIndex;
    const barStart = beats[b0];
    const barEnd = beats[b1];
    if (!(barEnd > barStart)) continue;
    // Solo compases completos que terminan antes del límite (tolerancia = pre-roll).
    if (barEnd - p > limit + EPS) break;
    const S = (b1 - b0) * k;       // cada compás usa su propia cantidad de beats
    const d = T - S;
    if (d === 0 || (d < 0 && -d > S - 1) || d > S) continue;
    const m = Math.abs(d);

    let cut = unitTime(beats, b0, S - m, k);
    if (!Number.isFinite(cut)) continue;
    if (typeof snap === 'function') {
      const s = snap(cut);
      if (Number.isFinite(s) && Math.abs(s - cut) < SNAP_MAX_SEC && s > barStart && s < barEnd) cut = s;
    }

    // Los empalmes van p segundos ANTES del límite musical para no comerse ataques.
    const a = Math.max(0, cut - p);
    const e = Math.min(barEnd - p, end);
    if (!(e > a)) continue;
    if (d < 0) {
      push(cursor, a);
      removed.push({ start: a, end: e });
    } else {
      push(cursor, e);
      push(a, e);
      repeated.push({ start: a, end: e });
    }
    cursor = e;
    barsChanged++;
  }
  push(cursor, end);

  if (!barsChanged) return noopPlan(end, delta, k, null, MSG_NOTHING);

  let outputDuration = 0;
  for (const s of segments) outputDuration += s.end - s.start;
  return { segments, removed, repeated, barsChanged, delta, unitsPerBeat: k, outputDuration, error: null, info: null };
}

// Posición en la salida de un instante de la fuente; null si ese audio se quitó.
// Si el audio se repite, devuelve la primera aparición.
export function sourceToOutputTime(segments, t) {
  if (!isList(segments) || !Number.isFinite(t)) return null;
  let acc = 0;
  let lastEnd = null;
  for (const s of segments) {
    const len = s.end - s.start;
    if (!(len > 0)) continue;
    if (t >= s.start && t < s.end) return acc + (t - s.start);
    acc += len;
    lastEnd = s.end;
  }
  if (lastEnd !== null && Math.abs(t - lastEnd) < 1e-9) return acc;
  return null;
}

// Instante de la fuente que suena en la posición t de la salida (se limita a [inicio, fin]).
export function outputToSourceTime(segments, t) {
  const list = isList(segments) ? segments : [];
  let x = Number.isNaN(t) ? 0 : t;
  let acc = 0;
  let lastEnd = null;
  for (const s of list) {
    const len = s.end - s.start;
    if (!(len > 0)) continue;
    if (x < acc + len) return s.start + Math.max(0, x - acc);
    acc += len;
    lastEnd = s.end;
  }
  return lastEnd !== null ? lastEnd : Math.max(0, Number.isFinite(x) ? x : 0);
}
