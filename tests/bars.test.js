import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAST_BAR_TOLERANCE, getBars, findLastBarIndex, cutForBarsRemoved, barsRemovedAt, nearestBeatIndex, stepBeat, stepBar,
} from '../js/core/bars.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** Rejilla regular: `pickup` beats de anacrusa y `nBars` compases de `bpb` beats, IBI fijo. */
function grid({ nBars = 10, bpb = 4, ibi = 0.5, t0 = 1, pickup = 0, lastOnset = null, musicEnd = null } = {}) {
  const beats = [];
  const positions = [];
  for (let i = 0; i < pickup + nBars * bpb; i++) {
    beats.push(t0 + i * ibi);
    positions.push((((i - pickup) % bpb) + bpb) % bpb);
  }
  const downbeats = [];
  positions.forEach((p, i) => { if (p === 0) downbeats.push(i); });
  const lastDb = beats[downbeats[downbeats.length - 1]];
  return {
    beats, positions, downbeats, beatsPerBar: bpb, bpm: 60 / ibi,
    lastOnset: lastOnset ?? lastDb + 0.01,
    musicEnd: musicEnd ?? beats[beats.length - 1] + 3,
  };
}

test('LAST_BAR_TOLERANCE es 80 ms', () => {
  assert.equal(LAST_BAR_TOLERANCE, 0.08);
});

test('getBars: rejilla regular 4/4', () => {
  const r = grid();
  const bars = getBars(r);
  assert.equal(bars.length, 10);
  bars.forEach((b, k) => {
    assert.equal(b.index, k);
    assert.equal(b.number, k + 1);
    assert.equal(b.beatIndex, 4 * k);
    assert.equal(b.beatCount, 4);
    close(b.start, 1 + 2 * k);
  });
  close(bars[3].end, bars[4].start);
  // último compás: último beat + IBI mediano
  close(bars[9].end, r.beats[39] + 0.5);
});

test('getBars: el final del último compás se limita a musicEnd (pero nunca antes del último beat)', () => {
  const r = grid({ musicEnd: 1 + 39 * 0.5 + 0.2 });
  close(getBars(r)[9].end, 1 + 39 * 0.5 + 0.2);
  const r2 = grid({ musicEnd: 1 + 39 * 0.5 - 1 }); // musicEnd incoherente: no retrocede
  close(getBars(r2)[9].end, r2.beats[39]);
  const r3 = { ...grid(), musicEnd: undefined };
  close(getBars(r3)[9].end, r3.beats[39] + 0.5);
});

test('getBars: la anacrusa no pertenece a ningún compás', () => {
  const r = grid({ pickup: 2, nBars: 5 });
  const bars = getBars(r);
  assert.equal(bars.length, 5);
  assert.equal(bars[0].beatIndex, 2);
  close(bars[0].start, r.beats[2]);
  assert.equal(bars.reduce((a, b) => a + b.beatCount, 0), r.beats.length - 2);
});

test('getBars: compases irregulares (uno de 3 y uno de 5 con posición === beatsPerBar)', () => {
  const positions = [0, 1, 2, 3, 0, 1, 2, 0, 1, 2, 3, 4, 0, 1, 2, 3];
  const beats = positions.map((_, i) => 10 + i * 0.4);
  const r = { beats, positions, beatsPerBar: 4, lastOnset: beats[12], musicEnd: 20 };
  const bars = getBars(r); // sin downbeats: se derivan de positions
  assert.deepEqual(bars.map((b) => b.beatCount), [4, 3, 5, 4]);
  assert.deepEqual(bars.map((b) => b.beatIndex), [0, 4, 7, 12]);
  close(bars[1].end, beats[7]);
});

test('getBars: downbeats desordenados, repetidos o fuera de rango se ignoran; beats en Float32Array', () => {
  const beats = Float32Array.from([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  const bars = getBars({ beats, downbeats: [4, 0, 4, 99, -1, 1.5], musicEnd: 10 });
  assert.deepEqual(bars.map((b) => b.beatIndex), [0, 4]);
  close(bars[1].end, 4);
});

test('getBars: resultados vacíos o sin downbeats', () => {
  assert.deepEqual(getBars({ beats: [], downbeats: [] }), []);
  assert.deepEqual(getBars({}), []);
  assert.deepEqual(getBars({ beats: [1, 2, 3], positions: [1, 2, 3] }), []);
  // un solo beat downbeat: el compás dura 60/bpm si hay tempo
  const one = getBars({ beats: [2], downbeats: [0], bpm: 120, musicEnd: 5 });
  assert.equal(one.length, 1);
  close(one[0].end, 2.5);
});

test('findLastBarIndex: el compás que contiene el último onset, con tolerancia de 80 ms', () => {
  const r = grid();
  assert.equal(findLastBarIndex(r), 9);
  // golpe final dentro del compás 8 (índice 7)
  assert.equal(findLastBarIndex({ ...r, lastOnset: 1 + 7 * 2 + 1.3 }), 7);
  // golpe anticipado 50 ms antes del downbeat: cuenta como ese compás
  assert.equal(findLastBarIndex({ ...r, lastOnset: 1 + 9 * 2 - 0.05 }), 9);
  // 100 ms antes: es el compás anterior
  assert.equal(findLastBarIndex({ ...r, lastOnset: 1 + 9 * 2 - 0.1 }), 8);
  // los compases de la cola (resonancia) no cuentan
  assert.equal(findLastBarIndex({ ...r, lastOnset: 1 + 5 * 2 + 0.2 }), 5);
  // sin lastOnset: el último compás
  assert.equal(findLastBarIndex({ ...r, lastOnset: undefined }), 9);
  assert.equal(findLastBarIndex({ beats: [], downbeats: [] }), -1);
  // último onset antes del primer compás
  assert.equal(findLastBarIndex({ ...r, lastOnset: 0.2 }), -1);
});

test('cutForBarsRemoved: corta al inicio del compás último − n + 1', () => {
  const r = grid();
  assert.deepEqual(cutForBarsRemoved(r, 1), { barIndex: 9, beatIndex: 36, time: r.beats[36], barsRemoved: 1 });
  const c4 = cutForBarsRemoved(r, 4);
  assert.equal(c4.barIndex, 6);
  assert.equal(c4.beatIndex, 24);
  close(c4.time, 1 + 6 * 2);
  assert.equal(c4.barsRemoved, 4);
  // el último compás se cuenta desde lastOnset, no desde el final de los beats
  const early = { ...r, lastOnset: 1 + 7 * 2 + 0.3 };
  assert.equal(cutForBarsRemoved(early, 1).barIndex, 7);
  assert.equal(cutForBarsRemoved(early, 2).barIndex, 6);
});

test('cutForBarsRemoved: n mayor que los compases disponibles deja al menos 1 compás', () => {
  const r = grid({ nBars: 5, pickup: 3 });
  const c = cutForBarsRemoved(r, 32);
  assert.equal(c.barIndex, 1);
  assert.equal(c.beatIndex, 3 + 4);
  assert.equal(c.barsRemoved, 4);
  assert.equal(cutForBarsRemoved(r, 4).barIndex, 1);
});

test('cutForBarsRemoved: casos nulos', () => {
  const r = grid();
  assert.equal(cutForBarsRemoved(r, 0), null);
  assert.equal(cutForBarsRemoved(r, -2), null);
  assert.equal(cutForBarsRemoved(r, NaN), null);
  assert.equal(cutForBarsRemoved(grid({ nBars: 1 }), 1), null); // sólo un compás
  assert.equal(cutForBarsRemoved({ beats: [], downbeats: [] }, 1), null);
  assert.equal(cutForBarsRemoved({ ...r, lastOnset: 0.1 }, 1), null);
  // n no entero: se trunca
  assert.equal(cutForBarsRemoved(r, 2.7).barIndex, 8);
});

test('barsRemovedAt: inversa de cutForBarsRemoved y fracciones en beats', () => {
  const r = grid();
  for (const n of [1, 2, 4, 8]) assert.equal(barsRemovedAt(r, cutForBarsRemoved(r, n).time), n);
  const lastStart = 1 + 9 * 2;
  assert.equal(barsRemovedAt(r, lastStart + 0.5), 0.8); // en el 2º beat del último compás
  assert.equal(barsRemovedAt(r, lastStart + 1.0), 0.5); // en el 3º
  assert.equal(barsRemovedAt(r, lastStart + 0.75), 0.6); // entre beats (1.5 beats de 4)
  assert.equal(barsRemovedAt(r, lastStart - 1.0), 1.5); // mitad del penúltimo
  assert.equal(barsRemovedAt(r, lastStart + 2.0), 0); // en el final del último compás
  assert.equal(barsRemovedAt(r, 100), 0);
  assert.equal(barsRemovedAt(r, 0), 10); // antes del compás 1: todos
  assert.equal(barsRemovedAt(r, lastStart - 0.004), 1); // pre-roll de 4 ms
  assert.equal(barsRemovedAt({ beats: [], downbeats: [] }, 3), 0);
  assert.equal(barsRemovedAt(r, NaN), 0);
});

test('barsRemovedAt: con compases irregulares y con compases de cola después del último', () => {
  const positions = [0, 1, 2, 3, 0, 1, 2, 0, 1, 2, 3, 4, 0, 1, 2, 3, 0, 1, 2, 3];
  const beats = positions.map((_, i) => 10 + i * 0.4);
  const r = { beats, positions, beatsPerBar: 4, lastOnset: beats[12] + 0.01, musicEnd: 30 };
  assert.equal(findLastBarIndex(r), 3);
  assert.equal(barsRemovedAt(r, beats[7]), 2);
  assert.equal(barsRemovedAt(r, beats[9]), 1.6); // 2 de 5 beats consumidos del compás de 5
  assert.equal(barsRemovedAt(r, beats[5]), 2.7); // 2/3 del compás de 3 + 2 compases
  assert.equal(barsRemovedAt(r, beats[16]), 0); // compás de cola: no cuenta
});

test('nearestBeatIndex', () => {
  const r = grid({ nBars: 2 });
  assert.equal(nearestBeatIndex(r, -5), 0);
  assert.equal(nearestBeatIndex(r, 1.2), 0);
  assert.equal(nearestBeatIndex(r, 1.26), 1);
  assert.equal(nearestBeatIndex(r, 1.25), 0); // empate: el anterior
  assert.equal(nearestBeatIndex(r, 99), 7);
  assert.equal(nearestBeatIndex({ beats: [] }, 1), -1);
});

test('stepBeat: sobre la rejilla, fuera de ella y en los extremos', () => {
  const r = grid({ nBars: 2 }); // beats 1.0 .. 4.5
  close(stepBeat(r, 2, 1), 2.5);
  close(stepBeat(r, 2, -2), 1);
  close(stepBeat(r, 2, 0), 2);
  close(stepBeat(r, 2.0004, 1), 2.5); // dentro de 1 ms: se considera sobre el beat
  close(stepBeat(r, 2.4, 1), 2.5); // antes del beat 2.5: +1 va a 2.5 (no lo salta)
  close(stepBeat(r, 2.1, -1), 2); // después de 2.0: −1 va a 2.0
  close(stepBeat(r, 2.1, 1), 2.5);
  close(stepBeat(r, 2.4, -1), 2);
  close(stepBeat(r, 2.1, 0), 2);
  close(stepBeat(r, 4.5, 3), 4.5);
  close(stepBeat(r, 1, -3), 1);
  close(stepBeat(r, 0.2, 1), 1); // antes del primer beat
  close(stepBeat(r, 9, -1), 4.5); // después del último
  assert.equal(stepBeat({ beats: [] }, 3.3, 1), 3.3);
});

test('stepBar: sobre los inicios de compás', () => {
  const r = grid({ pickup: 1, nBars: 3 }); // beats desde 1.0; compases en 1.5, 3.5, 5.5
  close(stepBar(r, 3.5, 1), 5.5);
  close(stepBar(r, 3.5, -1), 1.5);
  close(stepBar(r, 4.0, -1), 3.5);
  close(stepBar(r, 4.0, 1), 5.5);
  close(stepBar(r, 5.5, 2), 5.5);
  close(stepBar(r, 1.0, 1), 1.5);
  // sin downbeats: usa beatsPerBar beats
  const nb = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3], beatsPerBar: 3 };
  close(stepBar(nb, 0.5, 1), 2);
  assert.equal(stepBar({ beats: [] }, 7, 1), 7);
});
