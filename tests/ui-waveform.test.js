import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPeakPyramid, pickLevel, snapToBeat, clampView, zoomView, PEAK_BLOCK, visibleSlices, firstSliceEndingAfter,
  classifyTapMove, cutPillX, PILL_W,
} from '../js/ui/waveform.js';

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

test('visibleSlices: solo los trozos del cambio de compás que se ven (búsqueda binaria)', () => {
  const slices = [];
  for (let i = 0; i < 300; i++) slices.push({ start: i * 2 + 1.7, end: i * 2 + 1.95 });
  assert.equal(firstSliceEndingAfter(slices, 0), 0);
  assert.equal(firstSliceEndingAfter(slices, 1.95), 1);
  assert.equal(firstSliceEndingAfter(slices, 1.9), 0);
  assert.equal(firstSliceEndingAfter(slices, 1e9), 300);
  assert.deepEqual(visibleSlices(slices, 10, 20), [5, 10]);   // 11.7–11.95 … 19.7–19.95
  assert.deepEqual(visibleSlices(slices, 9.8, 9.9), [4, 5]);  // dentro de un trozo
  assert.deepEqual(visibleSlices(slices, 9.96, 11.69), [5, 5]);
  assert.deepEqual(visibleSlices(slices, -5, 1e9), [0, 300]);
  assert.deepEqual(visibleSlices([], 0, 10), [0, 0]);
  assert.deepEqual(visibleSlices(null, 0, 10), [0, 0]);
});

test('classifyTapMove: vertical = desplazar la página (sin salto del cabezal), horizontal = paneo', () => {
  assert.equal(classifyTapMove(0, 0), 'tap');
  assert.equal(classifyTapMove(3, -5), 'tap');          // temblor del dedo: sigue siendo un toque
  assert.equal(classifyTapMove(2, -40), 'cancel');      // swipe vertical: ni paneo ni seek
  assert.equal(classifyTapMove(-4, 9), 'cancel');
  assert.equal(classifyTapMove(-20, 3), 'pan');
  assert.equal(classifyTapMove(10, 9), 'pan');          // diagonal más horizontal que vertical
  assert.equal(classifyTapMove(7, 30), 'cancel');       // diagonal más vertical: la página
});

test('cutPillX: la etiqueta CORTE va a la derecha de la línea (no tapa el último compás que queda)', () => {
  assert.equal(cutPillX(300, 800), 299);                  // a la derecha: empieza en la línea
  assert.equal(cutPillX(790, 800), 790 - PILL_W + 1);     // sin sitio a la derecha: a la izquierda
  assert.equal(cutPillX(10, 30), 0);                      // nunca fuera del lienzo
});
