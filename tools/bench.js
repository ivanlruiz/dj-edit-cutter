#!/usr/bin/env node
// Benchmark de análisis rítmico sobre la suite sintética (con verdad de referencia) y, opcionalmente, clips reales.
//
// Uso:
//   node tools/bench.js --analyze [--sets suite,stress,extra] [--variants none,limit12,clip4,clip8,applause] [--cases a,b]
//                       [--real | --real-only] [--long] [--json out.json] [--no-cache] [--detail]
//   node tools/bench.js --beats <módulo> [--bars <módulo>] [--gt-beats] [--cases a,b] [--sets ...] [--variants ...]
//                       [--real] [--json out.json] [--long | --no-long] [--onsets] [--no-cache]
// --analyze: el pipeline COMPLETO de la app (analyze(): preparación, características, límites, tempo, beats + afinado,
//            compases) y la comprobación del corte con js/core/bars.js: ¿cutForBarsRemoved(result, n) para n = 1, 2, 4
//            cae a menos de 70 ms del downbeat de la verdad?
// Módulo de beats:   export function trackBeats(features, opts) -> { beats: number[] (s), bpm: number }
// Módulo de compases: export function labelBars(features, beats, opts) -> { beatsPerBar, positions, downbeats, confidence }
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUITE, generateCase } from '../tests/synth/suite.js';
import { SETS, generateSetCase } from '../tests/synth/sets.js';
import { MASTERING_VARIANTS } from '../tests/synth/mastering.js';
import { LIVE_VARIANTS } from '../tests/synth/live.js';
import { readWav } from '../tests/synth/wav-io.js';
import {
  fMeasure, continuity, tempoCheck, lastBarStartFrom, lastBarOk as lastBarOkFn, medianBpm, onsetFMeasure,
} from '../tests/synth/metrics.js';
import { computeFeatures, detectOnsets } from '../js/analysis/features.js';
import { estimateTempo } from '../js/analysis/tempo.js';
import { findMusicBounds, findLastOnset } from '../js/analysis/bounds.js';
import { analyze } from '../js/analysis/analyze.js';
import { getBars, findLastBarIndex, cutForBarsRemoved } from '../js/core/bars.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_REAL_DIR = 'tmp/real-audio'; // relativo a la raíz del repo; carpeta local ignorada por git (ver .gitignore)
const LAST_BAR_TOLERANCE = 0.08;
const CUT_BARS = [1, 2, 4];
const CUT_WINDOW = 0.07;
const SET_NAMES = ['suite', ...Object.keys(SETS)];
// variantes del audio: masterización (mismo largo) y directo (aplausos tras el golpe final)
const VARIANTS = { ...MASTERING_VARIANTS, ...LIVE_VARIANTS };

function parseArgs(argv) {
  const a = {
    cases: null, real: false, gtBeats: false, json: null, long: null, onsets: false, cache: true, beats: null, bars: null,
    realOnly: false, analyze: false, sets: ['suite'], variants: ['none'], detail: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    const list = () => String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (k === '--beats') a.beats = next();
    else if (k === '--bars') a.bars = next();
    else if (k === '--analyze') a.analyze = true;
    else if (k === '--gt-beats') a.gtBeats = true;
    else if (k === '--cases') a.cases = list();
    else if (k === '--sets') a.sets = list();
    else if (k === '--variants') a.variants = list();
    else if (k === '--real') a.real = true;
    else if (k === '--real-only') { a.real = true; a.realOnly = true; }
    else if (k === '--json') a.json = next();
    else if (k === '--long') a.long = true;
    else if (k === '--no-long') a.long = false;
    else if (k === '--onsets') a.onsets = true;
    else if (k === '--no-cache') a.cache = false;
    else if (k === '--detail') a.detail = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`Argumento desconocido: ${k}`);
  }
  for (const s of a.sets) if (!SET_NAMES.includes(s)) throw new Error(`Conjunto desconocido: ${s}. Conjuntos: ${SET_NAMES.join(', ')}`);
  for (const v of a.variants) if (v !== 'none' && !VARIANTS[v]) throw new Error(`Variante desconocida: ${v}. Variantes: none, ${Object.keys(VARIANTS).join(', ')}`);
  return a;
}

const HELP = `node tools/bench.js --analyze [--sets suite,stress,extra] [--variants none,limit12,clip4,clip8,applause] [--cases a,b]
                    [--real|--real-only] [--long] [--json out.json] [--no-cache] [--detail]
node tools/bench.js --beats <mod> [--bars <mod>] [--gt-beats] [--cases a,b] [--sets ...] [--variants ...]
                    [--real|--real-only] [--json out.json] [--long|--no-long] [--onsets] [--no-cache]
  --analyze   pipeline completo (analyze() + bars.js): beats, tempo, compás, último compás, corte de 1/2/4 compases,
              último onset y cola extrapolada (tailBeatsFrom)
  --beats     módulo con trackBeats(features, opts) -> { beats, bpm }   (opcional con --gt-beats)
  --bars      módulo con labelBars(features, beats, opts) -> { beatsPerBar, positions, downbeats, confidence }
  --gt-beats  usa los beats de referencia como entrada de --bars (evalúa compases sin errores del tracker)
  --sets      conjuntos: suite (tests/synth/suite.js), stress y extra (tests/synth/sets.js). Por defecto: suite
  --variants  variante del audio: none, ${Object.keys(MASTERING_VARIANTS).join(', ')} (masterización, tests/synth/mastering.js),
              ${Object.keys(LIVE_VARIANTS).join(', ')} (directo, tests/synth/live.js). Por defecto: none. En un fade out con variante la
              zona ambigua cambia: no cuenta para último compás/corte
  --cases     lista de casos (por defecto todos los de los conjuntos; long_song_4m30 sólo con --long o si se nombra)
  --real      añade los clips reales de $REAL_AUDIO_DIR (por defecto ${DEFAULT_REAL_DIR}, relativo a la raíz del repo):
              <nombre>.wav + <nombre>.madmom.beats.json (referencia madmom, no es verdad manual)
  --onsets    añade la F-measure de detección de notas (detectOnsets vs noteOnsets, ±50 ms)
  --json      guarda resultados por caso y promedios
  --detail    (--analyze) una línea por caso`;

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

function loadCase(set, name, useCache) {
  const dir = join(tmpdir(), 'dj-edit-cutter-synth-cache');
  const key = `${set === 'suite' ? '' : `${set}-`}${name}-${synthHash()}`;
  const fAudio = join(dir, `${key}.f32`);
  const fTruth = join(dir, `${key}.json`);
  if (useCache && existsSync(fAudio) && existsSync(fTruth)) {
    const buf = readFileSync(fAudio);
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const meta = JSON.parse(readFileSync(fTruth, 'utf8'));
    return { ...meta, set, samples, cached: true };
  }
  const c = set === 'suite' ? generateCase(name) : generateSetCase(set, name);
  if (useCache) {
    try {
      mkdirSync(dir, { recursive: true });
      // escritura atómica: otro proceso puede estar leyendo la misma caché
      writeFileSync(`${fAudio}.${process.pid}`, Buffer.from(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength));
      renameSync(`${fAudio}.${process.pid}`, fAudio);
      writeFileSync(`${fTruth}.${process.pid}`, JSON.stringify({ name: c.name, tags: c.tags, description: c.description, sampleRate: c.sampleRate, truth: c.truth }));
      renameSync(`${fTruth}.${process.pid}`, fTruth);
    } catch {
      // sin caché si el disco no deja
    }
  }
  return { ...c, set, cached: false };
}

function realDir() {
  const d = process.env.REAL_AUDIO_DIR || DEFAULT_REAL_DIR;
  return isAbsolute(d) ? d : resolve(ROOT, d);
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
      set: 'real',
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

/** Audio del caso con la variante aplicada (sin copiar si es 'none'). */
function withVariant(c, variant) {
  if (variant === 'none') return c;
  return { ...c, samples: VARIANTS[variant].apply(c.samples, c.sampleRate, c.truth) };
}

// ---------------------------------------------------------------- evaluación de un caso (piezas sueltas)
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

  const row = { name: c.name, set: c.set, variant: c.variant, tags: c.tags, duration: samples.length / sampleRate, refBpm: truth.tempo.bpm };
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
  const fadeMastered = truth.ending === 'fadeout' && c.variant && c.variant !== 'none';
  if (truth.lastOnset != null && !fadeMastered) row.lastOnsetErr = lastOnset - truth.lastOnset;

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
    if (truth.lastBarStart != null && !fadeMastered) {
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

// ---------------------------------------------------------------- evaluación de un caso (pipeline completo)
/** Downbeats de la verdad donde tendría que caer el corte de n compases (uno por alternativa del último compás). */
function gtCutTimes(truth, n) {
  const db = truth.downbeats.map((i) => truth.beats[i]);
  const alts = truth.lastBarAlternatives && truth.lastBarAlternatives.length ? truth.lastBarAlternatives : [truth.lastBarStart];
  const out = [];
  for (const a of alts) {
    let k = -1;
    for (let i = 0; i < db.length; i++) if (Math.abs(db[i] - a) < CUT_WINDOW) k = i;
    if (k >= 0 && k - n + 1 >= 1) out.push(db[k - n + 1]);
  }
  return out;
}

function runAnalyzeCase(c) {
  const { samples, sampleRate, truth } = c;
  const t0 = performance.now();
  const res = analyze(samples, sampleRate);
  const ms = performance.now() - t0;
  const range = truth.evalRange;
  const row = {
    name: c.name, set: c.set, variant: c.variant, tags: c.tags, duration: samples.length / sampleRate, refBpm: truth.tempo.bpm,
    totalMs: ms, timings: res.timingsMs,
  };
  const fm = fMeasure(res.beats, truth.beats, { range });
  const cont = continuity(res.beats, truth.beats, { range });
  row.beatF = fm.f;
  row.cmlt = cont.cmlt;
  row.amlt = cont.amlt;
  row.bpm = res.bpm;
  const tc = tempoCheck(res.bpm, truth.tempo.bpm);
  row.tempoOk = tc.ok;
  row.tempoLabel = tc.label;
  row.beatsPerBar = res.beatsPerBar;
  row.meterOk = res.beatsPerBar === truth.beatsPerBar;
  row.downbeatF = fMeasure(res.downbeats.map((i) => res.beats[i]), truth.downbeats.map((i) => truth.beats[i]), { range }).f;
  row.confidence = res.confidence;
  row.nBeats = res.beats.length;
  row.tailBeatsFrom = res.tailBeatsFrom;
  row.lastOnset = res.lastOnset;
  // en un fade out masterizado el limitador sube la cola: la zona ambigua de la verdad (medida sin masterizar) no vale
  const fadeMastered = truth.ending === 'fadeout' && c.variant !== 'none';
  row.fadeMastered = fadeMastered;
  if (truth.lastOnset != null && !fadeMastered) row.lastOnsetErr = res.lastOnset - truth.lastOnset;
  if (truth.musicEnd != null) row.musicEndErr = res.musicEnd - truth.musicEnd;
  if (truth.lastBarStart != null && !fadeMastered) {
    const bars = getBars(res);
    const k = findLastBarIndex(res);
    row.lastBarStart = k >= 0 ? bars[k].start : null;
    row.lastBarOk = k >= 0 && lastBarOkFn(bars[k].start, truth);
    row.lastBarAmbiguous = !!truth.lastBarAmbiguous;
    row.cut = {};
    for (const n of CUT_BARS) {
      const gt = gtCutTimes(truth, n);
      if (!gt.length) continue;
      const cut = cutForBarsRemoved(res, n);
      row.cut[n] = !!cut && gt.some((t) => Math.abs(t - cut.time) <= CUT_WINDOW);
    }
  }
  return row;
}

// ---------------------------------------------------------------- impresión
const f3 = (x) => (x == null || Number.isNaN(x) ? '  -  ' : x.toFixed(3));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const label = (r) => `${r.variant && r.variant !== 'none' ? `${r.variant} ` : ''}${r.set && r.set !== 'suite' && r.set !== 'real' ? `${r.set}:` : ''}${r.name}`;

function printTable(rows, opts) {
  const cols = [
    ['caso', 40, (r) => label(r)],
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
    if (r.error) console.log(`${pad(label(r), 40)} ERROR: ${r.error}`);
    else console.log(cols.map(([, w, fn], i) => (i === 0 ? pad(fn(r), w) : lpad(fn(r), w))).join(' '));
  }
}

function printAnalyzeDetail(rows) {
  const cut = (r) => (r.cut ? CUT_BARS.map((n) => (r.cut[n] == null ? '-' : r.cut[n] ? 'o' : 'x')).join('') : '   ');
  console.log(`${pad('caso', 44)} ${lpad('beatF', 6)} ${lpad('bpm', 12)} bpb ${lpad('dbF', 6)} ${pad('último', 7)} corte ${lpad('lastOn', 8)} ${lpad('conf b/c', 9)} cola ${lpad('ms', 6)}`);
  for (const r of rows) {
    if (r.error) {
      console.log(`${pad(label(r), 44)} ERROR: ${r.error}`);
      continue;
    }
    console.log(`${pad(label(r), 44)} ${f3(r.beatF).padStart(6)} ${lpad(`${r.bpm} ${r.tempoLabel === 'ok' ? '' : r.tempoLabel}`.trim(), 12)} ${lpad(`${r.beatsPerBar}${r.meterOk ? '' : '!'}`, 3)} ${f3(r.downbeatF).padStart(6)} ` +
      `${pad(r.lastBarOk == null ? (r.fadeMastered ? 'fade*' : '-') : r.lastBarOk ? 'ok' : 'FALLA', 7)} ${pad(cut(r), 5)} ${lpad(r.lastOnsetErr == null ? '-' : `${(r.lastOnsetErr * 1000).toFixed(0)}ms`, 8)} ` +
      `${lpad(`${r.confidence.beats.toFixed(2)}/${r.confidence.bars.toFixed(2)}`, 9)} ${lpad(r.tailBeatsFrom < 0 ? '-' : r.nBeats - r.tailBeatsFrom, 4)} ${lpad(r.totalMs.toFixed(0), 6)}`);
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

const GROUPS = {
  band: (r) => r.tags.includes('band'),
  nodrums: (r) => r.tags.includes('nodrums') && !r.tags.includes('hard'),
  hard: (r) => r.tags.includes('hard'),
};

/** Promedios por variante × conjunto × grupo (band / nodrums / hard), total sintético por variante y reales. */
function summarize(rows) {
  const out = {};
  const variants = [...new Set(rows.map((r) => r.variant || 'none'))];
  const sets = [...new Set(rows.map((r) => r.set))].filter((s) => s !== 'real');
  for (const v of variants) {
    const rv = rows.filter((r) => (r.variant || 'none') === v);
    for (const s of sets) {
      for (const [g, fn] of Object.entries(GROUPS)) {
        const rs = rv.filter((r) => r.set === s && fn(r));
        if (rs.length) out[`${v}|${s}|${g}`] = groupStats(rs);
      }
    }
    const synth = rv.filter((r) => r.set !== 'real');
    if (synth.length) out[`${v}|sintéticos`] = groupStats(synth);
    const real = rv.filter((r) => r.set === 'real');
    if (real.length) out[`${v}|reales`] = groupStats(real);
  }
  return out;
}

function groupStats(rs) {
  const ok = rs.filter((r) => !r.error);
  const lo = ok.filter((r) => r.lastOnsetErr != null).map((r) => Math.abs(r.lastOnsetErr)).sort((a, b) => a - b);
  let cutOk = 0;
  let cutN = 0;
  for (const r of ok) if (r.cut) for (const v of Object.values(r.cut)) { cutN++; cutOk += v ? 1 : 0; }
  const dur = ok.reduce((a, r) => a + r.duration, 0) / 60;
  return {
    n: rs.length,
    errors: rs.length - ok.length,
    beatF: mean(ok, 'beatF'),
    cmlt: mean(ok, 'cmlt'),
    amlt: mean(ok, 'amlt'),
    tempoOk: rate(ok, 'tempoOk'),
    tempoEstOk: ok.some((r) => r.tempoEstCheck) ? { ok: ok.filter((r) => r.tempoEstCheck === 'ok').length, n: ok.length } : null,
    downbeatF: mean(ok, 'downbeatF'),
    meterOk: rate(ok, 'meterOk'),
    lastBarOk: rate(ok, 'lastBarOk'),
    cutOk: cutN ? { ok: cutOk, n: cutN } : null,
    lastOnset70: lo.length ? { ok: lo.filter((e) => e <= CUT_WINDOW).length, n: lo.length } : null,
    lastOnsetMedianMs: lo.length ? 1000 * lo[lo.length >> 1] : null,
    onsetF: mean(ok, 'onsetF'),
    msPerMinute: dur > 0 ? ok.reduce((a, r) => a + r.totalMs, 0) / dur : 0,
    featuresMsPerMinute: dur > 0 ? ok.reduce((a, r) => a + ((r.timings && r.timings.features) || 0), 0) / dur : 0,
  };
}

function printSummary(sum) {
  console.log('');
  const fr = (x) => (x ? `${x.ok}/${x.n}` : '-');
  console.log(`${pad('variante|conjunto|grupo', 26)} ${lpad('n', 3)} ${lpad('beatF', 6)} ${lpad('CMLt', 6)} ${lpad('AMLt', 6)} ${lpad('tempo', 7)} ${lpad('T.est', 7)} ${lpad('dbF', 6)} ` +
    `${lpad('compás', 7)} ${lpad('último', 7)} ${lpad('corte', 8)} ${lpad('onset±70', 8)} ${lpad('|err|med', 8)} ${lpad('ms/min', 7)}`);
  for (const [g, s] of Object.entries(sum)) {
    console.log(`${pad(g, 26)} ${lpad(s.n, 3)} ${f3(s.beatF).padStart(6)} ${f3(s.cmlt).padStart(6)} ${f3(s.amlt).padStart(6)} ${lpad(fr(s.tempoOk), 7)} ${lpad(fr(s.tempoEstOk), 7)} ${f3(s.downbeatF).padStart(6)} ` +
      `${lpad(fr(s.meterOk), 7)} ${lpad(fr(s.lastBarOk), 7)} ${lpad(fr(s.cutOk), 8)} ${lpad(fr(s.lastOnset70), 8)} ${lpad(s.lastOnsetMedianMs == null ? '-' : `${s.lastOnsetMedianMs.toFixed(0)}ms`, 8)} ` +
      `${lpad(s.msPerMinute.toFixed(0), 7)}${s.errors ? `  ERRORES ${s.errors}` : ''}`);
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
  if (!args.analyze && !trackBeats && !args.gtBeats && !labelBars) console.log('(sin --analyze, --beats ni --bars: sólo features, tempo y límites)');

  // casos de los conjuntos pedidos
  const all = [];
  for (const s of args.sets) {
    const list = s === 'suite' ? SUITE : SETS[s];
    for (const c of list) all.push({ set: s, name: c.name, tags: c.tags || [] });
  }
  let jobs = all;
  if (args.cases) {
    for (const n of args.cases) if (!all.some((j) => j.name === n)) throw new Error(`Caso desconocido: ${n}. Casos: ${all.map((j) => j.name).join(', ')}`);
    jobs = all.filter((j) => args.cases.includes(j.name));
  } else if (args.long !== true) {
    jobs = all.filter((j) => !j.tags.includes('long'));
  }
  if (args.realOnly) jobs = [];
  const t0 = performance.now();
  const rows = [];
  const safe = async (c, fn) => {
    try {
      return await fn(c);
    } catch (e) {
      console.error(`ERROR en ${label(c)}: ${e.stack || e}`);
      return {
        name: c.name, set: c.set, variant: c.variant, tags: c.tags, error: String(e && e.message ? e.message : e), duration: c.samples.length / c.sampleRate,
        timings: { features: 0 }, totalMs: 0, refBpm: c.truth.tempo.bpm, tempoEst: NaN, tempoEstCheck: 'error',
      };
    }
  };
  const run = (c) => (args.analyze ? runAnalyzeCase(c) : runCase(c, { trackBeats, labelBars, gtBeats: args.gtBeats, onsets: args.onsets }));
  const real = args.real ? loadReal(realDir()) : [];
  if (args.real && !real.length) console.log(`(no hay clips reales en ${realDir()})`);
  for (const variant of args.variants) {
    for (const j of jobs) {
      const c = { ...withVariant(loadCase(j.set, j.name, args.cache), variant), variant };
      rows.push(await safe(c, run));
    }
    for (const r of real) rows.push(await safe({ ...withVariant(r, variant), variant }, run));
  }
  if (args.analyze) {
    console.log(`pipeline completo (analyze + bars.js)   conjuntos: ${args.sets.join(', ')}${args.real ? ' + reales' : ''}   variantes: ${args.variants.join(', ')}`);
    if (args.detail) printAnalyzeDetail(rows);
  } else {
    const opts = { gtBeats: args.gtBeats, hasBeats: !!trackBeats || args.gtBeats, hasBars: !!labelBars, onsets: args.onsets };
    console.log(`beats: ${args.gtBeats ? 'GT' : args.beats || '-'}   bars: ${args.bars || '-'}`);
    printTable(rows, opts);
  }
  const sum = summarize(rows);
  printSummary(sum);
  console.log('\n* último compás ambiguo (fade out): se acepta cualquier compás en la zona de -18..-36 dB del fade.');
  if (args.variants.some((v) => v !== 'none')) console.log('  fade out masterizado (fade*): no cuenta para último compás, corte ni último onset.');
  if (args.analyze) console.log(`  corte: cutForBarsRemoved(result, n) para n = ${CUT_BARS.join(', ')} a menos de ${CUT_WINDOW * 1000} ms del downbeat de la verdad.`);
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
