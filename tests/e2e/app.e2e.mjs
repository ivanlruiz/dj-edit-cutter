#!/usr/bin/env node
// E2E de la app completa en Chromium (Playwright): carga canciones sintéticas con verdad de referencia,
// quita 2 compases, exporta WAV/MP3 y comprueba el archivo descargado contra la referencia.
// Modo 2 («Cambiar el compás»): 7/8, 3/4, 5/4 y «Otro» 15/16 solo, 7/8 junto con quitar 2 compases (WAV y MP3);
// la duración exportada se compara con el plan de la app y el análisis de la propia app (en Node) comprueba que el
// audio exportado tiene el compás nuevo (tests/e2e/meter-check.mjs).
// El proyecto se sirve bajo /dj-edit-cutter/ (como en GitHub Pages) con un servidor propio.
//
// Uso: node tests/e2e/app.e2e.mjs [--cases a,b,c] [--all] [--keep] [--no-meter]
//   --all       todos los casos de la suite menos el largo (los 'hard' solo se informan, no fallan)
//   --keep      no borra la carpeta temporal (canciones y descargas)
//   --no-meter  sin las pruebas del cambio de compás
// Variables: E2E_SCREENSHOTS=<dir> (capturas; por defecto <tmp>/dj-edit-cutter-e2e-screens), PLAYWRIGHT_MODULE.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../synth/wav-io.js';
import { SUITE } from '../synth/suite.js';
import { CUT_PREROLL_SEC, ANTICLICK_SEC, fadeGain } from '../../js/audio/edit.js';
import { checkMeter } from './meter-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = '/dj-edit-cutter/';
const DEFAULT_CASES = ['rock_steady_120', 'live_band_ritardando_fermata_104', 'ballad_piano_pad_66_nodrums', 'pop_fadeout_110'];
const BARS_TO_REMOVE = 2;
const CUT_TOLERANCE = 0.06; // s
const LSB16 = 1 / 32768;
const MP3_MAX_OFFSET = 576 + 529; // retardo de codificador + decodificador (muestras)
// Fade por caso: índice del deslizador (0, ½, 1, 2, 4, 8, 16 beats) y curva
const FADE_PLAN = {
  rock_steady_120: { idx: 0, curve: 'smooth' },
  live_band_ritardando_fermata_104: { idx: 3, curve: 'linear' },
  ballad_piano_pad_66_nodrums: { idx: 0, curve: 'smooth' },
  pop_fadeout_110: { idx: 4, curve: 'exp' },
};

// ---------- argumentos ----------
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
let CASES = DEFAULT_CASES;
if (args.includes('--all')) CASES = SUITE.filter((c) => !c.tags.includes('long')).map((c) => c.name);
if (argVal('--cases')) CASES = argVal('--cases').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = args.includes('--keep');
const METER = !args.includes('--no-meter');
// Cambio de compás: canciones y casos (solo modo 2; luego 7/8 + quitar 2 compases)
const METER_SONGS = ['rock_steady_120', 'live_band_ritardando_fermata_104'];
const METER_CASES = [
  { id: '7/8', num: 7, den: 8, desc: 'Se quita la última corchea de cada compás.' },
  { id: '3/4', num: 3, den: 4, desc: 'Se quita el último tiempo de cada compás.' },
  { id: '5/4', num: 5, den: 4, desc: 'Se repite el último tiempo de cada compás.' },
  { id: 'other', num: 15, den: 16, desc: 'Se quita la última semicorchea de cada compás.' },
];
const DUR_TOL = 0.005; // s: duración exportada frente al plan
const TAGS = Object.fromEntries(SUITE.map((c) => [c.name, c.tags]));
for (const c of CASES) if (!TAGS[c]) throw new Error(`Caso desconocido: ${c}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'djec-e2e-'));
const SONGS = path.join(TMP, 'songs');
const DL = path.join(TMP, 'downloads');
const SHOTS = path.resolve(process.env.E2E_SCREENSHOTS || path.join(os.tmpdir(), 'dj-edit-cutter-e2e-screens'));
fs.mkdirSync(DL, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- informe ----------
const results = [];
const findings = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright/index.js'].filter(Boolean);
  for (const c of candidates) {
    try {
      const m = await import(c);
      return m.chromium ? m : m.default;
    } catch { /* siguiente */ }
  }
  throw new Error('No se encontró Playwright (instálalo o define PLAYWRIGHT_MODULE).');
}

// ---------- servidor estático bajo /dj-edit-cutter/ ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const served = []; // { method, path, status }
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const log = (status) => served.push({ method: req.method, path: url.pathname, status });
    if (!url.pathname.startsWith(BASE)) {
      log(404);
      res.writeHead(404);
      res.end();
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, rel);
    if (req.method !== 'GET' || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      log(404);
      res.writeHead(404);
      res.end();
      return;
    }
    log(200);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- referencia ----------
// Cortes aceptables al quitar n compases: inicio del compás (último − n + 1) de la referencia, menos el pre-roll.
// En un fade-out vale cualquiera de los "últimos compases" alternativos.
function expectedCuts(truth, n) {
  const db = truth.downbeats.map((i) => truth.beats[i]);
  const alts = truth.lastBarAlternatives && truth.lastBarAlternatives.length ? truth.lastBarAlternatives : [truth.lastBarStart];
  const out = [];
  for (const a of alts) {
    const k = db.findIndex((t) => Math.abs(t - a) < 0.002);
    if (k < 0) continue;
    const j = Math.max(1, k - n + 1);
    out.push({ time: db[j] - CUT_PREROLL_SEC, lastBar: k + 1 });
  }
  return out;
}

function gtBarCount(truth) {
  return truth.downbeats.filter((i) => truth.beats[i] <= truth.lastBarStart + 0.002).length;
}

// Ajusta la longitud del fade (en muestras) que mejor explica out = src · g(x) y devuelve el error máximo
function fitFade(src, out, curve, lenMin, lenMax) {
  const n = out.length;
  const errFor = (L, step) => {
    let e = 0;
    const start = n - L;
    for (let i = Math.max(0, start); i < n; i += step) {
      const g = fadeGain((i - start + 1) / L, curve);
      const d = Math.abs(out[i] - src[i] * g);
      if (d > e) e = d;
    }
    return e;
  };
  let best = lenMin;
  let bestE = Infinity;
  for (let L = lenMin; L <= lenMax; L++) {
    const e = errFor(L, 7);
    if (e < bestE) { bestE = e; best = L; }
  }
  // refina alrededor con todas las muestras
  let fine = best;
  let fineE = Infinity;
  for (let L = Math.max(lenMin, best - 8); L <= Math.min(lenMax, best + 8); L++) {
    const e = errFor(L, 1);
    if (e < fineE) { fineE = e; fine = L; }
  }
  return { len: fine, maxErr: fineE };
}

function maxAbsDiff(a, b, from, to) {
  let e = 0;
  for (let i = from; i < to; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > e) e = d;
  }
  return e;
}

function maxAbs(a, from, to) {
  let m = 0;
  for (let i = Math.max(0, from); i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

// ---------- ayudas de página ----------
const text = (page, sel) => page.locator(sel).innerText();

function watchPage(page, label, sink) {
  page.on('console', (m) => {
    if (m.type() === 'error') sink.errors.push(`${label}: ${m.text()}`);
    else if (m.type() === 'warning') sink.warnings.push(`${label}: ${m.text()}`);
  });
  page.on('pageerror', (e) => sink.errors.push(`${label}: pageerror ${e.message}`));
  page.on('worker', (w) => sink.workers.add(new URL(w.url()).pathname));
}

async function openApp(browser, url, ctxOpts, label, sink) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  watchPage(page, label, sink);
  await page.goto(url);
  await page.waitForSelector('html.js-ready');
  return { ctx, page };
}

async function loadSong(page, file) {
  const t0 = Date.now();
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('body[data-phase="ready"], body[data-phase="error"]', { timeout: 180000 });
  const phase = await page.getAttribute('body', 'data-phase');
  await sleep(250); // deja que la onda se redibuje
  return { phase, ms: Date.now() - t0 };
}

async function readInfo(page) {
  return {
    bpm: await text(page, '#info-bpm'),
    meter: (await text(page, '#info-meter')).trim(),
    bars: await text(page, '#info-bars'),
    conf: await text(page, '#info-conf'),
    n: await text(page, '#bars-value'),
    readout: await text(page, '#cut-readout'),
    lowConf: await page.locator('#low-conf-hint').isVisible(),
  };
}

async function waitGridIdle(page) {
  await page.waitForFunction(() => document.getElementById('review-busy').hidden, null, { timeout: 60000 });
  await sleep(50);
}

async function setFade(page, idx, curve) {
  await page.$eval('#rng-fade', (e, v) => {
    e.value = String(v);
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, idx);
  await page.selectOption('#sel-curve', curve);
  return text(page, '#fade-value');
}

async function exportAs(page, format) {
  await page.click(`label.radio-chip:has(input[value="${format}"])`);
  const expectedName = await text(page, '#out-name');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#btn-export')]);
  const file = path.join(DL, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  await page.waitForFunction(() => document.getElementById('export-label').textContent === 'Descargar', null, { timeout: 60000 });
  return { file, name: dl.suggestedFilename(), expectedName };
}

// Decodifica un MP3 descargado dentro de la página (el decodificador del navegador, como un reproductor real)
async function decodeInPage(page, file) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async (data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ctx = new OfflineAudioContext(2, 1, 44100);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const x = buf.getChannelData(0);
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return { length: buf.length, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, rms: Math.sqrt(s / Math.max(1, x.length)) };
  }, b64);
}

// ---------- flujo por canción ----------
const report = [];

async function runSong(page, name, { transport = false, mp3 = false } = {}) {
  const hard = TAGS[name].includes('hard');
  const wavPath = path.join(SONGS, `${name}.wav`);
  const truth = JSON.parse(fs.readFileSync(path.join(SONGS, `${name}.truth.json`), 'utf8'));
  const row = { name, hard, gtBpm: truth.tempo.bpm, gtMeter: truth.meter, gtBars: gtBarCount(truth) };
  report.push(row);

  const { phase, ms } = await loadSong(page, wavPath);
  row.loadMs = ms;
  check(`${name}: carga y análisis llegan a «listo»`, phase === 'ready', `${ms} ms`);
  if (phase !== 'ready') {
    row.error = await text(page, '#error-text');
    return null;
  }
  const info = await readInfo(page);
  Object.assign(row, { bpm: info.bpm, meter: info.meter, bars: info.bars, conf: info.conf, lowConf: info.lowConf });
  check(`${name}: N inicial = 1`, info.n === '1', info.n);
  check(`${name}: la info muestra tempo, compás y compases`, /BPM/.test(info.bpm) && /\/4/.test(info.meter) && /^\d+$/.test(info.bars),
    `${info.bpm} · ${info.meter} · ${info.bars} compases · ${info.conf}`);

  // compases a quitar = 2
  await page.click(`#bar-chips button[data-bars="${BARS_TO_REMOVE}"]`);
  const n = await text(page, '#bars-value');
  check(`${name}: «Compases a quitar» = ${BARS_TO_REMOVE}`, n === String(BARS_TO_REMOVE), n);
  row.readout = await text(page, '#cut-readout');

  const plan = FADE_PLAN[name] || { idx: 0, curve: 'smooth' };
  const fadeText = await setFade(page, plan.idx, plan.curve);
  row.fade = `${fadeText} (${plan.curve})`;

  if (transport) await transportChecks(page, name);

  // WAV 16 bits
  const wav = await exportAs(page, 'wav16');
  check(`${name}: nombre del archivo`, wav.name === wav.expectedName && wav.name === `${name} (edit -${BARS_TO_REMOVE} compases).wav`, wav.name);
  const out = decodeWav(fs.readFileSync(wav.file));
  const src = decodeWav(fs.readFileSync(wavPath));
  const sr = out.sampleRate;
  const len = out.channels[0].length;
  check(`${name}: WAV exportado 44,1 kHz estéreo 16 bits`, sr === 44100 && out.channels.length === 2 && out.bitDepth === 16,
    `${sr} Hz, ${out.channels.length} canales, ${out.bitDepth} bits`);
  const cutSec = len / sr;
  row.cut = cutSec;

  // duración = corte esperado (inicio del compás último−1 de la referencia − pre-roll)
  const exp = expectedCuts(truth, BARS_TO_REMOVE);
  let best = null;
  for (const e of exp) if (!best || Math.abs(cutSec - e.time) < Math.abs(cutSec - best.time)) best = e;
  const err = best ? cutSec - best.time : NaN;
  row.expected = best ? best.time : NaN;
  row.cutErrMs = err * 1000;
  const cutOk = Math.abs(err) <= CUT_TOLERANCE;
  const detail = `corte ${cutSec.toFixed(3)} s, esperado ${best ? best.time.toFixed(3) : '?'} s` +
    `${exp.length > 1 ? ` (${exp.length} alternativas de fade-out)` : ''}, error ${(err * 1000).toFixed(1)} ms`;
  if (hard && !cutOk) {
    findings.push(`${name} (caso difícil): el corte no coincide con la referencia — ${detail}; info: ${info.bpm}, ${info.meter}, ${info.conf}`);
    console.log(`info ${name}: corte fuera de tolerancia en un caso difícil (se informa, no falla) — ${detail}`);
  } else {
    check(`${name}: duración del WAV = corte de la referencia (±${CUT_TOLERANCE * 1000} ms)`, cutOk, detail);
  }

  // contenido: idéntico al original hasta el fade; el fade sigue la curva y termina en silencio
  const o = out.channels[0];
  const s = src.channels[0];
  const fadeSecShown = plan.idx === 0 ? 0 : Number(((fadeText.match(/≈\s*([\d.,]+)\s*s/) || [])[1] || '').replace(',', '.'));
  const fadeMaxLen = Math.round(Math.max(fadeSecShown + 0.006, ANTICLICK_SEC) * sr);
  const fadeMinLen = Math.round(Math.max(fadeSecShown - 0.006, ANTICLICK_SEC) * sr);
  // ±2 LSB: dither TPDF (±1) + Chromium decodifica int16 positivos como k/32767 (no k/32768), +1 LSB en picos
  const preErr = maxAbsDiff(o, s, 0, len - fadeMaxLen);
  check(`${name}: audio idéntico al original antes del fade (±2 LSB: dither + escala del decodificador)`,
    preErr <= 2.01 * LSB16, `${(preErr / LSB16).toFixed(2)} LSB`);
  const lr = maxAbsDiff(out.channels[0], out.channels[1], 0, len);
  check(`${name}: canales coherentes (fuente mono duplicada)`, lr <= 2.01 * LSB16, `${(lr / LSB16).toFixed(2)} LSB`);
  const fit = fitFade(s, o, plan.curve, fadeMinLen, fadeMaxLen);
  check(`${name}: el fade sigue la curva «${plan.curve}» (${plan.idx === 0 ? 'rampa anticlic de 5 ms' : fadeText})`,
    fit.maxErr <= 2.51 * LSB16 && (plan.idx !== 0 || fit.len === Math.round(ANTICLICK_SEC * sr)),
    `${fit.len} muestras (${(fit.len / sr * 1000).toFixed(1)} ms), error máx. ${(fit.maxErr / LSB16).toFixed(2)} LSB`);
  const lastMs = Math.round(0.001 * sr);
  const tailOut = maxAbs(o, len - lastMs, len);
  const tailSrc = maxAbs(s, len - lastMs, len);
  const lastSample = Math.abs(o[len - 1]);
  check(`${name}: el último milisegundo se desvanece hasta el silencio`,
    lastSample <= LSB16 && tailOut <= 0.2 * tailSrc + 2 * LSB16,
    `última muestra ${(lastSample / LSB16).toFixed(0)} LSB, pico último ms ${(tailOut / LSB16).toFixed(0)} LSB vs original ${(tailSrc / LSB16).toFixed(0)} LSB`);

  if (mp3) {
    const m = await exportAs(page, 'mp3-320');
    check(`${name}: nombre del MP3`, m.name === `${name} (edit -${BARS_TO_REMOVE} compases).mp3`, m.name);
    const bytes = fs.readFileSync(m.file);
    const kbps = (bytes.length * 8) / cutSec / 1000;
    const dec = await decodeInPage(page, m.file);
    const diff = dec.length - len;
    row.mp3 = `${(bytes.length / 1024).toFixed(0)} KB, ${dec.length} muestras (${diff >= 0 ? '+' : ''}${diff} vs WAV)`;
    check(`${name}: MP3 320 kbps se decodifica con la duración del corte (± retardo del codificador)`,
      dec.sampleRate === 44100 && Math.abs(diff) <= MP3_MAX_OFFSET,
      `${dec.length} vs ${len} muestras (${diff >= 0 ? '+' : ''}${diff}), ${kbps.toFixed(0)} kbps`);
    const rmsWav = rms(o);
    const db = 20 * Math.log10(dec.rms / rmsWav);
    check(`${name}: el MP3 tiene el mismo nivel que el WAV (±1 dB)`, Math.abs(db) <= 1, `${db.toFixed(2)} dB`);
    await page.click('label.radio-chip:has(input[value="wav16"])');
  }
  return row;
}

async function transportChecks(page, name) {
  const errsBefore = sink.errors.length;
  await page.click('#btn-metro');
  check(`${name}: «Clic de metrónomo» se activa`, (await page.getAttribute('#btn-metro', 'aria-pressed')) === 'true');
  await page.click('#btn-play');
  await sleep(700);
  const t1 = await text(page, '#time-now');
  await sleep(400);
  const t2 = await text(page, '#time-now');
  check(`${name}: reproducir con metrónomo avanza`, (await page.getAttribute('#btn-play', 'data-state')) === 'playing' && t1 !== t2, `${t1} → ${t2}`);
  await page.click('#btn-play');
  check(`${name}: pausa`, (await page.getAttribute('#btn-play', 'data-state')) === 'paused');
  await page.click('#btn-preview');
  await sleep(500);
  const pv = await page.getAttribute('#btn-preview', 'data-state');
  const pvLabel = await text(page, '#preview-label');
  check(`${name}: «Escuchar el final» suena`, pv === 'playing' && pvLabel === 'Detener', `${pv}, «${pvLabel}», cabezal ${await text(page, '#time-now')}`);
  await page.click('#btn-preview');
  check(`${name}: «Detener» para la vista previa`, (await page.getAttribute('#btn-preview', 'data-state')) === 'idle');
  await page.click('#btn-metro');
  check(`${name}: «Clic de metrónomo» se desactiva`, (await page.getAttribute('#btn-metro', 'aria-pressed')) === 'false');

  // Tempo ×2 / ÷2 y Restablecer sobre el worker real
  const bpm0 = await text(page, '#info-bpm');
  const n0 = await text(page, '#bars-value');
  await page.click('#btn-tempo-double');
  await waitGridIdle(page);
  const bpm2 = await text(page, '#info-bpm');
  await page.click('#btn-tempo-half');
  await waitGridIdle(page);
  const bpm1 = await text(page, '#info-bpm');
  check(`${name}: Tempo ×2 y ÷2 recalculan la cuadrícula`, bpm2 !== bpm0 && parseFloat(bpm1.replace('≈', '').replace(',', '.')) > 0, `${bpm0} → ${bpm2} → ${bpm1}`);
  await page.click('#btn-reset-grid');
  await waitGridIdle(page);
  const bpmR = await text(page, '#info-bpm');
  check(`${name}: Restablecer vuelve a la detección inicial`, bpmR === bpm0 && (await text(page, '#bars-value')) === n0, `${bpmR}, N = ${await text(page, '#bars-value')}`);
  check(`${name}: sin errores durante reproducción / vista previa / tempo`, sink.errors.length === errsBefore, sink.errors.slice(errsBefore).join(' | '));
}

// ---------- cambio de compás (modo 2) ----------
async function setSwitch(page, id, on) {
  if ((await page.isChecked(`#${id}`)) !== on) await page.click(`label:has(#${id})`);
  return page.isChecked(`#${id}`);
}

async function chooseMeter(page, mc) {
  await page.click(`#meter-chips [data-meter="${mc.id}"]`);
  if (mc.id === 'other') {
    await page.fill('#inp-meter-num', String(mc.num));
    await page.selectOption('#sel-meter-den', String(mc.den));
  }
  await sleep(50);
}

async function planInfo(page) {
  return page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const rs = g('result-summary');
    return {
      change: g('meter-change').textContent, desc: g('meter-desc').textContent, stats: g('meter-stats').textContent,
      msg: g('meter-msg').hidden ? '' : g('meter-msg').textContent, summary: rs.hidden ? '' : rs.textContent,
      outSec: Number(rs.dataset.outputSec), barsChanged: Number(rs.dataset.barsChanged),
      exportDisabled: g('btn-export').disabled, hint: g('export-hint').hidden ? '' : g('export-hint').textContent,
      previewDisabled: g('btn-meter-preview').disabled,
    };
  });
}

const bpmOf = (s) => Number(((String(s).match(/([\d.,]+)\s*BPM/) || [])[1] || '').replace(',', '.'));
const secOf = (s) => {
  const m = String(s).match(/(\d+):(\d\d)\.(\d\d)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100 : NaN;
};

// Mismo audio (±2 LSB: dither + escala del decodificador) en un tramo del original y del exportado
function sameAudio(src, srcFrom, out, outFrom, len) {
  let e = 0;
  for (let i = 0; i < len; i++) e = Math.max(e, Math.abs(src[srcFrom + i] - out[outFrom + i]));
  return e;
}

async function meterPreviewChecks(page, name) {
  const errsBefore = sink.errors.length;
  // el cabezal al principio: la vista previa arranca en 0 y el tiempo del original avanza 8/7 más rápido (7/8)
  await page.evaluate(() => document.getElementById('btn-zoom-all').click());
  await page.locator('.wf-main').scrollIntoViewIfNeeded();
  const box = await page.locator('.wf-main').boundingBox();
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await page.click('#btn-meter-preview');
  await sleep(300);
  const st = await page.getAttribute('#btn-meter-preview', 'data-state');
  const lbl = await text(page, '#meter-preview-label');
  check(`${name}: «Escuchar con el nuevo compás» suena`, st === 'playing' && lbl === 'Detener', `${st}, «${lbl}»`);
  await sleep(2200); // pasa la anacrusa y el primer compás
  const a = { t: secOf(await text(page, '#time-now')), w: Date.now() };
  await sleep(3500);
  const b = { t: secOf(await text(page, '#time-now')), w: Date.now() };
  const ratio = (b.t - a.t) / ((b.w - a.w) / 1000);
  check(`${name}: el cabezal sigue la canción original durante la vista previa (7/8 → ×8/7)`, ratio > 1.06 && ratio < 1.24,
    `${a.t.toFixed(2)} s → ${b.t.toFixed(2)} s en ${((b.w - a.w) / 1000).toFixed(2)} s de reloj: ×${ratio.toFixed(3)} (esperado ≈ 1.143)`);
  // tocar la onda mientras suena: sigue con el compás nuevo desde ese punto (tiempo del original)
  const dur = secOf(await text(page, '#time-total'));
  const tClick = dur * 0.45;
  await page.locator('.wf-main').scrollIntoViewIfNeeded();
  const box2 = await page.locator('.wf-main').boundingBox();   // el clic en el botón pudo desplazar la página
  await page.mouse.click(box2.x + box2.width * 0.45, box2.y + box2.height / 2);
  await sleep(400);
  const st2 = await page.getAttribute('#btn-meter-preview', 'data-state');
  const tNow = secOf(await text(page, '#time-now'));
  check(`${name}: tocar la onda durante la vista previa sigue con el compás nuevo desde ahí`,
    st2 === 'playing' && tNow >= tClick - 0.05 && tNow <= tClick + 1.2, `${st2}, toque en ${tClick.toFixed(2)} s, cabezal ${tNow.toFixed(2)} s`);
  await page.click('#btn-meter-preview');
  check(`${name}: «Detener» para la vista previa del compás`, (await page.getAttribute('#btn-meter-preview', 'data-state')) === 'idle');
  // atajos: con el modo 1 apagado, P escucha con el compás nuevo; T marca el tempo
  await setSwitch(page, 'chk-mode1', false);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('p');
  await sleep(250);
  const kp = await page.getAttribute('#btn-meter-preview', 'data-state');
  await page.keyboard.press('p');
  await sleep(100);
  const kp2 = await page.getAttribute('#btn-meter-preview', 'data-state');
  await page.keyboard.press('t');
  await page.keyboard.press('t');
  const kt = await text(page, '#tap-value');
  check(`${name}: atajos P (vista previa del compás sin el modo 1) y T (marcar tempo)`, kp === 'playing' && kp2 === 'idle' && /BPM/.test(kt),
    `P → ${kp}, P → ${kp2}, T T → «${kt}»`);
  await setSwitch(page, 'chk-mode1', true);
  check(`${name}: sin errores en la vista previa del compás`, sink.errors.length === errsBefore, sink.errors.slice(errsBefore).join(' | '));
}

async function reviewChecks(page, name) {
  // «Marcar tempo»: 6 toques cada 500 ms → ≈ 120 BPM en el campo «Tempo manual»
  for (let i = 0; i < 6; i++) {
    await page.click('#btn-tap');
    if (i < 5) await sleep(500);
  }
  const tapped = await text(page, '#tap-value');
  const typed = await page.inputValue('#inp-bpm');
  check(`${name}: «Marcar tempo» muestra el tempo marcado`, Math.abs(bpmOf(tapped) - 120) <= 6 && Math.abs(Number(typed.replace(',', '.')) - 120) <= 6,
    `${tapped} · campo ${typed}`);
  // «Tempo manual» + «Aplicar» = retrack estricto
  await page.fill('#inp-bpm', '120');
  await page.click('#btn-bpm-apply');
  await waitGridIdle(page);
  const bpm = bpmOf(await text(page, '#info-bpm'));
  check(`${name}: «Tempo manual» 120 + «Aplicar» recalcula a ≈ 120 BPM`, Math.abs(bpm - 120) < 2, `${bpm} BPM`);
  // «Este beat es el 1» → insignia neutra, sin el aviso de baja confianza
  await page.click('#btn-this-one');
  await waitGridIdle(page);
  const badge = await text(page, '#info-conf');
  const warn = await page.locator('#low-conf-hint').isVisible();
  check(`${name}: tras fijar el 1 a mano la insignia es «Cuadrícula ajustada a mano» y no hay aviso`,
    badge === 'Cuadrícula ajustada a mano' && !warn, `«${badge}», aviso ${warn}`);
  await page.click('#btn-reset-grid');
  await waitGridIdle(page);
  const badge2 = await text(page, '#info-conf');
  check(`${name}: «Restablecer» vuelve a la insignia de confianza`, badge2 !== 'Cuadrícula ajustada a mano', badge2);
}

async function runMeterSong(page, name, { mp3 = false, ui = false, control = false } = {}) {
  const wavPath = path.join(SONGS, `${name}.wav`);
  const { phase, ms } = await loadSong(page, wavPath);
  check(`${name} [compás]: carga y análisis llegan a «listo»`, phase === 'ready', `${ms} ms`);
  if (phase !== 'ready') return;
  const srcBpm = bpmOf(await text(page, '#info-bpm'));
  const meterShown = (await text(page, '#info-meter')).trim();
  const src = decodeWav(fs.readFileSync(wavPath));
  const s0 = src.channels[0];
  if (control) {
    // control del comprobador: el original se reconoce como 4/4 y no como 7/8
    const pos = checkMeter(src.channels, src.sampleRate, { num: 4, den: 4, sourceBpm: srcBpm });
    const neg = checkMeter(src.channels, src.sampleRate, { num: 7, den: 8, sourceBpm: srcBpm });
    check(`${name}: control — el análisis ve 4/4 en el original y no 7/8`, pos.ok && !neg.ok, `4/4: ${pos.detail} | 7/8: ${neg.detail}`);
  }
  if (ui) await reviewChecks(page, name);

  // ambos interruptores apagados → no se puede descargar
  await setSwitch(page, 'chk-mode2', false);
  await setSwitch(page, 'chk-mode1', false);
  let info = await planInfo(page);
  check(`${name}: con los dos modos apagados «Descargar» está desactivado con una pista`, info.exportDisabled && /Activa/.test(info.hint), info.hint);

  // solo modo 2
  await setSwitch(page, 'chk-mode2', true);
  const only = {};
  for (const mc of METER_CASES) {
    const label = `${mc.num}/${mc.den}${mc.id === 'other' ? ' (Otro)' : ''}`;
    await chooseMeter(page, mc);
    info = await planInfo(page);
    only[mc.id] = info;
    check(`${name} ${label}: panel del compás`,
      info.change === `Original: ${meterShown.replace(/\s*auto$/, '')} → Nuevo: ${mc.num}/${mc.den}` && info.desc === mc.desc &&
      /^Se cambian \d+ compases · dura \d+:\d\d → \d+:\d\d$/.test(info.stats) && !info.exportDisabled && !info.msg && info.barsChanged > 0,
      `${info.change} · ${info.desc} · ${info.stats}`);
    const wav = await exportAs(page, 'wav16');
    check(`${name} ${label}: nombre del archivo`, wav.name === wav.expectedName && wav.name === `${name} (${mc.num}-${mc.den}).wav`, wav.name);
    const out = decodeWav(fs.readFileSync(wav.file));
    const o0 = out.channels[0];
    const outDur = o0.length / out.sampleRate;
    check(`${name} ${label}: duración exportada = plan (±${DUR_TOL * 1000} ms)`, Math.abs(outDur - info.outSec) <= DUR_TOL,
      `${outDur.toFixed(4)} s vs plan ${info.outSec.toFixed(4)} s (${((outDur - info.outSec) * 1000).toFixed(2)} ms); original ${(s0.length / src.sampleRate).toFixed(3)} s`);
    // el principio (anacrusa) y el compás final con la resonancia quedan intactos
    const head = Math.round(0.3 * out.sampleRate);
    const tail = Math.round(1.5 * out.sampleRate);
    const anti = Math.round(ANTICLICK_SEC * out.sampleRate) + 2;
    const eHead = sameAudio(s0, 0, o0, 0, head);
    const eTail = sameAudio(s0, s0.length - tail, o0, o0.length - tail, tail - anti);
    check(`${name} ${label}: principio y final idénticos al original (±2 LSB)`, eHead <= 2.01 * LSB16 && eTail <= 2.01 * LSB16,
      `inicio ${(eHead / LSB16).toFixed(2)} LSB, últimos 1,5 s ${(eTail / LSB16).toFixed(2)} LSB`);
    const t0 = Date.now();
    const mcheck = checkMeter(out.channels, out.sampleRate, { num: mc.num, den: mc.den, sourceBpm: srcBpm });
    check(`${name} ${label}: el análisis de la app encuentra ${mc.num}/${mc.den} en el WAV exportado`, mcheck.ok,
      `${mcheck.detail} (${Date.now() - t0} ms)`);
  }

  if (ui) {
    // errores y avisos del compás nuevo (solo modo 2 activo)
    await chooseMeter(page, { id: 'other', num: 33, den: 8 });
    info = await planInfo(page);
    check(`${name}: «Otro» 33/8 → error en español y «Descargar» desactivado`,
      /numerador/.test(info.msg) && info.exportDisabled && /compás válido/.test(info.hint) && info.previewDisabled, `${info.msg} · ${info.hint}`);
    await chooseMeter(page, { id: 'other', num: 0, den: 8 });
    info = await planInfo(page);
    check(`${name}: «Otro» 0/8 → «demasiado corto»`, /demasiado corto/.test(info.msg) && info.exportDisabled, info.msg);
    await chooseMeter(page, { id: 'other', num: 4, den: 4 });
    info = await planInfo(page);
    check(`${name}: «Otro» 4/4 → ya está en ese compás, nada que descargar`,
      info.msg === 'La canción ya está en ese compás.' && info.exportDisabled && /no cambia/.test(info.hint), `${info.msg} · ${info.hint}`);
  }

  // 7/8 + quitar 2 compases
  await setSwitch(page, 'chk-mode1', true);
  await chooseMeter(page, METER_CASES[0]);
  await page.click(`#bar-chips button[data-bars="${BARS_TO_REMOVE}"]`);
  info = await planInfo(page);
  const readout = await text(page, '#cut-readout');
  check(`${name} 7/8 + −2 compases: resumen y lectura del corte`,
    /^Compás 7\/8 · −2 compases del final · dura \d+:\d\d → \d+:\d\d$/.test(info.summary) && /con el compás nuevo pasa de/.test(readout) &&
    info.barsChanged === only['7/8'].barsChanged - (BARS_TO_REMOVE - 1),
    `${info.summary} · ${readout} · ${info.barsChanged} compases cambiados (solo 7/8: ${only['7/8'].barsChanged})`);
  const both = await exportAs(page, 'wav16');
  check(`${name} 7/8 + −2 compases: nombre del archivo`, both.name === `${name} (7-8, edit -${BARS_TO_REMOVE} compases).wav`, both.name);
  const ob = decodeWav(fs.readFileSync(both.file));
  const b0 = ob.channels[0];
  const bDur = b0.length / ob.sampleRate;
  check(`${name} 7/8 + −2 compases: duración = plan (±${DUR_TOL * 1000} ms)`, Math.abs(bDur - info.outSec) <= DUR_TOL,
    `${bDur.toFixed(4)} s vs ${info.outSec.toFixed(4)} s`);
  check(`${name} 7/8 + −2 compases: termina en silencio (rampa anticlic)`, Math.abs(b0[b0.length - 1]) <= LSB16, `${(Math.abs(b0[b0.length - 1]) / LSB16).toFixed(0)} LSB`);
  const mb = checkMeter(ob.channels, ob.sampleRate, { num: 7, den: 8, sourceBpm: srcBpm });
  check(`${name} 7/8 + −2 compases: el análisis encuentra 7/8`, mb.ok, mb.detail);
  if (mp3) {
    const m = await exportAs(page, 'mp3-320');
    check(`${name} 7/8 + −2 compases: nombre del MP3`, m.name === `${name} (7-8, edit -${BARS_TO_REMOVE} compases).mp3`, m.name);
    const dec = await decodeInPage(page, m.file);
    const diff = dec.length - b0.length;
    check(`${name} 7/8 + −2 compases: el MP3 dura lo mismo que el WAV (± retardo del codificador)`,
      dec.sampleRate === 44100 && Math.abs(diff) <= MP3_MAX_OFFSET, `${dec.length} vs ${b0.length} muestras (${diff >= 0 ? '+' : ''}${diff})`);
    const db = 20 * Math.log10(dec.rms / rms(b0));
    check(`${name} 7/8 + −2 compases: el MP3 tiene el mismo nivel que el WAV (±1 dB)`, Math.abs(db) <= 1, `${db.toFixed(2)} dB`);
    await page.click('label.radio-chip:has(input[value="wav16"])');
  }
  if (ui) await meterPreviewChecks(page, name);
}

// Archivos equivocados y toques durante «Escuchar el final» (canción ya cargada en `page`)
async function robustnessChecks(page, name) {
  const errsBefore = sink.errors.length;
  const song = await text(page, '#song-name');
  const bad = [['notas.txt', 'text/plain', Buffer.from('hola, esto no es audio')], ['falso.mp3', 'audio/mpeg', Buffer.alloc(4096, 7)]];
  for (const [fname, mimeType, buffer] of bad) {
    await page.setInputFiles('#file-input', { name: fname, mimeType, buffer });
    await page.waitForFunction(() => document.body.dataset.phase !== 'loading', null, { timeout: 30000 }).catch(() => {});
    await sleep(300);
    const st = await page.evaluate(() => ({
      phase: document.body.dataset.phase, name: document.getElementById('song-name').textContent,
      toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast-text').textContent,
      editor: !document.getElementById('editor').hidden,
    }));
    check(`${name}: cargar «${fname}» por error no borra la canción cargada`, st.phase === 'ready' && st.name === song && st.editor &&
      st.toast.includes(fname), `${st.phase}, «${st.name}», aviso «${st.toast}»`);
  }
  // tocar la onda durante «Escuchar el final»: sigue sonando el final editado, no la canción original
  await page.click('#btn-preview');
  await sleep(400);
  await page.locator('.wf-main').scrollIntoViewIfNeeded();
  const box = await page.locator('.wf-main').boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
  await sleep(300);
  const pv = await page.getAttribute('#btn-preview', 'data-state');
  const lbl = await text(page, '#play-label');
  check(`${name}: tocar la onda durante «Escuchar el final» sigue con el final editado`, pv === 'playing' && lbl === 'Detener', `${pv}, botón principal «${lbl}»`);
  await page.click('#btn-play');
  check(`${name}: el botón principal detiene la vista previa`, (await page.getAttribute('#btn-preview', 'data-state')) === 'idle' &&
    (await text(page, '#play-label')) === 'Reproducir');
  check(`${name}: sin errores con archivos equivocados / toques en la vista previa`, sink.errors.length === errsBefore, sink.errors.slice(errsBefore).join(' | '));
}

// Deslizar el dedo en vertical sobre la onda desplaza la página y no mueve el cabezal
async function touchScrollCheck(ctx, page, label) {
  const cdp = await ctx.newCDPSession(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  const g = await page.evaluate(() => { const r = document.querySelector('.wf-main').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height * 0.8 }; });
  const t0 = await text(page, '#time-now');
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 5, radiusY: 5, force: 1 })) });
  await touch('touchStart', [[g.x, g.y]]);
  for (let k = 1; k <= 12; k++) {
    await touch('touchMove', [[g.x, g.y - 12.5 * k]]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(400);
  const sy = await page.evaluate(() => Math.round(window.scrollY));
  const t1 = await text(page, '#time-now');
  check(`${label}: deslizar en vertical sobre la onda desplaza la página y no mueve el cabezal`, sy > 40 && t1 === t0, `scrollY ${sy}, cabezal ${t0} → ${t1}`);
  await cdp.detach();
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(150);
}

async function meterShots(page, label) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(150);
  await page.screenshot({ path: path.join(SHOTS, `${label}-meter-top.png`) });
  await page.locator('#panel-meter').scrollIntoViewIfNeeded();
  await sleep(150);
  await page.screenshot({ path: path.join(SHOTS, `${label}-meter-panel.png`) });
  await page.screenshot({ path: path.join(SHOTS, `${label}-meter-full.png`), fullPage: true });
}

// ---------- main ----------
const sink = { errors: [], warnings: [], workers: new Set() };

const TO_MAKE = [...new Set([...CASES, ...(METER ? METER_SONGS : [])])];
console.log(`Generando ${TO_MAKE.length} canciones de prueba en ${SONGS}…`);
const gen = spawnSync(process.execPath, [path.join(ROOT, 'tools/make-test-songs.js'), SONGS, ...TO_MAKE], { encoding: 'utf8' });
if (gen.status !== 0) {
  console.error(gen.stdout, gen.stderr);
  throw new Error('No se pudieron generar las canciones de prueba');
}

const { chromium } = await loadPlaywright();
const server = await startServer();
const APP = `http://127.0.0.1:${server.address().port}${BASE}`;
const browser = await chromium.launch();
try {
  // Escritorio oscuro: todas las canciones en la misma página (también prueba cargar una canción tras otra)
  const { ctx, page } = await openApp(browser, APP, { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }, 'escritorio', sink);
  for (let i = 0; i < CASES.length; i++) {
    const name = CASES[i];
    if (i === 0) {
      // captura del estado «listo» (antes de tocar nada)
      await loadSong(page, path.join(SONGS, `${name}.wav`));
      await page.screenshot({ path: path.join(SHOTS, 'desktop-1280-dark-ready.png') });
      await page.screenshot({ path: path.join(SHOTS, 'desktop-1280-dark-full.png'), fullPage: true });
    }
    await runSong(page, name, { transport: i === 0, mp3: i === 0 });
  }
  if (METER) {
    for (let i = 0; i < METER_SONGS.length; i++) {
      await runMeterSong(page, METER_SONGS[i], { mp3: i === 0, ui: i === 0, control: i === 0 });
      if (i === 0) await meterShots(page, 'desktop-1280-dark');
    }
  }
  await robustnessChecks(page, 'escritorio');
  await ctx.close();

  // Escritorio claro
  {
    const { ctx: c2, page: p2 } = await openApp(browser, APP, { viewport: { width: 1280, height: 800 }, colorScheme: 'light' }, 'escritorio claro', sink);
    const r = await loadSong(p2, path.join(SONGS, `${CASES[0]}.wav`));
    check('escritorio claro: llega a «listo»', r.phase === 'ready', `${r.ms} ms`);
    await p2.screenshot({ path: path.join(SHOTS, 'desktop-1280-light-ready.png') });
    await p2.screenshot({ path: path.join(SHOTS, 'desktop-1280-light-full.png'), fullPage: true });
    if (METER) {
      await setSwitch(p2, 'chk-mode2', true);
      await chooseMeter(p2, METER_CASES[0]);
      await meterShots(p2, 'desktop-1280-light');
    }
    await c2.close();
  }

  // Móvil: el nombre de archivo más largo es el peor caso para el desbordamiento horizontal
  const longest = [...CASES].sort((a, b) => b.length - a.length)[0];
  for (const [w, h, scheme] of [[390, 844, 'dark'], [390, 844, 'light'], [360, 740, 'dark']]) {
    const { ctx: c3, page: p3 } = await openApp(browser, APP,
      { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme }, `móvil ${w}`, sink);
    const r = await loadSong(p3, path.join(SONGS, `${longest}.wav`));
    check(`móvil ${w}×${h} ${scheme}: llega a «listo»`, r.phase === 'ready', `${r.ms} ms`);
    // el aviso «Listo…» no tapa el botón de reproducir ni la onda
    const cover = await p3.evaluate(() => {
      const t = document.getElementById('toast');
      if (t.hidden) return { shown: false, hits: [] };
      const r = t.getBoundingClientRect();
      const hits = ['btn-play', 'wave', 'btn-metro'].filter((id) => {
        const q = document.getElementById(id).getBoundingClientRect();
        return Math.min(r.right, q.right) > Math.max(r.left, q.left) && Math.min(r.bottom, q.bottom) > Math.max(r.top, q.top);
      });
      return { shown: true, pos: t.dataset.pos, hits };
    });
    check(`móvil ${w}×${h} ${scheme}: el aviso «Listo» no tapa reproducir ni la onda`, cover.hits.length === 0,
      cover.shown ? `aviso ${cover.pos}, tapa: ${cover.hits.join(', ') || 'nada'}` : 'aviso ya cerrado');
    const sw = await p3.evaluate(() => document.scrollingElement.scrollWidth);
    check(`móvil ${w}×${h} ${scheme}: sin scroll horizontal`, sw <= w, `scrollWidth ${sw}`);
    if (w === 390 && scheme === 'dark') await touchScrollCheck(c3, p3, `móvil ${w}×${h} ${scheme}`);
    await p3.screenshot({ path: path.join(SHOTS, `mobile-${w}-${scheme}-ready.png`) });
    await p3.screenshot({ path: path.join(SHOTS, `mobile-${w}-${scheme}-full.png`), fullPage: true });
    if (METER) {
      await setSwitch(p3, 'chk-mode2', true);
      await chooseMeter(p3, METER_CASES[3]);   // «Otro» 15/16: el panel más ancho
      const sw2 = await p3.evaluate(() => document.scrollingElement.scrollWidth);
      check(`móvil ${w}×${h} ${scheme}: sin scroll horizontal con «Cambiar el compás» (Otro)`, sw2 <= w, `scrollWidth ${sw2}`);
      await meterShots(p3, `mobile-${w}-${scheme}`);
    }
    await c3.close();
  }
} finally {
  await browser.close();
  server.close();
}

// Rutas relativas bajo el subdirectorio: nada da 404, los workers arrancan y nada se sube
const notFound = served.filter((r) => r.status !== 200 && r.path.startsWith(BASE)).map((r) => r.path);
check('ninguna petición bajo /dj-edit-cutter/ da 404', notFound.length === 0, notFound.join(', '));
const outside = served.filter((r) => !r.path.startsWith(BASE) && r.path !== '/favicon.ico').map((r) => r.path);
check('ninguna petición fuera del subdirectorio (solo rutas relativas)', outside.length === 0, outside.join(', '));
check('solo peticiones GET (la canción no se sube)', served.every((r) => r.method === 'GET'),
  served.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`).join(', '));
const workers = [...sink.workers];
check('el análisis corre en el worker de módulo', workers.some((u) => u.endsWith(`${BASE}js/analysis/worker.js`)), workers.join(', '));
check('el MP3 se codifica en workers (lamejs cargado)', workers.some((u) => u.split('?')[0].endsWith(`${BASE}js/audio/mp3-worker.js`)) &&
  served.some((r) => r.path === `${BASE}vendor/lame.min.js` && r.status === 200));
check('cero errores de consola', sink.errors.length === 0, sink.errors.slice(0, 10).join(' | '));
if (sink.warnings.length) console.log(`avisos de consola (${sink.warnings.length}): ${sink.warnings.slice(0, 10).join(' | ')}`);

console.log('\nDetección por canción (referencia = verdad del generador):');
for (const r of report) {
  console.log(`  ${r.name}${r.hard ? ' [difícil]' : ''}: ${r.bpm || '—'} (ref ${r.gtBpm.toFixed(1)}) · ${r.meter || '—'} (ref ${r.gtMeter}) · ` +
    `${r.bars || '—'} compases (ref ${r.gtBars}) · ${r.conf || r.error || '—'} · corte ${Number.isFinite(r.cutErrMs) ? `${r.cutErrMs.toFixed(1)} ms` : '—'}` +
    ` · fade ${r.fade || '—'} · ${r.loadMs} ms${r.mp3 ? ` · MP3 ${r.mp3}` : ''}`);
}
if (findings.length) {
  console.log('\nHallazgos (casos difíciles, no cuentan como fallo):');
  for (const f of findings) console.log(`  - ${f}`);
}
console.log(`\nCapturas: ${SHOTS}`);
if (KEEP) console.log(`Archivos temporales: ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} comprobaciones correctas`);
process.exit(failed.length ? 1 : 0);
