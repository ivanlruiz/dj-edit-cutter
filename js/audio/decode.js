// Decodificación del archivo del usuario sin remuestrear + señal mono para el análisis.

const DECODE_ERROR = 'No se pudo leer este archivo de audio. Prueba con MP3 o WAV.';
const FALLBACK_RATE = 44100;
const COMMON_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000,
  176400, 192000, 352800, 384000];

function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

function ascii(b, off, n) {
  let s = '';
  for (let i = 0; i < n && off + i < b.length; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
const u32be = (b, o) => b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];

function plausible(rate) {
  return Number.isFinite(rate) && rate >= 1000 && rate <= 768000 ? Math.round(rate) : null;
}

// ---------- sniffers ----------

// Salta una o varias etiquetas ID3v2 al principio (incluye el footer de v2.4)
function skipId3v2(b) {
  let p = 0;
  while (p + 10 <= b.length && b[p] === 0x49 && b[p + 1] === 0x44 && b[p + 2] === 0x33 && b[p + 3] < 0xff) {
    if ((b[p + 6] | b[p + 7] | b[p + 8] | b[p + 9]) & 0x80) break;
    const size = ((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f);
    p += 10 + size + (b[p + 5] & 0x10 ? 10 : 0);
  }
  return p;
}

function sniffWav(b) {
  let p = 12;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    if (id === 'fmt ' && p + 16 <= b.length) return plausible(u32le(b, p + 12));
    if (size === 0xffffffff) break;
    p += 8 + size + (size & 1);
  }
  return null;
}

// Número en coma flotante extendida de 80 bits (IEEE 754, big endian), como en AIFF
function readExtended80(b, o) {
  const exp = ((b[o] & 0x7f) << 8) | b[o + 1];
  const hi = u32be(b, o + 2);
  const lo = u32be(b, o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const v = (hi * 4294967296 + lo) * 2 ** (exp - 16383 - 63);
  return b[o] & 0x80 ? -v : v;
}

function sniffAiff(b) {
  let p = 12;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32be(b, p + 4);
    if (id === 'COMM' && p + 8 + 18 <= b.length) return plausible(readExtended80(b, p + 16));
    p += 8 + size + (size & 1);
  }
  return null;
}

// STREAMINFO: 20 bits de frecuencia en los bytes 10–12 del bloque
function flacStreamInfoRate(b, o) {
  if (o + 13 > b.length) return null;
  return plausible((b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >> 4));
}

function sniffFlac(b, p) {
  if ((b[p + 4] & 0x7f) !== 0) return null;   // el primer bloque debe ser STREAMINFO
  return flacStreamInfoRate(b, p + 8);
}

function sniffOgg(b, p0) {
  let p = p0;
  for (let page = 0; page < 8 && p + 27 <= b.length && ascii(b, p, 4) === 'OggS'; page++) {
    const nSeg = b[p + 26];
    let len = 0;
    for (let i = 0; i < nSeg; i++) len += b[p + 27 + i];
    const d = p + 27 + nSeg;
    if (d + 8 > b.length) break;
    if (b[d] === 0x01 && ascii(b, d + 1, 6) === 'vorbis') return plausible(u32le(b, d + 12));
    if (ascii(b, d, 8) === 'OpusHead') return 48000;   // Opus siempre se decodifica a 48 kHz
    if (b[d] === 0x7f && ascii(b, d + 1, 4) === 'FLAC' && ascii(b, d + 9, 4) === 'fLaC') return flacStreamInfoRate(b, d + 17);
    if (ascii(b, d, 8) === 'Speex   ') return plausible(u32le(b, d + 36));
    if (!(b[p + 5] & 0x02)) break;   // ya no es una página de inicio de flujo
    p = d + len;
  }
  return null;
}

const MPEG_RATES = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];
const MPEG_BITRATES = {
  '3-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Cabecera de frame MPEG audio (MPEG1/2/2.5, capas I–III) → { key, rate, length } o null
function mpegFrame(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3;
  const layerBits = (b[i + 1] >> 1) & 3;
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (ver === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits;
  const rate = MPEG_RATES[ver][srIdx];
  const kbps = MPEG_BITRATES[ver === 3 ? `3-${layer}` : `2-${layer === 1 ? 1 : 2}`][brIdx];
  const pad = (b[i + 2] >> 1) & 1;
  let length;
  if (layer === 1) length = (Math.floor(12000 * kbps / rate) + pad) * 4;
  else if (layer === 3 && ver !== 3) length = Math.floor(72000 * kbps / rate) + pad;
  else length = Math.floor(144000 * kbps / rate) + pad;
  return { key: (b[i + 1] & 0xfe) << 8 | (b[i + 2] & 0x0c), rate, length };
}

function adtsFrame(b, i) {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
  const srIdx = (b[i + 2] >> 2) & 0x0f;
  if (srIdx >= ADTS_RATES.length) return null;
  const length = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  if (length < 7) return null;
  return { key: (b[i + 1] << 8) | (b[i + 2] & 0x3c), rate: ADTS_RATES[srIdx], length };
}

// Busca un frame MP3 (o AAC ADTS) y lo confirma con el siguiente
function sniffMpegStream(b, start) {
  const end = Math.min(b.length - 4, start + (1 << 20));
  for (let i = start; i < end; i++) {
    if (b[i] !== 0xff) continue;
    const isAdts = (b[i + 1] & 0xf6) === 0xf0;
    const f = isAdts ? adtsFrame(b, i) : mpegFrame(b, i);
    if (!f) continue;
    const j = i + f.length;
    if (j + 4 > b.length) {
      if (i === start || j >= b.length) return aacGuard(isAdts, f.rate);   // archivo con un solo frame
      continue;
    }
    const g = isAdts ? adtsFrame(b, j) : mpegFrame(b, j);
    if (g && g.key === f.key) return aacGuard(isAdts, f.rate);
  }
  return null;
}

// AAC a ≤ 24 kHz puede ser HE-AAC (SBR implícito): el decodificador entrega el doble. Pedir el doble no pierde nada.
function aacGuard(isAac, rate) {
  return isAac && rate <= 24000 ? rate * 2 : rate;
}

// ---------- MP4 / M4A ----------

function mp4Boxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) break;
    out.push({ type, start: p, body: p + header, end: Math.min(end, p + size) });
    p += size;
  }
  return out;
}

const child = (b, box, type) => mp4Boxes(b, box.body, box.end).find((x) => x.type === type) || null;

// Lector de bits para AudioSpecificConfig
function bitReader(b, start, end) {
  let pos = start * 8;
  return (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      const byte = pos >> 3;
      if (byte >= end) return -1;
      v = v * 2 + ((b[byte] >> (7 - (pos & 7))) & 1);
    }
    return v;
  };
}

function readDescriptorLength(b, p, end) {
  let len = 0;
  for (let i = 0; i < 4 && p < end; i++) {
    const c = b[p++];
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return { len, p };
}

// esds → frecuencia de salida según AudioSpecificConfig (null si no se puede)
function ascRate(b, esds) {
  let p = esds.body + 4;
  const end = esds.end;
  const fixedFreq = (r) => {
    const idx = r(4);
    return idx === 15 ? r(24) : ADTS_RATES[idx];
  };
  while (p + 2 < end) {
    const tag = b[p++];
    const d = readDescriptorLength(b, p, end);
    p = d.p;
    if (tag === 0x03) {   // ES_Descriptor: entrar
      const flags = b[p + 2];
      p += 3;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + b[p];
      if (flags & 0x20) p += 2;
      continue;
    }
    if (tag === 0x04) { p += 13; continue; }   // DecoderConfigDescriptor: saltar campos fijos y entrar
    if (tag === 0x05) {
      const r = bitReader(b, p, Math.min(end, p + d.len));
      let aot = r(5);
      if (aot === 31) aot = 32 + r(6);
      const core = fixedFreq(r);
      r(4);   // canales
      if (aot === 5 || aot === 29) return plausible(fixedFreq(r)) || plausible(core);
      const rate = plausible(core);
      return rate && aot === 2 ? aacGuard(true, rate) : rate;
    }
    p += d.len;
  }
  return null;
}

function sniffMp4(b) {
  const moov = mp4Boxes(b, 0, b.length).find((x) => x.type === 'moov');
  if (!moov) return null;
  for (const trak of mp4Boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(b, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(b, mdia, 'hdlr');
    if (!hdlr || ascii(b, hdlr.body + 8, 4) !== 'soun') continue;
    const candidates = [];
    const mdhd = child(b, mdia, 'mdhd');
    if (mdhd) {
      const ts = b[mdhd.body] === 1 ? u32be(b, mdhd.body + 20) : u32be(b, mdhd.body + 12);
      if (COMMON_RATES.includes(ts)) candidates.push(ts);
    }
    const minf = child(b, mdia, 'minf');
    const stbl = minf && child(b, minf, 'stbl');
    const stsd = stbl && child(b, stbl, 'stsd');
    if (stsd) {
      const entry = mp4Boxes(b, stsd.body + 8, stsd.end)[0];
      if (entry) {
        if (entry.type === 'Opus') return 48000;
        const version = u16be(b, entry.body + 8);
        const entryRate = u32be(b, entry.body + 24) / 65536;
        if (COMMON_RATES.includes(entryRate)) candidates.push(entryRate);
        const kids = entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
        const esds = mp4Boxes(b, kids, entry.end).find((x) => x.type === 'esds');
        const r = esds && ascRate(b, esds);
        if (r) candidates.push(r);
      }
    }
    if (candidates.length) return Math.max(...candidates);
  }
  return null;
}

// ---------- WebM / Matroska (mejor esfuerzo) ----------

function sniffMatroska(b) {
  const lim = Math.min(b.length, 1 << 16);
  if (ascii(b, 0, lim).includes('A_OPUS')) return 48000;
  for (let i = 0; i + 6 <= lim; i++) {
    if (b[i] !== 0xb5 || (b[i + 1] !== 0x88 && b[i + 1] !== 0x84)) continue;
    const size = b[i + 1] === 0x88 ? 8 : 4;
    if (i + 2 + size > lim) break;
    const dv = new DataView(b.buffer, b.byteOffset + i + 2, size);
    const v = size === 8 ? dv.getFloat64(0) : dv.getFloat32(0);
    if (COMMON_RATES.includes(v)) return v;
  }
  return null;
}

function sniffCaf(b) {
  let p = 8;
  while (p + 12 <= b.length) {
    const type = ascii(b, p, 4);
    const size = u32be(b, p + 4) * 4294967296 + u32be(b, p + 8);
    if (type === 'desc' && p + 20 <= b.length) {
      return plausible(new DataView(b.buffer, b.byteOffset + p + 12, 8).getFloat64(0));
    }
    p += 12 + size;
  }
  return null;
}

// Frecuencia de muestreo nativa leída de la cabecera (null si no se reconoce)
export function sniffSampleRate(arrayBuffer) {
  const b = toBytes(arrayBuffer);
  if (!b || b.length < 4) return null;
  try {
    const head = ascii(b, 0, 4);
    if ((head === 'RIFF' || head === 'RF64' || head === 'BW64') && ascii(b, 8, 4) === 'WAVE') return sniffWav(b);
    if (head === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 4))) return sniffAiff(b);
    if (head === 'caff') return sniffCaf(b);
    if (ascii(b, 4, 4) === 'ftyp') return sniffMp4(b);
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return sniffMatroska(b);
    const p = skipId3v2(b);
    if (p >= b.length) return null;
    const tag = ascii(b, p, 4);
    if (tag === 'fLaC') return sniffFlac(b, p);
    if (tag === 'OggS') return sniffOgg(b, p);
    return sniffMpegStream(b, p);
  } catch {
    return null;
  }
}

// ---------- decodificación (navegador) ----------

function offlineContextClass() {
  const g = globalThis;
  return g.OfflineAudioContext || g.webkitOfflineAudioContext || null;
}

// decodeAudioData con promesa o con callbacks (Safari antiguo)
function decodeWith(ctx, data) {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function readBytes(file) {
  if (file instanceof ArrayBuffer) return file;
  if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {   // Blob sin arrayBuffer() (navegadores viejos)
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(file);
  });
}

async function tryDecode(bytes, rate) {
  const Offline = offlineContextClass();
  let ctx;
  if (Offline) ctx = new Offline(1, 1, rate);   // puede lanzar si la frecuencia no está soportada
  else {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio no disponible');
    ctx = new Ctx();
    try {
      return await decodeWith(ctx, bytes.slice(0));
    } finally {
      if (ctx.close) ctx.close().catch(() => {});
    }
  }
  return decodeWith(ctx, bytes.slice(0));   // decodeAudioData desengancha su entrada: se pasa una copia
}

// Lee y decodifica el archivo. Mantiene `bytes` intacto (para copiar las etiquetas al exportar).
export async function decodeAudioFile(file) {
  let bytes;
  try {
    bytes = await readBytes(file);
  } catch {
    throw new Error('No se pudo leer el archivo.');
  }
  const name = (file && file.name) || 'audio';
  const nativeRate = sniffSampleRate(bytes);
  let buffer = null;
  if (nativeRate) {
    try {
      buffer = await tryDecode(bytes, nativeRate);
    } catch {
      buffer = null;
    }
  }
  if (!buffer) {
    try {
      buffer = await tryDecode(bytes, FALLBACK_RATE);
    } catch {
      buffer = null;
    }
  }
  if (!buffer || !buffer.length) throw new Error(DECODE_ERROR);
  return { buffer, bytes, name, sampleRate: buffer.sampleRate, nativeRate };
}

// ---------- remuestreo (puro) ----------
// Chrome remuestrea los AudioBufferSourceNode con interpolación lineal y sin filtro anti-alias
// (medido: un tono de 14 kHz a 44,1 kHz reaparece a 0 dB en 8 kHz al pasar a 22,05 kHz), así que
// el remuestreo se hace aquí con un FIR sinc·Kaiser de fase lineal.

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Mezcla simple a mono (promedio de canales)
export function downmixMono(channels) {
  const chans = Array.from(channels || []);
  if (!chans.length) return new Float32Array(0);
  let n = Infinity;
  for (const c of chans) n = Math.min(n, c.length);
  if (chans.length === 1) return Float32Array.from(chans[0].subarray ? chans[0].subarray(0, n) : chans[0]);
  const mono = new Float32Array(n);
  const k = 1 / chans.length;
  for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i] * k;
  return mono;
}

// Prepara un remuestreador fromRate → toRate. zeroCrossings = semiancho del núcleo (en muestras de la
// frecuencia más baja); rolloff = corte relativo a la Nyquist de la frecuencia más baja.
export function createResampler(fromRate, toRate, { zeroCrossings = 12, rolloff = 0.93 } = {}) {
  const from = Math.round(fromRate);
  const to = Math.round(toRate);
  if (!(from > 0) || !(to > 0)) throw new Error('Frecuencia de muestreo no válida.');
  const scale = Math.min(1, to / from);
  const cutoff = 0.5 * scale * rolloff;             // ciclos por muestra de entrada
  const half = Math.ceil(zeroCrossings / scale);    // semiancho del núcleo en muestras de entrada
  const taps = 2 * half;
  const beta = 8.6;                                 // ≈ 85 dB de rechazo
  const i0b = besselI0(beta);
  const kernel = (t) => {
    const a = Math.abs(t);
    if (a >= half) return 0;
    const w = besselI0(beta * Math.sqrt(1 - (a / half) ** 2)) / i0b;
    return (a < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * a) / (Math.PI * a)) * w;
  };
  const g = gcd(from, to);
  const P = from / g;   // avance de entrada cada Q salidas
  const Q = to / g;     // número de fases distintas
  const phases = Q <= 4096 ? Q : 0;
  let coef = null;
  if (phases) {
    coef = new Float32Array(phases * taps);
    for (let ph = 0; ph < phases; ph++) {
      let sum = 0;
      for (let k = 0; k < taps; k++) sum += (coef[ph * taps + k] = kernel(k - half + 1 - ph / Q));
      for (let k = 0; k < taps; k++) coef[ph * taps + k] /= sum;   // ganancia 1 en continua
    }
  }
  const step = from / to;

  return {
    from,
    to,
    outLength: (n) => Math.ceil((n * to) / from),
    // Calcula out[j0..j1) a partir de toda la entrada x
    process(x, out, j0, j1) {
      const n = x.length;
      for (let j = j0; j < j1; j++) {
        let i0;
        let ph = -1;
        let frac = 0;
        if (phases) {
          const num = j * P;
          i0 = Math.floor(num / Q);
          ph = num - i0 * Q;
        } else {
          const t = j * step;
          i0 = Math.floor(t);
          frac = t - i0;
        }
        const base = i0 - half + 1;
        if (ph >= 0 && base >= 0 && base + taps <= n) {
          const c0 = ph * taps;
          let acc = 0;
          for (let k = 0; k < taps; k++) acc += x[base + k] * coef[c0 + k];
          out[j] = acc;
          continue;
        }
        // Bordes (renormaliza) o relación sin fases precalculadas
        let acc = 0;
        let wsum = 0;
        const lo = Math.max(0, base);
        const hi = Math.min(n - 1, i0 + half);
        for (let i = lo; i <= hi; i++) {
          const h = ph >= 0 ? coef[ph * taps + (i - base)] : kernel(i - i0 - frac);
          acc += x[i] * h;
          wsum += h;
        }
        out[j] = wsum > 1e-6 ? acc / wsum : 0;
      }
    },
  };
}

export function resample(x, fromRate, toRate, opts) {
  if (Math.round(fromRate) === Math.round(toRate)) return Float32Array.from(x);
  const r = createResampler(fromRate, toRate, opts);
  const out = new Float32Array(r.outLength(x.length));
  r.process(x, out, 0, out.length);
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Igual que resample() pero por bloques, cediendo el hilo entre bloques (la UI sigue respondiendo)
export async function resampleAsync(x, fromRate, toRate, { onProgress = null, blockSize = 1 << 18, ...opts } = {}) {
  if (Math.round(fromRate) === Math.round(toRate)) return Float32Array.from(x);
  const r = createResampler(fromRate, toRate, opts);
  const out = new Float32Array(r.outLength(x.length));
  for (let j = 0; j < out.length; j += blockSize) {
    r.process(x, out, j, Math.min(out.length, j + blockSize));
    if (onProgress) onProgress(Math.min(1, (j + blockSize) / out.length));
    if (j + blockSize < out.length) await tick();
  }
  return out;
}

// ---------- mono para el análisis ----------

export const ANALYSIS_RESAMPLER = { zeroCrossings: 10, rolloff: 0.92 };

// Mono a `targetRate` (normalmente 22050 Hz) para el análisis. Devuelve un Float32Array nuevo (se puede transferir).
export async function toAnalysisMono(audioBuffer, targetRate = 22050) {
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  const mono = downmixMono(chans);
  if (Math.round(audioBuffer.sampleRate) === Math.round(targetRate)) return mono;
  await tick();
  return resampleAsync(mono, audioBuffer.sampleRate, targetRate, ANALYSIS_RESAMPLER);
}
