import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSegments, mixCrossfade, SPLICE_CEILING, renderedLength, segmentSource } from '../js/audio/splice.js';
import { renderEdit } from '../js/audio/edit.js';

const SR = 44100;

function sine(seconds, freq, { amp = 1, phase = 0, sr = SR } = {}) {
  const n = Math.round(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / sr + phase);
  return a;
}

function noise(n, seed = 1) {
  const a = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    a[i] = (s / 0xffffffff) * 2 - 1;
  }
  return a;
}

const expectedLength = (segs, sr = SR) =>
  segs.reduce((acc, s) => acc + Math.max(0, Math.round(s.end * sr) - Math.round(s.start * sr)), 0);

function maxJump(a, from = 0, to = a.length) {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}

function maxAbs(a, from = 0, to = a.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

const antiClick = Math.round(0.005 * SR);

test('longitud exacta: Σ round(end·sr) − round(start·sr)', () => {
  const src = [noise(SR * 4, 7)];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 50; trial++) {
    const segs = [];
    const n = 1 + Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) {
      const start = rnd() * 4.5 - 0.2;               // a veces fuera de la fuente
      segs.push({ start, end: start + rnd() * 0.8 - 0.05 });
    }
    const out = renderSegments(src, SR, segs, { crossfadeSec: rnd() * 0.04 });
    assert.equal(out[0].length, expectedLength(segs));
    for (const v of out[0]) assert.ok(Number.isFinite(v));
  }
  const odd = [{ start: 0.1234567, end: 0.9876543 }, { start: 1.1111111, end: 2.2222222 }];
  assert.equal(renderSegments(src, SR, odd)[0].length, expectedLength(odd));
});

test('copia bit a bit en segmentos contiguos y lejos de los empalmes', () => {
  const src = noise(SR * 3, 3);
  const single = renderSegments([src], SR, [{ start: 0, end: 3 }])[0];
  assert.equal(single.length, src.length);
  for (let i = 0; i < src.length - antiClick; i++) assert.equal(single[i], src[i]);

  const contiguous = renderSegments([src], SR, [{ start: 0, end: 0.5 }, { start: 0.5, end: 1.2 }, { start: 1.2, end: 3 }])[0];
  assert.deepEqual(contiguous, single);

  // A 1 muestra de distancia se considera contiguo: concatenación exacta, sin crossfade.
  const gap1 = renderSegments([src], SR, [{ start: 0, end: 22050 / SR }, { start: 22051 / SR, end: 1 }])[0];
  for (let i = 0; i < 22050; i++) assert.equal(gap1[i], src[i]);
  for (let i = 22050; i < gap1.length - antiClick; i++) assert.equal(gap1[i], src[i + 1]);

  // Empalme real: solo cambia la ventana del crossfade [p − h, p + r).
  const xf = Math.round(0.01 * SR);
  const h = Math.floor(xf / 2);
  const r = xf - h;
  const b0 = Math.round(1.5 * SR);
  const out = renderSegments([src], SR, [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }])[0];
  const p = SR;
  for (let i = 0; i < p - h; i++) assert.equal(out[i], src[i]);
  for (let i = p + r; i < out.length - antiClick; i++) assert.equal(out[i], src[i - p + b0]);
  let changed = 0;
  for (let i = p - h; i < p; i++) if (out[i] !== src[i]) changed++;
  for (let i = p; i < p + r; i++) if (out[i] !== src[i - p + b0]) changed++;
  assert.ok(changed > xf * 0.9);

  // crossfadeSec = 0 → empalme seco, concatenación exacta.
  const hard = renderSegments([src], SR, [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }], { crossfadeSec: 0 })[0];
  for (let i = 0; i < p; i++) assert.equal(hard[i], src[i]);
  for (let i = p; i < hard.length - antiClick; i++) assert.equal(hard[i], src[i - p + Math.round(1.5 * SR)]);
});

test('crossfade de igual potencia: senoides en fase, sin caída ni salto grande', () => {
  const f = 100;                                        // período = 441 muestras
  const src = sine(3, f);
  const naturalStep = 2 * Math.sin(Math.PI * f / SR);   // salto máximo propio de la senoide
  const segs = [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }];   // 0,5 s = 50 períodos → misma fase
  const out = renderSegments([src], SR, segs)[0];
  const p = SR;
  const win = 441;
  // Envolvente (pico por período) alrededor del empalme.
  let minEnv = Infinity;
  let maxEnv = 0;
  for (let w = p - 3 * win; w < p + 3 * win; w += 20) {
    const e = maxAbs(out, w, w + win);
    minEnv = Math.min(minEnv, e);
    maxEnv = Math.max(maxEnv, e);
  }
  assert.ok(minEnv > 0.999, `caída de amplitud: ${minEnv}`);
  assert.ok(maxEnv <= Math.SQRT2 + 1e-6, `pico: ${maxEnv}`);
  const jump = maxJump(out, p - 2000, p + 2000);
  assert.ok(jump < naturalStep * 1.75, `salto ${jump} vs natural ${naturalStep}`);
});

test('crossfade: empalme fuera de fase no produce clic (y sin crossfade sí)', () => {
  const f = 220;
  const src = sine(3, f);
  const naturalStep = 2 * Math.sin(Math.PI * f / SR);
  // Salto de 0,5 s + 1/4 de período → 90° de desfase; y otro con fase arbitraria.
  for (const jumpSec of [0.5 + 1 / (4 * f), 0.5123457]) {
    const segs = [{ start: 0, end: 1 }, { start: 1 + jumpSec, end: 2.5 }];
    const hard = renderSegments([src], SR, segs, { crossfadeSec: 0 })[0];
    const soft = renderSegments([src], SR, segs)[0];
    const hardJump = maxJump(hard, SR - 50, SR + 50);
    const softJump = maxJump(soft, SR - 2000, SR + 2000);
    assert.ok(hardJump > naturalStep * 5, `el test detecta el clic: ${hardJump}`);
    assert.ok(softJump < naturalStep * 1.5, `salto con crossfade ${softJump} vs natural ${naturalStep}`);
    for (let i = SR - 2000; i < SR + 2000; i++) assert.ok(Math.abs(soft[i]) <= Math.SQRT2 + 1e-6);
  }
});

test('crossfade: silencio → señal es una rampa suave', () => {
  const src = new Float32Array(SR * 2);
  src.fill(0.8, SR);                                   // 0 en [0,1) s, 0,8 en [1,2) s
  const segs = [{ start: 0, end: 0.5 }, { start: 1.2, end: 2 }];
  const out = renderSegments([src], SR, segs)[0];
  const p = Math.round(0.5 * SR);
  const xf = Math.round(0.01 * SR);
  const h = Math.floor(xf / 2);
  const r = xf - h;
  for (let i = 0; i < p - h; i++) assert.equal(out[i], 0);
  for (let i = p + r; i < out.length - antiClick; i++) assert.equal(out[i], src[SR]);
  for (let i = p - h + 1; i < p + r; i++) assert.ok(out[i] >= out[i - 1], 'rampa monótona');
  assert.ok(out[p - h] > 0 && out[p + r - 1] < src[SR] && out[p + r - 1] > 0.79);
  const jump = maxJump(out, p - xf, p + xf);
  assert.ok(jump <= 0.8 * (Math.PI / 2) / xf * 1.01, `salto ${jump}`);
  assert.ok(out[p - 1] > 0.3 && out[p - 1] < 0.8 * Math.SQRT1_2 + 1e-3);   // centrado en el empalme

  // Silencio → senoide de 1 kHz: sin salto mayor que el propio de la senoide.
  const tone = new Float32Array(SR * 2);
  tone.set(sine(1, 1000, { amp: 0.9 }), SR);
  const out2 = renderSegments([tone], SR, [{ start: 0, end: 0.5 }, { start: 1.3, end: 2 }])[0];
  assert.ok(maxJump(out2, p - xf, p + xf) <= 2 * Math.sin(Math.PI * 1000 / SR) * 0.9 * 1.01);
});

test('crossfade limitado en los bordes de la fuente', () => {
  const src = sine(3, 50);
  const n = src.length;
  // B empieza en 0: no hay audio antes → el crossfade queda todo después del empalme.
  const segsB0 = [{ start: 1, end: 1.5 }, { start: 0, end: 0.5 }];
  const outB0 = renderSegments([src], SR, segsB0)[0];
  assert.equal(outB0.length, expectedLength(segsB0));
  const p = Math.round(0.5 * SR);
  for (let i = 0; i < p; i++) assert.equal(outB0[i], src[SR + i]);
  assert.ok(maxJump(outB0, p - 10, p + 500) < 0.02);

  // A termina en el final de la fuente: no se puede seguir leyendo → crossfade todo antes.
  const segsAEnd = [{ start: 2.5, end: 3 }, { start: 1, end: 1.5 }];
  const outAEnd = renderSegments([src], SR, segsAEnd)[0];
  const q = n - Math.round(2.5 * SR);
  for (let i = q; i < outAEnd.length - antiClick; i++) assert.equal(outAEnd[i], src[SR + i - q]);
  for (const v of outAEnd) assert.ok(Number.isFinite(v));

  // Segmentos que se salen de la fuente: silencio, longitud exacta.
  const segsOut = [{ start: -0.5, end: 0.5 }, { start: 2.8, end: 3.4 }];
  const outOut = renderSegments([src], SR, segsOut)[0];
  assert.equal(outOut.length, expectedLength(segsOut));
  const half = Math.round(0.5 * SR);
  const b2 = Math.round(2.8 * SR);
  for (let i = 0; i < half; i++) assert.equal(outOut[i], 0);
  for (let i = half; i < SR - 300; i++) assert.equal(outOut[i], src[i - half]);
  for (let i = SR + 300; i < SR + (n - b2); i++) assert.equal(outOut[i], src[b2 + i - SR]);
  for (let i = SR + (n - b2); i < outOut.length; i++) assert.equal(outOut[i], 0);
});

test('segmentos más cortos que el crossfade: sin solapes ni clics', () => {
  const src = sine(2, 30);                              // lenta: cualquier salto grande sería un clic
  const segs = [];
  for (let i = 0; i < 40; i++) segs.push({ start: 0.05 + i * 0.0437, end: 0.05 + i * 0.0437 + 0.002 });
  segs.push({ start: 1.9, end: 1.9 + 1 / SR });          // una sola muestra
  segs.push({ start: 0.3, end: 0.8 });
  const hard = renderSegments([src], SR, segs, { crossfadeSec: 0 })[0];
  const out = renderSegments([src], SR, segs, { crossfadeSec: 0.04 })[0];
  assert.equal(out.length, expectedLength(segs));
  for (const v of out) assert.ok(Number.isFinite(v) && Math.abs(v) <= Math.SQRT2 + 1e-6);
  assert.ok(maxJump(hard) > 0.5);
  // Cada segmento de 2 ms (88 muestras) cede como mucho 44 muestras a cada empalme:
  // pendiente máxima ≈ 2 · (π/2) / 88 ≈ 0,036 por muestra.
  const jump = maxJump(out, 0, out.length - antiClick);
  assert.ok(jump < 0.06, `salto ${jump}`);
});

test('fade-out final: curvas, mínimo anti-clic y última muestra en 0', () => {
  const dc = new Float32Array(SR).fill(1);
  const segs = [{ start: 0, end: 1 }];
  const F = Math.round(0.1 * SR);
  const mid = (a) => a[a.length - F + Math.round(F / 2) - 1];
  const curves = {};
  for (const curve of ['linear', 'smooth', 'exp']) {
    const out = renderSegments([dc], SR, segs, { fadeOutSec: 0.1, curve })[0];
    curves[curve] = out;
    assert.equal(out.length, SR);
    assert.equal(out[SR - F - 1], 1);
    assert.equal(out[SR - 1], 0);
    for (let i = SR - F; i < SR; i++) assert.ok(out[i] <= out[i - 1] && out[i] >= 0, `${curve} monótona`);
  }
  assert.ok(Math.abs(mid(curves.linear) - 0.5) < 0.01);
  assert.ok(Math.abs(mid(curves.smooth) - 0.5) < 0.02);
  // 'exp': recta en dB (≈ −15 dB al 25 %, −30 dB al 50 %, −45 dB al 75 %).
  const db = (x) => 20 * Math.log10(curves.exp[SR - F + Math.round(x * F) - 1]);
  assert.ok(Math.abs(db(0.25) + 15) < 0.3, `exp 25 %: ${db(0.25)}`);
  assert.ok(Math.abs(db(0.5) + 30) < 0.5, `exp 50 %: ${db(0.5)}`);
  assert.ok(Math.abs(db(0.75) + 45) < 2, `exp 75 %: ${db(0.75)}`);   // se curva al final para llegar a 0
  assert.ok(mid(curves.smooth) > mid(curves.exp));

  // fadeOutSec = 0 → solo el anti-clic de 5 ms.
  const anti = renderSegments([dc], SR, segs)[0];
  for (let i = 0; i < SR - antiClick; i++) assert.equal(anti[i], 1);
  assert.ok(anti[SR - antiClick] < 1);
  assert.equal(anti[SR - 1], 0);
  // Fade más largo que la salida: se limita a toda la salida.
  const long = renderSegments([dc], SR, [{ start: 0, end: 0.05 }], { fadeOutSec: 10, curve: 'linear' })[0];
  assert.ok(long[0] < 1 && long[0] > 0.99);
  assert.equal(long[long.length - 1], 0);
  // Curva desconocida → 'smooth'.
  assert.deepEqual(renderSegments([dc], SR, segs, { fadeOutSec: 0.1, curve: 'nope' })[0], curves.smooth);
  // Modo 1 solo: un segmento [0, corte).
  const cut = renderSegments([noise(SR * 2)], SR, [{ start: 0, end: 1.2345 }], { fadeOutSec: 0.5 })[0];
  assert.equal(cut.length, Math.round(1.2345 * SR));
});

test('multicanal: cada canal se procesa igual que por separado', () => {
  const a = noise(SR * 2, 21);
  const b = sine(2, 330, { amp: 0.7 });
  const c = noise(SR * 2, 22).map((v) => v * 0.3);
  const segs = [{ start: 0, end: 0.4 }, { start: 0.9, end: 1.3 }, { start: 0.2, end: 0.6 }, { start: 0.6, end: 1.9 }];
  const opts = { crossfadeSec: 0.02, fadeOutSec: 0.3, curve: 'exp' };
  const out = renderSegments([a, b, c], SR, segs, opts);
  assert.equal(out.length, 3);
  for (const [i, ch] of [a, b, c].entries()) {
    assert.deepEqual(out[i], renderSegments([ch], SR, segs, opts)[0]);
  }
});

test('nunca modifica las entradas', () => {
  const a = noise(SR, 5);
  const b = noise(SR, 6);
  const copyA = a.slice();
  const copyB = b.slice();
  const segs = Object.freeze([
    Object.freeze({ start: 0, end: 0.3 }), Object.freeze({ start: 0.5, end: 0.7 }), Object.freeze({ start: 0.1, end: 0.9 }),
  ]);
  const channels = Object.freeze([a, b]);
  const out = renderSegments(channels, SR, segs, { fadeOutSec: 0.2 });
  assert.deepEqual(a, copyA);
  assert.deepEqual(b, copyB);
  assert.notEqual(out[0], a);
  assert.notEqual(out[0].buffer, a.buffer);
});

test('entradas vacías o inválidas', () => {
  assert.deepEqual(renderSegments([], SR, [{ start: 0, end: 1 }]), []);
  const src = [noise(1000), noise(1000, 2)];
  assert.deepEqual(renderSegments(src, SR, []).map((x) => x.length), [0, 0]);
  assert.deepEqual(renderSegments(src, SR, null).map((x) => x.length), [0, 0]);
  assert.deepEqual(renderSegments(src, 0, [{ start: 0, end: 1 }]).map((x) => x.length), [0, 0]);
  const weird = [{ start: NaN, end: 1 }, { start: 0.01, end: 0.005 }, null, { start: 0, end: 0.01 }];
  assert.equal(renderSegments(src, SR, weird)[0].length, Math.round(0.01 * SR));
  // Array normal como canal.
  assert.equal(renderSegments([[0.1, 0.2, 0.3, 0.4]], 4, [{ start: 0, end: 1 }])[0].length, 4);
});

test('rendimiento: 5 min estéreo 44,1 kHz con ~150 empalmes', (t) => {
  const n = SR * 300;
  const left = noise(n, 11);
  const right = noise(n, 12);
  // Plan tipo 7/8 a 120 BPM: compases de 2 s, se quita el último 0,25 s de cada uno.
  const segs = [];
  let cursor = 0;
  for (let bar = 0; bar < 150; bar++) {
    const barEnd = 0.5 + (bar + 1) * 2 - 0.008;
    segs.push({ start: cursor, end: barEnd - 0.25 });
    cursor = barEnd;
  }
  segs.push({ start: cursor, end: 300 });
  renderSegments([left.subarray(0, SR * 5), right.subarray(0, SR * 5)], SR, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  const t0 = performance.now();
  const out = renderSegments([left, right], SR, segs, { fadeOutSec: 4 });
  const ms = performance.now() - t0;
  t.diagnostic(`renderSegments 5 min estéreo, 150 empalmes: ${ms.toFixed(1)} ms`);
  assert.equal(out[0].length, expectedLength(segs));
  assert.ok(ms < 300, `${ms} ms`);
});

test('from/to: un tramo de la salida es idéntico al mismo tramo del render completo', () => {
  const a = noise(SR * 3, 31);
  const b = sine(3, 440, { amp: 0.6 });
  const segs = [{ start: 0, end: 0.7 }, { start: 0.95, end: 1.6 }, { start: 1.2, end: 1.6 }, { start: 1.6, end: 2.9 }];
  for (const opts of [{}, { crossfadeSec: 0.04, fadeOutSec: 0.8, curve: 'exp' }, { crossfadeSec: 0, fadeOutSec: 0.3 }]) {
    const full = renderSegments([a, b], SR, segs, opts);
    const total = full[0].length;
    for (const [from, to] of [[0, Infinity], [0.69, 0.72], [0.5, 1.4], [1.0, 1.9], [2.0, 5], [2.7, undefined], [0.7, 0.7],
      [-3, 0.2], [0.3456789, 1.2345678]]) {
      const part = renderSegments([a, b], SR, segs, { ...opts, from, to });
      const w0 = Math.min(total, Math.max(0, Math.round(from * SR)));
      const w1 = to === undefined || to === Infinity ? total : Math.min(total, Math.max(w0, Math.round(to * SR)));
      for (let c = 0; c < 2; c++) {
        assert.equal(part[c].length, w1 - w0, `${from}–${to}`);
        assert.deepEqual(part[c], full[c].subarray(w0, w1), `${from}–${to} canal ${c}`);
      }
    }
  }
});

test('modo 1 por renderSegments = renderEdit, muestra a muestra (un solo fadeGain para los dos)', () => {
  const L = noise(SR * 3, 41);
  const R = sine(3, 220, { amp: 0.5 });
  for (const curve of ['linear', 'smooth', 'exp', 'otra']) {
    for (const [cutTime, fadeSec] of [[2.5, 0], [2.5, 0.001], [2.3456, 1.5], [0.02, 1]]) {
      const a = renderSegments([L, R], SR, [{ start: 0, end: cutTime }], { fadeOutSec: fadeSec, curve });
      const b = renderEdit([L, R], SR, { cutTime, fadeSec, curve });
      assert.deepEqual(a, b, `${curve} ${cutTime} ${fadeSec}`);
      // vista previa de los últimos 0,8 s (from) = renderEdit con startTime
      const start = Math.max(0, cutTime - 0.8);
      const pa = renderSegments([L, R], SR, [{ start: 0, end: cutTime }], { fadeOutSec: fadeSec, curve, from: start });
      const pb = renderEdit([L, R], SR, { cutTime, fadeSec, curve, startTime: start });
      assert.deepEqual(pa, pb, `preview ${curve} ${cutTime} ${fadeSec}`);
    }
  }
});

test('crossfade sobre audio correlacionado y a tope (master): nunca supera el pico de la fuente', () => {
  // Riff periódico (período 441 muestras) + algo de ruido, limitado duro a ±0,97 como un master "a tope".
  // Los empalmes saltan un número entero de períodos: A y B casi idénticos (ρ ≈ 1), donde el crossfade de
  // igual potencia llegaba a +3 dB (y recortaba al exportar).
  const n = SR * 4;
  const nz = noise(n, 77);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * i) / 441;
    const v = 1.3 * (Math.sin(ph) + 0.4 * Math.sin(3 * ph + 0.7)) + 0.08 * nz[i];
    src[i] = Math.max(-0.97, Math.min(0.97, v));
  }
  const segs = [];
  for (let k = 0; k < 12; k++) segs.push({ start: 0.1 + k * 0.3, end: 0.1 + k * 0.3 + 0.25 });   // saltos de 0,05 s
  for (const xfSec of [0.005, 0.01, 0.04]) {
    const out = renderSegments([src], SR, segs, { crossfadeSec: xfSec })[0];
    assert.ok(maxAbs(out) <= 0.97 + 1e-6, `${xfSec}: pico ${maxAbs(out)}`);
  }
});

test('mixCrossfade: igual potencia sin correlación, igual ganancia en fase; cerca de 0 dBFS nunca sobre el pico', () => {
  const L = 441;
  const c = new Float64Array(L);
  const s = new Float64Array(L);
  for (let j = 0; j < L; j++) {
    c[j] = Math.cos(((j + 0.5) / L) * Math.PI / 2);
    s[j] = Math.sin(((j + 0.5) / L) * Math.PI / 2);
  }
  const y = new Float64Array(L);
  const rms = (x, a, b) => { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return Math.sqrt(e / (b - a)); };
  // ruido independiente a nivel normal: la potencia en el centro se mantiene, como con igual potencia
  let lvl = 0;
  const trials = 40;
  for (let t = 0; t < trials; t++) {
    const a = Float64Array.from(noise(L, 100 + t), (v) => v * 0.4);
    const b = Float64Array.from(noise(L, 500 + t), (v) => v * 0.4);
    mixCrossfade(a, b, L, c, s, y);
    lvl += 20 * Math.log10(rms(y, 110, 331) / rms(a, 110, 331));
  }
  assert.ok(Math.abs(lvl / trials) < 0.5, `nivel medio ${lvl / trials} dB`);
  // ruido a 0 dBFS: nunca por encima del pico de A y B (no se crea recorte)
  for (let t = 0; t < trials; t++) {
    const a = Float64Array.from(noise(L, 900 + t));
    const b = Float64Array.from(noise(L, 1300 + t));
    mixCrossfade(a, b, L, c, s, y);
    const peak = Math.max(maxAbs(Float32Array.from(a)), maxAbs(Float32Array.from(b)));
    for (let j = 0; j < L; j++) assert.ok(Math.abs(y[j]) <= Math.max(peak, SPLICE_CEILING) * (1 + 1e-6));
  }
  // misma señal en A y B: la salida es la señal (sin +3 dB)
  const a = Float64Array.from(sine(0.01, 300, { amp: 0.8 }).subarray(0, L));
  mixCrossfade(a, a, L, c, s, y);
  for (let j = 0; j < L; j++) assert.ok(Math.abs(y[j] - a[j]) < 1e-9);
  // al revés de fase: sin división por cero ni valores raros
  const neg = a.map((v) => -v);
  mixCrossfade(a, neg, L, c, s, y);
  for (let j = 0; j < L; j++) assert.ok(Number.isFinite(y[j]) && Math.abs(y[j]) <= 0.8 + 1e-6);
  // silencio en los dos
  const z = new Float64Array(L);
  mixCrossfade(z, z, L, c, s, y);
  for (let j = 0; j < L; j++) assert.equal(y[j], 0);
});

test('segmentSource: leer la salida por tramos da las mismas muestras que el render completo', () => {
  const a = noise(SR * 3, 61);
  const b = sine(3, 440, { amp: 0.6 });
  const segs = [{ start: 0, end: 0.7 }, { start: 0.95, end: 1.6 }, { start: 1.2, end: 1.6 }, { start: 1.6, end: 2.9 }];
  const opts = { crossfadeSec: 0.03, fadeOutSec: 0.8, curve: 'exp' };
  const full = renderSegments([a, b], SR, segs, opts);
  const src = segmentSource([a, b], SR, segs, opts);
  assert.equal(src.length, full[0].length);
  assert.equal(src.length, renderedLength(segs, SR));
  assert.equal(src.numberOfChannels, 2);
  for (const step of [1000, 4410, 44100]) {
    for (let s0 = 0; s0 < src.length; s0 += step) {
      const s1 = Math.min(src.length, s0 + step);
      const part = src.read(s0, s1);
      for (let c = 0; c < 2; c++) assert.deepEqual(part[c], full[c].subarray(s0, s1), `${step} @${s0}`);
    }
  }
  assert.equal(renderedLength([{ start: 1, end: 0.5 }, null, { start: NaN, end: 1 }], SR), 0);
});
