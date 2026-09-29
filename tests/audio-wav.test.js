import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, parseWav } from '../js/audio/wav.js';
import { readId3v2 } from '../js/audio/id3.js';

function noise(n, seed = 1, amp = 0.9) {
  const a = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    a[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return a;
}

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

// Recorre los chunks de un RIFF y devuelve [{id, size, off}]
function chunks(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const out = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const size = dv.getUint32(p + 4, true);
    out.push({ id: ascii(b, p, 4), size, off: p + 8 });
    p += 8 + size + (size & 1);
  }
  assert.equal(p, b.length, 'los chunks cubren el archivo exacto');
  return out;
}

test('WAV 16 bits: ida y vuelta dentro de la tolerancia del dither', () => {
  const L = noise(10001, 1);
  const R = noise(10001, 2);
  const buf = encodeWav([L, R], 44100, { bitDepth: 16 });
  const dv = new DataView(buf);
  assert.equal(ascii(new Uint8Array(buf), 0, 4), 'RIFF');
  assert.equal(dv.getUint32(4, true), buf.byteLength - 8);
  assert.equal(dv.getUint16(20, true), 1);          // PCM
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(24, true), 44100);
  assert.equal(dv.getUint32(28, true), 44100 * 4);  // byte rate
  assert.equal(dv.getUint16(32, true), 4);          // block align
  assert.equal(dv.getUint16(34, true), 16);
  const w = parseWav(buf);
  assert.equal(w.sampleRate, 44100);
  assert.equal(w.bitDepth, 16);
  assert.equal(w.channels.length, 2);
  assert.equal(w.channels[0].length, 10001);
  let maxErr = 0;
  let sumErr = 0;
  for (let c = 0; c < 2; c++) {
    const src = c ? R : L;
    for (let i = 0; i < src.length; i++) {
      const e = w.channels[c][i] - src[i];
      maxErr = Math.max(maxErr, Math.abs(e));
      sumErr += e;
    }
  }
  assert.ok(maxErr <= 1.5 / 32768 + 1e-9, `error máx ${maxErr * 32768} LSB`);
  assert.ok(Math.abs(sumErr / 20002) < 0.05 / 32768, 'dither sin sesgo');
  // el dither existe: no todas las muestras coinciden con el redondeo simple
  let differs = 0;
  for (let i = 0; i < L.length; i++) if (Math.round(L[i] * 32768) !== Math.round(w.channels[0][i] * 32768)) differs++;
  assert.ok(differs > L.length * 0.1, `dither aplicado (${differs})`);
});

test('WAV 16 bits: silencio digital intacto y recorte a ±1', () => {
  const x = new Float32Array([0, 0, 1.5, -1.5, 1, -1, 0, NaN]);
  const w = parseWav(encodeWav([x], 48000));
  const v = Array.from(w.channels[0], (s) => Math.round(s * 32768));
  assert.deepEqual(v.slice(0, 2), [0, 0]);
  assert.equal(v[2], 32767);
  assert.equal(v[3], -32768);
  assert.ok(v[4] >= 32766 && v[4] <= 32767);
  assert.ok(v[5] >= -32768 && v[5] <= -32767);
  assert.equal(v[6], 0);
  assert.equal(v[7], 0);
});

test('WAV 24 bits: exacto a 1 LSB, mono con tamaño impar y relleno', () => {
  const x = noise(1001, 5, 0.99);
  const buf = encodeWav([x], 96000, { bitDepth: 24 });
  const cs = chunks(buf);
  const data = cs.find((c) => c.id === 'data');
  assert.equal(data.size, 1001 * 3);                  // impar → lleva byte de relleno
  assert.equal(buf.byteLength, 12 + 8 + 16 + 8 + 3003 + 1);
  const w = parseWav(buf);
  assert.equal(w.bitDepth, 24);
  assert.equal(w.sampleRate, 96000);
  for (let i = 0; i < x.length; i++) {
    assert.ok(Math.abs(w.channels[0][i] - x[i]) <= 1 / 8388608, `muestra ${i}`);
  }
  // valores extremos
  const e = parseWav(encodeWav([new Float32Array([1, -1, 2, -2])], 44100, { bitDepth: 24 })).channels[0];
  assert.deepEqual(Array.from(e, (s) => Math.round(s * 8388608)), [8388607, -8388608, 8388607, -8388608]);
});

test('WAV con más de 2 canales usa WAVE_FORMAT_EXTENSIBLE', () => {
  for (const [nCh, mask] of [[3, 0x7], [4, 0x33], [6, 0x3f], [8, 0x63f]]) {
    const chans = Array.from({ length: nCh }, (_, c) => noise(333, c + 1, 0.5));
    for (const bitDepth of [16, 24]) {
      const buf = encodeWav(chans, 48000, { bitDepth });
      const dv = new DataView(buf);
      assert.equal(dv.getUint32(16, true), 40);           // tamaño fmt
      assert.equal(dv.getUint16(20, true), 0xfffe);
      assert.equal(dv.getUint16(22, true), nCh);
      assert.equal(dv.getUint16(32, true), nCh * bitDepth / 8);
      assert.equal(dv.getUint16(36, true), 22);           // cbSize
      assert.equal(dv.getUint16(38, true), bitDepth);     // bits válidos
      assert.equal(dv.getUint32(40, true), mask);
      assert.equal(dv.getUint16(44, true), 1);            // SubFormat PCM
      const w = parseWav(buf);
      assert.equal(w.channels.length, nCh);
      const tol = bitDepth === 16 ? 1.5 / 32768 : 1 / 8388608;
      for (let c = 0; c < nCh; c++) {
        for (let i = 0; i < 333; i++) assert.ok(Math.abs(w.channels[c][i] - chans[c][i]) <= tol + 1e-9);
      }
    }
  }
});

test("WAV: chunk 'id3 ' con relleno a tamaño par y legible", () => {
  // etiqueta ID3v2.3 mínima de tamaño impar (TIT2 'Hola')
  const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 15,
    0x54, 0x49, 0x54, 0x32, 0, 0, 0, 5, 0, 0, 0, 0x48, 0x6f, 0x6c, 0x61]);
  assert.equal(tag.length % 2, 1);
  const buf = encodeWav([noise(11, 3), noise(11, 4)], 44100, { bitDepth: 24, id3: tag });
  const cs = chunks(buf);
  assert.deepEqual(cs.map((c) => c.id), ['fmt ', 'data', 'id3 ']);
  const id3 = cs[2];
  assert.equal(id3.size, tag.length);
  assert.equal(new DataView(buf).getUint32(4, true), buf.byteLength - 8);
  assert.equal(buf.byteLength % 2, 0);
  assert.deepEqual(new Uint8Array(buf, id3.off, id3.size), tag);
  const w = parseWav(buf);
  assert.deepEqual(w.id3, tag);
  // readId3v2 encuentra la etiqueta dentro del WAV
  const r = readId3v2(buf);
  assert.equal(r.version, 3);
  assert.equal(r.frames[0].id, 'TIT2');
  // sin etiqueta no hay chunk
  assert.deepEqual(chunks(encodeWav([noise(10)], 44100)).map((c) => c.id), ['fmt ', 'data']);
});

test('WAV: errores claros en español', () => {
  assert.throws(() => encodeWav([], 44100), /audio/);
  assert.throws(() => encodeWav([noise(10)], 0), /[Ff]recuencia/);
  assert.throws(() => encodeWav([noise(10)], 44100, { bitDepth: 32 }), /bits/);
  // más de 4 GB: se detecta antes de reservar memoria
  const huge = { length: 2 ** 30 };
  assert.throws(() => encodeWav([huge, huge], 44100, { bitDepth: 24 }), /4 GB/);
  assert.throws(() => parseWav(new ArrayBuffer(12)), /WAV/);
});

test('parseWav lee también float32 y 8 bits', () => {
  // float32 estéreo, 2 frames
  const buf = new ArrayBuffer(44 + 16);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 52, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); dv.setUint16(22, 2, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 64000, true);
  dv.setUint16(32, 8, true); dv.setUint16(34, 32, true); w(36, 'data'); dv.setUint32(40, 16, true);
  [0.5, -0.25, 1, 0].forEach((v, i) => dv.setFloat32(44 + 4 * i, v, true));
  const r = parseWav(buf);
  assert.deepEqual(Array.from(r.channels[0]), [0.5, 1]);
  assert.deepEqual(Array.from(r.channels[1]), [-0.25, 0]);
});
