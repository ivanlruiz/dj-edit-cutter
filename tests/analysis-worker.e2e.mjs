// Prueba de extremo a extremo del análisis en Chromium (Playwright): el worker de módulo arranca con URLs relativas
// desde una subruta (el proyecto se sirve bajo /dj-edit-cutter/ como en GitHub Pages), analiza canciones sintéticas,
// transfiere las muestras, atiende retrack / relabel / peticiones simultáneas y no bloquea el hilo principal.
// Uso: node tests/analysis-worker.e2e.mjs [--no-long]   (--no-long omite la canción de 4:30 del rendimiento)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCase } from './synth/suite.js';
import { analyze } from '../js/analysis/analyze.js';
import { fMeasure, tempoCheck, lastBarOk } from './synth/metrics.js';
import { getBars, findLastBarIndex } from '../js/core/bars.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/dj-edit-cutter/';
const BROKEN = '/roto/';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const PAGE = '<!doctype html><meta charset="utf-8"><title>e2e análisis</title><body>e2e</body>';
const LONG = !process.argv.includes('--no-long');

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

function startServer(blobs) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // /roto/: el mismo proyecto pero sin worker.js (404) para probar el análisis en el hilo principal
    const broken = url.pathname.startsWith(BROKEN);
    if (!url.pathname.startsWith(BASE) && !broken) { res.writeHead(404); res.end(); return; }
    const rel = decodeURIComponent(url.pathname.slice((broken ? BROKEN : BASE).length));
    if (broken && rel === 'js/analysis/worker.js') { res.writeHead(404); res.end(); return; }
    if (rel === '__e2e__.html') { res.writeHead(200, { 'content-type': MIME['.html'] }); res.end(PAGE); return; }
    if (blobs.has(rel)) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(blobs.get(rel)); return; }
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- código que corre dentro de la página ----------
async function inPage({ songs }) {
  const base = new URL('./', location.href).href;
  const { AnalysisClient } = await import(base + 'js/analysis/client.js');
  const out = { checks: [], results: {}, timings: {} };
  const check = (name, ok, detail = '') => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const load = async (name) => new Float32Array(await (await fetch(base + `__e2e__/${name}.f32`)).arrayBuffer());

  // mide el mayor hueco entre ticks del hilo principal mientras dura una promesa
  async function watchMainThread(promise) {
    let last = performance.now();
    let maxGap = 0;
    const iv = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 10);
    try {
      return { value: await promise, maxGap };
    } finally {
      clearInterval(iv);
    }
  }

  // 1) error antes de analizar
  const c0 = new AnalysisClient();
  try {
    await c0.retrack({});
    check('retrack sin análisis se rechaza', false, 'no se rechazó');
  } catch (e) {
    check('retrack sin análisis se rechaza con Error en español', e instanceof Error && /primero hay que analizar/.test(e.message), e.message);
  }
  c0.terminate();

  // 2) análisis normal
  const client = new AnalysisClient();
  const x = await load(songs.short);
  const n = x.length;
  const stages = [];
  const t0 = performance.now();
  const { value: r, maxGap } = await watchMainThread(client.analyze(x, 22050, {}, (stage, fraction) => stages.push([stage, fraction])));
  out.timings.shortMs = performance.now() - t0;
  out.timings.shortMaxGapMs = maxGap;
  out.results.short = r;
  check('las muestras se transfieren al worker', x.byteLength === 0 && n > 0, `byteLength ${x.byteLength}`);
  check('se usó el worker (no el modo en el hilo principal)', client._state === 'ready', client._state);
  const order = [...new Set(stages.map((s) => s[0]))].join(',');
  check('etapas de progreso en orden', order === 'features,tempo,beats,bars', order);
  check('fracciones de progreso en [0, 1]', stages.every(([, f]) => f >= 0 && f <= 1));

  // 3) retrack ×2 y ÷2, relabel con "1" forzado, peticiones simultáneas
  const d = r.downbeats[Math.floor(r.downbeats.length / 2)];
  const forced = await client.relabel({ forcedDownbeats: [d + 1] });
  check('relabel con un "1" forzado', forced.downbeats.includes(d + 1) && forced.forcedDownbeats[0] === d + 1, forced.forcedDownbeats);
  const dbl = await client.retrack({ bpmHint: r.bpm * 2, strict: true });
  out.results.dbl = { bpm: dbl.bpm, forced: dbl.forcedDownbeats.map((i) => dbl.beats[i]), oldForced: r.beats[d + 1] };
  check('retrack ×2', Math.abs(dbl.bpm / (2 * r.bpm) - 1) < 0.04, dbl.bpm);
  check('el "1" forzado sigue en su sitio tras ×2', dbl.forcedDownbeats.length === 1 && Math.abs(dbl.beats[dbl.forcedDownbeats[0]] - r.beats[d + 1]) < 0.02);
  const half = await client.retrack({ bpmHint: r.bpm / 2, strict: true });
  check('retrack ÷2', Math.abs(half.bpm / (r.bpm / 2) - 1) < 0.04, half.bpm);
  const [a, b, back] = await Promise.all([
    client.relabel({ beatsPerBar: 3, forcedDownbeats: [] }),
    client.relabel({ beatsPerBar: 4 }),
    client.retrack({}),
  ]);
  check('peticiones simultáneas: cada una con su resultado', a.beatsPerBar === 3 && b.beatsPerBar === 4 && back.beatsPerBar === 4, `${a.beatsPerBar} ${b.beatsPerBar} ${back.beatsPerBar}`);
  check('retrack sin tempo vuelve a la detección inicial', JSON.stringify(back.beats) === JSON.stringify(r.beats));
  try {
    await client.retrack({ bpmHint: 5000, strict: true });
    check('tempo absurdo se rechaza', false);
  } catch (e) {
    check('tempo absurdo se rechaza con Error en español', e instanceof Error && /fuera de rango/.test(e.message), e.message);
  }
  const pending = client.relabel({ beatsPerBar: 'auto' });
  client.terminate();
  try {
    await pending;
    check('terminate rechaza lo pendiente', false);
  } catch (e) {
    check('terminate rechaza lo pendiente', /cancelado/.test(e.message), e.message);
  }

  // 4) si el worker no carga (404, CSP…) el cliente analiza en el hilo principal con la misma API
  const { AnalysisClient: BrokenClient } = await import(location.origin + '/roto/js/analysis/client.js');
  const bc = new BrokenClient();
  const z = await load(songs.short);
  const rz = await bc.analyze(z, 22050);
  const rz2 = await bc.relabel({ beatsPerBar: 3 });
  check('sin worker: análisis en el hilo principal', bc._state === 'local' && JSON.stringify(rz.beats) === JSON.stringify(r.beats) && rz2.beatsPerBar === 3, bc._state);
  bc.terminate();

  // 5) rendimiento con la canción larga (cliente nuevo: incluye el arranque del worker)
  if (songs.long) {
    const y = await load(songs.long);
    out.timings.longSeconds = y.length / 22050;
    const c2 = new AnalysisClient();
    const t1 = performance.now();
    const st = {};
    let prev = t1;
    const res = await watchMainThread(c2.analyze(y, 22050, {}, (stage, fraction) => {
      const t = performance.now();
      if (fraction === 1) st[stage] = t - prev;
      prev = t;
    }));
    out.timings.longMs = performance.now() - t1;
    out.timings.longMaxGapMs = res.maxGap;
    out.timings.longStagesSeenFromMain = st;
    out.timings.longWorkerTimings = res.value.timingsMs;
    out.results.long = res.value;
    c2.terminate();
  }
  return out;
}

async function main() {
  const t0 = performance.now();
  const short = generateCase('live_rock_drift_128');
  const blobs = new Map([['__e2e__/short.f32', Buffer.from(short.samples.buffer.slice(0))]]);
  let long = null;
  if (LONG) {
    long = generateCase('long_song_4m30');
    blobs.set('__e2e__/long.f32', Buffer.from(long.samples.buffer.slice(0)));
  }
  const genMs = performance.now() - t0;
  // referencia en Node con las mismas muestras
  const t1 = performance.now();
  const nodeShort = analyze(short.samples, 22050);
  const nodeShortMs = performance.now() - t1;
  let nodeLong = null;
  let nodeLongMs = 0;
  if (long) {
    const t2 = performance.now();
    nodeLong = analyze(long.samples, 22050);
    nodeLongMs = performance.now() - t2;
  }

  const { chromium } = await loadPlaywright();
  const server = await startServer(blobs);
  const port = server.address().port;
  const browser = await chromium.launch();
  const failures = [];
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}${BASE}__e2e__.html`);
    const out = await page.evaluate(inPage, { songs: { short: 'short', long: long ? 'long' : null } });

    const checks = [...out.checks];
    const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });
    const r = out.results.short;
    const T = short.truth;
    const f = fMeasure(r.beats, T.beats, { range: T.evalRange }).f;
    add('resultado del navegador: beat F ≥ 0.95', f >= 0.95, f.toFixed(3));
    add('resultado del navegador: tempo correcto', tempoCheck(r.bpm, T.tempo.bpm).ok, `${r.bpm} vs ${T.tempo.bpm.toFixed(1)}`);
    const bars = getBars(r);
    const k = findLastBarIndex(r);
    add('resultado del navegador: último compás correcto', k >= 0 && lastBarOk(bars[k].start, T), k >= 0 ? bars[k].start : 'ninguno');
    const same = r.beats.length === nodeShort.beats.length && r.beats.every((t, i) => Math.abs(t - nodeShort.beats[i]) < 1e-3);
    add('mismos beats que en Node (±1 ms)', same, `${r.beats.length} vs ${nodeShort.beats.length}`);
    add('mismos compases que en Node', JSON.stringify(r.downbeats) === JSON.stringify(nodeShort.downbeats));
    add('el hilo principal no se bloquea (hueco máx. < 250 ms)', out.timings.shortMaxGapMs < 250, `${out.timings.shortMaxGapMs.toFixed(0)} ms`);
    if (long) {
      const L = out.results.long;
      const fl = fMeasure(L.beats, long.truth.beats, { range: long.truth.evalRange }).f;
      add('canción de 4:30 en el navegador: beat F ≥ 0.95', fl >= 0.95, fl.toFixed(3));
      add('canción de 4:30: < 10 s en el worker', out.timings.longMs < 10000, `${out.timings.longMs.toFixed(0)} ms`);
      add('canción de 4:30: el hilo principal no se bloquea (hueco máx. < 250 ms)', out.timings.longMaxGapMs < 250, `${out.timings.longMaxGapMs.toFixed(0)} ms`);
      add('canción de 4:30: mismos beats que en Node', L.beats.length === nodeLong.beats.length && L.beats.every((t, i) => Math.abs(t - nodeLong.beats[i]) < 1e-3));
    }
    add('sin errores en la página', pageErrors.length === 0, pageErrors.join(' | '));

    for (const c of checks) {
      console.log(`${c.ok ? 'ok  ' : 'FALLA'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      if (!c.ok) failures.push(c.name);
    }
    console.log('\nTiempos:');
    console.log(`  generación de canciones (Node): ${genMs.toFixed(0)} ms`);
    console.log(`  analyze() en Node: corta ${nodeShortMs.toFixed(0)} ms${long ? `, 4:30 ${nodeLongMs.toFixed(0)} ms ${JSON.stringify(nodeLong.timingsMs)}` : ''}`);
    console.log(`  worker en Chromium: corta ${out.timings.shortMs.toFixed(0)} ms (incluye arranque del worker)`);
    if (long) {
      console.log(`  worker en Chromium: 4:30 (${out.timings.longSeconds.toFixed(1)} s de audio) ${out.timings.longMs.toFixed(0)} ms, ` +
        `etapas dentro del worker ${JSON.stringify(out.timings.longWorkerTimings)}, hueco máx. del hilo principal ${out.timings.longMaxGapMs.toFixed(0)} ms`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) {
    console.log(`\n${failures.length} comprobación(es) fallida(s)`);
    process.exit(1);
  }
  console.log('\nTodo correcto');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
