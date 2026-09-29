import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeakPyramid, pickLevel, snapToBeat, clampView, zoomView, PEAK_BLOCK } from '../js/ui/waveform.js';

test('buildPeakPyramid: min/max/rms por bloque y niveles que se reducen a la mitad', () => {
  const n = PEAK_BLOCK * 5 + 10;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  a[3] = 0.9; // bloque 0
  b[PEAK_BLOCK * 2 + 7] = -0.7; // bloque 2
  a[n - 1] = 0.5; // último bloque parcial
  const p = buildPeakPyramid([a, b]);
  const L0 = p.levels[0];
  assert.equal(L0.min.length, 6);
  assert.ok(Math.abs(L0.max[0] - 0.9) < 1e-6);
  assert.ok(Math.abs(L0.min[2] + 0.7) < 1e-6);
  assert.ok(Math.abs(L0.max[5] - 0.5) < 1e-6);
  assert.ok(Math.abs(p.peak - 0.9) < 1e-6);
  assert.equal(p.length, n);
  // cada nivel tiene la mitad de bloques (redondeando hacia arriba) hasta llegar a 1
  for (let k = 1; k < p.levels.length; k++) {
    assert.equal(p.levels[k].min.length, Math.ceil(p.levels[k - 1].min.length / 2));
    assert.equal(p.levels[k].blockSize, p.levels[k - 1].blockSize * 2);
  }
  const top = p.levels[p.levels.length - 1];
  assert.equal(top.min.length, 1);
  assert.ok(Math.abs(top.max[0] - 0.9) < 1e-6 && Math.abs(top.min[0] + 0.7) < 1e-6);
  // rms de un seno de amplitud 1 ≈ 0.707
  const s = new Float32Array(PEAK_BLOCK * 64).map((_, i) => Math.sin((2 * Math.PI * i) / 64));
  const ps = buildPeakPyramid([s]);
  assert.ok(Math.abs(ps.levels[3].rms[0] - Math.SQRT1_2) < 1e-3);
});

test('pickLevel elige el nivel más grueso que no supera las muestras por píxel', () => {
  const p = buildPeakPyramid([new Float32Array(PEAK_BLOCK * 1024)]);
  assert.equal(pickLevel(p, 100), -1);
  assert.equal(pickLevel(p, PEAK_BLOCK), 0);
  assert.equal(pickLevel(p, PEAK_BLOCK * 3), 1);
  assert.equal(pickLevel(p, PEAK_BLOCK * 4), 2);
  assert.equal(pickLevel(p, 1e12), p.levels.length - 1);
});

test('snapToBeat respeta el umbral', () => {
  const beats = [1, 1.5, 2, 2.5];
  assert.deepEqual(snapToBeat(beats, 1.52, 0.05), { time: 1.5, index: 1, snapped: true });
  const free = snapToBeat(beats, 1.7, 0.05);
  assert.equal(free.snapped, false);
  assert.equal(free.time, 1.7);
  assert.equal(snapToBeat([], 3, 1).snapped, false);
});

test('clampView y zoomView mantienen la vista dentro de la canción', () => {
  assert.deepEqual(clampView(-5, 5, 100), { start: 0, end: 10 });
  assert.deepEqual(clampView(95, 105, 100), { start: 90, end: 100 });
  assert.deepEqual(clampView(0, 500, 100), { start: 0, end: 100 });
  const tiny = clampView(10, 10.01, 100, 0.1);
  assert.ok(Math.abs(tiny.end - tiny.start - 0.1) < 1e-9);
  // zoom alrededor de un ancla: el ancla queda en la misma posición relativa
  const v = zoomView({ start: 0, end: 40 }, 0.5, 30, 100);
  assert.ok(Math.abs(v.end - v.start - 20) < 1e-9);
  assert.ok(Math.abs((30 - v.start) / (v.end - v.start) - 0.75) < 1e-9);
  const out = zoomView({ start: 50, end: 60 }, 100, 55, 100);
  assert.deepEqual(out, { start: 0, end: 100 });
});
