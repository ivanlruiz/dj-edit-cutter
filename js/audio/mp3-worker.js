/* Worker clásico: codifica PCM float a MP3 con lamejs (vendor/lame.min.js, LGPL).
 *
 * Entrada:  { channels: Float32Array[] (1 o 2, transferidos), sampleRate, kbps,
 *             sampleOffset = 0,   // índice global de la primera muestra (para el dither determinista)
 *             dropFrames = 0,     // frames iniciales a descartar (pre-roll de un segmento en paralelo)
 *             maxFrames = ∞ }     // máximo de frames a devolver tras descartar
 * Salida:   { type: 'progress', fraction }
 *           { type: 'done', chunks: Uint8Array[] (transferidos), frames, sampleRate, channels, kbps, sampleCount }
 *           { type: 'error', message }
 * lamejs usa estéreo L/R (no joint stereo), sin reservorio de bits y sin cabecera Xing/LAME:
 * cada frame es independiente, lo que permite codificar segmentos en paralelo y empalmarlos por frames.
 */
/* global lamejs */
'use strict';

importScripts('../../vendor/lame.min.js');

var SAMPLES_PER_FRAME = 1152;
var BLOCK_FRAMES = 32;

// Ruido uniforme [0,1) determinista según (índice global, canal): el dither no depende de cómo se trocee
function hashUniform(i, c) {
  var h = Math.imul(i ^ Math.imul(c + 1, 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Float → Int16 con dither TPDF (±1 LSB) y recorte
function toInt16(src, from, to, dst, globalOffset, c) {
  for (var i = from, k = 0; i < to; i++, k++) {
    var x = src[i];
    var v = 0;
    if (x !== 0) {
      var g = globalOffset + i;
      v = Math.round(x * 32768 + hashUniform(2 * g, c) - hashUniform(2 * g + 1, c));
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      else if (v !== v) v = 0;
    }
    dst[k] = v;
  }
  for (; k < dst.length; k++) dst[k] = 0;
}

// Longitud de un frame MPEG-1/2/2.5 capa III a partir de su cabecera (0 si no es válida)
var BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
var BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
var SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function frameLength(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  var ver = (b[i + 1] >> 3) & 3;
  var brIdx = b[i + 2] >> 4;
  var srIdx = (b[i + 2] >> 2) & 3;
  if (ver === 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return 0;
  var rate = SR[ver][srIdx];
  var kbps = (ver === 3 ? BR_V1 : BR_V2)[brIdx];
  var pad = (b[i + 2] >> 1) & 1;
  return Math.floor((ver === 3 ? 144000 : 72000) * kbps / rate) + pad;
}

function concat(parts, total) {
  var out = new Uint8Array(total);
  var o = 0;
  for (var i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

function encode(msg) {
  var chans = msg.channels || [];
  if (!chans.length) throw new Error('No hay audio para codificar.');
  var nCh = Math.min(2, chans.length);
  var sampleRate = msg.sampleRate | 0;
  var kbps = msg.kbps | 0 || 320;
  var offset = msg.sampleOffset | 0;
  var dropFrames = msg.dropFrames | 0;
  var maxFrames = msg.maxFrames > 0 ? msg.maxFrames : Infinity;
  var n = chans[0].length;
  for (var c = 1; c < nCh; c++) n = Math.min(n, chans[c].length);

  var encoder = new lamejs.Mp3Encoder(nCh, sampleRate, kbps);
  var block = SAMPLES_PER_FRAME * BLOCK_FRAMES;
  var left = new Int16Array(block);
  var right = nCh > 1 ? new Int16Array(block) : null;
  var parts = [];
  var total = 0;
  var lastPost = -1;
  for (var s = 0; s < n; s += block) {
    var e = Math.min(n, s + block);
    var len = e - s;
    var l = len === block ? left : new Int16Array(len);
    toInt16(chans[0], s, e, l, offset, 0);
    var r = null;
    if (right) {
      r = len === block ? right : new Int16Array(len);
      toInt16(chans[1], s, e, r, offset, 1);
    }
    var out = encoder.encodeBuffer(l, r || l);
    if (out.length) {
      parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
      total += out.length;
    }
    var fraction = e / n;
    if (fraction - lastPost >= 0.01 || e === n) {
      self.postMessage({ type: 'progress', fraction: fraction });
      lastPost = fraction;
    }
  }
  var tail = encoder.flush();
  if (tail.length) {
    parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length));
    total += tail.length;
  }
  var bytes = concat(parts, total);
  parts = null;

  // Recorta por frames (descarta el pre-roll y lo que sobra al final de un segmento)
  var p = 0;
  var frame = 0;
  var startByte = -1;
  var endByte = bytes.length;
  var kept = 0;
  while (p < bytes.length) {
    var fl = frameLength(bytes, p);
    if (!fl) throw new Error('El codificador MP3 produjo un frame no válido.');
    if (frame === dropFrames) startByte = p;
    if (frame >= dropFrames) {
      if (kept === maxFrames) {
        endByte = p;
        break;
      }
      kept++;
    }
    p += fl;
    frame++;
  }
  var result = startByte < 0 ? new Uint8Array(0) : bytes.subarray(startByte, endByte);
  if (result.byteOffset !== 0 || result.length !== bytes.length) result = result.slice();
  return { chunks: [result], frames: kept, sampleRate: sampleRate, channels: nCh, kbps: kbps, sampleCount: n };
}

self.onmessage = function (event) {
  try {
    var res = encode(event.data || {});
    self.postMessage({
      type: 'done', chunks: res.chunks, frames: res.frames, sampleRate: res.sampleRate,
      channels: res.channels, kbps: res.kbps, sampleCount: res.sampleCount,
    }, res.chunks.map(function (ch) { return ch.buffer; }));
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
