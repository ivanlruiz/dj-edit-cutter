// Lectura/escritura WAV mínima para Node (tests y herramientas). Sin dependencias.
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Decodifica un WAV RIFF (PCM 8/16/24/32 bits entero o 32/64 bits float; WAVE_FORMAT_EXTENSIBLE incluido).
 * @returns {{ sampleRate:number, bitDepth:number, format:'pcm'|'float', channels: Float32Array[] }}
 */
export function decodeWav(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('No es un WAV RIFF/WAVE');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= u8.length) {
    const id = tag(off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (body + size > u8.length) size = u8.length - body; // tolera cabeceras truncadas
    if (id === 'fmt ') {
      let formatTag = dv.getUint16(body, true);
      const numChannels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitDepth = dv.getUint16(body + 14, true);
      if (formatTag === 0xfffe && size >= 40) formatTag = dv.getUint16(body + 24, true);
      fmt = { formatTag, numChannels, sampleRate, bitDepth };
    } else if (id === 'data') {
      data = { offset: body, size };
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV sin chunk fmt o data');
  const { formatTag, numChannels, sampleRate, bitDepth } = fmt;
  const isFloat = formatTag === 3;
  if (!isFloat && formatTag !== 1) throw new Error(`Formato WAV no soportado: ${formatTag}`);
  const bps = bitDepth / 8;
  const frames = Math.floor(data.size / (bps * numChannels));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
  let p = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let v;
      if (isFloat) v = bitDepth === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
      else if (bitDepth === 16) v = dv.getInt16(p, true) / 32768;
      else if (bitDepth === 24) {
        let x = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (bitDepth === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (bitDepth === 8) v = (u8[p] - 128) / 128;
      else throw new Error(`Profundidad no soportada: ${bitDepth}`);
      channels[c][i] = v;
      p += bps;
    }
  }
  return { sampleRate, bitDepth, format: isFloat ? 'float' : 'pcm', channels };
}

/** Promedia canales a mono. */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Lee un WAV de disco. opts.mono=true devuelve { samples } mezclado a mono además de channels. */
export function readWav(path, { mono = false } = {}) {
  const res = decodeWav(readFileSync(path));
  if (mono) res.samples = toMono(res.channels);
  return res;
}

/**
 * Codifica canales Float32 a WAV. bitDepth 16 | 24 (PCM entero) | 32 (float). Sin dither (determinista).
 * @returns {Uint8Array}
 */
export function encodeWavFile(channels, sampleRate, { bitDepth = 16 } = {}) {
  const nc = channels.length;
  const n = channels[0].length;
  const bps = bitDepth / 8;
  const isFloat = bitDepth === 32;
  const dataSize = n * nc * bps;
  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w4(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  w4(8, 'WAVE');
  w4(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, isFloat ? 3 : 1, true);
  dv.setUint16(22, nc, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nc * bps, true);
  dv.setUint16(32, nc * bps, true);
  dv.setUint16(34, bitDepth, true);
  w4(36, 'data');
  dv.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      let v = channels[c][i];
      if (!(v === v)) v = 0; // NaN
      if (isFloat) {
        dv.setFloat32(p, v, true);
      } else {
        v = Math.max(-1, Math.min(1, v));
        if (bitDepth === 16) {
          dv.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
        } else if (bitDepth === 24) {
          let x = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
          if (x < 0) x += 0x1000000;
          out[p] = x & 255;
          out[p + 1] = (x >> 8) & 255;
          out[p + 2] = (x >> 16) & 255;
        } else throw new Error(`Profundidad no soportada: ${bitDepth}`);
      }
      p += bps;
    }
  }
  return out;
}

export function writeWav(path, channels, sampleRate, opts) {
  writeFileSync(path, encodeWavFile(channels, sampleRate, opts));
}
