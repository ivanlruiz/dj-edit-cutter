// Datos golden del análisis para los tests de paridad del port a C++ (plugin/tests/core/analysis_parity_test.cpp).
//
//   node plugin/tools/golden-analysis.mjs <directorio de salida>
//
// Ejecuta la implementación WEB (js/analysis/*, js/audio/decode.js) sobre canciones sintéticas deterministas
// (tests/synth) y escribe en <salida>/analysis/:
//   index.json            lista de casos (análisis, sesiones retrack/relabel, remuestreo, cadena completa)
//   <caso>.f32            audio mono float32 little-endian (22050 Hz salvo que el caso diga otra cosa)
//   <caso>.json           AnalysisResult de analyze() (sin timingsMs) y metadatos
//   session_<caso>.json   secuencia de retrack / relabel sobre una sesión y el resultado de cada paso
//   rs_<caso>_in.f32 / _out.f32   entrada (canales planos) y salida de toAnalysisMono()
//   pipe_<caso>_in.f32    estéreo plano a 44.1/48 kHz → toAnalysisMono → analyze (resultado en pipe_<caso>.json)
// Nada de esto se versiona (va al directorio de build).
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AnalysisSession, analyze } from '../../js/analysis/analyze.js';
import { toAnalysisMono, resample } from '../../js/audio/decode.js';
import { SUITE, generateCase } from '../../tests/synth/suite.js';
import { generateSong } from '../../tests/synth/generate.js';
import { brickwallLimit, hardClip } from '../../tests/synth/mastering.js';
import { addApplause } from '../../tests/synth/live.js';
import { Rng } from '../../tests/synth/prng.js';

const SR = 22050;
const outRoot = process.argv[2];
if (!outRoot) {
  console.error('uso: node plugin/tools/golden-analysis.mjs <directorio de salida>');
  process.exit(2);
}
const OUT = path.join(outRoot, 'analysis');
fs.mkdirSync(OUT, { recursive: true });

function writeF32(name, arrays) {
  const list = Array.isArray(arrays) ? arrays : [arrays];
  const bufs = list.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  fs.writeFileSync(path.join(OUT, name), Buffer.concat(bufs));
}

function writeJson(name, obj) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
}

/** AnalysisResult sin timingsMs (no son deterministas). */
function strip(r) {
  const { timingsMs, ...rest } = r;
  return rest;
}

const index = { version: 1, sampleRate: SR, cases: [], sessions: [], resample: [], pipeline: [] };

function addCase(name, samples, sampleRate = SR, extra = {}) {
  const t0 = performance.now();
  const r = analyze(samples, sampleRate);
  const ms = performance.now() - t0;
  writeF32(`${name}.f32`, samples);
  writeJson(`${name}.json`, { name, sampleRate, n: samples.length, jsMs: Math.round(ms), result: strip(r), ...extra });
  index.cases.push({ name, file: `${name}.f32`, json: `${name}.json`, sampleRate, n: samples.length });
  return r;
}

// ------------------------------------------------------------------ suite sintética completa + variantes

const songs = new Map();
for (const c of SUITE) {
  const g = generateCase(c.name);
  songs.set(c.name, g);
  addCase(c.name, g.samples, SR, { tags: c.tags });
}

const rock = songs.get('rock_steady_120');
const waltz = songs.get('waltz_piano_3_4_nodrums');
addCase('rock_steady_120__limit12', brickwallLimit(rock.samples, SR, { thresholdDb: -12 }), SR, { variant: 'limit12' });
addCase('waltz_piano_3_4_nodrums__clip8', hardClip(waltz.samples, 8), SR, { variant: 'clip8' });
addCase('rock_steady_120__applause', addApplause(rock.samples, SR, rock.truth), SR, { variant: 'applause' });
addCase('live_rock_drift_128__applause_m8', addApplause(songs.get('live_rock_drift_128').samples, SR,
  songs.get('live_rock_drift_128').truth, { applauseDb: -8, delaySec: 0.3 }), SR, { variant: 'applause -8 dB' });

// ------------------------------------------------------------------ bordes

const shortRock = generateSong({ seed: 7, style: 'rock', bpm: 118, bars: 12, jitterMs: 6, ending: { type: 'ring', ringSec: [1.5, 2] } });
addCase('edge_empty', new Float32Array(0));
addCase('edge_tiny', new Float32Array(10).fill(0.1));
addCase('edge_silence_5s', new Float32Array(5 * SR));
addCase('edge_short_1s', shortRock.samples.slice(2 * SR, 3 * SR));
addCase('edge_short_2_5s', shortRock.samples.slice(2 * SR, Math.round(4.5 * SR)));
{
  const x = new Float32Array(shortRock.samples.length + 6 * SR);
  x.set(shortRock.samples);
  for (let i = 0; i < x.length; i++) x[i] += 0.3;
  addCase('edge_dc', x);
}
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  addCase('edge_noise_10s', Float32Array.from({ length: 10 * SR }, () => 0.3 * rnd()));
}
{
  let peak = 0;
  for (const v of shortRock.samples) peak = Math.max(peak, Math.abs(v));
  addCase('edge_clip4', Float32Array.from(shortRock.samples, (v) => Math.max(-1, Math.min(1, (4 * v) / peak))));
  addCase('edge_quiet_m60', Float32Array.from(shortRock.samples, (v) => v * 0.001));
}
{
  const x = new Float32Array(10 * SR).fill(0.5); // DC puro
  addCase('edge_dc_only', x);
}
{
  // entrada a 44.1 kHz (remuestreo lineal de respaldo de prepareSamples)
  const up = new Float32Array(shortRock.samples.length * 2);
  for (let i = 0; i < up.length; i++) up[i] = shortRock.samples[Math.min(shortRock.samples.length - 1, i >> 1)];
  addCase('edge_rate44100', up, 44100);
}

// ------------------------------------------------------------------ sesiones: retrack / relabel

function session(name, samples, plan) {
  const s = new AnalysisSession(samples, SR);
  const first = strip(s.run());
  const steps = [];
  for (const step of plan(first)) {
    let r;
    if (step.op === 'retrack') {
      const opts = step.bpmHint > 0 ? { bpmHint: step.bpmHint, strict: !!step.strict } : {};
      r = s.retrack(opts);
    } else {
      r = s.relabel({ beatsPerBar: step.beatsPerBar > 0 ? step.beatsPerBar : 'auto', forcedDownbeats: step.forced });
    }
    steps.push({ ...step, result: strip(r) });
  }
  writeJson(`session_${name}.json`, { name, file: `${name}.f32`, first, steps });
  index.sessions.push({ name, file: `${name}.f32`, json: `session_${name}.json`, n: samples.length });
}

session('rock_steady_120', rock.samples, (first) => {
  const d = first.downbeats[Math.floor(first.downbeats.length / 2)];
  const plan = [
    { op: 'relabel', beatsPerBar: 0, forced: [d + 1] }, // "Mover el 1 ▶"
    { op: 'retrack', bpmHint: first.bpm * 2, strict: true }, // Tempo ×2 (el "1" forzado se conserva por tiempo)
    { op: 'retrack', bpmHint: first.bpm / 2, strict: true }, // Tempo ÷2
    { op: 'relabel', beatsPerBar: 3, forced: [] }, // compás manual
    { op: 'retrack', bpmHint: 0 }, // restablecer el tempo
    { op: 'retrack', bpmHint: 100, strict: false }, // tempo indicado sin strict
    { op: 'retrack', bpmHint: 0 },
  ];
  if (first.tailBeatsFrom > 0) plan.push({ op: 'relabel', beatsPerBar: 0, forced: [first.tailBeatsFrom + 1] }); // "1" en la cola
  plan.push({ op: 'relabel', beatsPerBar: 0, forced: [] });
  return plan;
});

session('pad_vocal_only_80_nodrums', songs.get('pad_vocal_only_80_nodrums').samples, (first) => [
  { op: 'retrack', bpmHint: first.bpm / 2, strict: true },
  { op: 'retrack', bpmHint: first.bpm * 2, strict: true },
  { op: 'retrack', bpmHint: 0 },
]);

session('waltz_piano_3_4_nodrums', waltz.samples, (first) => [
  { op: 'relabel', beatsPerBar: 4, forced: [] },
  { op: 'relabel', beatsPerBar: 0, forced: [first.downbeats[3] + 1, first.downbeats[10]] }, // forzados incompatibles
  { op: 'retrack', bpmHint: first.bpm * 2, strict: true },
]);

// ------------------------------------------------------------------ toAnalysisMono (remuestreo + mezcla)

/** Señal de prueba determinista: tonos (incluidos > 11 kHz, que el filtro debe quitar), ruido y clics. */
function testSignal(rate, seconds, extra, seed, gain = 1) {
  const n = Math.round(rate * seconds) + extra;
  const rng = new Rng(seed);
  const x = new Float32Array(n);
  const tones = [[110, 0.2], [440, 0.15], [1000, 0.1], [5000, 0.05], [9500, 0.05], [12000, 0.05], [15000, 0.05], [19000, 0.03]];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const [f, a] of tones) v += a * Math.sin(2 * Math.PI * f * t + f * 0.001);
    v += 0.05 * (rng.next() * 2 - 1);
    if (i % Math.round(rate * 0.5) < 20) v += 0.6 * (1 - (i % Math.round(rate * 0.5)) / 20);
    x[i] = v * gain;
  }
  return x;
}

async function addResample(name, rate, chans) {
  const n = chans[0].length;
  const buffer = { numberOfChannels: chans.length, sampleRate: rate, length: n, getChannelData: (c) => chans[c] };
  const out = await toAnalysisMono(buffer, SR);
  writeF32(`rs_${name}_in.f32`, chans);
  writeF32(`rs_${name}_out.f32`, out);
  index.resample.push({ name, rate, channels: chans.length, n, input: `rs_${name}_in.f32`, output: `rs_${name}_out.f32`, outN: out.length });
}

await addResample('stereo44100', 44100, [testSignal(44100, 12, 7, 11), testSignal(44100, 12, 7, 12, 0.7)]);
await addResample('stereo48000', 48000, [testSignal(48000, 12, 3, 21), testSignal(48000, 12, 3, 22, 0.8)]);
{
  const l = testSignal(48000, 6, 1, 31);
  const r = Float32Array.from(l, (v) => -v); // contrafase: la mezcla promedio se anula
  await addResample('antiphase48000', 48000, [l, r]);
}
await addResample('mono96000', 96000, [testSignal(96000, 4, 5, 41)]);
await addResample('three88200', 88200, [testSignal(88200, 3, 0, 51), testSignal(88200, 3, 0, 52), testSignal(88200, 3, 0, 53)]);
await addResample('stereo22050', 22050, [testSignal(22050, 3, 0, 61), testSignal(22050, 3, 0, 62)]);
await addResample('stereo16000', 16000, [testSignal(16000, 5, 9, 71), testSignal(16000, 5, 9, 72)]); // sube a 22050

// ------------------------------------------------------------------ cadena completa: estéreo del host → mono → análisis

async function addPipeline(name, song, rate, seed) {
  const up = resample(song.samples, SR, rate);
  const rng = new Rng(seed);
  const r = Float32Array.from(up, (v) => 0.8 * v + 0.002 * (rng.next() * 2 - 1));
  const chans = [up, r];
  const buffer = { numberOfChannels: 2, sampleRate: rate, length: up.length, getChannelData: (c) => chans[c] };
  const mono = await toAnalysisMono(buffer, SR);
  const t0 = performance.now();
  const res = analyze(mono, SR);
  const ms = performance.now() - t0;
  writeF32(`pipe_${name}_in.f32`, chans);
  writeF32(`pipe_${name}_mono.f32`, mono);
  writeJson(`pipe_${name}.json`, { name, rate, n: up.length, monoN: mono.length, jsMs: Math.round(ms), result: strip(res) });
  index.pipeline.push({ name, rate, channels: 2, n: up.length, input: `pipe_${name}_in.f32`, mono: `pipe_${name}_mono.f32`, monoN: mono.length, json: `pipe_${name}.json` });
}

await addPipeline('rock_steady_120_48k', rock, 48000, 81);
await addPipeline('live_rock_drift_128_44k', songs.get('live_rock_drift_128'), 44100, 82);

writeJson('index.json', index);
console.log(`golden-analysis: ${index.cases.length} casos, ${index.sessions.length} sesiones, ${index.resample.length} remuestreos, ${index.pipeline.length} cadenas → ${OUT}`);
