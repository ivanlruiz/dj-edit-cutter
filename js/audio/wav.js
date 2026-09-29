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

export function encodeWav(channels, sampleRate, { bitDepth = 16, id3 = null } = {}) {
  const chans = Array.from(channels || []);
  const nCh = chans.length;
  if (!nCh) throw new Error('No hay audio para guardar.');
  const sr = Math.round(Number(sampleRate));
  if (!(sr > 0)) throw new Error('Frecuencia de muestreo no válida.');
  const bits = Number(bitDepth) === 24 ? 24 : 16;
  if (bitDepth != null && Number(bitDepth) !== 16 && Number(bitDepth) !== 24) {
    throw new Error('Profundidad de bits no soportada (usa 16 o 24 bits).');
  }
  let frames = Infinity;
  for (const ch of chans) frames = Math.min(frames, ch ? ch.length : 0);
  const bytesPerSample = bits / 8;
  const blockAlign = nCh * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const extensible = nCh > 2;
  const fmtBytes = extensible ? 40 : 16;
  const tag = id3 && id3.length ? (id3 instanceof Uint8Array ? id3 : new Uint8Array(id3)) : null;
  const pad = (n) => n & 1;
  const total = 12 + (8 + fmtBytes) + (8 + dataBytes + pad(dataBytes)) + (tag ? 8 + tag.length + pad(tag.length) : 0);
  if (total - 8 > MAX_RIFF_BYTES) {
    throw new Error('El archivo WAV superaría el límite de 4 GB. Prueba con MP3 o con 16 bits.');
  }

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
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
  const dataOff = p + 8;

  if (bits === 16) writePcm16(chans, frames, buf, dataOff);
  else writePcm24(chans, frames, buf, dataOff);

  p = dataOff + dataBytes + pad(dataBytes);   // el byte de relleno ya es 0
  if (tag) {
    writeAscii(view, p, 'id3 ');
    view.setUint32(p + 4, tag.length, true);
    new Uint8Array(buf, p + 8, tag.length).set(tag);
  }
  return buf;
}

// 16 bits con dither TPDF de ±1 LSB; el silencio digital (0.0 exacto) se mantiene en 0.
function writePcm16(chans, frames, buf, dataOff) {
  const nCh = chans.length;
  const aligned = LITTLE_ENDIAN && (dataOff % 2 === 0);
  const out = aligned ? new Int16Array(buf, dataOff, frames * nCh) : null;
  const view = aligned ? null : new DataView(buf);
  let s = 0x9e3779b9;   // xorshift32 en línea (más rápido que un cierre por muestra)
  for (let c = 0; c < nCh; c++) {
    const src = chans[c];
    for (let i = 0, k = c; i < frames; i++, k += nCh) {
      const x = src[i];
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
      else view.setInt16(dataOff + 2 * k, v, true);
    }
  }
}

function writePcm24(chans, frames, buf, dataOff) {
  const nCh = chans.length;
  const bytes = new Uint8Array(buf, dataOff, frames * nCh * 3);
  const stride = 3 * nCh;
  for (let c = 0; c < nCh; c++) {
    const src = chans[c];
    for (let i = 0, o = 3 * c; i < frames; i++, o += stride) {
      let y = src[i] * 8388608;
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
