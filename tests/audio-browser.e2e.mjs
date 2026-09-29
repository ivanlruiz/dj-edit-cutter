// Prueba de extremo a extremo de la E/S de audio en Chromium (Playwright).
// Uso: node tests/audio-browser.e2e.mjs
// Levanta su propio servidor estático (el proyecto se sirve bajo /dj-edit-cutter/ como en GitHub Pages),
// decodifica, analiza, recorta y exporta a WAV/MP3 dentro de la página y muestra un informe con tiempos.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/dj-edit-cutter/';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
const PAGE = '<!doctype html><meta charset="utf-8"><title>e2e audio</title><body>e2e</body>';

async function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright/index.js'].filter(Boolean);
  for (const c of candidates) {
    try {
      const m = await import(c);
      return m.chromium ? m : m.default;
    } catch { /* siguiente */ }
  }
  throw new Error('No se encontró Playwright (instálalo o define PLAYWRIGHT_MODULE).');
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404); res.end(); return; }
    const rel = decodeURIComponent(url.pathname.slice(BASE.length));
    if (rel === '__e2e__.html') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(PAGE); return; }
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- código que corre dentro de la página ----------
async function inPage() {
  const base = new URL('./', location.href).href;
  const { decodeAudioFile, toAnalysisMono, sniffSampleRate } = await import(base + 'js/audio/decode.js');
  const { renderEdit } = await import(base + 'js/audio/edit.js');
  const { encodeWav, parseWav } = await import(base + 'js/audio/wav.js');
  const { buildId3v2, readId3v2, frameText } = await import(base + 'js/audio/id3.js');
  const { exportAudio, suggestFileName } = await import(base + 'js/audio/export.js');

  const report = { checks: [], timings: {}, info: {} };
  const check = (name, ok, detail = '') => report.checks.push({ name, ok: !!ok, detail: String(detail) });
  const now = () => performance.now();

  function music(seconds, sr, nCh = 2, seed = 1) {
    const n = Math.round(seconds * sr);
    return Array.from({ length: nCh }, (_, c) => {
      const x = new Float32Array(n);
      let s = (seed * 7919 + c) >>> 0 || 1;
      for (let i = 0; i < n; i++) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        const t = i / sr;
        const beat = Math.exp(-((t % 0.5) * 25));
        x[i] = 0.35 * Math.sin(2 * Math.PI * (98 + 49 * c) * t) * (0.6 + 0.4 * beat)
          + 0.25 * beat * ((s / 4294967296) * 2 - 1) + 0.08 * Math.sin(2 * Math.PI * 2637 * t);
      }
      return x;
    });
  }
  const latin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const channelsOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));

  // Correlación cruzada normalizada para medir el desfase entre dos señales
  function bestLag(ref, sig, maxLag, from, len) {
    let best = 0;
    let bestV = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = from; i < from + len; i++) {
        const j = i + lag;
        if (j >= 0 && j < sig.length) acc += ref[i] * sig[j];
      }
      if (acc > bestV) { bestV = acc; best = lag; }
    }
    return best;
  }
  function snr(ref, sig, lag, from, len) {
    let s = 0;
    let e = 0;
    for (let i = from; i < from + len; i++) {
      const d = sig[i + lag] - ref[i];
      s += ref[i] * ref[i];
      e += d * d;
    }
    return 10 * Math.log10(s / e);
  }

  report.info.userAgent = navigator.userAgent;
  report.info.hardwareConcurrency = navigator.hardwareConcurrency;
  try {
    const ac = new AudioContext();
    report.info.defaultAudioContextRate = ac.sampleRate;
    await ac.close();
  } catch { report.info.defaultAudioContextRate = 'n/d'; }

  // 1) WAV de 44,1 kHz estéreo con etiqueta ID3 dentro de la página
  const SR = 44100;
  const src = music(20, SR, 2);
  const tag = buildId3v2([
    { id: 'TIT2', data: new Uint8Array([3, ...new TextEncoder().encode('Canción de prueba ñ')]) },
    { id: 'TPE1', data: new Uint8Array([0, ...latin1('Banda en vivo')]) },
    { id: 'TBPM', data: new Uint8Array([0, ...latin1('120')]) },
    { id: 'TLEN', data: new Uint8Array([0, ...latin1('20000')]) },
    { id: 'PRIV', data: latin1('TRAKTOR4\u0000datos') },
    { id: 'APIC', data: new Uint8Array([0, ...latin1('image/png'), 0, 3, 0, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xe0, 1, 2, 3]) },
  ], { version: 3 });
  const wavBytes = encodeWav(src, SR, { bitDepth: 24, id3: tag });
  const file = new File([wavBytes], 'Canción de prueba.wav', { type: 'audio/wav' });

  let t = now();
  const dec = await decodeAudioFile(file);
  report.timings.decodeWav20s = now() - t;
  check('decode WAV 44,1 kHz: sin remuestreo', dec.buffer.sampleRate === 44100 && dec.sampleRate === 44100, dec.buffer.sampleRate);
  check('decode WAV: longitud exacta', dec.buffer.length === src[0].length, `${dec.buffer.length} vs ${src[0].length}`);
  check('decode WAV: 2 canales', dec.buffer.numberOfChannels === 2);
  check('decode: bytes originales intactos', dec.bytes.byteLength === wavBytes.byteLength && sniffSampleRate(dec.bytes) === 44100);
  let maxErr = 0;
  const d0 = dec.buffer.getChannelData(0);
  for (let i = 0; i < d0.length; i++) maxErr = Math.max(maxErr, Math.abs(d0[i] - src[0][i]));
  check('decode WAV 24 bits: muestras idénticas (±1 LSB)', maxErr <= 1.01 / 8388608, `err máx ${(maxErr * 8388608).toFixed(2)} LSB`);
  check('readId3v2 lee el chunk id3 del WAV', (readId3v2(dec.bytes) || { frames: [] }).frames.length === 6);

  // Otras frecuencias nativas: tampoco se remuestrean
  for (const [rate, nCh, bits] of [[96000, 2, 24], [22050, 1, 16], [32000, 2, 16], [48000, 1, 16]]) {
    const x = music(1, rate, nCh, rate);
    const b = await decodeAudioFile(new File([encodeWav(x, rate, { bitDepth: bits })], `t${rate}.wav`));
    check(`decode WAV ${rate} Hz ${nCh} ch: sin remuestreo`, b.buffer.sampleRate === rate && b.buffer.length === x[0].length,
      `${b.buffer.sampleRate} Hz, ${b.buffer.length} muestras`);
  }

  // Archivo corrupto → error en español
  try {
    await decodeAudioFile(new File([new Uint8Array(5000).fill(7)], 'roto.mp3'));
    check('archivo corrupto rechazado', false, 'no lanzó');
  } catch (e) {
    check('archivo corrupto rechazado con mensaje en español', /No se pudo leer este archivo de audio/.test(e.message), e.message);
  }

  // 2) Mono para el análisis
  t = now();
  const mono = await toAnalysisMono(dec.buffer, 22050);
  report.timings.toAnalysisMono20s = now() - t;
  check('toAnalysisMono: longitud = ceil(duración·22050)', mono.length === Math.ceil(dec.buffer.duration * 22050), mono.length);
  check('toAnalysisMono: Float32Array nuevo', mono instanceof Float32Array && mono.buffer !== d0.buffer);

  // 3) Corte + fade
  const cutTime = 15.5;
  const fadeSec = 2;
  t = now();
  const edited = renderEdit(channelsOf(dec.buffer), SR, { cutTime, fadeSec, curve: 'smooth' });
  report.timings.renderEdit20s = now() - t;
  const cutSamples = Math.round(cutTime * SR);
  check('renderEdit: longitud', edited[0].length === cutSamples && edited[1].length === cutSamples);
  check('renderEdit: termina en 0', edited[0][cutSamples - 1] === 0 && edited[1][cutSamples - 1] === 0);

  // 4) Exportar WAV 24 bits con etiquetas
  t = now();
  const wavBlob = await exportAudio({ channels: edited, sampleRate: SR, format: 'wav', bitDepth: 24, sourceBytes: dec.bytes, keepTags: true });
  report.timings.exportWav = now() - t;
  const wavOut = parseWav(await wavBlob.arrayBuffer());
  check('export WAV: tipo', wavBlob.type === 'audio/wav');
  check('export WAV: longitud y frecuencia', wavOut.channels[0].length === cutSamples && wavOut.sampleRate === SR);
  const wavTag = readId3v2(await wavBlob.arrayBuffer());
  check('export WAV: etiquetas portables (sin TLEN/PRIV)', wavTag && wavTag.frames.map((f) => f.id).join() === 'TIT2,TPE1,TBPM,APIC',
    wavTag && wavTag.frames.map((f) => f.id).join());
  const wavBack = await decodeAudioFile(new File([wavBlob], 'x.wav'));
  check('export WAV → decode: longitud exacta', wavBack.buffer.length === cutSamples);

  // 5) Exportar MP3 320 kbps con etiquetas
  const progress = [];
  t = now();
  const mp3Blob = await exportAudio({ channels: edited, sampleRate: SR, format: 'mp3', kbps: 320, sourceBytes: dec.bytes,
    keepTags: true, onProgress: (f) => progress.push(f) });
  report.timings.exportMp3_15s = now() - t;
  check('export MP3: tipo', mp3Blob.type === 'audio/mpeg');
  check('export MP3: progreso creciente hasta 1', progress.length > 3 && progress.at(-1) === 1
    && progress.every((v, i) => i === 0 || v >= progress[i - 1] - 1e-9), `${progress.length} avisos`);
  const mp3Bytes = await mp3Blob.arrayBuffer();
  const mp3Tag = readId3v2(mp3Bytes);
  check('export MP3: etiqueta ID3 conservada', mp3Tag && mp3Tag.frames.map((f) => f.id).join() === 'TIT2,TPE1,TBPM,APIC'
    && frameText(mp3Tag.frames[0]) === 'Canción de prueba ñ', mp3Tag && mp3Tag.frames.map((f) => f.id).join());
  check('export MP3: sniff 44,1 kHz', sniffSampleRate(mp3Bytes) === 44100);
  report.info.mp3Bytes = mp3Bytes.byteLength;
  report.info.mp3Kbps = Math.round((mp3Bytes.byteLength * 8) / cutTime / 1000);
  report.info.fileName = suggestFileName(file.name, { barsRemoved: 4, format: 'mp3' });

  const mp3Back = await decodeAudioFile(new File([mp3Blob], 'x.mp3'));
  const back = mp3Back.buffer;
  check('MP3 → decode: 44,1 kHz', back.sampleRate === SR, back.sampleRate);
  const lagL = bestLag(edited[0], back.getChannelData(0), 2400, SR * 2, SR);
  const extra = back.length - cutSamples;
  report.info.mp3DecodedSamples = back.length;
  report.info.mp3ExpectedSamples = cutSamples;
  report.info.mp3ExtraSamples = extra;
  report.info.mp3ObservedDelaySamples = lagL;
  report.info.mp3SnrNoisyDb = +snr(edited[0], back.getChannelData(0), lagL, SR * 2, SR * 10).toFixed(1);
  check('MP3 → decode: duración ≈ esperada (±1 frame)', Math.abs(back.duration - cutTime) <= 1152 / SR,
    `${back.duration.toFixed(4)} s vs ${cutTime} s`);
  // Calidad con material tonal (el ruido blanco de music() es el peor caso para MP3 y el SNR no lo refleja bien)
  const chord = [new Float32Array(SR * 6), new Float32Array(SR * 6)];
  for (let i = 0; i < chord[0].length; i++) {
    const tt = i / SR;
    const env = 0.5 + 0.5 * Math.exp(-((tt % 0.5) * 8));
    let v = 0;
    for (const [f, a] of [[110, 0.3], [220, 0.15], [277.2, 0.12], [329.6, 0.12], [440, 0.08], [880, 0.04], [1760, 0.02]]) v += a * Math.sin(2 * Math.PI * f * tt);
    chord[0][i] = v * env;
    chord[1][i] = v * env * 0.8;
  }
  const chordBack = (await decodeAudioFile(new File([await exportAudio({ channels: chord, sampleRate: SR, format: 'mp3', kbps: 320 })], 'q.mp3'))).buffer;
  report.info.mp3SnrTonalDb = +snr(chord[0], chordBack.getChannelData(0), 0, SR, SR * 4).toFixed(1);
  check('MP3 320 kbps: calidad con material tonal (SNR > 35 dB, sin desfase)', report.info.mp3SnrTonalDb > 35, `${report.info.mp3SnrTonalDb} dB`);

  // MP3 a 48 kHz como archivo de entrada: el decode respeta 48 kHz
  const x48 = music(3, 48000, 2, 3);
  const mp348 = await exportAudio({ channels: x48, sampleRate: 48000, format: 'mp3', kbps: 192, keepTags: false });
  const d48 = await decodeAudioFile(new File([mp348], 'b.mp3'));
  check('decode MP3 48 kHz: sin remuestreo', d48.buffer.sampleRate === 48000 && Math.abs(d48.buffer.length - x48[0].length) <= 1152,
    `${d48.buffer.sampleRate} Hz, ${d48.buffer.length} vs ${x48[0].length}`);
  // 96 kHz → MP3 a 48 kHz
  const x96 = music(2, 96000, 2, 4);
  t = now();
  const mp396 = await exportAudio({ channels: x96, sampleRate: 96000, format: 'mp3', kbps: 256, keepTags: false });
  report.timings.exportMp3_96k_2s = now() - t;
  const d96 = await decodeAudioFile(new File([mp396], 'c.mp3'));
  check('MP3 desde 96 kHz: se codifica a 48 kHz con la duración correcta', d96.buffer.sampleRate === 48000
    && Math.abs(d96.buffer.duration - 2) < 1152 / 48000, `${d96.buffer.sampleRate} Hz, ${d96.buffer.duration.toFixed(4)} s`);

  // 6) Tiempos con una canción de 4 minutos en estéreo
  const song = music(240, SR, 2, 9);
  const songWav = encodeWav(song, SR, { bitDepth: 16 });
  t = now();
  const songDec = await decodeAudioFile(new File([songWav], 'song.wav'));
  report.timings.decodeWav4min = now() - t;
  t = now();
  await toAnalysisMono(songDec.buffer, 22050);
  report.timings.toAnalysisMono4min = now() - t;
  t = now();
  const songEdit = renderEdit(song, SR, { cutTime: 232, fadeSec: 4 });
  report.timings.renderEdit4min = now() - t;
  t = now();
  await exportAudio({ channels: songEdit, sampleRate: SR, format: 'wav', bitDepth: 16 });
  report.timings.exportWav16_4min = now() - t;
  t = now();
  const songMp3 = await exportAudio({ channels: songEdit, sampleRate: SR, format: 'mp3', kbps: 320 });
  report.timings.exportMp3_320_4min_parallel = now() - t;
  t = now();
  const songMp3Serial = await exportAudio({ channels: songEdit, sampleRate: SR, format: 'mp3', kbps: 320, maxWorkers: 1 });
  report.timings.exportMp3_320_4min_oneWorker = now() - t;
  const dSong = await decodeAudioFile(new File([songMp3], 's.mp3'));
  const dSerial = await decodeAudioFile(new File([songMp3Serial], 's1.mp3'));
  check('MP3 4 min (paralelo): duración exacta ±1 frame', Math.abs(dSong.buffer.length - songEdit[0].length) <= 1152,
    `${dSong.buffer.length} vs ${songEdit[0].length}`);
  const snrPar = snr(songEdit[0], dSong.buffer.getChannelData(0), bestLag(songEdit[0], dSong.buffer.getChannelData(0), 2400, SR * 10, SR), SR * 5, SR * 200);
  const snrSer = snr(songEdit[0], dSerial.buffer.getChannelData(0), bestLag(songEdit[0], dSerial.buffer.getChannelData(0), 2400, SR * 10, SR), SR * 5, SR * 200);
  report.info.snr4minParallelDb = +snrPar.toFixed(2);
  report.info.snr4minOneWorkerDb = +snrSer.toFixed(2);
  check('MP3 paralelo = misma calidad que 1 worker (±0.5 dB)', Math.abs(snrPar - snrSer) < 0.5, `${snrPar.toFixed(2)} vs ${snrSer.toFixed(2)} dB`);
  return report;
}

// ---------- ejecución ----------
const server = await startServer();
const port = server.address().port;
let browser;
let failed = 0;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}${BASE}__e2e__.html`);
  const report = await page.evaluate(inPage);
  for (const c of report.checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'ok  ' : 'FALLA'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log('\nInfo:', JSON.stringify(report.info, null, 2));
  console.log('\nTiempos (ms):');
  for (const [k, v] of Object.entries(report.timings)) console.log(`  ${k.padEnd(32)} ${v.toFixed(0)}`);
  if (pageErrors.length) {
    console.log('\nErrores en la página:', pageErrors.join('\n'));
    failed++;
  }
  console.log(`\n${report.checks.length - failed} de ${report.checks.length} comprobaciones correctas`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
