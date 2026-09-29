#!/usr/bin/env node
// Benchmark de análisis rítmico sobre la suite sintética (con verdad de referencia) y, opcionalmente, clips reales.
//
// Uso:
//   node tools/bench.js --beats <módulo> [--bars <módulo>] [--gt-beats] [--cases a,b] [--real] [--json out.json]
//                       [--long | --no-long] [--onsets] [--no-cache]
// Módulo de beats:   export function trackBeats(features, opts) -> { beats: number[] (s), bpm: number }
// Módulo de compases: export function labelBars(features, beats, opts) -> { beatsPerBar, positions, downbeats, confidence }
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUITE, generateCase } from '../tests/synth/suite.js';
import { readWav } from '../tests/synth/wav-io.js';
import {
  fMeasure, continuity, tempoCheck, lastBarStartFrom, lastBarOk as lastBarOkFn, medianBpm, onsetFMeasure,
} from '../tests/synth/metrics.js';
import { computeFeatures, detectOnsets } from '../js/analysis/features.js';
import { estimateTempo } from '../js/analysis/tempo.js';
import { findMusicBounds, findLastOnset } from '../js/analysis/bounds.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_REAL_DIR = 'tmp/real-audio'; // carpeta local ignorada por git (ver .gitignore)
const LAST_BAR_TOLERANCE = 0.08;

function parseArgs(argv) {
  const a = { cases: null, real: false, gtBeats: false, json: null, long: null, onsets: false, cache: true, beats: null, bars: null, realOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--beats') a.beats = next();
    else if (k === '--bars') a.bars = next();
    else if (k === '--gt-beats') a.gtBeats = true;
    else if (k === '--cases') a.cases = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--real') a.real = true;
    else if (k === '--real-only') { a.real = true; a.realOnly = true; }
    else if (k === '--json') a.json = next();
    else if (k === '--long') a.long = true;
    else if (k === '--no-long') a.long = false;
    else if (k === '--onsets') a.onsets = true;
    else if (k === '--no-cache') a.cache = false;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`Argumento desconocido: ${k}`);
  }
  return a;
}

const HELP = `node tools/bench.js --beats <mod> [--bars <mod>] [--gt-beats] [--cases a,b] [--real|--real-only] [--json out.json]
                    [--long|--no-long] [--onsets] [--no-cache]
  --beats     módulo con trackBeats(features, opts) -> { beats, bpm }   (opcional con --gt-beats)
  --bars      módulo con labelBars(features, beats, opts) -> { beatsPerBar, positions, downbeats, confidence }
  --gt-beats  usa los beats de referencia como entrada de --bars (evalúa compases sin errores del tracker)
  --cases     lista de casos de tests/synth/suite.js (por defecto todos; long_song_4m30 sólo con --long o si se nombra)
  --real      añade los clips reales de $REAL_AUDIO_DIR (referencia madmom, no es verdad manual)
  --onsets    añade la F-measure de detección de notas (detectOnsets vs noteOnsets, ±50 ms)
  --json      guarda resultados por caso y promedios`;

async function loadModule(p, fn) {
  if (!p) return null;
  const mod = await import(pathToFileURL(resolve(process.cwd(), p)).href);
  if (typeof mod[fn] !== 'function') throw new Error(`${p} no exporta ${fn}()`);
  return mod[fn];
}

// ---------------------------------------------------------------- caché de audio sintético
function synthHash() {
  const h = createHash('sha1');
  for (const f of readdirSync(join(ROOT, 'tests/synth')).sort()) {
    if (f.endsWith('.js')) h.update(readFileSync(join(ROOT, 'tests/synth', f)));
  }
  return h.digest('hex').slice(0, 12);
}

function loadCase(name, useCache) {
  const dir = join(tmpdir(), 'dj-edit-cutter-synth-cache');
  const key = `${name}-${synthHash()}`;
  const fAudio = join(dir, `${key}.f32`);
  const fTruth = join(dir, `${key}.json`);
  if (useCache && existsSync(fAudio) && existsSync(fTruth)) {
    const buf = readFileSync(fAudio);
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const meta = JSON.parse(readFileSync(fTruth, 'utf8'));
    return { ...meta, samples, cached: true };
  }
  const c = generateCase(name);
  if (useCache) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fAudio, Buffer.from(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength));
      writeFileSync(fTruth, JSON.stringify({ name: c.name, tags: c.tags, description: c.description, sampleRate: c.sampleRate, truth: c.truth }));
    } catch {
      // sin caché si el disco no deja
    }
  }
  return { ...c, cached: false };
}

function loadReal(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.wav')) continue;
    const name = f.slice(0, -4);
    const refPath = join(dir, `${name}.madmom.beats.json`);
    if (!existsSync(refPath)) continue;
    const ref = JSON.parse(readFileSync(refPath, 'utf8'));
    const { samples, sampleRate } = readWav(join(dir, f), { mono: true });
    const beats = ref.beats;
    const bpb = ref.beatsPerBar || 4;
    const dbTimes = ref.downbeats || [];
    // índices de downbeats sobre los beats de referencia (el más cercano)
    const downbeats = dbTimes.map((t) => {
      let best = 0;
      for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - t) < Math.abs(beats[best] - t)) best = i;
      return best;
    });
    out.push({
      name: `real:${name}`,
      tags: ['real'],
      samples,
      sampleRate,
      truth: {
        beats,
        downbeats,
        beatsPerBar: bpb,
        evalRange: [beats[0] - 0.1, beats[beats.length - 1] + 0.1],
        tempo: { bpm: medianBpm(beats) },
        lastBarStart: null,
        note: name.startsWith('waltz') ? 'madmom etiqueta este vals como 4/4 (probablemente mal): downbeatF/compás poco fiables' : '',
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------- evaluación de un caso
async function runCase(c, { trackBeats, labelBars, gtBeats, onsets }) {
  const { samples, sampleRate, truth } = c;
  const timings = {};
  let t0 = performance.now();
  const features = computeFeatures(samples, sampleRate);
  timings.features = performance.now() - t0;

  t0 = performance.now();
  const bounds = findMusicBounds(samples, sampleRate);
  timings.bounds = performance.now() - t0;

  t0 = performance.now();
  const tempo = estimateTempo(features, { minBpm: 50, maxBpm: 220 });
  timings.tempo = performance.now() - t0;

  const row = { name: c.name, tags: c.tags, duration: samples.length / sampleRate, refBpm: truth.tempo.bpm };
  row.tempoEst = tempo.bpm;
  row.tempoEstCheck = tempoCheck(tempo.bpm, truth.tempo.bpm).label;
  const range = truth.evalRange;

  let beats = null;
  let bpm = null;
  if (gtBeats) {
    beats = truth.beats.slice();
    bpm = truth.tempo.bpm;
  } else if (trackBeats) {
    t0 = performance.now();
    const res = await trackBeats(features, {
      minBpm: 50, maxBpm: 220, musicStart: bounds.musicStart, musicEnd: bounds.musicEnd, samples, sampleRate, tempo,
    });
    timings.beats = performance.now() - t0;
    beats = Array.from(res.beats || []);
    bpm = res.bpm;
  }
  if (beats) {
    const fm = fMeasure(beats, truth.beats, { range });
    const cont = continuity(beats, truth.beats, { range });
    row.beatF = fm.f;
    row.beatP = fm.precision;
    row.beatR = fm.recall;
    row.cmlt = cont.cmlt;
    row.amlt = cont.amlt;
    row.bpm = bpm;
    const tc = tempoCheck(bpm, truth.tempo.bpm);
    row.tempoOk = tc.ok;
    row.tempoLabel = tc.label;
    row.nBeats = beats.length;
  }

  t0 = performance.now();
  const lastOnset = findLastOnset(features, bounds.musicEnd);
  timings.lastOnset = performance.now() - t0;
  row.lastOnset = lastOnset;
  if (truth.lastOnset != null) row.lastOnsetErr = lastOnset - truth.lastOnset;

  if (labelBars && beats && beats.length) {
    t0 = performance.now();
    const bars = await labelBars(features, beats, {
      beatsPerBar: 'auto', forcedDownbeats: [], musicStart: bounds.musicStart, musicEnd: bounds.musicEnd, samples, sampleRate, bpm,
    });
    timings.bars = performance.now() - t0;
    const dbIdx = Array.from(bars.downbeats || []);
    const dbTimes = dbIdx.map((i) => beats[i]);
    const refDb = truth.downbeats.map((i) => truth.beats[i]);
    row.beatsPerBar = bars.beatsPerBar;
    row.meterOk = bars.beatsPerBar === truth.beatsPerBar;
    row.downbeatF = fMeasure(dbTimes, refDb, { range }).f;
    row.barsConfidence = bars.confidence;
    if (truth.lastBarStart != null) {
      const start = lastBarStartFrom(beats, dbIdx, lastOnset, LAST_BAR_TOLERANCE);
      row.lastBarStart = start;
      row.lastBarOk = lastBarOkFn(start, truth);
      row.lastBarAmbiguous = !!truth.lastBarAmbiguous;
    }
  }
  if (onsets && truth.noteOnsets) {
    const det = detectOnsets(features);
    const r = onsetFMeasure(det, truth.noteOnsets);
    row.onsetF = r.f;
  }
  row.boundsErr = truth.musicEnd != null ? { start: bounds.musicStart - truth.musicStart, end: bounds.musicEnd - truth.musicEnd } : null;
  row.timings = timings;
  row.totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
  return row;
}

// ---------------------------------------------------------------- impresión
const f3 = (x) => (x == null || Number.isNaN(x) ? '  -  ' : x.toFixed(3));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function printTable(rows, opts) {
  const cols = [
    ['caso', 34, (r) => r.name],
    ['ref', 6, (r) => (r.refBpm ? r.refBpm.toFixed(1) : '-')],
    ['T.est', 11, (r) => `${r.tempoEst.toFixed(1)} ${r.tempoEstCheck === 'ok' ? '' : r.tempoEstCheck}`.trim()],
  ];
  if (!opts.gtBeats && opts.hasBeats) {
    cols.push(['bpm', 11, (r) => (r.bpm ? `${r.bpm.toFixed(1)} ${r.tempoLabel === 'ok' ? '' : r.tempoLabel}`.trim() : '-')]);
    cols.push(['beatF', 6, (r) => f3(r.beatF)]);
    cols.push(['CMLt', 6, (r) => f3(r.cmlt)]);
    cols.push(['AMLt', 6, (r) => f3(r.amlt)]);
  }
  if (opts.hasBars) {
    cols.push(['bpb', 4, (r) => (r.beatsPerBar ? `${r.beatsPerBar}${r.meterOk ? '' : '!'}` : '-')]);
    cols.push(['dbF', 6, (r) => f3(r.downbeatF)]);
    cols.push(['lastBar', 8, (r) => (r.lastBarOk == null ? '-' : `${r.lastBarOk ? 'ok' : 'FALLA'}${r.lastBarAmbiguous ? '*' : ''}`)]);
  }
  cols.push(['lastOn', 7, (r) => (r.lastOnsetErr == null ? '-' : `${(r.lastOnsetErr * 1000).toFixed(0)}ms`)]);
  if (opts.onsets) cols.push(['onsetF', 6, (r) => f3(r.onsetF)]);
  cols.push(['ms', 12, (r) => `${r.totalMs.toFixed(0)} (${r.timings.features.toFixed(0)}f)`]);
  const header = cols.map(([h, w], i) => (i === 0 ? pad(h, w) : lpad(h, w))).join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    if (r.error) console.log(`${pad(r.name, 34)} ERROR: ${r.error}`);
    else console.log(cols.map(([, w, fn], i) => (i === 0 ? pad(fn(r), w) : lpad(fn(r), w))).join(' '));
  }
}

function mean(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function rate(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => typeof x === 'boolean');
  return v.length ? { ok: v.filter(Boolean).length, n: v.length } : null;
}

function summarize(rows) {
  const groups = {
    band: rows.filter((r) => r.tags.includes('band')),
    nodrums: rows.filter((r) => r.tags.includes('nodrums')),
    synth: rows.filter((r) => !r.tags.includes('real')),
    real: rows.filter((r) => r.tags.includes('real')),
  };
  const out = {};
  for (const [g, rs] of Object.entries(groups)) {
    if (!rs.length) continue;
    out[g] = {
      n: rs.length,
      errors: rs.filter((r) => r.error).length,
      beatF: mean(rs, 'beatF'),
      cmlt: mean(rs, 'cmlt'),
      amlt: mean(rs, 'amlt'),
      tempoOk: rate(rs, 'tempoOk'),
      tempoEstOk: { ok: rs.filter((r) => r.tempoEstCheck === 'ok').length, n: rs.length },
      downbeatF: mean(rs, 'downbeatF'),
      meterOk: rate(rs, 'meterOk'),
      lastBarOk: rate(rs, 'lastBarOk'),
      onsetF: mean(rs, 'onsetF'),
      msPerMinute: rs.reduce((a, r) => a + r.totalMs, 0) / (rs.reduce((a, r) => a + r.duration, 0) / 60),
      featuresMsPerMinute: rs.reduce((a, r) => a + r.timings.features, 0) / (rs.reduce((a, r) => a + r.duration, 0) / 60),
    };
  }
  return out;
}

function printSummary(sum) {
  console.log('');
  const fr = (x) => (x ? `${x.ok}/${x.n}` : '-');
  for (const [g, s] of Object.entries(sum)) {
    console.log(
      `${pad(g, 8)} n=${lpad(s.n, 2)}  beatF ${f3(s.beatF)}  CMLt ${f3(s.cmlt)}  AMLt ${f3(s.amlt)}  tempo ${fr(s.tempoOk)}  T.est ${fr(s.tempoEstOk)}` +
        `  dbF ${f3(s.downbeatF)}  meter ${fr(s.meterOk)}  lastBar ${fr(s.lastBarOk)}${s.onsetF != null ? `  onsetF ${f3(s.onsetF)}` : ''}` +
        `  ${s.msPerMinute.toFixed(0)} ms/min (features ${s.featuresMsPerMinute.toFixed(0)})${s.errors ? `  ERRORES ${s.errors}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const trackBeats = await loadModule(args.beats, 'trackBeats');
  const labelBars = await loadModule(args.bars, 'labelBars');
  if (!trackBeats && !args.gtBeats && !labelBars) console.log('(sin --beats ni --bars: sólo features, tempo y límites)');

  let names = SUITE.map((c) => c.name);
  if (args.cases) {
    for (const n of args.cases) if (!names.includes(n)) throw new Error(`Caso desconocido: ${n}. Casos: ${names.join(', ')}`);
    names = args.cases;
  } else if (args.long !== true) {
    names = names.filter((n) => !SUITE.find((c) => c.name === n).tags.includes('long'));
  }
  if (args.realOnly) names = [];
  const t0 = performance.now();
  const rows = [];
  const safeRun = async (c, o) => {
    try {
      return await runCase(c, o);
    } catch (e) {
      console.error(`ERROR en ${c.name}: ${e.stack || e}`);
      return { name: c.name, tags: c.tags, error: String(e && e.message ? e.message : e), duration: c.samples.length / c.sampleRate, timings: { features: 0 }, totalMs: 0, refBpm: c.truth.tempo.bpm, tempoEst: NaN, tempoEstCheck: 'error' };
    }
  };
  for (const n of names) {
    const c = loadCase(n, args.cache);
    rows.push(await safeRun(c, { trackBeats, labelBars, gtBeats: args.gtBeats, onsets: args.onsets }));
  }
  if (args.real) {
    const dir = process.env.REAL_AUDIO_DIR || DEFAULT_REAL_DIR;
    const real = loadReal(dir);
    if (!real.length) console.log(`(no hay clips reales en ${dir})`);
    for (const c of real) rows.push(await safeRun(c, { trackBeats, labelBars, gtBeats: args.gtBeats, onsets: false }));
  }
  const opts = { gtBeats: args.gtBeats, hasBeats: !!trackBeats || args.gtBeats, hasBars: !!labelBars, onsets: args.onsets };
  console.log(`beats: ${args.gtBeats ? 'GT' : args.beats || '-'}   bars: ${args.bars || '-'}`);
  printTable(rows, opts);
  const sum = summarize(rows);
  printSummary(sum);
  console.log(`\n* último compás ambiguo (fade out): se acepta cualquier compás en la zona de -18..-36 dB del fade.`);
  if (rows.some((r) => r.name.startsWith('real:waltz'))) console.log('  real:waltz_3-4: la referencia madmom lo marca 4/4 (probablemente mal).');
  console.log(`tiempo total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ args, cases: rows, summary: sum }, null, 1));
    console.log(`JSON: ${args.json}`);
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
