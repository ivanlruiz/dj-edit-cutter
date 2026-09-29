import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffSampleRate, resample, downmixMono, toAnalysisMono, createResampler } from '../js/audio/decode.js';

// ---------- fabricación de cabeceras ----------

const cat = (...parts) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n) => [(n >>> 8) & 0xff, n & 0xff];
const ss32 = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const sniff = (u8) => sniffSampleRate(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

function riffChunk(id, body) {
  return cat(latin1(id), le32(body.length), body, body.length & 1 ? [0] : []);
}
function fmtPcm(rate, ch = 2, bits = 16) {
  return cat(le16(1), le16(ch), le32(rate), le32(rate * ch * bits / 8), le16(ch * bits / 8), le16(bits));
}
function wav(chunks, magic = 'RIFF') {
  const body = cat(latin1('WAVE'), ...chunks);
  return cat(latin1(magic), le32(magic === 'RF64' ? 0xffffffff : body.length), body);
}

// 80 bits extendido (AIFF) para enteros
function ext80(v) {
  const e = Math.floor(Math.log2(v));
  const mant = BigInt(v) << BigInt(63 - e);
  const out = [((16383 + e) >> 8) & 0x7f, (16383 + e) & 0xff];
  for (let i = 7; i >= 0; i--) out.push(Number((mant >> BigInt(8 * i)) & 0xffn));
  return out;
}

function streamInfo(rate, ch = 2, bps = 16) {
  const s = new Uint8Array(34);
  s[0] = 0x10; s[2] = 0x10;
  s[10] = (rate >> 12) & 0xff;
  s[11] = (rate >> 4) & 0xff;
  s[12] = ((rate & 0x0f) << 4) | ((ch - 1) << 1) | ((bps - 1) >> 4);
  s[13] = ((bps - 1) & 0x0f) << 4;
  return s;
}

function mpegFrames(b1, b2, len, count = 3, b3 = 0x64) {
  const f = new Uint8Array(len);
  f.set([0xff, b1, b2, b3]);
  return cat(...Array.from({ length: count }, () => f));
}

function adtsFrames(srIdx, len = 200, count = 3) {
  const f = new Uint8Array(len);
  f.set([0xff, 0xf1, (1 << 6) | (srIdx << 2) | 0, (2 << 6) | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
  return cat(...Array.from({ length: count }, () => f));
}

function oggPage(packet, bos = true) {
  return cat(latin1('OggS'), [0, bos ? 2 : 0], new Uint8Array(8), le32(1234), le32(0), le32(0), [1, packet.length], packet);
}

function box(type, ...children) {
  const body = cat(...children);
  return cat(be32(8 + body.length), latin1(type), body);
}
function box64(type, body) {
  const size = 16 + body.length;
  return cat(be32(1), latin1(type), be32(0), be32(size), body);
}
const mdhd = (ts, v = 0) => (v === 1
  ? box('mdhd', [1, 0, 0, 0], new Uint8Array(16), be32(ts), new Uint8Array(8), [0x55, 0xc4, 0, 0])
  : box('mdhd', [0, 0, 0, 0], new Uint8Array(8), be32(ts), be32(0), [0x55, 0xc4, 0, 0]));
const hdlr = (kind) => box('hdlr', new Uint8Array(4), new Uint8Array(4), latin1(kind), new Uint8Array(12), [0]);
function esds(asc) {
  const dsi = cat([0x05, asc.length], asc);
  const dcd = cat([0x04, 13 + dsi.length, 0x40, 0x15], new Uint8Array(3), be32(0), be32(0), dsi);
  const esd = cat([0x03, 3 + dcd.length], be16(1), [0], dcd);
  return box('esds', [0, 0, 0, 0], esd);
}
function audioEntry(type, rate, kids = []) {
  return box(type, new Uint8Array(6), be16(1), be16(0), be16(0), new Uint8Array(4), be16(2), be16(16), be16(0), be16(0),
    be32((rate % 65536) * 65536), ...kids);
}
function trak(kind, ts, entry, mdhdVersion = 0) {
  const stsd = box('stsd', [0, 0, 0, 0], be32(1), entry);
  return box('trak', box('tkhd', new Uint8Array(84)),
    box('mdia', mdhd(ts, mdhdVersion), hdlr(kind), box('minf', box('stbl', stsd))));
}
const ftyp = box('ftyp', latin1('M4A '), be32(0), latin1('isomM4A '));
// bits → bytes (para AudioSpecificConfig)
function bits(str) {
  const s = str.replace(/\s/g, '').padEnd(Math.ceil(str.replace(/\s/g, '').length / 8) * 8, '0');
  return Uint8Array.from(s.match(/.{8}/g), (b) => parseInt(b, 2));
}

// ---------- sniffSampleRate ----------

test('WAV: PCM, EXTENSIBLE, RF64 y chunks previos de tamaño impar', () => {
  assert.equal(sniff(wav([riffChunk('fmt ', fmtPcm(48000)), riffChunk('data', new Uint8Array(8))])), 48000);
  const ext = cat(le16(0xfffe), le16(6), le32(88200), le32(88200 * 18), le16(18), le16(24), le16(22), le16(24), le32(0x3f), new Uint8Array(16));
  assert.equal(sniff(wav([riffChunk('fmt ', ext), riffChunk('data', new Uint8Array(18))])), 88200);
  const ds64 = riffChunk('ds64', new Uint8Array(28));
  assert.equal(sniff(wav([ds64, riffChunk('fmt ', fmtPcm(96000)), cat(latin1('data'), le32(0xffffffff), new Uint8Array(12))], 'RF64')), 96000);
  assert.equal(sniff(wav([riffChunk('bext', new Uint8Array(5)), riffChunk('fmt ', fmtPcm(44100))])), 44100);
});

test('AIFF y AIFC (frecuencia en coma flotante de 80 bits)', () => {
  for (const rate of [8000, 22050, 44100, 48000, 96000, 192000]) {
    const comm = cat(latin1('COMM'), be32(18), be16(2), be32(1000), be16(16), ext80(rate));
    assert.equal(sniff(cat(latin1('FORM'), be32(4 + comm.length), latin1('AIFF'), comm)), rate, `AIFF ${rate}`);
  }
  const fver = cat(latin1('FVER'), be32(4), be32(0xa2805140));
  const comm = cat(latin1('COMM'), be32(24), be16(2), be32(1000), be16(16), ext80(48000), latin1('NONE'), [0, 0]);
  assert.equal(sniff(cat(latin1('FORM'), be32(4 + fver.length + comm.length), latin1('AIFC'), fver, comm)), 48000);
});

test('FLAC (con y sin ID3v2 delante)', () => {
  const flac = (rate) => cat(latin1('fLaC'), [0x80, 0, 0, 34], streamInfo(rate));
  for (const rate of [44100, 48000, 88200, 96000, 192000]) assert.equal(sniff(flac(rate)), rate);
  const id3 = cat(latin1('ID3'), [4, 0, 0x10], ss32(20), new Uint8Array(20), latin1('3DI'), [4, 0, 0], ss32(20));
  assert.equal(sniff(cat(id3, flac(96000))), 96000);
});

test('MP3: MPEG-1/2/2.5, ID3v2 con footer, basura antes y confirmación con el siguiente frame', () => {
  assert.equal(sniff(mpegFrames(0xfb, 0x90, 417)), 44100);            // MPEG-1 128 kbps 44,1 kHz
  assert.equal(sniff(mpegFrames(0xfb, 0xe4, 960)), 48000);            // MPEG-1 320 kbps 48 kHz
  assert.equal(sniff(mpegFrames(0xfb, 0x98, 576)), 32000);            // MPEG-1 128 kbps 32 kHz
  assert.equal(sniff(mpegFrames(0xf3, 0x80, 208)), 22050);            // MPEG-2 64 kbps 22,05 kHz
  assert.equal(sniff(mpegFrames(0xf3, 0x88, 288)), 16000);            // MPEG-2 64 kbps 16 kHz
  assert.equal(sniff(mpegFrames(0xe3, 0x80, 417)), 11025);            // MPEG-2.5 64 kbps 11,025 kHz
  assert.equal(sniff(mpegFrames(0xe3, 0x88, 576)), 8000);             // MPEG-2.5 64 kbps 8 kHz
  // Layer II (MPEG-1, 192 kbps, 48 kHz): 144000·192/48000 = 576
  assert.equal(sniff(mpegFrames(0xfd, 0xa4, 576)), 48000);
  const id3 = cat(latin1('ID3'), [4, 0, 0x10], ss32(100), new Uint8Array(100), latin1('3DI'), [4, 0, 0x10], ss32(100));
  assert.equal(sniff(cat(id3, mpegFrames(0xfb, 0x92, 418))), 44100);   // frames con bit de relleno
  // etiqueta ID3 grande (carátula de 300 KB) delante: el escaneo empieza después de ella
  const bigId3 = cat(latin1('ID3'), [3, 0, 0], ss32(300000), new Uint8Array(300000));
  assert.equal(sniff(cat(bigId3, mpegFrames(0xfb, 0xe4, 960))), 48000);
  // basura con falsas sincronías antes del primer frame real
  const junk = cat([0xff, 0xfb, 0x90, 0x64], new Uint8Array(50), [0xff, 0xe0, 0x00], new Uint8Array(30));
  assert.equal(sniff(cat(junk, mpegFrames(0xfb, 0xe0, 1044, 3))), 44100);
  // un frame suelto sin siguiente no confirma (salvo al final del archivo)
  assert.equal(sniff(cat([0xff, 0xfb, 0x90, 0x64], new Uint8Array(3000))), null);
});

test('AAC ADTS (con posible SBR implícito a ≤ 24 kHz)', () => {
  assert.equal(sniff(adtsFrames(4)), 44100);
  assert.equal(sniff(adtsFrames(3)), 48000);
  assert.equal(sniff(adtsFrames(6)), 48000);   // 24 kHz → probablemente HE-AAC: se pide 48 kHz
});

test('OGG: Vorbis, Opus, FLAC en Ogg y flujo no-audio antes', () => {
  const vorbis = (rate) => cat([1], latin1('vorbis'), le32(0), [2], le32(rate), le32(0), le32(128000), le32(0), [0xb8, 1]);
  assert.equal(sniff(oggPage(vorbis(44100))), 44100);
  assert.equal(sniff(oggPage(vorbis(32000))), 32000);
  assert.equal(sniff(oggPage(cat(latin1('OpusHead'), [1, 2], le16(312), le32(44100), le16(0), [0]))), 48000);
  const oggFlac = cat([0x7f], latin1('FLAC'), [1, 0], be16(1), latin1('fLaC'), [0, 0, 0, 34], streamInfo(96000));
  assert.equal(sniff(oggPage(oggFlac)), 96000);
  const skeleton = cat(latin1('fishead\0'), new Uint8Array(56));
  assert.equal(sniff(cat(oggPage(skeleton), oggPage(vorbis(22050)))), 22050);
});

test('MP4/M4A: mdhd del track de audio, esds, cajas de 64 bits, moov al final', () => {
  const lc44 = esds(bits('00010 0100 0010'));   // AAC-LC 44,1 kHz estéreo
  const m4a = cat(ftyp, box64('mdat', new Uint8Array(40)),
    box('moov', box('mvhd', new Uint8Array(100)), trak('vide', 90000, box('avc1', new Uint8Array(20))),
      trak('soun', 44100, audioEntry('mp4a', 44100, [lc44]))));
  assert.equal(sniff(m4a), 44100);
  // mdhd versión 1 a 48 kHz
  const v1 = cat(ftyp, box('moov', trak('soun', 48000, audioEntry('mp4a', 48000, [esds(bits('00010 0011 0010'))]), 1)));
  assert.equal(sniff(v1), 48000);
  // HE-AAC con SBR explícito: núcleo 22,05 kHz, salida 44,1 kHz aunque mdhd diga 22050
  const he = esds(bits('00101 0111 0010 0100 00010'));
  assert.equal(sniff(cat(ftyp, box('moov', trak('soun', 22050, audioEntry('mp4a', 22050, [he])))) ), 44100);
  // HE-AAC implícito (LC a 24 kHz): se pide el doble
  assert.equal(sniff(cat(ftyp, box('moov', trak('soun', 24000, audioEntry('mp4a', 24000, [esds(bits('00010 0110 0010'))]))))), 48000);
  // ALAC a 96 kHz (la entrada 16.16 desborda: manda mdhd)
  assert.equal(sniff(cat(ftyp, box('moov', trak('soun', 96000, audioEntry('alac', 96000))))), 96000);
  // Opus en MP4
  assert.equal(sniff(cat(ftyp, box('moov', trak('soun', 48000, audioEntry('Opus', 48000))))), 48000);
  // sin moov
  assert.equal(sniff(cat(ftyp, box('mdat', new Uint8Array(10)))), null);
});

test('CAF, Matroska/WebM y desconocidos', () => {
  const desc = new Uint8Array(32);
  new DataView(desc.buffer).setFloat64(0, 48000);
  assert.equal(sniff(cat(latin1('caff'), be16(1), be16(0), latin1('desc'), be32(0), be32(32), desc)), 48000);
  assert.equal(sniff(cat([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(20), [0x86, 0x86], latin1('A_OPUS'))), 48000);
  const f = new Uint8Array(8);
  new DataView(f.buffer).setFloat64(0, 44100);
  assert.equal(sniff(cat([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(20), [0x86, 0x85], latin1('A_AAC'), [0xb5, 0x88], f)), 44100);
  assert.equal(sniff(new Uint8Array(0)), null);
  assert.equal(sniff(latin1('hola, esto no es audio')), null);
  assert.equal(sniffSampleRate(null), null);
  assert.equal(sniffSampleRate(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f])), null);
});

// ---------- remuestreo ----------

function tone(n, f, sr, a = 0.5) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / sr);
  return x;
}
function amplitude(y, f, sr) {
  let re = 0;
  let im = 0;
  const s = Math.floor(y.length * 0.25);
  const e = Math.floor(y.length * 0.75);
  for (let i = s; i < e; i++) { re += y[i] * Math.cos(2 * Math.PI * f * i / sr); im += y[i] * Math.sin(2 * Math.PI * f * i / sr); }
  return (2 * Math.hypot(re, im)) / (e - s);
}

test('resample: longitudes exactas y ganancia 1 en continua (también en los bordes)', () => {
  for (const [from, to, n] of [[44100, 22050, 44101], [48000, 22050, 48000], [96000, 48000, 1001], [22050, 44100, 777], [44100, 48000, 44100], [44100, 44100, 10]]) {
    const x = new Float32Array(n).fill(0.5);
    const y = resample(x, from, to);
    assert.equal(y.length, Math.ceil((n * to) / from), `${from}->${to}`);
    for (let i = 0; i < y.length; i++) assert.ok(Math.abs(y[i] - 0.5) < 2e-3, `${from}->${to} [${i}] = ${y[i]}`);
  }
  assert.equal(createResampler(44100, 48000).outLength(13230000), 14400000);
});

test('resample: banda pasante plana y rechazo de alias', () => {
  const y = resample(tone(44100, 5000, 44100), 44100, 22050);
  assert.ok(Math.abs(amplitude(y, 5000, 22050) - 0.5) < 0.005);
  const a = resample(tone(44100, 14025, 44100), 44100, 22050);   // alias a 8025 Hz
  const db = 20 * Math.log10(amplitude(a, 8025, 22050) / 0.5);
  assert.ok(db < -70, `alias ${db.toFixed(1)} dB`);
  const b = resample(tone(48000, 15000, 48000), 48000, 22050);   // 15 kHz fuera de banda
  assert.ok(20 * Math.log10(amplitude(b, 22050 - 15000, 22050) / 0.5 + 1e-12) < -70);
  const up = resample(tone(22050, 3000, 22050), 22050, 44100);
  assert.ok(Math.abs(amplitude(up, 3000, 44100) - 0.5) < 0.005);
});

test('downmixMono promedia y toAnalysisMono devuelve un array nuevo a 22050 Hz', async () => {
  const L = new Float32Array([1, 0.5, 0]);
  const R = new Float32Array([0, 0.5, 1, 7]);
  assert.deepEqual(Array.from(downmixMono([L, R])), [0.5, 0.5, 0.5]);
  const mono = new Float32Array([0.1, 0.2]);
  const m = downmixMono([mono]);
  assert.deepEqual(Array.from(m), Array.from(mono));
  assert.notEqual(m.buffer, mono.buffer);

  const n = 44100 * 2 + 1;
  const chans = [tone(n, 440, 44100), tone(n, 440, 44100)];
  const fake = { numberOfChannels: 2, sampleRate: 44100, length: n, duration: n / 44100, getChannelData: (c) => chans[c] };
  const out = await toAnalysisMono(fake, 22050);
  assert.equal(out.length, Math.ceil((n / 44100) * 22050));
  assert.ok(Math.abs(amplitude(out, 440, 22050) - 0.5) < 0.005);
  const same = { numberOfChannels: 1, sampleRate: 22050, length: 100, duration: 100 / 22050, getChannelData: () => chans[0].subarray(0, 100) };
  const o2 = await toAnalysisMono(same);
  assert.equal(o2.length, 100);
  assert.notEqual(o2.buffer, chans[0].buffer);
});
