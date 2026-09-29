import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METER_PRESETS, describeMeterChange, planMeterChange, sourceToOutputTime, outputToSourceTime,
} from '../js/core/meter.js';

const P = 0.004;
const TOO_SHORT = 'Ese compás es demasiado corto para esta canción.';
const TOO_LONG = 'Ese compás es demasiado largo: como máximo se puede duplicar el compás.';
const SAME = 'La canción ya está en ese compás.';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} ≉ ${b} (±${eps})`);

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function lcm(a, b) { return (a * b) / gcd(a, b); }

// AnalysisResult sintético. barBeats: beats de cada compás (el último es el compás final, sin "1" siguiente).
function makeResult({ pickup = 2, barBeats = [...Array(16).fill(4), 4], beatsPerBar = 4,
                      beatTime = (i) => 0.3 + i * 0.5, tail = 2, lastOnset } = {}) {
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
  const res = {
    duration: last + tail, musicStart: beats[0], musicEnd: last + tail * 0.8, bpm: 120, beats,
    beatsPerBar, positions, downbeats,
  };
  if (lastOnset !== undefined) res.lastOnset = lastOnset;
  return res;
}

function checkInvariants(plan, end, { exactEnd = true } = {}) {
  let sum = 0;
  for (const s of plan.segments) {
    assert.ok(s.start >= 0 && s.end <= end + 1e-9 && s.end > s.start, `bad segment ${JSON.stringify(s)}`);
    sum += s.end - s.start;
  }
  close(plan.outputDuration, sum, 1e-9);
  if (plan.segments.length) {
    assert.equal(plan.segments[0].start, 0);
    const last = plan.segments[plan.segments.length - 1].end;
    if (exactEnd) close(last, end, 1e-9);
    else assert.ok(last <= end + 1e-9);
  }
}

const coverage = (segments, t) => segments.filter((s) => t >= s.start && t < s.end).length;

// ---------------------------------------------------------------- describeMeterChange

test('METER_PRESETS', () => {
  assert.deepEqual(METER_PRESETS, [{ num: 7, den: 8 }, { num: 3, den: 4 }, { num: 5, den: 4 }]);
});

test('describeMeterChange: unidades por mcm para todos los denominadores y numeradores', () => {
  const names = { 4: 'negra', 8: 'corchea', 16: 'semicorchea' };
  for (const den of [2, 4, 8, 16]) {
    for (let bpb = 2; bpb <= 7; bpb++) {
      for (let num = 1; num <= 32; num++) {
        const d = describeMeterChange(bpb, num, den);
        const l = lcm(4, den);
        const k = l / 4;
        const S = bpb * k;
        const T = num * (l / den);
        const delta = T - S;
        const ctx = `${bpb}/4 → ${num}/${den}`;
        assert.equal(d.unitsPerBeat, k, ctx);
        assert.equal(d.sourceUnits, S, ctx);
        assert.equal(d.targetUnits, T, ctx);
        assert.equal(d.delta, delta, ctx);
        assert.equal(Math.sign(d.delta), Math.sign(T - S), ctx);
        assert.equal(d.unitName, names[l], ctx);
        if (delta > S) {
          assert.equal(d.error, TOO_LONG, ctx);
          assert.equal(d.text, '', ctx);
          continue;
        }
        assert.equal(d.error, null, ctx);
        if (delta === 0) { assert.equal(d.text, SAME, ctx); continue; }
        const n = Math.abs(delta);
        if (delta === S) { assert.equal(d.text, 'Se repite cada compás completo.', ctx); continue; }
        const verb = delta < 0 ? (n === 1 ? 'Se quita' : 'Se quitan') : (n === 1 ? 'Se repite' : 'Se repiten');
        const noun = k === 1
          ? (n === 1 ? 'el último tiempo' : `los últimos ${n} tiempos`)
          : (n === 1 ? `la última ${names[l]}` : `las últimas ${n} ${names[l]}s`);
        assert.equal(d.text, `${verb} ${noun} de cada compás.`, ctx);
      }
    }
  }
});

test('describeMeterChange: textos concretos', () => {
  const cases = [
    [4, 7, 8, { delta: -1, unitsPerBeat: 2, sourceUnits: 8, targetUnits: 7, unitName: 'corchea',
      text: 'Se quita la última corchea de cada compás.' }],
    [4, 5, 8, { delta: -3, text: 'Se quitan las últimas 3 corcheas de cada compás.' }],
    [4, 6, 8, { delta: -2, text: 'Se quitan las últimas 2 corcheas de cada compás.' }],
    [4, 3, 4, { delta: -1, unitsPerBeat: 1, unitName: 'negra', text: 'Se quita el último tiempo de cada compás.' }],
    [4, 2, 4, { delta: -2, text: 'Se quitan los últimos 2 tiempos de cada compás.' }],
    [4, 5, 4, { delta: 1, text: 'Se repite el último tiempo de cada compás.' }],
    [4, 6, 4, { delta: 2, text: 'Se repiten los últimos 2 tiempos de cada compás.' }],
    [4, 3, 2, { delta: 2, unitsPerBeat: 1, unitName: 'negra', text: 'Se repiten los últimos 2 tiempos de cada compás.' }],
    [4, 15, 16, { delta: -1, unitsPerBeat: 4, sourceUnits: 16, targetUnits: 15, unitName: 'semicorchea',
      text: 'Se quita la última semicorchea de cada compás.' }],
    [4, 17, 16, { delta: 1, text: 'Se repite la última semicorchea de cada compás.' }],
    [4, 9, 8, { delta: 1, text: 'Se repite la última corchea de cada compás.' }],
    [3, 7, 8, { delta: 1, text: 'Se repite la última corchea de cada compás.' }],
    [3, 5, 8, { delta: -1, text: 'Se quita la última corchea de cada compás.' }],
    [4, 8, 4, { delta: 4, text: 'Se repite cada compás completo.' }],
    [4, 1, 4, { delta: -3, text: 'Se quitan los últimos 3 tiempos de cada compás.' }],
  ];
  for (const [bpb, num, den, exp] of cases) {
    const d = describeMeterChange(bpb, num, den);
    for (const [key, val] of Object.entries(exp)) assert.equal(d[key], val, `${bpb}/4 → ${num}/${den}: ${key}`);
    assert.equal(d.error, null);
  }
  // Fuente en blancas: nombres 'blanca' y 'negra'.
  const half = describeMeterChange(2, 3, 2, 2);
  assert.equal(half.unitName, 'blanca');
  assert.equal(half.text, 'Se repite el último tiempo de cada compás.');
  const halfToQuarter = describeMeterChange(2, 3, 4, 2);
  assert.equal(halfToQuarter.unitName, 'negra');
  assert.equal(halfToQuarter.text, 'Se quita la última negra de cada compás.');
});

test('describeMeterChange: Δ = 0, errores y entradas inválidas', () => {
  for (const [num, den] of [[4, 4], [8, 8], [2, 2], [16, 16]]) {
    const d = describeMeterChange(4, num, den);
    assert.equal(d.delta, 0);
    assert.equal(d.error, null);
    assert.equal(d.text, SAME);
  }
  assert.equal(describeMeterChange(4, 9, 4).error, TOO_LONG);
  assert.equal(describeMeterChange(4, 17, 8).error, TOO_LONG);
  assert.equal(describeMeterChange(4, 16, 8).error, null);           // Δ = S: se duplica el compás
  assert.equal(describeMeterChange(4, 0, 8).error, TOO_SHORT);       // |Δ| = S
  assert.equal(describeMeterChange(4, -2, 4).error, TOO_SHORT);
  assert.equal(describeMeterChange(4, 0, 8).text, '');
  assert.match(describeMeterChange(4, 33, 16).error, /numerador/);
  assert.match(describeMeterChange(4, 7.5, 8).error, /numerador/);
  assert.match(describeMeterChange(4, undefined, 8).error, /numerador/);
  assert.match(describeMeterChange(4, 7, 3).error, /denominador/);
  assert.match(describeMeterChange(4, 7, 12).error, /denominador/);
  assert.match(describeMeterChange(0, 7, 8).error, /original/);
  assert.match(describeMeterChange(4, 7, 8, 3).error, /original/);
  assert.equal(describeMeterChange('4', '7', '8').text, 'Se quita la última corchea de cada compás.');
});

// ---------------------------------------------------------------- planMeterChange

test('plan 4/4 → 7/8 a 120 BPM estable: quita 0,25 s por compás completo', () => {
  const r = makeResult();
  const plan = planMeterChange(r, { targetNum: 7, targetDen: 8 });
  assert.equal(plan.error, null);
  assert.equal(plan.info, null);
  assert.equal(plan.delta, -1);
  assert.equal(plan.unitsPerBeat, 2);
  assert.equal(plan.barsChanged, 16);
  assert.equal(plan.removed.length, 16);
  assert.equal(plan.repeated.length, 0);
  assert.equal(plan.segments.length, 17);
  checkInvariants(plan, r.duration);
  close(plan.outputDuration, r.duration - 16 * 0.25, 1e-9);
  for (let j = 0; j < 16; j++) {
    const next = r.beats[r.downbeats[j + 1]];
    const rm = plan.removed[j];
    close(rm.end - rm.start, 0.25, 1e-9);
    close(rm.end, next - P, 1e-9);
    // Los segmentos saltan exactamente el rango quitado.
    close(plan.segments[j].end, rm.start, 1e-12);
    close(plan.segments[j + 1].start, rm.end, 1e-12);
  }
  // Anacrusa intacta y compás final intacto.
  assert.ok(plan.segments[0].end > r.beats[r.downbeats[0]] + 1.5);
  const finalStart = r.beats[r.downbeats[16]];
  assert.ok(plan.segments[16].start < finalStart && plan.segments[16].end === r.duration);
  // En la salida los "1" quedan cada 7 corcheas = 1,75 s.
  const outDown = r.downbeats.slice(0, 17).map((i) => sourceToOutputTime(plan.segments, r.beats[i]));
  for (let j = 1; j < outDown.length; j++) close(outDown[j] - outDown[j - 1], 1.75, 1e-9);
});

test('plan 4/4 → 3/4 quita el tiempo 4; 4/4 → 15/16 quita la última semicorchea', () => {
  const r = makeResult();
  const p34 = planMeterChange(r, { targetNum: 3, targetDen: 4 });
  assert.equal(p34.barsChanged, 16);
  checkInvariants(p34, r.duration);
  for (let j = 0; j < 16; j++) {
    const beat4 = r.beats[r.downbeats[j] + 3];
    close(p34.removed[j].start, beat4 - P, 1e-9);
    close(p34.removed[j].end - p34.removed[j].start, 0.5, 1e-9);
  }
  close(p34.outputDuration, r.duration - 8, 1e-9);

  const p1516 = planMeterChange(r, { targetNum: 15, targetDen: 16 });
  assert.equal(p1516.unitsPerBeat, 4);
  for (const rm of p1516.removed) close(rm.end - rm.start, 0.125, 1e-9);
  close(p1516.outputDuration, r.duration - 2, 1e-9);
});

test('plan 4/4 → 5/4 repite el último tiempo (el rango aparece dos veces)', () => {
  const r = makeResult();
  const plan = planMeterChange(r, { targetNum: 5, targetDen: 4 });
  assert.equal(plan.error, null);
  assert.equal(plan.delta, 1);
  assert.equal(plan.barsChanged, 16);
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.repeated.length, 16);
  checkInvariants(plan, r.duration);
  close(plan.outputDuration, r.duration + 16 * 0.5, 1e-9);
  for (let j = 0; j < 16; j++) {
    const beat4 = r.beats[r.downbeats[j] + 3];
    const next = r.beats[r.downbeats[j + 1]];
    const rep = plan.repeated[j];
    close(rep.start, beat4 - P, 1e-9);
    close(rep.end, next - P, 1e-9);
    // El segmento del compás llega hasta el "1" siguiente y justo después va el tiempo 4 otra vez.
    const k = plan.segments.findIndex((s) => s.start === rep.start && s.end === rep.end);
    assert.ok(k > 0, 'el rango repetido es un segmento propio');
    close(plan.segments[k - 1].end, rep.end, 1e-12);
    close(plan.segments[k + 1].start, rep.end, 1e-12);
    assert.equal(coverage(plan.segments, (beat4 + next) / 2), 2);
    assert.equal(coverage(plan.segments, beat4 - 0.1), 1);
  }
  const outDown = r.downbeats.slice(0, 17).map((i) => sourceToOutputTime(plan.segments, r.beats[i]));
  for (let j = 1; j < outDown.length; j++) close(outDown[j] - outDown[j - 1], 2.5, 1e-9);
});

test('plan con deriva de tempo: lo quitado sigue la duración local del beat', () => {
  // ritardando: IBI de 0,45 s a ~0,75 s
  const beatTime = (i) => 0.2 + 0.45 * i + 0.0045 * i * i;
  const r = makeResult({ beatTime, barBeats: [...Array(12).fill(4), 4] });
  const p78 = planMeterChange(r, { targetNum: 7, targetDen: 8 });
  const p34 = planMeterChange(r, { targetNum: 3, targetDen: 4 });
  assert.equal(p78.barsChanged, 12);
  checkInvariants(p78, r.duration);
  checkInvariants(p34, r.duration);
  let total = 0;
  for (let j = 0; j < 12; j++) {
    const b1 = r.downbeats[j + 1];
    const ibi = r.beats[b1] - r.beats[b1 - 1];
    close(p78.removed[j].end - p78.removed[j].start, ibi / 2, 1e-9);
    close(p34.removed[j].end - p34.removed[j].start, ibi, 1e-9);
    total += ibi / 2;
  }
  assert.ok(p78.removed[11].end - p78.removed[11].start > p78.removed[0].end - p78.removed[0].start + 0.1);
  close(p78.outputDuration, r.duration - total, 1e-9);
});

test('plan con compases irregulares: cada compás usa su propia cantidad de beats', () => {
  const barBeats = [4, 4, 5, 4, 3, 4, 4, 4];
  const r = makeResult({ barBeats });
  assert.ok(r.positions.includes(4));
  const p78 = planMeterChange(r, { targetNum: 7, targetDen: 8 });
  checkInvariants(p78, r.duration);
  assert.equal(p78.barsChanged, 7);
  // 5 beats = 10 corcheas → se quitan 3; 3 beats = 6 corcheas → se repite 1.
  const rmLens = p78.removed.map((x) => +(x.end - x.start).toFixed(9));
  assert.deepEqual(rmLens, [0.25, 0.25, 0.75, 0.25, 0.25, 0.25]);
  assert.equal(p78.repeated.length, 1);
  close(p78.repeated[0].end - p78.repeated[0].start, 0.25, 1e-9);
  close(p78.repeated[0].end, r.beats[r.downbeats[5]] - P, 1e-9);
  // Todos los compases de la salida duran 7 corcheas.
  const outDown = r.downbeats.map((i) => sourceToOutputTime(p78.segments, r.beats[i]));
  for (let j = 1; j < outDown.length; j++) close(outDown[j] - outDown[j - 1], 1.75, 1e-9);

  const p34 = planMeterChange(r, { targetNum: 3, targetDen: 4 });
  assert.equal(p34.barsChanged, 6);   // el compás de 3 beats ya está en 3/4
  assert.deepEqual(p34.removed.map((x) => +(x.end - x.start).toFixed(9)), [0.5, 0.5, 1, 0.5, 0.5, 0.5]);

  // Sin downbeats: se derivan de positions.
  const noDb = { ...r, downbeats: undefined };
  assert.deepEqual(planMeterChange(noDb, { targetNum: 7, targetDen: 8 }).segments, p78.segments);
});

test('plan respeta limitTime (corte del modo 1)', () => {
  const r = makeResult();
  const cut = r.beats[r.downbeats[8]];
  for (const limitTime of [cut, cut - P]) {
    const plan = planMeterChange(r, { targetNum: 7, targetDen: 8, limitTime });
    assert.equal(plan.barsChanged, 8);
    // Con el límite ya adelantado por el pre-roll, la salida termina donde empieza lo quitado.
    checkInvariants(plan, limitTime, { exactEnd: limitTime === cut });
    close(plan.outputDuration, limitTime - 8 * 0.25, 1e-9);
  }
  const mid = planMeterChange(r, { targetNum: 7, targetDen: 8, limitTime: cut + 0.9 });
  assert.equal(mid.barsChanged, 8);
  checkInvariants(mid, cut + 0.9);
  const rep = planMeterChange(r, { targetNum: 5, targetDen: 4, limitTime: cut });
  assert.equal(rep.barsChanged, 8);
  checkInvariants(rep, cut);
  close(rep.outputDuration, cut + 8 * 0.5, 1e-9);
  const big = planMeterChange(r, { targetNum: 7, targetDen: 8, limitTime: 1e6 });
  checkInvariants(big, r.duration);
  assert.equal(big.barsChanged, 16);
  const early = planMeterChange(r, { targetNum: 7, targetDen: 8, limitTime: 1 });
  assert.equal(early.barsChanged, 0);
  assert.ok(early.info);
  assert.deepEqual(early.segments, [{ start: 0, end: 1 }]);
});

test('plan sin limitTime: el compás del golpe final y el ring-out quedan intactos', () => {
  const r = makeResult({ barBeats: [...Array(19).fill(4), 3] });
  const all = planMeterChange(r, { targetNum: 7, targetDen: 8 });
  assert.equal(all.barsChanged, 19);
  const hit = r.beats[r.downbeats[16]] + 0.01;   // golpe final en el "1" del compás 17
  const withHit = planMeterChange({ ...r, lastOnset: hit }, { targetNum: 7, targetDen: 8 });
  assert.equal(withHit.barsChanged, 16);
  const lastRemoved = withHit.removed[withHit.removed.length - 1];
  assert.ok(lastRemoved.end <= r.beats[r.downbeats[16]]);
  checkInvariants(withHit, r.duration);
});

test('plan: snap solo en límites internos y solo si mueve < 25 ms', () => {
  const r = makeResult();
  const calls = [];
  const plan = planMeterChange(r, { targetNum: 7, targetDen: 8, snap: (t) => { calls.push(t); return t + 0.012; } });
  assert.equal(calls.length, 16);
  const downTimes = new Set(r.downbeats.map((i) => r.beats[i]));
  for (const t of calls) assert.ok(!downTimes.has(t));
  for (const rm of plan.removed) close(rm.end - rm.start, 0.25 - 0.012, 1e-9);

  const far = planMeterChange(r, { targetNum: 7, targetDen: 8, snap: (t) => t + 0.03 });
  for (const rm of far.removed) close(rm.end - rm.start, 0.25, 1e-9);
  const nan = planMeterChange(r, { targetNum: 7, targetDen: 8, snap: () => NaN });
  for (const rm of nan.removed) close(rm.end - rm.start, 0.25, 1e-9);
  const back = planMeterChange(r, { targetNum: 7, targetDen: 8, snap: (t) => t - 0.024 });
  for (const rm of back.removed) close(rm.end - rm.start, 0.274, 1e-9);
});

test('plan: preroll configurable', () => {
  const r = makeResult();
  const plan = planMeterChange(r, { targetNum: 7, targetDen: 8, preroll: 0 });
  close(plan.removed[0].end, r.beats[r.downbeats[1]], 1e-12);
  const plan2 = planMeterChange(r, { targetNum: 7, targetDen: 8, preroll: 0.01 });
  close(plan2.removed[0].end, r.beats[r.downbeats[1]] - 0.01, 1e-12);
});

test('sourceToOutputTime / outputToSourceTime son inversas en el audio conservado', () => {
  const r = makeResult({ beatTime: (i) => 0.2 + 0.47 * i + 0.002 * i * i });
  for (const [num, den] of [[7, 8], [3, 4], [15, 16]]) {
    const plan = planMeterChange(r, { targetNum: num, targetDen: den });
    let nulls = 0;
    for (let t = 0; t < r.duration; t += 0.0137) {
      const o = sourceToOutputTime(plan.segments, t);
      const inRemoved = plan.removed.some((x) => t >= x.start && t < x.end);
      if (inRemoved) { assert.equal(o, null); nulls++; continue; }
      assert.equal(typeof o, 'number');
      close(outputToSourceTime(plan.segments, o), t, 1e-9);
    }
    assert.ok(nulls > 0);
    for (let o = 0; o < plan.outputDuration; o += 0.0113) {
      close(sourceToOutputTime(plan.segments, outputToSourceTime(plan.segments, o)), o, 1e-9);
    }
    assert.equal(outputToSourceTime(plan.segments, 0), 0);
    assert.equal(outputToSourceTime(plan.segments, -5), 0);
    close(outputToSourceTime(plan.segments, plan.outputDuration), r.duration, 1e-9);
    close(outputToSourceTime(plan.segments, 1e9), r.duration, 1e-9);
    close(sourceToOutputTime(plan.segments, r.duration), plan.outputDuration, 1e-9);
    assert.equal(sourceToOutputTime(plan.segments, r.duration + 1), null);
    assert.equal(sourceToOutputTime(plan.segments, NaN), null);
  }
  // Con repeticiones: la segunda aparición vuelve a la primera.
  const rep = planMeterChange(r, { targetNum: 5, targetDen: 4 });
  for (let o = 0; o < rep.outputDuration; o += 0.0113) {
    const t = outputToSourceTime(rep.segments, o);
    const back = sourceToOutputTime(rep.segments, t);
    assert.ok(back <= o + 1e-9);
    close(outputToSourceTime(rep.segments, back), t, 1e-9);
  }
  for (let t = 0; t < r.duration; t += 0.0137) {
    close(outputToSourceTime(rep.segments, sourceToOutputTime(rep.segments, t)), t, 1e-9);
  }
  assert.equal(sourceToOutputTime([], 1), null);
  assert.equal(outputToSourceTime([], 1), 1);
});

test('plan: Δ = 0 y compás inválido devuelven un plan sin cambios', () => {
  const r = makeResult();
  const same = planMeterChange(r, { targetNum: 8, targetDen: 8 });
  assert.equal(same.info, SAME);
  assert.equal(same.error, null);
  assert.equal(same.barsChanged, 0);
  assert.deepEqual(same.segments, [{ start: 0, end: r.duration }]);
  close(same.outputDuration, r.duration);
  const long = planMeterChange(r, { targetNum: 9, targetDen: 4 });
  assert.equal(long.error, TOO_LONG);
  assert.deepEqual(long.segments, [{ start: 0, end: r.duration }]);
  const bad = planMeterChange(r, { targetNum: 7, targetDen: 5 });
  assert.ok(bad.error);
  assert.deepEqual(bad.removed, []);
});

test('plan: entradas degeneradas nunca lanzan', () => {
  const opts = { targetNum: 7, targetDen: 8 };
  const r = makeResult();
  const cases = [
    [null, opts],
    [undefined, opts],
    [{}, opts],
    [{ beats: [], downbeats: [], positions: [], beatsPerBar: 4, duration: 10 }, opts],
    [{ ...r, downbeats: [], positions: [] }, opts],
    [{ ...r, downbeats: [], positions: undefined }, opts],
    [{ ...r, downbeats: [5] }, opts],                                // un solo compás
    [{ ...r, beatsPerBar: undefined }, opts],
    [{ ...r, downbeats: [3, 3, 99999, -1] }, opts],
    [{ ...r, beats: r.beats.map(() => NaN) }, opts],
    [r, {}],
    [r, null],
    [r, undefined],
  ];
  for (const [res, o] of cases) {
    const plan = planMeterChange(res, o);
    assert.ok(Array.isArray(plan.segments));
    assert.equal(plan.barsChanged, 0);
    assert.ok(plan.error || plan.info, JSON.stringify(plan));
    assert.ok(Number.isFinite(plan.outputDuration));
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.repeated, []);
  }
  const nothing = planMeterChange({ duration: 5 }, opts);
  assert.deepEqual(nothing.segments, [{ start: 0, end: 5 }]);
  assert.ok(nothing.error);
  const oneBar = planMeterChange({ ...r, downbeats: [5] }, opts);
  assert.ok(oneBar.info);
  assert.equal(oneBar.error, null);
  // Sin duración: se usa el último beat.
  const noDur = planMeterChange({ ...r, duration: NaN, musicEnd: undefined }, opts);
  assert.equal(noDur.barsChanged, 16);
  checkInvariants(noDur, r.beats[r.beats.length - 1]);
  // Dos "1": un compás completo que no es el final → se transforma.
  const twoBars = planMeterChange({ ...r, downbeats: [2, 6] }, opts);
  assert.equal(twoBars.barsChanged, 1);
});
