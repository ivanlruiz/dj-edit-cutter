import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fadeGain, renderEdit, FADE_CURVES, ANTICLICK_SEC, CUT_PREROLL_SEC } from '../js/audio/edit.js';

const SR = 44100;

function ramp(n, offset = 0) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.25 + 0.5 * ((i + offset) % 1000) / 1000;
  return a;
}

test('constantes del contrato', () => {
  assert.deepEqual(FADE_CURVES, ['linear', 'smooth', 'exp']);
  assert.equal(ANTICLICK_SEC, 0.005);
  assert.equal(CUT_PREROLL_SEC, 0.004);
});

test('fadeGain: extremos, monotonía y rango para todas las curvas', () => {
  for (const curve of [...FADE_CURVES, 'desconocida', undefined]) {
    assert.equal(fadeGain(0, curve), 1, `g(0) ${curve}`);
    assert.equal(fadeGain(1, curve), 0, `g(1) ${curve}`);
    assert.equal(fadeGain(-0.5, curve), 1);
    assert.equal(fadeGain(1.5, curve), 0);
    assert.equal(fadeGain(NaN, curve), 1);
    let prev = 1;
    for (let i = 1; i <= 1000; i++) {
      const g = fadeGain(i / 1000, curve);
      assert.ok(g <= prev + 1e-12, `monótona ${curve} en ${i}`);
      assert.ok(g >= 0 && g <= 1);
      prev = g;
    }
  }
});

test('fadeGain: forma de cada curva', () => {
  assert.equal(fadeGain(0.5, 'linear'), 0.5);
  assert.ok(Math.abs(fadeGain(0.5, 'smooth') - 0.5) < 1e-12);            // coseno elevado simétrico
  assert.ok(fadeGain(0.1, 'smooth') > fadeGain(0.1, 'linear'));           // arranca suave
  // 'exp' es (casi) recta en dB: a mitad de fade ≈ -30 dB
  const db = 20 * Math.log10(fadeGain(0.5, 'exp'));
  assert.ok(db < -29 && db > -31, `exp a mitad: ${db}`);
  const d1 = 20 * Math.log10(fadeGain(0.2, 'exp')) - 20 * Math.log10(fadeGain(0.1, 'exp'));
  const d2 = 20 * Math.log10(fadeGain(0.4, 'exp')) - 20 * Math.log10(fadeGain(0.3, 'exp'));
  assert.ok(Math.abs(d1 - d2) < 0.1, 'pasos iguales en dB');
});

test('renderEdit: longitud exacta, no muta la entrada y termina en 0', () => {
  const L = ramp(SR * 3);
  const R = ramp(SR * 3, 7);
  const copyL = L.slice();
  const out = renderEdit([L, R], SR, { cutTime: 2.5, fadeSec: 0.5, curve: 'linear' });
  assert.equal(out.length, 2);
  assert.equal(out[0].length, Math.round(2.5 * SR));
  assert.ok(out[0] !== L && out[0].buffer !== L.buffer);
  assert.deepEqual(L, copyL);
  assert.equal(out[0][out[0].length - 1], 0);
  assert.equal(out[1][out[1].length - 1], 0);
  // antes del fade: copia exacta
  const fadeStart = Math.round(2.5 * SR) - Math.round(0.5 * SR);
  for (const i of [0, 1000, fadeStart - 1]) assert.equal(out[0][i], L[i]);
  // a mitad del fade lineal: ≈ 0.5
  const mid = fadeStart + Math.round(0.25 * SR);
  assert.ok(Math.abs(out[0][mid] / L[mid] - 0.5) < 0.001);
  // primera muestra del fade ya atenuada un poco
  assert.ok(out[0][fadeStart] < L[fadeStart] && out[0][fadeStart] > 0.99 * L[fadeStart]);
});

test('renderEdit: la muestra de corte es round(cutTime·sr)', () => {
  const L = ramp(1000);
  for (const cutTime of [0.01, 0.0100001, 0.010011, 0.0123456]) {
    const out = renderEdit([L], 1000 * 10, { cutTime });
    assert.equal(out[0].length, Math.round(cutTime * 10000));
  }
});

test('renderEdit: fade 0 → rampa anti-clic mínima de 5 ms', () => {
  const L = new Float32Array(SR).fill(0.8);
  const out = renderEdit([L], SR, { cutTime: 0.5, fadeSec: 0 })[0];
  const cut = Math.round(0.5 * SR);
  const ac = Math.round(ANTICLICK_SEC * SR);
  assert.equal(out.length, cut);
  assert.equal(out[cut - ac - 1], L[0]);        // justo antes de la rampa: intacto
  assert.ok(out[cut - ac] < 0.8);               // la rampa empieza aquí
  assert.equal(out[cut - 1], 0);
  let maxStep = 0;
  for (let i = cut - ac; i < cut; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep < 0.8 / ac * 2, `sin saltos bruscos (${maxStep})`);
  // un fade más corto que el anti-clic también usa 5 ms
  const out2 = renderEdit([L], SR, { cutTime: 0.5, fadeSec: 0.001 })[0];
  assert.deepEqual(out2, out);
});

test('renderEdit: startTime corta el tramo y coincide con el render completo', () => {
  const L = ramp(SR * 4);
  const R = ramp(SR * 4, 3);
  const opts = { cutTime: 3.2, fadeSec: 1.5, curve: 'exp' };
  const full = renderEdit([L, R], SR, opts);
  for (const startTime of [0, 1, 2.1, 3.0, 3.19]) {
    const part = renderEdit([L, R], SR, { ...opts, startTime });
    const s0 = Math.round(startTime * SR);
    assert.equal(part[0].length, Math.round(3.2 * SR) - s0);
    for (let c = 0; c < 2; c++) assert.deepEqual(part[c], full[c].subarray(s0));
  }
});

test('renderEdit: valores fuera de rango se acotan', () => {
  const L = ramp(SR);
  const n = L.length;
  // corte más allá del final → hasta el final (con fade)
  let out = renderEdit([L], SR, { cutTime: 99 })[0];
  assert.equal(out.length, n);
  assert.equal(out[n - 1], 0);
  // corte negativo → vacío
  assert.equal(renderEdit([L], SR, { cutTime: -1 })[0].length, 0);
  // corte no numérico → hasta el final
  assert.equal(renderEdit([L], SR, { cutTime: NaN })[0].length, n);
  assert.equal(renderEdit([L], SR, {})[0].length, n);
  // startTime > cutTime → vacío; startTime negativo → 0
  assert.equal(renderEdit([L], SR, { cutTime: 0.5, startTime: 0.7 })[0].length, 0);
  assert.equal(renderEdit([L], SR, { cutTime: 0.5, startTime: -3 })[0].length, Math.round(0.5 * SR));
  // fade más largo que el audio: fade desde la muestra 0
  out = renderEdit([L], SR, { cutTime: 0.1, fadeSec: 10, curve: 'linear' })[0];
  assert.ok(out[0] < L[0] && out[0] > 0.99 * L[0]);
  assert.equal(out[out.length - 1], 0);
  // fade negativo o NaN → anti-clic
  const a = renderEdit([L], SR, { cutTime: 0.5, fadeSec: -2 })[0];
  const b = renderEdit([L], SR, { cutTime: 0.5, fadeSec: NaN })[0];
  const c = renderEdit([L], SR, { cutTime: 0.5, fadeSec: 0 })[0];
  assert.deepEqual(a, c);
  assert.deepEqual(b, c);
  // curva desconocida → 'smooth'
  assert.deepEqual(renderEdit([L], SR, { cutTime: 0.5, fadeSec: 0.2, curve: 'zzz' })[0],
    renderEdit([L], SR, { cutTime: 0.5, fadeSec: 0.2, curve: 'smooth' })[0]);
  // canales de distinta longitud → el más corto manda
  const short = ramp(1000);
  const res = renderEdit([L, short], SR, { cutTime: 1 });
  assert.equal(res[0].length, 1000);
  assert.equal(res[1].length, 1000);
  // sin canales / frecuencia inválida
  assert.deepEqual(renderEdit([], SR, { cutTime: 1 }), []);
  assert.equal(renderEdit([L], 0, { cutTime: 1 })[0].length, 0);
  // arrays normales también valen
  const arr = renderEdit([[0.5, 0.5, 0.5, 0.5]], 1000, { cutTime: 0.004, fadeSec: 0.002, curve: 'linear' })[0];
  assert.ok(arr instanceof Float32Array);
  assert.equal(arr.length, 4);
});

test('renderEdit: cada curva produce un fade monótono sobre señal constante', () => {
  const L = new Float32Array(SR * 2).fill(0.5);
  for (const curve of FADE_CURVES) {
    const out = renderEdit([L], SR, { cutTime: 1.5, fadeSec: 1, curve })[0];
    const f0 = Math.round(0.5 * SR);
    for (let i = f0 + 1; i < out.length; i++) assert.ok(out[i] <= out[i - 1], `${curve} en ${i}`);
    assert.equal(out[out.length - 1], 0);
    assert.equal(out[f0 - 1], 0.5);
  }
});
