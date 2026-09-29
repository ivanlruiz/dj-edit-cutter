import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportAudio, suggestFileName, mp3SampleRateFor, downmixToStereo, planSegments, buildLameInfoFrame, crc16,
  buildTagBytes, MP3_ENCODER_DELAY, workerCount, channelSource, MAX_WORKERS, MAX_WORKERS_LOW_MEMORY,
} from '../js/audio/export.js';
import { parseWav } from '../js/audio/wav.js';
import { readId3v2, buildId3v2, frameText } from '../js/audio/id3.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_FILE = path.join(ROOT, 'js/audio/mp3-worker.js');

// ---------- worker clásico ejecutado en un contexto vm (importScripts + postMessage simulados) ----------

function loadWorker(file, onPost) {
  const ctx = {
    Math, Int8Array, Uint8Array, Int16Array, Int32Array, Float32Array, Float64Array, Array, Object, Error,
    String, Number, Infinity, NaN, console,
  };
  ctx.self = ctx;
  ctx.postMessage = (m, transfer) => onPost(m, transfer);
  ctx.importScripts = (...urls) => {
    for (const u of urls) vm.runInContext(fs.readFileSync(path.resolve(path.dirname(file), u), 'utf8'), ctx);
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return ctx;
}

function runWorkerSync(msg) {
  const posted = [];
  const ctx = loadWorker(WORKER_FILE, (m, transfer) => posted.push({ m, transfer }));
  ctx.onmessage({ data: msg });
  return posted;
}

// Worker falso para exportAudio en Node: misma API que Worker (postMessage/onmessage/terminate)
class FakeWorker {
  static created = 0;
  constructor(url) {
    FakeWorker.created++;
    this.terminated = false;
    this.ctx = loadWorker(fileURLToPath(url), (m) => {
      setImmediate(() => { if (!this.terminated && this.onmessage) this.onmessage({ data: m }); });
    });
  }
  postMessage(m) {
    setImmediate(() => this.ctx.onmessage({ data: m }));
  }
  terminate() { this.terminated = true; }
}

let savedWorker;
before(() => { savedWorker = globalThis.Worker; globalThis.Worker = FakeWorker; });
after(() => { globalThis.Worker = savedWorker; });

// ---------- utilidades MP3 ----------

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SR1 = [44100, 48000, 32000];
function parseFrames(b, start) {
  const frames = [];
  let p = start;
  while (p < b.length) {
    assert.equal(b[p], 0xff, `sync en ${p}`);
    assert.equal(b[p + 1] & 0xfe, 0xfa, 'MPEG-1 capa III');
    const kbps = BR1[b[p + 2] >> 4];
    const rate = SR1[(b[p + 2] >> 2) & 3];
    const len = Math.floor(144000 * kbps / rate) + ((b[p + 2] >> 1) & 1);
    frames.push({ p, len, kbps, rate, mode: b[p + 3] >> 6 });
    p += len;
  }
  assert.equal(p, b.length, 'los frames terminan justo al final');
  return frames;
}

function music(seconds, sr, nCh = 2) {
  const n = Math.round(seconds * sr);
  return Array.from({ length: nCh }, (_, c) => {
    const x = new Float32Array(n);
    let s = 12345 + c;
    for (let i = 0; i < n; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const t = i / sr;
      const beat = Math.exp(-((t % 0.5) * 30));
      x[i] = 0.3 * Math.sin(2 * Math.PI * (110 + 55 * c) * t) + 0.2 * beat * ((s / 0xffffffff) * 2 - 1) + 0.1 * Math.sin(2 * Math.PI * 1760 * t);
    }
    return x;
  });
}

function sourceWithTag() {
  const latin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const tag = buildId3v2([
    { id: 'TIT2', data: new Uint8Array([3, ...new TextEncoder().encode('Canción de prueba')]) },
    { id: 'TPE1', data: new Uint8Array([0, ...latin1('Banda')]) },
    { id: 'TLEN', data: new Uint8Array([0, ...latin1('999')]) },
    { id: 'PRIV', data: latin1('traktor\u0000xyz') },
    { id: 'APIC', data: new Uint8Array([0, ...latin1('image/png'), 0, 3, 0, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xe0]) },
  ], { version: 4 });
  const src = new Uint8Array(tag.length + 417 * 3);
  src.set(tag);
  return src.buffer;
}

// ---------- nombres y frecuencias ----------

test('suggestFileName: casos límite', () => {
  assert.equal(suggestFileName('Mi canción.mp3', { barsRemoved: 4, format: 'mp3' }), 'Mi canción (edit -4 compases).mp3');
  assert.equal(suggestFileName('Mi canción.flac', { barsRemoved: 1, format: 'wav' }), 'Mi canción (edit -1 compás).wav');
  assert.equal(suggestFileName('C:\\Música\\DJ\\tema.m4a', { barsRemoved: 2, format: 'mp3' }), 'tema (edit -2 compases).mp3');
  assert.equal(suggestFileName('/home/dj/set/Artista - Tema (Original Mix).wav', { barsRemoved: 8, format: 'wav' }),
    'Artista - Tema (Original Mix) (edit -8 compases).wav');
  assert.equal(suggestFileName('sin extension', { barsRemoved: 16, format: 'mp3' }), 'sin extension (edit -16 compases).mp3');
  assert.equal(suggestFileName('v1.2 final', { barsRemoved: 1, format: 'mp3' }), 'v1.2 final (edit -1 compás).mp3');
  assert.equal(suggestFileName('a:b*c?"d"<e>|f.mp3', { barsRemoved: 1, format: 'mp3' }), 'a b c d e f (edit -1 compás).mp3');
  assert.equal(suggestFileName('', { barsRemoved: 2.5, format: 'mp3' }), 'Canción (edit -2,5 compases).mp3');
  assert.equal(suggestFileName(null, { barsRemoved: 1, format: 'wav' }), 'Canción (edit -1 compás).wav');
  assert.equal(suggestFileName('.mp3', { barsRemoved: 1, format: 'mp3' }), 'Canción (edit -1 compás).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 0, format: 'mp3' }), 'tema (edit).mp3');
  assert.equal(suggestFileName('tema.mp3', { format: 'mp3' }), 'tema (edit).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 0.04, format: 'mp3' }), 'tema (edit).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 1.04, format: 'mp3' }), 'tema (edit -1 compás).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 0.5, format: 'WAV' }), 'tema (edit -0,5 compases).wav');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 3 }), 'tema (edit -3 compases).mp3');
  assert.equal(suggestFileName('  ..raro..  .mp3', { barsRemoved: 1, format: 'mp3' }), 'raro (edit -1 compás).mp3');
  const long = suggestFileName('ñ'.repeat(300) + '.mp3', { barsRemoved: 1, format: 'mp3' });
  assert.ok(long.length < 150);
  assert.ok(suggestFileName('Cafe\u0301.mp3', { barsRemoved: 1, format: 'mp3' }).startsWith('Café'));   // NFC
  assert.ok(!/[\u0000-\u001f]/.test(suggestFileName('a\u0001b\nc.mp3', { barsRemoved: 1, format: 'mp3' })));
});

test('suggestFileName: con el compás nuevo', () => {
  assert.equal(suggestFileName('Canción.mp3', { barsRemoved: 2, format: 'mp3', meter: { num: 7, den: 8 } }), 'Canción (7-8, edit -2 compases).mp3');
  assert.equal(suggestFileName('Canción.mp3', { barsRemoved: null, format: 'wav', meter: { num: 7, den: 8 } }), 'Canción (7-8).wav');
  assert.equal(suggestFileName('Canción.flac', { format: 'wav', meter: '15/16' }), 'Canción (15-16).wav');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 1, format: 'mp3', meter: '5/4' }), 'tema (5-4, edit -1 compás).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 0, format: 'mp3', meter: { num: 3, den: 4 } }), 'tema (3-4, edit).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 2.5, format: 'mp3', meter: { num: 3, den: 4 } }), 'tema (3-4, edit -2,5 compases).mp3');
  // compás inválido → como sin compás
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 2, format: 'mp3', meter: { num: NaN, den: 8 } }), 'tema (edit -2 compases).mp3');
  assert.equal(suggestFileName('tema.mp3', { format: 'mp3', meter: 'x' }), 'tema (edit).mp3');
  assert.equal(suggestFileName('tema.mp3', { barsRemoved: 4, format: 'mp3', meter: null }), 'tema (edit -4 compases).mp3');
});

test('mp3SampleRateFor: sólo frecuencias MPEG-1', () => {
  const cases = { 44100: 44100, 48000: 48000, 32000: 32000, 22050: 44100, 11025: 44100, 88200: 44100, 176400: 44100,
    96000: 48000, 192000: 48000, 24000: 48000, 16000: 48000, 8000: 48000, 12000: 48000, 64000: 48000, 37800: 48000, 44099.6: 44100 };
  for (const [from, to] of Object.entries(cases)) assert.equal(mp3SampleRateFor(Number(from)), to, from);
});

test('downmixToStereo: mezcla 5.1 y quad sin saturar', () => {
  const n = 4;
  const one = () => new Float32Array(n).fill(0.5);
  const [L, R] = downmixToStereo([one(), one(), one(), one(), one(), one()]);
  // L = 0.5 + 0.707·(0.5 + 0.5) = 1.207 → normalizado a 1
  assert.ok(Math.abs(L[0] - 1) < 1e-6 && Math.abs(R[0] - 1) < 1e-6);
  const q = downmixToStereo([one(), new Float32Array(n), one(), new Float32Array(n)]);
  assert.ok(Math.abs(q[0][0] - 0.5) < 1e-6 && q[1][0] === 0);
  const seven = downmixToStereo(Array.from({ length: 7 }, (_, i) => new Float32Array(n).fill(i % 2 ? 0.2 : 0.4)));
  assert.ok(Math.abs(seven[0][0] - 0.4) < 1e-6 && Math.abs(seven[1][0] - 0.2) < 1e-6);
});

test('planSegments: segmentos contiguos por frames, con pre-roll', () => {
  const n = 44100 * 240;
  const segs = planSegments(n, 44100, 4);
  assert.ok(segs.length >= 2);
  assert.equal(segs[0].s0, 0);
  assert.equal(segs[0].dropFrames, 0);
  let frame = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    assert.equal(s.s0 % 1152, 0);
    assert.equal(s.s0 / 1152 + s.dropFrames, frame, 'el primer frame útil continúa al anterior');
    if (i < segs.length - 1) {
      assert.ok(s.maxFrames > 0);
      assert.ok(s.s1 >= (frame + s.maxFrames) * 1152, 'hay audio después del último frame útil');
      frame += s.maxFrames;
    } else {
      assert.equal(s.maxFrames, 0);
      assert.equal(s.s1, n);
    }
  }
  assert.equal(planSegments(44100 * 5, 44100, 8).length, 1, 'canciones cortas: un solo segmento');
  assert.equal(planSegments(1000, 44100, 1).length, 1);
});

// ---------- etiqueta Info/LAME ----------

test('buildLameInfoFrame: Info CBR con retardo, relleno y CRC', () => {
  const header = new Uint8Array([0xff, 0xfb, 0xe2, 0x04]);   // 320 kbps 44,1 kHz, con relleno, estéreo
  const f = buildLameInfoFrame(header, { frames: 100, audioBytes: 104480, sampleCount: 113000, audioCrc: 0x1234 });
  assert.equal(f.length, 1044);
  assert.equal(f[2] & 0x02, 0, 'sin bit de relleno');
  const x = 36;
  assert.equal(String.fromCharCode(...f.subarray(x, x + 4)), 'Info');
  const dv = new DataView(f.buffer);
  assert.equal(dv.getUint32(x + 4), 0x0f);
  assert.equal(dv.getUint32(x + 8), 100);
  assert.equal(dv.getUint32(x + 12), 1044 + 104480);
  const l = x + 120;
  assert.equal(String.fromCharCode(...f.subarray(l, l + 4)), 'LAME');
  const delay = (f[l + 21] << 4) | (f[l + 22] >> 4);
  const pad = ((f[l + 22] & 0x0f) << 8) | f[l + 23];
  assert.equal(delay, MP3_ENCODER_DELAY);
  assert.equal(pad, 100 * 1152 - 576 - 113000);
  assert.equal(dv.getUint16(l + 32), 0x1234);
  assert.equal(dv.getUint16(l + 34), crc16(f.subarray(0, l + 34)));
  // CRC-16/ARC de referencia: "123456789" → 0xBB3D
  assert.equal(crc16(Uint8Array.from('123456789', (c) => c.charCodeAt(0))), 0xbb3d);
  // mono: la cabecera Xing va tras 17 bytes de side info
  const m = buildLameInfoFrame(new Uint8Array([0xff, 0xfb, 0x90, 0xc4]), { frames: 3, audioBytes: 1251, sampleCount: 2000 });
  assert.equal(String.fromCharCode(...m.subarray(21, 25)), 'Info');
});

// ---------- worker MP3 ----------

test('mp3-worker: mono y estéreo, progreso, frames válidos y recorte por frames', () => {
  const [L, R] = music(3, 44100);
  const posted = runWorkerSync({ channels: [L.slice(), R.slice()], sampleRate: 44100, kbps: 320 });
  const progress = posted.filter((p) => p.m.type === 'progress').map((p) => p.m.fraction);
  assert.ok(progress.length >= 2);
  assert.equal(progress.at(-1), 1);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] > progress[i - 1]);
  const done = posted.at(-1);
  assert.equal(done.m.type, 'done');
  assert.equal(done.transfer.length, done.m.chunks.length);
  assert.equal(done.transfer[0], done.m.chunks[0].buffer, 'los chunks se transfieren');
  const bytes = done.m.chunks[0];
  const frames = parseFrames(bytes, 0);
  assert.equal(frames.length, done.m.frames);
  assert.ok(frames.every((f) => f.kbps === 320 && f.rate === 44100 && f.mode === 0), 'estéreo L/R a 320 kbps');
  assert.ok(Math.abs(frames.length - (L.length + 1105) / 1152) < 2);

  const mono = runWorkerSync({ channels: [L.slice(0, 20000)], sampleRate: 48000, kbps: 192 }).at(-1).m;
  const mf = parseFrames(mono.chunks[0], 0);
  assert.ok(mf.every((f) => f.kbps === 192 && f.rate === 48000 && f.mode === 3), 'mono');

  // dropFrames / maxFrames devuelven exactamente esos frames
  const cut = runWorkerSync({ channels: [L.slice(), R.slice()], sampleRate: 44100, kbps: 320, dropFrames: 4, maxFrames: 50 }).at(-1).m;
  assert.equal(cut.frames, 50);
  assert.equal(parseFrames(cut.chunks[0], 0).length, 50);

  const err = runWorkerSync({ channels: [], sampleRate: 44100, kbps: 320 }).at(-1).m;
  assert.equal(err.type, 'error');
  assert.match(err.message, /audio/);
});

test('mp3-worker: el dither es determinista por índice global (segmentos = serie)', () => {
  const [L] = music(1, 44100, 1);
  const a = runWorkerSync({ channels: [L.slice()], sampleRate: 44100, kbps: 320 }).at(-1).m.chunks[0];
  const b = runWorkerSync({ channels: [L.slice()], sampleRate: 44100, kbps: 320 }).at(-1).m.chunks[0];
  assert.deepEqual(a, b);
});

// ---------- exportAudio ----------

test('exportAudio MP3: etiqueta ID3 filtrada + frame Info/LAME + frames encadenados (en paralelo)', async () => {
  FakeWorker.created = 0;
  const sr = 44100;
  const chans = music(20, sr);
  const copies = chans.map((c) => c.slice());
  const fractions = [];
  const blob = await exportAudio({ channels: chans, sampleRate: sr, format: 'mp3', kbps: 320, sourceBytes: sourceWithTag(),
    onProgress: (f) => fractions.push(f) });
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(chans, copies, 'no toca la entrada');
  assert.ok(chans[0].length > 0, 'no desengancha la entrada');
  assert.ok(FakeWorker.created >= 1);
  assert.ok(planSegments(chans[0].length, sr, 4).length >= 2, 'la prueba cubre el empalme de segmentos');
  for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1] - 1e-9, 'progreso creciente');
  assert.equal(fractions.at(-1), 1);

  const b = new Uint8Array(await blob.arrayBuffer());
  const tag = readId3v2(b.buffer);
  assert.equal(tag.version, 4);
  assert.deepEqual(tag.frames.map((f) => f.id), ['TIT2', 'TPE1', 'APIC']);
  assert.equal(frameText(tag.frames[0]), 'Canción de prueba');
  const frames = parseFrames(b, tag.size);
  const info = b.subarray(frames[0].p, frames[0].p + frames[0].len);
  assert.equal(String.fromCharCode(...info.subarray(36, 40)), 'Info');
  const dv = new DataView(info.buffer, info.byteOffset, info.length);
  const audioFrames = frames.length - 1;
  assert.equal(dv.getUint32(44), audioFrames);
  assert.equal(dv.getUint32(48), b.length - tag.size);
  const l = 156;
  const delay = (info[l + 21] << 4) | (info[l + 22] >> 4);
  const pad = ((info[l + 22] & 0x0f) << 8) | info[l + 23];
  assert.equal(delay, 576);
  assert.equal(delay + chans[0].length + pad, audioFrames * 1152, 'retardo + muestras + relleno = frames·1152');
  assert.ok(pad >= 529 && pad < 529 + 1152 * 2);
  assert.equal(dv.getUint16(l + 34), crc16(info.subarray(0, l + 34)));
  assert.equal(dv.getUint16(l + 32), crc16(b.subarray(frames[1].p)));
  assert.ok(frames.slice(1).every((f) => f.kbps === 320 && f.rate === 44100));
});

test('exportAudio MP3: 96 kHz se remuestrea a 48 kHz; 22,05 kHz → 44,1 kHz; 6 canales → estéreo', async () => {
  for (const [sr, expected, nCh] of [[96000, 48000, 2], [22050, 44100, 1], [48000, 48000, 6]]) {
    const chans = music(1.5, sr, nCh);
    const blob = await exportAudio({ channels: chans, sampleRate: sr, format: 'mp3', kbps: 256, keepTags: false });
    const b = new Uint8Array(await blob.arrayBuffer());
    assert.equal(readId3v2(b.buffer), null, 'sin etiquetas');
    const frames = parseFrames(b, 0);
    assert.ok(frames.every((f) => f.rate === expected && f.kbps === 256), `${sr} → ${expected}`);
    assert.equal(frames[1].mode, nCh === 1 ? 3 : 0);
    const info = b.subarray(0, frames[0].len);
    const l = (nCh === 1 ? 21 : 36) + 120;
    const pad = ((info[l + 22] & 0x0f) << 8) | info[l + 23];
    const expectedSamples = Math.ceil((chans[0].length * expected) / sr);
    assert.equal(576 + expectedSamples + pad, (frames.length - 1) * 1152);
  }
});

test('exportAudio WAV: 16 y 24 bits con chunk id3 filtrado', async () => {
  const chans = music(0.5, 48000);
  for (const bitDepth of [16, 24]) {
    const blob = await exportAudio({ channels: chans, sampleRate: 48000, format: 'wav', bitDepth, sourceBytes: sourceWithTag() });
    assert.equal(blob.type, 'audio/wav');
    const buf = await blob.arrayBuffer();
    const w = parseWav(buf);
    assert.equal(w.bitDepth, bitDepth);
    assert.equal(w.sampleRate, 48000);
    assert.equal(w.channels[0].length, chans[0].length);
    const tag = readId3v2(buf);
    assert.deepEqual(tag.frames.map((f) => f.id), ['TIT2', 'TPE1', 'APIC']);
  }
  const plain = await exportAudio({ channels: chans, sampleRate: 48000, format: 'wav', sourceBytes: sourceWithTag(), keepTags: false });
  assert.equal(parseWav(await plain.arrayBuffer()).id3, null);
  assert.equal(buildTagBytes(new ArrayBuffer(100)), null);
  assert.equal(buildTagBytes(null), null);
});

test('workerCount: como mucho 3 workers MP3 (2 en móviles / poca memoria)', () => {
  assert.equal(MAX_WORKERS, 3);
  assert.equal(MAX_WORKERS_LOW_MEMORY, 2);
  assert.equal(workerCount(0, { hardwareConcurrency: 16, lowMemory: false }), 3);
  assert.equal(workerCount(0, { hardwareConcurrency: 8, lowMemory: true }), 2);
  assert.equal(workerCount(0, { hardwareConcurrency: 2, lowMemory: false }), 1);
  assert.equal(workerCount(1, { hardwareConcurrency: 16, lowMemory: false }), 1);
});

test('exportAudio desde una fuente por tramos: mismos bytes que desde los canales y nunca lee la salida entera', async () => {
  const sr = 44100;
  const chans = music(30, sr);
  const tags = buildTagBytes(sourceWithTag());
  for (const [format, extra] of [['wav', { bitDepth: 16 }], ['wav', { bitDepth: 24 }], ['mp3', { kbps: 256 }]]) {
    const reads = [];
    const base = channelSource(chans);
    const source = { ...base, read: (a, b) => { reads.push(b - a); return base.read(a, b); } };
    const a = await exportAudio({ source, sampleRate: sr, format, ...extra, tagBytes: tags });
    const b = await exportAudio({ channels: chans, sampleRate: sr, format, ...extra, sourceBytes: sourceWithTag() });
    assert.deepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()), format);
    assert.ok(reads.length >= 2 && Math.max(...reads) < chans[0].length, `${format}: tramos ${reads.join(', ')}`);
  }
  // tagBytes null = sin etiquetas aunque keepTags
  const none = await exportAudio({ channels: chans, sampleRate: sr, format: 'wav', tagBytes: null });
  assert.equal(parseWav(await none.arrayBuffer()).id3, null);
});
