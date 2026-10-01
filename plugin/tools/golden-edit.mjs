// Datos golden del motor de recorte para los tests de paridad del port a C++ (plugin/tests/core/edit_plan_test.cpp).
//
//   node plugin/tools/golden-edit.mjs <directorio de salida>
//
// Ejecuta la implementación WEB (js/core/bars.js, js/core/meter.js, js/ui/edit-plan.js, js/ui/format.js,
// js/audio/edit.js, js/audio/splice.js) sobre entradas fijas y escribe en <salida>/edit/:
//   edit.json      constantes, describeMeterChange, botones (meterAmountChips), targetMeter, curvas de fade,
//                  cuadrículas (getBars, findLastBarIndex, cutForBarsRemoved, barsRemovedAt, nearest/step…),
//                  planes de planMeterChange y planes completos (lo que hace main.js con el estado de la interfaz:
//                  corte del modo 1, fade en beats → segundos, buildEditPlan, exportBlocker)
//   input.f32      señal sintética estéreo de 44,1 kHz (canales planos, float32 little-endian)
//   renders.f32    salidas de renderSegments de cada caso de edit.json.renders (planas, una tras otra)
// Nada de esto se versiona (va al directorio de build).
import fs from 'node:fs';
import path from 'node:path';
import {
  LAST_BAR_TOLERANCE, getBars, findLastBarIndex, cutForBarsRemoved, barsRemovedAt, nearestBeatIndex, stepBeat, stepBar,
} from '../../js/core/bars.js';
import {
  describeMeterChange, planMeterChange, sourceToOutputTime, outputToSourceTime, SNAP_MAX_SEC,
} from '../../js/core/meter.js';
import {
  XFADE_MS, DEFAULT_METER_AMOUNT, SPLICE_GUARD_SEC, SNAP_WINDOW_SEC, buildEditPlan, exportBlocker, meterApplies,
  meterAmountChips, targetMeter, makeTransientSnap,
} from '../../js/ui/edit-plan.js';
import { FADE_BEAT_STEPS, fadeBeatsToSeconds, medianBeatInterval, clamp } from '../../js/ui/format.js';
import { CUT_PREROLL_SEC, ANTICLICK_SEC, fadeGain, fadeOutGains } from '../../js/audio/edit.js';
import { renderSegments, renderedLength, SPLICE_CEILING } from '../../js/audio/splice.js';

const outRoot = process.argv[2];
if (!outRoot) {
  console.error('uso: node plugin/tools/golden-edit.mjs <directorio de salida>');
  process.exit(2);
}
const OUT = path.join(outRoot, 'edit');
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------------------- cuadrículas

// AnalysisResult sintético (como tests/meter.test.js). barBeats: beats de cada compás (el último es el compás final).
function makeResult({ pickup = 2, barBeats = [...Array(16).fill(4), 4], beatsPerBar = 4, beatTime = (i) => 0.3 + i * 0.5,
  tail = 2, lastOnset = 'final', bpm = 120, musicEndFactor = 0.8, useDownbeats = true } = {}) {
  const beats = [];
  const positions = [];
  const downbeats = [];
  for (let i = 0; i < pickup; i++) positions.push(beatsPerBar - pickup + i);
  for (const n of barBeats) {
    downbeats.push(positions.length);
    for (let i = 0; i < n; i++) positions.push(i);
  }
  for (let i = 0; i < positions.length; i++) beats.push(beatTime(i));
  const last = beats[beats.length - 1];
  let lo;
  if (lastOnset === 'final') lo = beats[downbeats[downbeats.length - 1]] + 0.01;
  else lo = lastOnset;
  return {
    duration: last + tail,
    musicStart: beats[0],
    musicEnd: last + tail * musicEndFactor,
    lastOnset: lo,
    bpm,
    beats,
    beatStrength: beats.map(() => 1),
    beatsPerBar,
    positions,
    downbeats: useDownbeats ? downbeats : [],
  };
}

const grids = [];
const addGrid = (name, r) => grids.push({ name, r });

addGrid('regular-4-4', makeResult());
addGrid('drift-4-4', makeResult({
  pickup: 1, barBeats: [...Array(20).fill(4), 4], bpm: 112,
  beatTime: (i) => 0.4 + i * 0.5 * (1 + 0.004 * i) + 0.006 * Math.sin(i * 1.7),
}));
addGrid('irregular-4-4', makeResult({ pickup: 0, barBeats: [4, 4, 3, 4, 5, 4, 4, 2, 4, 4, 4], tail: 3 }));
for (let m = 2; m <= 7; m++) {
  addGrid(`regular-${m}-4`, makeResult({
    pickup: 1, beatsPerBar: m, barBeats: [...Array(12).fill(m), m], beatTime: (i) => 0.25 + i * 0.45, bpm: 133.3,
  }));
}
// golpe final en el compás 9 de 17: lo que sigue (cola con beats) no se transforma
addGrid('early-final-hit', makeResult({ pickup: 0, barBeats: [...Array(16).fill(4), 4], lastOnset: 0.3 + 8 * 4 * 0.5 + 0.03 }));
addGrid('no-last-onset', makeResult({ pickup: 3, lastOnset: null }));
addGrid('two-bars', makeResult({ pickup: 0, barBeats: [4, 4], tail: 1.5 }));
addGrid('one-bar', makeResult({ pickup: 1, barBeats: [4], tail: 1.5 }));
addGrid('positions-only', makeResult({ pickup: 2, barBeats: [...Array(6).fill(3), 3], beatsPerBar: 3, useDownbeats: false }));
{
  const r = makeResult({ pickup: 0, barBeats: [4, 4, 4, 4] });
  r.positions = r.positions.map(() => 1);
  r.downbeats = [];
  addGrid('no-downbeats', r);
}
addGrid('empty', { duration: 30, musicStart: 0, musicEnd: 29, lastOnset: 28, bpm: 0, beats: [], beatStrength: [],
  beatsPerBar: 4, positions: [], downbeats: [] });
// grabación en vivo a 92 BPM con deriva fuerte y compases irregulares
addGrid('live-3-4', makeResult({
  pickup: 2, beatsPerBar: 3, barBeats: [3, 3, 3, 4, 3, 3, 2, 3, 3, 3, 3, 3], bpm: 92,
  beatTime: (i) => 1.1 + i * 0.652 * (1 - 0.0025 * i) + 0.012 * Math.sin(i * 2.3),
}));
// cuadrícula de la señal de los renders (5 s): 240 BPM, "1" en 0.2 s
addGrid('render', makeResult({ pickup: 0, barBeats: [4, 4, 4, 2], beatTime: (i) => 0.2 + i * 0.25, tail: 1.2, bpm: 240 }));

function gridOut(r) {
  const bars = getBars(r);
  const times = [];
  const beats = r.beats || [];
  const t0 = beats.length ? beats[0] : 0;
  const t1 = beats.length ? beats[beats.length - 1] : 10;
  for (let k = -2; k <= 42; k++) times.push(t0 - 0.7 + ((t1 - t0 + 1.4) * k) / 40);
  for (const b of beats.slice(0, 12)) times.push(b, b + 0.0004, b - 0.0004, b + 0.002);
  times.push(NaN);
  const cuts = [];
  for (let n = -1; n <= 22; n++) cuts.push([n, cutForBarsRemoved(r, n)]);
  const step = [];
  for (const t of times) for (const d of [-3, -1, 0, 1, 2, 5]) step.push([t, d, stepBeat(r, t, d), stepBar(r, t, d)]);
  return {
    bars,
    lastBarIndex: findLastBarIndex(r),
    cuts,
    removedAt: times.map((t) => [t, barsRemovedAt(r, t)]),
    nearest: times.map((t) => [t, nearestBeatIndex(r, t)]),
    step,
  };
}

// --------------------------------------------------------------------------------------- planes de compás

const EXTRA_TARGETS = [[7, 8], [3, 4], [5, 4], [15, 16], [9, 8], [1, 4], [13, 8], [4, 2], [33, 4], [7, 3], [0, 4], [2, 2],
  [6, 8], [11, 16]];

function planOut(p) {
  return {
    segments: p.segments, removed: p.removed, repeated: p.repeated, barsChanged: p.barsChanged, delta: p.delta,
    unitsPerBeat: p.unitsPerBeat, outputDuration: p.outputDuration, error: p.error, info: p.info,
  };
}

const meterPlans = [];
grids.forEach((g, gi) => {
  const r = g.r;
  const targets = meterAmountChips(r.beatsPerBar).filter((c) => c.id !== 'other').map((c) => [c.num, c.den]);
  for (const t of EXTRA_TARGETS) if (!targets.some((x) => x[0] === t[0] && x[1] === t[1])) targets.push(t);
  const bars = getBars(r);
  const limits = [null];
  if (bars.length > 4) limits.push(bars[3].start - 0.02, bars[bars.length - 2].start + 0.1, 0);   // C++: < 0 = sin límite
  for (const [num, den] of targets) {
    for (const limitTime of limits) {
      for (const preroll of [CUT_PREROLL_SEC, 0.004, 0.035]) {
        if (limitTime !== null && preroll !== CUT_PREROLL_SEC) continue;
        const p = planMeterChange(r, { targetNum: num, targetDen: den, limitTime, preroll });
        meterPlans.push({ grid: gi, targetNum: num, targetDen: den, sourceDen: 4, limitTime, preroll, plan: planOut(p) });
      }
    }
  }
});
// fuente en x/8 (cuadrícula de FL en 7/8 o 6/8)
{
  const gi = grids.findIndex((g) => g.name === 'regular-7-4');
  for (const [num, den] of [[13, 16], [6, 8], [5, 8], [8, 8], [7, 8], [3, 4], [7, 4], [9, 16]]) {
    const p = planMeterChange(grids[gi].r, { targetNum: num, targetDen: den, sourceDen: 8, preroll: CUT_PREROLL_SEC });
    meterPlans.push({ grid: gi, targetNum: num, targetDen: den, sourceDen: 8, limitTime: null, preroll: CUT_PREROLL_SEC,
      plan: planOut(p) });
  }
}

// sourceToOutputTime / outputToSourceTime sobre algunos planes
const timeMaps = [];
for (const mp of meterPlans.filter((_, i) => i % 37 === 0)) {
  const segs = mp.plan.segments;
  const end = segs.length ? segs[segs.length - 1].end : 1;
  const ts = [];
  for (let k = -2; k <= 60; k++) ts.push((end * k) / 57);
  for (const s of segs.slice(0, 6)) ts.push(s.start, s.end, s.end - 1e-10);
  timeMaps.push({
    segments: segs,
    s2o: ts.map((t) => [t, sourceToOutputTime(segs, t)]),
    o2s: ts.map((t) => [t, outputToSourceTime(segs, t)]),
  });
}

// ------------------------------------------------------------- planes completos (estado de la interfaz → plan)

// Lo que hace js/main.js: targetMeter, setCutBars (o el corte a mano por defecto), currentFadeSec, buildEditPlan,
// exportBlocker. Settings con los nombres de djec::EditSettings.
function pluginPlan(r, s, snap = null) {
  const tm = targetMeter({ amount: s.amount, num: s.otherNum, den: s.otherDen }, r.beatsPerBar);
  const dur = r.duration;
  let cut = null;
  if (s.removeEnd) {
    const lastBarIndex = findLastBarIndex(r);
    let c = null;
    if (lastBarIndex >= 1) c = cutForBarsRemoved(r, s.barsToRemove);
    if (c && Number.isFinite(c.time)) {
      cut = { time: Math.max(0, c.time - CUT_PREROLL_SEC), n: Math.max(1, lastBarIndex - c.barIndex + 1), fromBars: true };
    } else {
      const t = Number.isFinite(r.lastOnset) && r.lastOnset > 0.5 ? r.lastOnset - CUT_PREROLL_SEC : Math.max(0.05, dur - 1);
      cut = { time: clamp(t, 0.05, dur), n: 0, fromBars: false };
    }
  }
  const fadeSec = cut ? fadeBeatsToSeconds(s.fadeBeats, r.beats, cut.time, r.bpm) : 0;
  const plan = buildEditPlan(r, {
    duration: dur, mode1: !!cut, cutTime: cut ? cut.time : null, fadeSec, mode2: s.trimEachBar,
    targetNum: tm.num, targetDen: tm.den, crossfadeSec: s.crossfadeSec, snap,
  });
  const blocker = exportBlocker(plan, { mode1: s.removeEnd, mode2: s.trimEachBar });
  return {
    target: tm,
    cutTime: cut ? cut.time : -1,
    cutFromBars: cut ? cut.fromBars : false,
    barsRemoved: cut ? cut.n : 0,
    fadeSec,
    segments: plan.segments,
    outputDuration: plan.outputDuration,
    sourceEnd: plan.sourceEnd,
    preroll: plan.preroll,
    crossfadeSec: plan.crossfadeSec,
    fadeOutSec: plan.fadeOutSec,
    meter: plan.meter ? planOut(plan.meter) : null,
    meterApplies: meterApplies(plan),
    blocker,
  };
}

const AMOUNTS = ['eighth', 'beat', 'two-beats', 'sixteenth', 'extend', 'other', 'nope'];
const OTHERS = [[15, 16], [7, 8], [33, 4], [7, 3], [4, 4], [0, 8]];
const base = { trimEachBar: true, amount: 'eighth', otherNum: 7, otherDen: 8, crossfadeSec: 0.010, removeEnd: false,
  barsToRemove: 1, fadeBeats: 0, curve: 'smooth' };
const editPlans = [];
grids.forEach((g, gi) => {
  const r = g.r;
  const add = (o) => {
    const settings = { ...base, ...o };
    editPlans.push({ grid: gi, settings, plan: pluginPlan(r, settings) });
  };
  for (const amount of AMOUNTS) {
    if (amount === 'other') for (const [n, d] of OTHERS) add({ amount, otherNum: n, otherDen: d });
    else add({ amount });
  }
  for (const xf of [0.005, 0.016, 0.04, 0]) add({ crossfadeSec: xf });
  add({ amount: 'extend', crossfadeSec: 0.04 });
  for (const n of [1, 2, 4, 16, 40, 0]) {
    add({ trimEachBar: false, removeEnd: true, barsToRemove: n, fadeBeats: n === 2 ? 2 : 0 });
    add({ trimEachBar: true, removeEnd: true, barsToRemove: n, fadeBeats: 0.5 });
  }
  for (const fb of FADE_BEAT_STEPS) add({ removeEnd: true, barsToRemove: 2, fadeBeats: fb, curve: 'exp' });
  add({ trimEachBar: false, removeEnd: false });
  add({ amount: 'beat', removeEnd: true, barsToRemove: 3, fadeBeats: 4, crossfadeSec: 0.025, curve: 'linear' });
  add({ amount: 'other', otherNum: 33, otherDen: 4, removeEnd: true, barsToRemove: 1 });
});

// medianBeatInterval / fadeBeatsToSeconds sueltos
const ibiCases = [];
for (const g of grids) {
  const b = g.r.beats;
  for (const t of [-1, 0, 0.31, 2.5, 7.77, 15, 40, b.length ? b[b.length - 1] : 3]) {
    for (const count of [8, 3]) ibiCases.push({ beats: b, t, count, bpm: g.r.bpm, v: medianBeatInterval(b, t, count, g.r.bpm) });
    ibiCases.push({ beats: b, t, fadeBeats: 3, bpm: g.r.bpm, fade: fadeBeatsToSeconds(3, b, t, g.r.bpm) });
  }
}
ibiCases.push({ beats: [1], t: 0, count: 8, bpm: 0, v: medianBeatInterval([1], 0, 8, 0) });
ibiCases.push({ beats: [1, 1, 1], t: 0, count: 8, bpm: 90, v: medianBeatInterval([1, 1, 1], 0, 8, 90) });

// ------------------------------------------------------------------------------------------ describe / botones

const describe = [];
for (const bpb of [0, 1, 2, 3, 4, 5, 6, 7, 9, 32, 33]) {
  for (const sDen of [2, 4, 8, 16, 3]) {
    for (const den of [2, 4, 8, 16, 3, 32]) {
      for (let num = -1; num <= 33; num++) {
        const d = describeMeterChange(bpb, num, den, sDen);
        describe.push([bpb, num, den, sDen, d.unitsPerBeat, d.sourceUnits, d.targetUnits, d.delta, d.unitName, d.text,
          d.error]);
      }
    }
  }
}
const chips = [];
for (const bpb of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 32, 33]) chips.push({ bpb, chips: meterAmountChips(bpb) });
const targets = [];
for (let bpb = 1; bpb <= 9; bpb++) {
  for (const amount of AMOUNTS) {
    for (const [num, den] of amount === 'other' ? OTHERS : [[7, 8]]) {
      targets.push({ bpb, amount, num, den, out: targetMeter({ amount, num, den }, bpb) });
    }
  }
}

// ------------------------------------------------------------------------------------------------- fades

const xs = [];
for (let k = -2; k <= 202; k++) xs.push(k / 200);
xs.push(NaN, 1e-9, 0.999999);
const curves = ['linear', 'smooth', 'exp', 'otra'];
const fade = { xs, gains: Object.fromEntries(curves.map((c) => [c, xs.map((x) => Math.fround(fadeGain(x, c)))])) };
const fadeOut = [];
for (const len of [1, 2, 7, 220, 441]) {
  for (const curve of curves) {
    fadeOut.push({ len, curve, from: 0, to: len, gains: Array.from(fadeOutGains(len, curve)) });
  }
}
fadeOut.push({ len: 441, curve: 'exp', from: 100, to: 300, gains: Array.from(fadeOutGains(441, 'exp', 100, 300)) });
fadeOut.push({ len: 50, curve: 'linear', from: 60, to: 80, gains: Array.from(fadeOutGains(50, 'linear', 60, 80)) });

// ------------------------------------------------------------------------------------------------ renders

const SR = 44100;
const N = 5 * SR;
function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}
const L = new Float32Array(N);
const R = new Float32Array(N);
{
  const nz = xorshift(12345);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const beatPh = ((t - 0.2) / 0.25) - Math.floor((t - 0.2) / 0.25);
    const env = t >= 0.2 ? Math.exp(-beatPh * 6) : 0;
    const bar = Math.floor((t - 0.2) / 1);
    const f = 110 * (1 + ((bar * 3) % 5) / 4);
    let l = 0.35 * Math.sin(2 * Math.PI * f * t) * (0.4 + 0.6 * env) + 0.25 * nz() * env * env;
    let r = 0.3 * Math.sin(2 * Math.PI * f * 1.5 * t + 0.4) * (0.5 + 0.5 * env) + 0.2 * nz() * env;
    // golpe corto 12 ms después de cada "y" (para el imán de transitorios)
    const andPh = ((t - 0.337) / 0.25) - Math.floor((t - 0.337) / 0.25);
    const andEnv = t >= 0.337 ? Math.exp(-andPh * 60) : 0;
    const burst = nz() * andEnv;
    l += 0.3 * burst;
    r += 0.25 * burst;
    // tramo "a tope" (master limitado): 2,5–3,5 s
    if (t >= 2.5 && t < 3.5) {
      const ph = (2 * Math.PI * i) / 441;
      l = Math.max(-0.97, Math.min(0.97, 1.3 * (Math.sin(ph) + 0.4 * Math.sin(3 * ph + 0.7)) + 0.08 * nz()));
      r = Math.max(-0.97, Math.min(0.97, 1.2 * Math.sin(ph + 0.3) + 0.08 * nz()));
    }
    L[i] = l;
    R[i] = r;
  }
}
fs.writeFileSync(path.join(OUT, 'input.f32'), Buffer.concat([Buffer.from(L.buffer), Buffer.from(R.buffer)]));

// imán de transitorios (makeTransientSnap) sobre esa señal, y planes con imán
const snapFn = makeTransientSnap([L, R], SR);
const snapCases = [];
for (let k = -3; k <= 140; k++) snapCases.push([k * 0.0371, snapFn(k * 0.0371)]);
for (const t of [NaN, 4.999, 5.2, 0.2, 0.45, 1.2, 0.325, 0.3125]) snapCases.push([t, snapFn(t)]);
const snapPlans = [];
const renderGrid = grids.findIndex((g) => g.name === 'render');
for (const o of [{}, { amount: 'beat' }, { amount: 'extend', crossfadeSec: 0.04 }, { amount: 'sixteenth' },
  { removeEnd: true, barsToRemove: 1, fadeBeats: 1 }]) {
  const settings = { ...base, ...o };
  snapPlans.push({ grid: renderGrid, settings, plan: pluginPlan(grids[renderGrid].r, settings, snapFn) });
}

const renderCases = [];
const renderBufs = [];
let renderOffset = 0;
function addRender(name, segments, { crossfadeSec = 0.010, fadeOutSec = 0, curve = 'smooth' } = {}) {
  const out = renderSegments([L, R], SR, segments, { crossfadeSec, fadeOutSec, curve });
  const length = out[0].length;
  if (length !== renderedLength(segments, SR)) throw new Error(`renderedLength ${name}`);
  renderCases.push({ name, segments, crossfadeSec, fadeOutSec, curve, offset: renderOffset, length });
  for (const ch of out) {
    renderBufs.push(Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength));
    renderOffset += ch.length;
  }
}
{
  const gi = grids.findIndex((g) => g.name === 'render');
  const r = grids[gi].r;
  const cases = [
    ['plan-eighth', {}],
    ['plan-beat-xf5', { amount: 'beat', crossfadeSec: 0.005 }],
    ['plan-extend-xf40', { amount: 'extend', crossfadeSec: 0.04 }],
    ['plan-sixteenth', { amount: 'sixteenth' }],
    ['plan-other-15-16', { amount: 'other', otherNum: 15, otherDen: 16 }],
    ['plan-two-beats-xf0', { amount: 'two-beats', crossfadeSec: 0 }],
    ['plan-both-smooth', { removeEnd: true, barsToRemove: 2, fadeBeats: 2 }],
    ['plan-both-exp', { removeEnd: true, barsToRemove: 1, fadeBeats: 4, curve: 'exp' }],
    ['plan-end-linear', { trimEachBar: false, removeEnd: true, barsToRemove: 2, fadeBeats: 1, curve: 'linear' }],
    ['plan-end-dry', { trimEachBar: false, removeEnd: true, barsToRemove: 3, fadeBeats: 0 }],
    ['plan-eighth-snap', { snap: true }],
  ];
  for (const [name, o] of cases) {
    const s = { ...base, ...o };
    const p = pluginPlan(r, s, o.snap ? snapFn : null);
    addRender(name, p.segments, { crossfadeSec: p.crossfadeSec, fadeOutSec: p.fadeOutSec, curve: s.curve });
  }
}
addRender('out-of-range', [{ start: -0.2, end: 0.5 }, { start: 0.7, end: 1.4 }, { start: 4.5, end: 5.6 }, { start: 1.3, end: 2 }],
  { crossfadeSec: 0.02, fadeOutSec: 0.3, curve: 'linear' });
addRender('short-segments', [{ start: 0, end: 0.5 }, { start: 0.9, end: 0.903 }, { start: 1.5, end: 1.5011 },
  { start: 2.2, end: 2.21 }, { start: 3, end: 4 }], { crossfadeSec: 0.04 });
addRender('contiguous', [{ start: 0, end: 1.25 }, { start: 1.25, end: 2.5 }, { start: 2.5000226, end: 4 }],
  { crossfadeSec: 0.03, fadeOutSec: 0 });
addRender('odd-times', [{ start: 0.1234567, end: 0.9876543 }, { start: 1.1111111, end: 2.2222222 },
  { start: 2.2222222, end: 3.3333333 }, { start: 0.5, end: 0.50001 }], { crossfadeSec: 0.0123, fadeOutSec: 0.111, curve: 'exp' });
{
  const segs = [];
  for (let k = 0; k < 6; k++) segs.push({ start: 2.51 + k * 0.15, end: 2.51 + k * 0.15 + 0.12 });
  for (const xf of [0.005, 0.01, 0.04]) addRender(`master-xf${xf * 1000}`, segs, { crossfadeSec: xf });
}
addRender('fade-longer-than-output', [{ start: 1, end: 1.5 }, { start: 2, end: 2.2 }], { fadeOutSec: 5, curve: 'smooth' });
addRender('fade-other-curve', [{ start: 0, end: 3 }], { fadeOutSec: 1.5, curve: 'otra' });
addRender('empty', [], {});
addRender('reversed-and-empty', [{ start: 2, end: 1 }, { start: 3, end: 3 }, { start: 4, end: 4.5 }], {});
addRender('whole', [{ start: 0, end: 5 }], { crossfadeSec: 0.01, fadeOutSec: 0 });
fs.writeFileSync(path.join(OUT, 'renders.f32'), Buffer.concat(renderBufs));

// ------------------------------------------------------------------------------------------------- salida

const golden = {
  version: 1,
  constants: {
    CUT_PREROLL_SEC, ANTICLICK_SEC, LAST_BAR_TOLERANCE, SPLICE_GUARD_SEC, SPLICE_CEILING, SNAP_MAX_SEC, SNAP_WINDOW_SEC,
    XFADE_MS, DEFAULT_METER_AMOUNT, FADE_BEAT_STEPS,
  },
  describe,
  chips,
  targets,
  fade,
  fadeOut,
  grids: grids.map((g) => ({ name: g.name, result: g.r, ...gridOut(g.r) })),
  meterPlans,
  timeMaps,
  editPlans,
  snapCases,
  snapPlans,
  ibiCases,
  renders: { sampleRate: SR, inputLength: N, channels: 2, cases: renderCases },
};
fs.writeFileSync(path.join(OUT, 'edit.json'), JSON.stringify(golden));
const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
console.log(`golden-edit: ${grids.length} cuadrículas, ${meterPlans.length} planes de compás, ${editPlans.length} planes ` +
  `completos, ${renderCases.length} renders (edit.json ${kb('edit.json')} KB, renders.f32 ${kb('renders.f32')} KB)`);
