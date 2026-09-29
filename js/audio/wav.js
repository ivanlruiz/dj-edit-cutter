// Codificador/lector WAV (RIFF PCM). Lógica pura.

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const MAX_RIFF_BYTES = 0xffffffff;

// Máscaras de altavoces habituales para WAVE_FORMAT_EXTENSIBLE (orden WAV = orden de Web Audio).
const CHANNEL_MASKS = { 1: 0x4, 2: 0x3, 3: 0x7, 4: 0x33, 5: 0x37, 6: 0x3f, 7: 0x13f, 8: 0x63f };

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function checkFormat(nCh, sampleRate, bitDepth) {
  if (!nCh) throw new Error('No hay audio para guardar.');
  const sr = Math.round(Number(sampleRate));
  if (!(sr > 0)) throw new Error('Frecuencia de muestreo no válida.');
  if (bitDepth != null && Number(bitDepth) !== 16 && Number(bitDepth) !== 24) {
    throw new Error('Profundidad de bits no soportada (usa 16 o 24 bits).');
  }
  return { sr, bits: Number(bitDepth) === 24 ? 24 : 16 };
}

// Cabecera RIFF/WAVE + fmt + cabecera del chunk 'data' para `frames` muestras por canal; tagLen = bytes del
// chunk 'id3 ' que irá después de los datos (0 = sin etiqueta). Devuelve { header, dataBytes, total }.
function wavLayout(nCh, sr, bits, frames, tagLen) {
  const bytesPerSample = bits / 8;
  const blockAlign = nCh * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const extensible = nCh > 2;
  const fmtBytes = extensible ? 40 : 16;
  const pad = (n) => n & 1;
  const headerBytes = 12 + (8 + fmtBytes) + 8;
  const total = headerBytes + dataBytes + pad(dataBytes) + (tagLen ? 8 + tagLen + pad(tagLen) : 0);
  if (total - 8 > MAX_RIFF_BYTES) {
    throw new Error('El archivo WAV superaría el límite de 4 GB. Prueba con MP3 o con 16 bits.');
  }
  const header = new ArrayBuffer(headerBytes);
  const view = new DataView(header);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, fmtBytes, true);
  view.setUint16(20, extensible ? WAVE_FORMAT_EXTENSIBLE : WAVE_FORMAT_PCM, true);
  view.setUint16(22, nCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  let p = 36;
  if (extensible) {
    view.setUint16(36, 22, true);                         // cbSize
    view.setUint16(38, bits, true);                       // wValidBitsPerSample
    view.setUint32(40, CHANNEL_MASKS[nCh] || 0, true);    // dwChannelMask
    // SubFormat KSDATAFORMAT_SUBTYPE_PCM = 00000001-0000-0010-8000-00aa00389b71
    const guid = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    for (let i = 0; i < 16; i++) view.setUint8(44 + i, guid[i]);
    p = 60;
  }
  writeAscii(view, p, 'data');
  view.setUint32(p + 4, dataBytes, true);
  return { header: new Uint8Array(header), dataBytes, total };
}

// Chunk 'id3 ' (con el byte de relleno si hace falta), precedido del relleno del chunk 'data' si era impar
function tailBytes(dataBytes, tag) {
  const padData = dataBytes & 1;
  if (!tag) return padData ? new Uint8Array(1) : null;
  const out = new Uint8Array(padData + 8 + tag.length + (tag.length & 1));
  const view = new DataView(out.buffer);
  writeAscii(view, padData, 'id3 ');
  view.setUint32(padData + 4, tag.length, true);
  out.set(tag, padData + 8);
  return out;
}

function toTag(id3) {
  return id3 && id3.length ? (id3 instanceof Uint8Array ? id3 : new Uint8Array(id3)) : null;
}

export function encodeWav(channels, sampleRate, { bitDepth = 16, id3 = null } = {}) {
  const chans = Array.from(channels || []);
  const nCh = chans.length;
  const { sr, bits } = checkFormat(nCh, sampleRate, bitDepth);
  let frames = Infinity;
  for (const ch of chans) frames = Math.min(frames, ch ? ch.length : 0);
  const tag = toTag(id3);
  const { header, dataBytes, total } = wavLayout(nCh, sr, bits, frames, tag ? tag.length : 0);
  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  bytes.set(header, 0);
  writePcm(chans, 0, frames, bits, bytes.subarray(header.length, header.length + dataBytes), { rng: DITHER_SEED });
  const tail = tailBytes(dataBytes, tag);
  if (tail) bytes.set(tail, header.length + dataBytes);
  return buf;
}

// Igual que encodeWav pero por tramos, sin tener la salida entera ni el WAV en un solo bloque de memoria.
// source = { length (muestras por canal), numberOfChannels, read(s0, s1) → Float32Array[] del tramo }.
// Mismos bytes que encodeWav sobre la salida completa. Cede el hilo entre tramos (onProgress 0..1).
export async function encodeWavBlob(source, sampleRate, {
  bitDepth = 16, id3 = null, onProgress = null, chunkFrames = 1 << 19, yieldFn = null,
} = {}) {
  const nCh = source ? source.numberOfChannels : 0;
  const { sr, bits } = checkFormat(nCh, sampleRate, bitDepth);
  const frames = Math.max(0, Math.floor(source.length) || 0);
  const tag = toTag(id3);
  const { header, dataBytes } = wavLayout(nCh, sr, bits, frames, tag ? tag.length : 0);
  const parts = [header];
  const state = { rng: DITHER_SEED };
  const step = Math.max(1, Math.floor(chunkFrames));
  for (let a = 0; a < frames; a += step) {
    const b = Math.min(frames, a + step);
    const chans = source.read(a, b);
    const pcm = new Uint8Array((b - a) * nCh * (bits / 8));
    writePcm(chans, 0, b - a, bits, pcm, state);
    parts.push(pcm);
    if (onProgress) onProgress(b / frames);
    if (b < frames && yieldFn) await yieldFn();
  }
  const tail = tailBytes(dataBytes, tag);
  if (tail) parts.push(tail);
  return new Blob(parts, { type: 'audio/wav' });
}

const DITHER_SEED = 0x9e3779b9;

// Muestras [from, from + frames) de cada canal → PCM entrelazado little-endian en dst (Uint8Array).
// 16 bits: dither TPDF de ±1 LSB (xorshift32; state.rng sigue entre tramos) y el silencio digital (0.0) queda en 0.
function writePcm(chans, from, frames, bits, dst, state) {
  if (bits === 16) state.rng = writePcm16(chans, from, frames, dst, state.rng);
  else writePcm24(chans, from, frames, dst);
}

function writePcm16(chans, from, frames, dst, seed) {
  const nCh = chans.length;
  const aligned = LITTLE_ENDIAN && (dst.byteOffset % 2 === 0);
  const out = aligned ? new Int16Array(dst.buffer, dst.byteOffset, frames * nCh) : null;
  const view = aligned ? null : new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
  let s = seed;
  for (let i = 0, k = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++, k++) {
      const x = chans[c][from + i];
      let v = 0;
      if (x !== 0) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const r1 = (s >>> 0) / 4294967296;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const r2 = (s >>> 0) / 4294967296;
        let y = x * 32768 + r1 - r2;
        if (y > 32767) y = 32767;
        else if (y < -32768) y = -32768;
        else if (y !== y) y = 0;
        v = y >= 0 ? (y + 0.5) | 0 : -((0.5 - y) | 0);
      }
      if (out) out[k] = v;
      else view.setInt16(2 * k, v, true);
    }
  }
  return s;
}

function writePcm24(chans, from, frames, bytes) {
  const nCh = chans.length;
  const stride = 3 * nCh;
  for (let c = 0; c < nCh; c++) {
    const src = chans[c];
    for (let i = 0, o = 3 * c; i < frames; i++, o += stride) {
      let y = src[from + i] * 8388608;
      if (y > 8388607) y = 8388607;
      else if (y < -8388608) y = -8388608;
      else if (y !== y) y = 0;
      const v = y >= 0 ? (y + 0.5) | 0 : -((0.5 - y) | 0);
      bytes[o] = v & 0xff;
      bytes[o + 1] = (v >> 8) & 0xff;
      bytes[o + 2] = (v >> 16) & 0xff;
    }
  }
}

function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('Se esperaba un ArrayBuffer.');
}

function ascii(bytes, off, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

// Lector WAV (para tests y verificación): PCM 8/16/24/32, float 32/64, EXTENSIBLE. También devuelve el chunk 'id3 '.
export function parseWav(arrayBuffer) {
  const bytes = toBytes(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = ascii(bytes, 0, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64') || ascii(bytes, 8, 4) !== 'WAVE') throw new Error('No es un archivo WAV.');
  let fmt = null;
  let data = null;
  let id3 = null;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    let size = view.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'data' && (size === 0xffffffff || body + size > bytes.length)) size = bytes.length - body;
    if (id === 'fmt ') {
      let format = view.getUint16(body, true);
      const bits = view.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits,
      };
    } else if (id === 'data') {
      data = { off: body, size };
    } else if (id === 'id3 ' || id === 'ID3 ') {
      id3 = bytes.slice(body, body + size);
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV incompleto.');
  const { format, channels: nCh, bits, blockAlign } = fmt;
  const frames = Math.floor(data.size / blockAlign);
  const channels = [];
  for (let c = 0; c < nCh; c++) channels.push(new Float32Array(frames));
  const bps = bits / 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const o = data.off + i * blockAlign + c * bps;
      let v;
      if (format === WAVE_FORMAT_IEEE_FLOAT) v = bits === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true);
      else if (bits === 8) v = (bytes[o] - 128) / 128;
      else if (bits === 16) v = view.getInt16(o, true) / 32768;
      else if (bits === 24) v = (((bytes[o + 2] << 24) | (bytes[o + 1] << 16) | (bytes[o] << 8)) >> 8) / 8388608;
      else if (bits === 32) v = view.getInt32(o, true) / 2147483648;
      else throw new Error('Formato WAV no soportado.');
      channels[c][i] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, bitDepth: bits, channels, id3 };
}
