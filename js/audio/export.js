// Exportación del edit a WAV o MP3 (+ etiquetas ID3 del original).

import { encodeWavBlob } from './wav.js';
import { readId3v2, keepPortableFrames, buildId3v2 } from './id3.js';
import { resampleAsync, yieldTask } from './decode.js';

const MPEG1_RATES = [32000, 44100, 48000];
const SAMPLES_PER_FRAME = 1152;          // MPEG-1 capa III
export const MP3_ENCODER_DELAY = 576;    // retardo del codificador que se declara en la etiqueta LAME
const DECODER_DELAY = 529;               // retardo del decodificador (lo suman los lectores al hacer gapless)
const SEG_PREROLL_FRAMES = 4;            // frames de calentamiento de cada segmento paralelo (se descartan)
const SEG_POSTROLL_FRAMES = 3;           // audio extra al final de un segmento para no depender del flush
const SEG_MIN_SECONDS = 12;
// Cada worker lleva su copia del tramo y su montón de lamejs: con 6 workers un MP3 de 7 min pasaba de 1,9 GB en
// Chrome (medido); 3 workers codifican igual de rápido en 4 núcleos. En móviles (o con ≤ 4 GB), 2.
export const MAX_WORKERS = 3;
export const MAX_WORKERS_LOW_MEMORY = 2;
const EXPORT_RESAMPLER = { zeroCrossings: 24, rolloff: 0.95 };

// Frecuencia a la que se codifica el MP3. Sólo frecuencias MPEG-1 (32/44,1/48 kHz): 192–320 kbps no existen
// en MPEG-2/2.5 (máx. 160 kbps) y los reproductores DJ esperan 44,1/48 kHz. 22050 → 44100, 96000 → 48000…
export function mp3SampleRateFor(sampleRate) {
  const r = Math.round(Number(sampleRate));
  if (MPEG1_RATES.includes(r)) return r;
  if (r > 0 && r % 11025 === 0) return 44100;
  return 48000;
}

// Compás para el nombre: { num: 7, den: 8 } o "7/8" → "7-8" ('' si no es válido)
function meterTag(meter) {
  let num;
  let den;
  if (typeof meter === 'string') [num, den] = meter.split(/[/-]/).map(Number);
  else if (meter && typeof meter === 'object') ({ num, den } = meter);
  return Number.isInteger(num) && Number.isInteger(den) && num > 0 && den > 0 ? `${num}-${den}` : '';
}

// "Mi canción (edit -4 compases).mp3"; con compás nuevo: "Mi canción (7-8, edit -4 compases).mp3", y si solo
// cambia el compás (barsRemoved null/undefined): "Mi canción (7-8).mp3"
export function suggestFileName(originalName, { barsRemoved, format, meter = null } = {}) {
  let base = String(originalName == null ? '' : originalName).split(/[\\/]/).pop();
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  if (typeof base.normalize === 'function') base = base.normalize('NFC');
  base = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const chars = Array.from(base);
  if (chars.length > 120) base = chars.slice(0, 120).join('').trim();
  if (!base) base = 'Canción';
  const ext = String(format).toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const parts = [];
  const mt = meterTag(meter);
  if (mt) parts.push(mt);
  if (!mt || (barsRemoved !== null && barsRemoved !== undefined)) {
    const n = Math.round(Number(barsRemoved) * 10) / 10;
    let tag = 'edit';
    if (Number.isFinite(n) && n > 0) {
      const txt = Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
      tag = `edit -${txt} ${n === 1 ? 'compás' : 'compases'}`;
    }
    parts.push(tag);
  }
  return `${base} (${parts.join(', ')}).${ext}`;
}

// Etiqueta ID3v2 reconstruida a partir del archivo original (null si no había o no queda nada útil)
export function buildTagBytes(sourceBytes) {
  if (!sourceBytes) return null;
  let tag = null;
  try {
    tag = readId3v2(sourceBytes);
  } catch {
    return null;
  }
  if (!tag) return null;
  const frames = keepPortableFrames(tag.frames);
  if (!frames.length) return null;
  const bytes = buildId3v2(frames, { version: tag.version });
  return bytes.length ? bytes : null;
}

// Más de 2 canales → estéreo (coeficientes de mezcla de Web Audio); normaliza sólo si fuese a saturar
export function downmixToStereo(channels) {
  const ch = Array.from(channels);
  const n = Math.min(...ch.map((c) => c.length));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const s = Math.SQRT1_2;
  const mix = (dst, terms) => {
    for (const [c, g] of terms) {
      const src = ch[c];
      for (let i = 0; i < n; i++) dst[i] += g * src[i];
    }
  };
  if (ch.length === 3) { mix(L, [[0, 1], [2, s]]); mix(R, [[1, 1], [2, s]]); }
  else if (ch.length === 4) { mix(L, [[0, 0.5], [2, 0.5]]); mix(R, [[1, 0.5], [3, 0.5]]); }
  else if (ch.length === 5) { mix(L, [[0, 1], [2, s], [3, s]]); mix(R, [[1, 1], [2, s], [4, s]]); }
  else if (ch.length === 6) { mix(L, [[0, 1], [2, s], [4, s]]); mix(R, [[1, 1], [2, s], [5, s]]); }
  else {
    const even = ch.map((_, i) => i).filter((i) => i % 2 === 0);
    const odd = ch.map((_, i) => i).filter((i) => i % 2 === 1);
    mix(L, even.map((i) => [i, 1 / even.length]));
    mix(R, odd.map((i) => [i, 1 / odd.length]));
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak > 1) {
    const g = 1 / peak;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  }
  return [L, R];
}

// ---------- etiqueta Xing/LAME ("Info") para reproducción sin huecos ----------

let crcTable = null;
// CRC-16/ARC (polinomio 0x8005 reflejado), el que usa LAME
export function crc16(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
      crcTable[i] = c;
    }
  }
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  return crc;
}

// Frame MP3 "Info" (Xing para CBR) con la extensión LAME: número de frames, bytes, TOC y el retardo/relleno
// del codificador, para que los decodificadores recorten el silencio inicial y final (duración exacta).
// firstHeader: los 4 bytes de cabecera del primer frame de audio (misma frecuencia, bitrate y modo).
export function buildLameInfoFrame(firstHeader, { frames, audioBytes, sampleCount, encoderDelay = MP3_ENCODER_DELAY, audioCrc = 0 }) {
  const h = firstHeader;
  const ver = (h[1] >> 3) & 3;
  const mono = (h[3] >> 6) === 3;
  const mpeg1 = ver === 3;
  const rate = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[ver][(h[2] >> 2) & 3];
  const kbps = (mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[h[2] >> 4];
  const spf = mpeg1 ? 1152 : 576;
  const size = Math.floor((mpeg1 ? 144000 : 72000) * kbps / rate);
  const out = new Uint8Array(size);
  out.set([h[0], h[1], h[2] & 0xfd, h[3]], 0);   // sin bit de relleno
  const xing = 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  if (xing + 156 > size) return null;   // no cabe (bitrates muy bajos)
  const dv = new DataView(out.buffer);
  const totalBytes = size + audioBytes;
  let p = xing;
  out.set([0x49, 0x6e, 0x66, 0x6f], p);   // 'Info' (CBR)
  dv.setUint32(p + 4, 0x0f);               // frames + bytes + TOC + calidad
  dv.setUint32(p + 8, frames);
  dv.setUint32(p + 12, totalBytes);
  for (let i = 0; i < 100; i++) out[p + 16 + i] = Math.floor((i * 256) / 100);
  dv.setUint32(p + 116, 0);
  p += 120;
  // Extensión LAME (36 bytes)
  const vendor = 'LAME3.98r';   // lamejs deriva de LAME 3.98 (vía jump3r)
  for (let i = 0; i < 9; i++) out[p + i] = vendor.charCodeAt(i);
  out[p + 9] = 0x01;                        // revisión 0, método CBR
  out[p + 20] = Math.min(255, kbps);
  const padding = Math.max(0, frames * spf - encoderDelay - sampleCount);
  const delay = Math.min(4095, encoderDelay);
  const pad = Math.min(4095, padding);
  out[p + 21] = delay >> 4;
  out[p + 22] = ((delay & 0x0f) << 4) | (pad >> 8);
  out[p + 23] = pad & 0xff;
  const srcFreq = rate <= 32000 ? 0 : rate === 44100 ? 1 : rate === 48000 ? 2 : 3;
  out[p + 24] = (srcFreq << 6) | ((mono ? 0 : 1) << 2);
  dv.setUint32(p + 28, totalBytes);
  dv.setUint16(p + 32, audioCrc);
  dv.setUint16(p + 34, crc16(out.subarray(0, p + 34)));
  return out;
}

// ---------- codificación MP3 (workers) ----------

function lowMemoryDevice() {
  const nav = globalThis.navigator;
  if (nav && Number(nav.deviceMemory) > 0 && Number(nav.deviceMemory) <= 4) return true;
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function workerCount(limit, { hardwareConcurrency, lowMemory } = {}) {
  const hc = hardwareConcurrency || (globalThis.navigator && navigator.hardwareConcurrency) || 2;
  const low = lowMemory === undefined ? lowMemoryDevice() : lowMemory;
  const n = Math.max(1, Math.min(low ? MAX_WORKERS_LOW_MEMORY : MAX_WORKERS, hc - 1));
  return limit > 0 ? Math.min(n, Math.floor(limit)) : n;
}

// Fuente de audio por tramos { length, numberOfChannels, read(s0, s1) → Float32Array[] NUEVOS } a partir de canales
export function channelSource(channels) {
  const chans = Array.from(channels || []);
  let n = chans.length ? Infinity : 0;
  for (const c of chans) n = Math.min(n, c.length);
  return { length: n, numberOfChannels: chans.length, read: (a, b) => chans.map((c) => c.slice(a, b)) };
}

// Divide la canción en segmentos alineados a frames. Cada segmento se codifica con unos frames de
// pre-roll que luego se descartan; como lamejs no usa reservorio de bits, los frames se empalman limpios.
export function planSegments(sampleCount, sampleRate, workers) {
  const totalFrames = Math.ceil((sampleCount + MP3_ENCODER_DELAY + DECODER_DELAY) / SAMPLES_PER_FRAME);
  const minFrames = Math.ceil((SEG_MIN_SECONDS * sampleRate) / SAMPLES_PER_FRAME);
  const wanted = Math.max(1, workers * 2);
  const segFrames = Math.max(minFrames, Math.ceil(totalFrames / wanted));
  const segs = [];
  for (let f0 = 0; ; f0 += segFrames) {
    const last = (f0 + segFrames) * SAMPLES_PER_FRAME >= sampleCount;
    const startFrame = Math.max(0, f0 - SEG_PREROLL_FRAMES);
    segs.push({
      s0: startFrame * SAMPLES_PER_FRAME,
      s1: last ? sampleCount : Math.min(sampleCount, (f0 + segFrames + SEG_POSTROLL_FRAMES) * SAMPLES_PER_FRAME),
      dropFrames: f0 - startFrame,
      maxFrames: last ? 0 : segFrames,
    });
    if (last) break;
  }
  return segs;
}

// source: { length, numberOfChannels, read(s0, s1) } (cada tramo se lee justo antes de mandarlo a un worker)
function encodeMp3(source, sampleRate, kbps, onProgress, maxWorkers) {
  const n = source.length;
  const workersWanted = workerCount(maxWorkers);
  const segs = planSegments(n, sampleRate, workersWanted);
  const nWorkers = Math.min(workersWanted, segs.length);
  const progress = new Float64Array(segs.length);
  const spans = segs.map((s) => s.s1 - s.s0);
  const spanSum = spans.reduce((a, b) => a + b, 0) || 1;
  const weight = spans.map((v) => v / spanSum);
  const results = new Array(segs.length);
  const workers = [];
  let next = 0;
  let finished = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const w of workers) w.terminate();
      workers.length = 0;
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const report = () => {
      let f = 0;
      for (let i = 0; i < segs.length; i++) f += weight[i] * progress[i];
      onProgress(Math.min(1, f));
    };
    const dispatch = (worker) => {
      if (next >= segs.length) return;
      const k = next++;
      const s = segs[k];
      worker.segment = k;
      // copias propias por segmento (se transfieren): no se tocan los arrays del llamador
      const chans = source.read(s.s0, s.s1);
      worker.postMessage({
        channels: chans, sampleRate, kbps,
        sampleOffset: s.s0, dropFrames: s.dropFrames, maxFrames: s.maxFrames,
      }, chans.map((c) => c.buffer));
    };
    for (let i = 0; i < nWorkers; i++) {
      let worker;
      try {
        // misma versión (?v=) que este módulo: tras publicar, el worker no sale de la caché vieja
        worker = new Worker(new URL(`./mp3-worker.js${new URL(import.meta.url).search}`, import.meta.url));
      } catch {
        fail('No se pudo iniciar el codificador MP3.');
        return;
      }
      workers.push(worker);
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        fail('No se pudo iniciar el codificador MP3.');
      };
      worker.onmessageerror = () => fail('Error al codificar el MP3.');
      worker.onmessage = (e) => {
        const m = e.data || {};
        const k = worker.segment;
        if (m.type === 'progress') {
          progress[k] = m.fraction;
          report();
        } else if (m.type === 'error') {
          fail(`Error al codificar el MP3: ${m.message || 'desconocido'}`);
        } else if (m.type === 'done') {
          results[k] = m;
          progress[k] = 1;
          report();
          finished++;
          if (finished === segs.length) {
            settled = true;
            cleanup();
            resolve(results);
          } else {
            dispatch(worker);
          }
        }
      };
      dispatch(worker);
    }
  });
}

async function exportMp3({ source, sampleRate, kbps, tagBytes, onProgress, maxWorkers }) {
  if (!source.numberOfChannels) throw new Error('No hay audio para guardar.');
  const srcRate = Math.round(sampleRate);
  const rate = mp3SampleRateFor(srcRate);
  let src = source;
  let chans = null;
  // Remuestreo o más de 2 canales: hace falta la salida entera; si no, cada worker lee solo su tramo
  if (rate !== srcRate || source.numberOfChannels > 2) {
    chans = source.read(0, source.length);
    if (chans.length > 2) chans = downmixToStereo(chans);
  }
  let base = 0;
  if (rate !== srcRate) {
    // Remuestreo propio (sinc): el de OfflineAudioContext en Chrome es lineal y sin anti-alias
    const out = [];
    for (let c = 0; c < chans.length; c++) {
      out.push(await resampleAsync(chans[c], srcRate, rate, {
        ...EXPORT_RESAMPLER,
        onProgress: (f) => onProgress((0.15 * (c + f)) / chans.length),
      }));
    }
    chans = out;
    base = 0.15;
  }
  if (chans) src = channelSource(chans);
  chans = null;
  const bitrate = [192, 256, 320].includes(Number(kbps)) ? Number(kbps) : Number(kbps) > 0 ? Number(kbps) : 320;
  const results = await encodeMp3(src, rate, bitrate, (f) => onProgress(base + (1 - base) * f * 0.99), maxWorkers);
  const chunks = [];
  let frames = 0;
  let audioBytes = 0;
  for (const r of results) {
    frames += r.frames;
    for (const c of r.chunks) {
      chunks.push(c);
      audioBytes += c.length;
    }
  }
  const sampleCount = src.length;
  const parts = [];
  if (tagBytes) parts.push(tagBytes);
  const first = chunks.find((c) => c.length >= 4);
  if (!first || first[0] !== 0xff) throw new Error('Error al codificar el MP3.');
  let crc = 0;
  for (const c of chunks) crc = crc16(c, crc);
  const info = buildLameInfoFrame(first.subarray(0, 4), { frames, audioBytes, sampleCount, audioCrc: crc });
  if (info) parts.push(info);
  parts.push(...chunks);
  onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

// Punto de entrada: devuelve un Blob listo para descargar. No modifica los arrays de entrada.
// Audio: `channels` (Float32Array[]) o `source` = { length, numberOfChannels, read(s0, s1) → Float32Array[] } para
// leer la salida por tramos sin tenerla entera en memoria. Etiquetas: `tagBytes` (ya filtradas, buildTagBytes) o
// `sourceBytes` (el archivo original). maxWorkers (opcional): límite de workers MP3 (por defecto
// hardwareConcurrency − 1, máx. 3; 2 en móviles).
export async function exportAudio({ channels, source = null, sampleRate, format, bitDepth, kbps, sourceBytes, tagBytes,
  keepTags = true, onProgress = () => {}, maxWorkers = 0 } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const tags = !keepTags ? null : tagBytes !== undefined ? tagBytes || null : buildTagBytes(sourceBytes);
  const src = source || channelSource(channels);
  if (String(format).toLowerCase() === 'mp3') {
    return exportMp3({ source: src, sampleRate, kbps, tagBytes: tags, onProgress: progress, maxWorkers });
  }
  progress(0);
  return encodeWavBlob(src, sampleRate, {
    bitDepth: Number(bitDepth) === 24 ? 24 : 16, id3: tags, onProgress: progress, yieldFn: yieldTask,
  });
}
