// Plan de edición de la app (puro, sin DOM): combina los dos modos —quitar compases del final (modo 1) y cambiar el
// compás (modo 2)— en UNA lista de segmentos de la fuente, que usan igual la exportación y la vista previa.
// También: ayudas de la vista previa (tiempo de salida ↔ original, clics del metrónomo), el tap tempo y textos.

import { planMeterChange, sourceToOutputTime, outputToSourceTime, METER_PRESETS, METER_MESSAGES } from '../core/meter.js';
import { CUT_PREROLL_SEC } from '../audio/edit.js';
import { refineToTransients } from '../analysis/bounds.js';
import { formatDuration, formatNumber } from './format.js';

export const XFADE_MS = Object.freeze({ min: 5, max: 40, def: 10 });   // "Suavizado de empalmes"
export const METER_DENS = Object.freeze([2, 4, 8, 16]);
export const METER_NUM_MAX = 32;
export const SNAP_WINDOW_SEC = 0.025;   // los límites internos se ajustan al ataque real más cercano (±25 ms)
// Margen entre el final del crossfade y el límite musical: el ataque real puede ir > 10 ms antes del beat detectado
export const SPLICE_GUARD_SEC = 0.015;
export const MANUAL_BPM = Object.freeze({ min: 30, max: 300 });
export const TAP = Object.freeze({ maxIntervals: 8, resetMs: 2000 });

// Opciones del selector: presets + "Otro"
export const METER_CHOICES = Object.freeze([
  ...METER_PRESETS.map((p) => Object.freeze({ id: `${p.num}/${p.den}`, num: p.num, den: p.den })),
  Object.freeze({ id: 'other', num: null, den: null }),
]);

export function meterLabel(num, den) {
  return Number.isFinite(num) && Number.isFinite(den) ? `${num}/${den}` : '–';
}

// Entero o NaN (acepta "7" y 7; rechaza "7.5", "", "abc")
export function parseIntStrict(v) {
  const s = typeof v === 'string' ? v.trim() : v;
  if (s === '' || s === null || s === undefined) return NaN;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}

// Compás elegido → { num, den } (con "Otro", lo que haya escrito el usuario; puede ser inválido y el plan lo dice)
export function targetMeter({ preset = '7/8', num, den } = {}) {
  const p = METER_CHOICES.find((c) => c.id === preset && c.id !== 'other');
  if (p) return { num: p.num, den: p.den };
  return { num: parseIntStrict(num), den: parseIntStrict(den) };
}

/**
 * Plan combinado.
 * @param {object} result AnalysisResult
 * @param {object} o { duration (s de la canción decodificada), mode1, cutTime, fadeSec, mode2, targetNum, targetDen,
 *                     crossfadeSec, snap }
 * @returns {{ segments, outputDuration, sourceEnd, meter: object|null, crossfadeSec, fadeOutSec, preroll }}
 *   segments: rangos de la fuente en orden de salida; meter: el plan de planMeterChange (null sin modo 2).
 */
export function buildEditPlan(result, {
  duration, mode1 = true, cutTime = null, fadeSec = 0, mode2 = false, targetNum, targetDen,
  crossfadeSec = XFADE_MS.def / 1000, snap = null,
} = {}) {
  const r = result || {};
  const dur = Number.isFinite(duration) && duration > 0 ? duration : Math.max(0, Number(r.duration) || 0);
  const useCut = !!mode1 && Number.isFinite(cutTime);
  const sourceEnd = useCut ? Math.min(Math.max(0, cutTime), dur) : dur;
  const xf = Math.max(0, Number(crossfadeSec) || 0);
  // el crossfade no debe llegar al ataque siguiente: el empalme va xf/2 + margen antes del límite musical, así el
  // "1" (y el ataque repetido) ya suena a ganancia plena. Todos los empalmes se mueven igual: la duración no cambia.
  const preroll = Math.max(CUT_PREROLL_SEC, xf / 2 + SPLICE_GUARD_SEC);
  let meter = null;
  let segments;
  if (mode2) {
    meter = planMeterChange({ ...r, duration: dur }, {
      targetNum, targetDen, limitTime: useCut ? sourceEnd : null, preroll, snap,
    });
    segments = meter.segments;
  } else {
    segments = sourceEnd > 0 ? [{ start: 0, end: sourceEnd }] : [];
  }
  let outputDuration = 0;
  for (const s of segments) outputDuration += s.end - s.start;
  return {
    segments, outputDuration, sourceEnd, meter, preroll,
    crossfadeSec: xf,
    fadeOutSec: useCut ? Math.max(0, Number(fadeSec) || 0) : 0,
  };
}

// ¿Hay algo que exportar? Devuelve null si sí, o el motivo (texto para el usuario) si no.
export function exportBlocker(plan, { mode1, mode2 }) {
  if (!mode1 && !mode2) return 'Activa «Quitar compases del final» o «Cambiar el compás» para poder descargar.';
  const m = plan && plan.meter;
  if (mode2 && m && (m.error === METER_MESSAGES.noBeats || m.error === METER_MESSAGES.noBars)) {
    // ningún compás serviría: el problema es la cuadrícula, no el compás elegido
    return 'Sin beats ni compases detectados no se puede cambiar el compás: desactiva «Cambiar el compás» para guardar.';
  }
  if (mode2 && m && m.error) return 'Elige un compás válido o desactiva «Cambiar el compás».';
  if (!mode1 && mode2 && (!m || !m.barsChanged)) return 'Con ese compás la canción no cambia: elige otro compás.';
  if (!plan || !(plan.outputDuration > 0)) return 'No queda audio que guardar.';
  return null;
}

// ¿El modo 2 cambia algo de verdad? (para el nombre del archivo y los textos)
export function meterApplies(plan) {
  const m = plan && plan.meter;
  return !!(m && !m.error && m.barsChanged > 0);
}

// Posición de la salida desde la que empezar a escuchar: la del cabezal (tiempo del original); si cae en audio
// quitado, el siguiente punto que se conserva; si está al final o fuera, los últimos `tailSec` segundos.
export function previewStartTime(segments, sourceTime, outputDuration, tailSec = 8) {
  const tail = Math.max(0, outputDuration - tailSec);
  if (!Number.isFinite(sourceTime) || !segments || !segments.length) return tail;
  let o = sourceToOutputTime(segments, sourceTime);
  if (o === null) {
    let acc = 0;
    for (const s of segments) {
      const len = s.end - s.start;
      if (!(len > 0)) continue;
      if (s.start >= sourceTime) {
        o = acc;
        break;
      }
      acc += len;
    }
  }
  if (o === null || o >= outputDuration - 0.05) return tail;
  return Math.max(0, o);
}

// Función salida → original para el cabezal durante la vista previa
export function outputToSourceFn(segments) {
  return (t) => outputToSourceTime(segments, t);
}

function lowerBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// Beats de la fuente llevados a la línea de tiempo de la salida (los repetidos suenan dos veces; los quitados, no).
// accents: índices (de la lista nueva) que son "1".
export function mapBeatsToOutput(segments, beats, downbeatSet) {
  const out = [];
  const accents = new Set();
  if (!segments || !beats || !beats.length) return { beats: out, accents };
  let acc = 0;
  for (const s of segments) {
    const len = s.end - s.start;
    if (!(len > 0)) continue;
    for (let i = lowerBound(beats, s.start); i < beats.length && beats[i] < s.end; i++) {
      if (downbeatSet && downbeatSet.has(i)) accents.add(out.length);
      out.push(acc + (beats[i] - s.start));
    }
    acc += len;
  }
  return { beats: out, accents };
}

// Imán de los límites internos: ataque real más cercano (±window) con el detector de transitorios del análisis,
// sobre una mezcla mono de un trozo corto de la fuente alrededor del instante (no se copia la canción entera).
export function makeTransientSnap(channels, sampleRate, { window = SNAP_WINDOW_SEC } = {}) {
  const chans = Array.from(channels || []);
  const sr = Number(sampleRate);
  if (!chans.length || !(sr > 0)) return null;
  const n = Math.min(...chans.map((c) => c.length));
  const margin = window + 0.03;   // bloques previos/posteriores que mira el detector
  return (t) => {
    if (!Number.isFinite(t)) return t;
    const i0 = Math.max(0, Math.floor((t - margin) * sr));
    const i1 = Math.min(n, Math.ceil((t + margin) * sr));
    if (i1 - i0 < 16) return t;
    const mono = new Float32Array(i1 - i0);
    for (const c of chans) for (let i = i0; i < i1; i++) mono[i - i0] += c[i];
    if (chans.length > 1) for (let i = 0; i < mono.length; i++) mono[i] /= chans.length;
    const off = i0 / sr;
    const v = refineToTransients(mono, sr, [t - off], { window })[0];
    return Number.isFinite(v) ? v + off : t;
  };
}

// Tap tempo: toques (ms) → { taps, bpm }. Mediana de los últimos 8 intervalos; se reinicia tras 2 s sin toques.
export function tapTempo(taps, now, { maxIntervals = TAP.maxIntervals, resetMs = TAP.resetMs } = {}) {
  let list = Array.isArray(taps) ? taps.filter((x) => Number.isFinite(x)) : [];
  if (!Number.isFinite(now)) return { taps: list, bpm: bpmFromTaps(list) };
  if (list.length && (now - list[list.length - 1] > resetMs || now <= list[list.length - 1])) list = [];
  list = [...list, now].slice(-(maxIntervals + 1));
  return { taps: list, bpm: bpmFromTaps(list) };
}

function bpmFromTaps(list) {
  if (list.length < 2) return null;
  const d = [];
  for (let i = 1; i < list.length; i++) d.push(list[i] - list[i - 1]);
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  const med = d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
  if (!(med > 0)) return null;
  return Math.round((60000 / med) * 10) / 10;
}

// "97,5" / "97.5" / 97.5 → número dentro del rango, o null
export function parseBpm(v) {
  const s = typeof v === 'string' ? v.trim().replace(',', '.') : v;
  if (s === '' || s === null || s === undefined) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < MANUAL_BPM.min || n > MANUAL_BPM.max) return null;
  return Math.round(n * 10) / 10;
}

// "1:04 → 0:57"
export function durationChange(before, after) {
  return `${formatDuration(before)} → ${formatDuration(after)}`;
}

// "Se cambian 28 compases" / "Se cambia 1 compás"
export function barsChangedText(n) {
  if (!(n > 0)) return 'No cambia ningún compás';
  return n === 1 ? 'Se cambia 1 compás' : `Se cambian ${formatNumber(n, 0)} compases`;
}

// "Original: 4/4 → Nuevo: 7/8"
export function meterChangeLabel(beatsPerBar, num, den) {
  const orig = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? `${beatsPerBar}/4` : '–';
  const nu = Number.isFinite(num) && Number.isFinite(den) ? `${num}/${den}` : '?';
  return `Original: ${orig} → Nuevo: ${nu}`;
}
