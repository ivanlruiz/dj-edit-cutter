// Tests de extremo a extremo del análisis (js/analysis/analyze.js, beats.js, worker.js, client.js).
// Umbrales de regresión con margen sobre lo medido (todo es determinista: el generador usa semillas fijas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, AnalysisSession, ANALYSIS_STAGES, computeFeatures, estimateTempo, trackBeats, labelBars, findMusicBounds,
  findLastOnset, refineBeats, remapForced, sanitizeForced, normalizeOptions, normalizeMeter, prepareSamples,
} from '../js/analysis/analyze.js';
import { getBars, findLastBarIndex, cutForBarsRemoved } from '../js/core/bars.js';
import { generateCase } from './synth/suite.js';
import { generateSong } from './synth/generate.js';
import { fMeasure, continuity, tempoCheck, lastBarOk } from './synth/metrics.js';

const SR = 22050;

// ---------------------------------------------------------------- utilidades

const songCache = new Map();
function suiteSong(name) {
  if (!songCache.has(name)) songCache.set(name, generateCase(name));
  return songCache.get(name);
}
function customSong(key, config) {
  if (!songCache.has(key)) songCache.set(key, generateSong(config));
  return songCache.get(key);
}
const sessionCache = new Map();
/** Sesión analizada (compartida entre tests: cada test que la modifica la deja como estaba o usa la suya). */
function sessionFor(name) {
  if (!sessionCache.has(name)) {
    const c = suiteSong(name);
    const s = new AnalysisSession(c.samples, c.sampleRate);
    const first = s.run();
    sessionCache.set(name, { s, first, c });
  }
  return sessionCache.get(name);
}

const beatF = (r, truth) => fMeasure(r.beats, truth.beats, { range: truth.evalRange }).f;
const lastBarStart = (r) => {
  const bars = getBars(r);
  const k = findLastBarIndex(r);
  return k >= 0 ? bars[k].start : null;
};

/** Forma y coherencia del AnalysisResult (SPEC). */
function checkShape(r) {
  const keys = ['duration', 'musicStart', 'musicEnd', 'lastOnset', 'bpm', 'bpmRange', 'beats', 'beatStrength', 'beatsPerBar',
    'meterAuto', 'positions', 'downbeats', 'forcedDownbeats', 'confidence', 'timingsMs'];
  assert.deepEqual(Object.keys(r).sort(), keys.slice().sort(), 'campos del resultado');
  for (const k of ['duration', 'musicStart', 'musicEnd', 'lastOnset', 'bpm']) assert.ok(Number.isFinite(r[k]) && r[k] >= 0, `${k} = ${r[k]}`);
  assert.ok(r.musicStart <= r.musicEnd && r.musicEnd <= r.duration + 1e-6);
  assert.equal(r.bpm, Math.round(r.bpm * 10) / 10, 'bpm redondeado a 0.1');
  assert.ok(Array.isArray(r.bpmRange) && r.bpmRange.length === 2 && r.bpmRange[0] <= r.bpmRange[1]);
  if (r.beats.length >= 2) assert.ok(r.bpmRange[0] <= r.bpm + 1e-9 && r.bpm <= r.bpmRange[1] + 1e-9, `bpm ${r.bpm} fuera de ${r.bpmRange}`);
  for (const k of ['beats', 'beatStrength', 'positions', 'downbeats', 'forcedDownbeats']) assert.ok(Array.isArray(r[k]), `${k} es un Array`);
  const n = r.beats.length;
  assert.equal(r.beatStrength.length, n);
  assert.equal(r.positions.length, n);
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(r.beats[i]));
    if (i) assert.ok(r.beats[i] > r.beats[i - 1], 'beats estrictamente ascendentes');
    assert.ok(r.beatStrength[i] >= 0 && r.beatStrength[i] <= 1);
    assert.ok(Number.isInteger(r.positions[i]) && r.positions[i] >= 0 && r.positions[i] <= r.beatsPerBar);
  }
  if (n) {
    assert.ok(r.beats[0] >= r.musicStart - 1e-9, 'ningún beat antes de musicStart');
    assert.ok(r.beats[n - 1] <= r.musicEnd + 1e-9, 'ningún beat después de musicEnd');
  }
  assert.ok(Number.isInteger(r.beatsPerBar) && r.beatsPerBar >= 2 && r.beatsPerBar <= 7);
  assert.equal(typeof r.meterAuto, 'boolean');
  assert.deepEqual(r.downbeats, r.positions.map((p, i) => (p === 0 ? i : -1)).filter((i) => i >= 0));
  for (const i of r.forcedDownbeats) assert.ok(r.downbeats.includes(i), `el beat forzado ${i} es un "1"`);
  assert.ok(r.confidence.beats >= 0 && r.confidence.beats <= 1 && r.confidence.bars >= 0 && r.confidence.bars <= 1);
  for (const v of Object.values(r.timingsMs)) assert.ok(Number.isFinite(v) && v >= 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, 'serializable a JSON sin pérdidas');
}

// ---------------------------------------------------------------- regresión sobre la suite sintética

// [caso, beatF mínimo, downbeat F mínimo]. Medido: 1.000 / 1.000 en todos.
const REGRESSION = [
  ['rock_steady_120', 0.97, 0.95],
  ['live_rock_drift_128', 0.95, 0.9],
  ['live_band_ritardando_fermata_104', 0.95, 0.9],
  ['pop_fadeout_110', 0.95, 0.9],
  ['anticipated_final_hit_124', 0.95, 0.9],
  ['piano_solo_100_nodrums', 0.9, 0.85],
  ['acoustic_strum_96_nodrums', 0.9, 0.85],
  ['waltz_piano_3_4_nodrums', 0.9, 0.85],
];

for (const [name, minF, minDb] of REGRESSION) {
  test(`analyze(): ${name} — beats, tempo, compás, último compás y confianza`, () => {
    const { first: r, c } = sessionFor(name);
    const T = c.truth;
    checkShape(r);
    const f = beatF(r, T);
    assert.ok(f >= minF, `beat F ${f.toFixed(3)} < ${minF}`);
    assert.equal(tempoCheck(r.bpm, T.tempo.bpm).label, 'ok', `bpm ${r.bpm} vs ${T.tempo.bpm}`);
    assert.equal(r.beatsPerBar, T.beatsPerBar, 'compás');
    assert.equal(r.meterAuto, true);
    const db = fMeasure(r.downbeats.map((i) => r.beats[i]), T.downbeats.map((i) => T.beats[i]), { range: T.evalRange }).f;
    assert.ok(db >= minDb, `downbeat F ${db.toFixed(3)} < ${minDb}`);
    assert.ok(lastBarOk(lastBarStart(r), T), `último compás en ${lastBarStart(r)} (verdad ${T.lastBarStart})`);
    assert.ok(Math.min(r.confidence.beats, r.confidence.bars) >= 0.5, `confianza ${JSON.stringify(r.confidence)}`);
    assert.ok(Math.abs(r.musicEnd - T.musicEnd) < 0.1, `musicEnd ${r.musicEnd} vs ${T.musicEnd}`);
  });
}

test('ritardando de −30 % en los 4 últimos compases + fermata: beats y último compás correctos', () => {
  const c = customSong('rit30', { seed: 501, style: 'rock', bpm: 100, bars: 24, jitterMs: 10, driftPct: 3, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4] } });
  const r = analyze(c.samples, c.sampleRate);
  checkShape(r);
  assert.ok(beatF(r, c.truth) >= 0.95, `beat F ${beatF(r, c.truth)}`);
  assert.ok(lastBarOk(lastBarStart(r), c.truth));
  // el tempo local refleja el ritardando
  assert.ok(r.bpmRange[0] < 0.95 * r.bpm, `rango ${r.bpmRange} con bpm ${r.bpm}`);
  // quitar 1 y 2 compases corta en los downbeats de la verdad
  const gtDb = c.truth.downbeats.map((i) => c.truth.beats[i]);
  const k = gtDb.findIndex((t) => Math.abs(t - c.truth.lastBarStart) < 0.07);
  for (const n of [1, 2]) {
    const cut = cutForBarsRemoved(r, n);
    assert.ok(cut && Math.abs(cut.time - gtDb[k - n + 1]) < 0.07, `corte de ${n} compases en ${cut && cut.time}`);
  }
});

test('pads y voz sin ataques: confianza baja ("revisa la cuadrícula") y ÷2 recupera el pulso', () => {
  const { s, first: r, c } = sessionFor('pad_vocal_only_80_nodrums');
  checkShape(r);
  assert.ok(r.confidence.beats < 0.5, `confianza de beats ${r.confidence.beats}`);
  // el tracker da el doble del tempo real; el usuario pulsa ÷2 (medido: F 1.000)
  const half = s.retrack({ bpmHint: r.bpm / 2, strict: true });
  checkShape(half);
  assert.ok(beatF(half, c.truth) >= 0.8, `beat F tras ÷2 ${beatF(half, c.truth)}`);
  // ×2 sobre material sin pulso no se queda sin cuadrícula
  const dbl = s.retrack({ bpmHint: r.bpm * 2, strict: true });
  checkShape(dbl);
  assert.ok(dbl.beats.length > 100 && dbl.bpm > 250, `×2: ${dbl.beats.length} beats a ${dbl.bpm}`);
  s.retrack({});
});

// ---------------------------------------------------------------- retrack / relabel

test('retrack ×2 / ÷2: tempo forzado, cuadrícula coherente, "1" forzado conservado por tiempo', () => {
  const { s, first, c } = sessionFor('rock_steady_120');
  const d = first.downbeats[Math.floor(first.downbeats.length / 2)];
  const forcedTime = first.beats[d + 1];
  const shifted = s.relabel({ forcedDownbeats: [d + 1] });
  assert.deepEqual(shifted.forcedDownbeats, [d + 1]);

  const dbl = s.retrack({ bpmHint: first.bpm * 2, strict: true });
  checkShape(dbl);
  assert.ok(tempoCheck(dbl.bpm, first.bpm * 2).ok, `×2 da ${dbl.bpm}`);
  assert.ok(continuity(dbl.beats, c.truth.beats, { range: c.truth.evalRange }).amlt >= 0.9);
  assert.equal(dbl.forcedDownbeats.length, 1, 'el "1" forzado sigue existiendo tras ×2');
  assert.ok(Math.abs(dbl.beats[dbl.forcedDownbeats[0]] - forcedTime) < 0.02);

  const half = s.retrack({ bpmHint: first.bpm / 2, strict: true });
  checkShape(half);
  assert.ok(tempoCheck(half.bpm, first.bpm / 2).ok, `÷2 da ${half.bpm}`);
  assert.ok(continuity(half.beats, c.truth.beats, { range: c.truth.evalRange }).amlt >= 0.9);
  for (const i of half.forcedDownbeats) assert.ok(Math.abs(half.beats[i] - forcedTime) < 0.1);

  // sin tempo indicado vuelve a la detección automática (determinista)
  s.relabel({ forcedDownbeats: [] });
  const again = s.retrack({});
  assert.deepEqual(again.beats, first.beats);
  assert.deepEqual(again.downbeats, first.downbeats);
  assert.equal(again.bpm, first.bpm);

  assert.throws(() => s.retrack({ bpmHint: 5000, strict: true }), /fuera de rango/);
  assert.throws(() => s.retrack({ bpmHint: -3 }), /fuera de rango/);
});

test('relabel: "este beat es el 1" desplaza toda la rejilla; compás manual; restablecer', () => {
  const { s, first } = sessionFor('rock_steady_120');
  const d = first.downbeats[Math.floor(first.downbeats.length / 2)];
  const r = s.relabel({ forcedDownbeats: [d + 1] });
  checkShape(r);
  assert.ok(r.downbeats.includes(d + 1) && !r.downbeats.includes(d));
  const shiftedAll = first.downbeats.filter((i) => r.downbeats.includes(i + 1)).length / first.downbeats.length;
  assert.ok(shiftedAll > 0.9, `sólo ${shiftedAll} de los compases se desplazaron`);
  assert.ok(r.confidence.bars >= 0.75, 'con un "1" fijado a mano no se pide revisar los compases');
  assert.equal(r.beatsPerBar, 4);

  // compás manual: se conserva el "1" forzado si no se pasa forcedDownbeats
  const three = s.relabel({ beatsPerBar: 3 });
  checkShape(three);
  assert.equal(three.beatsPerBar, 3);
  assert.equal(three.meterAuto, false);
  assert.deepEqual(three.forcedDownbeats, [d + 1]);
  const threeFree = s.relabel({ forcedDownbeats: [] });
  assert.ok(threeFree.confidence.bars < 0.5, `3/4 sobre un 4/4 debería tener confianza baja: ${threeFree.confidence.bars}`);
  assert.equal(s.relabel({ beatsPerBar: '6' }).beatsPerBar, 6);

  // índices no válidos se ignoran; el eco es la lista usada
  const bad = s.relabel({ beatsPerBar: 'auto', forcedDownbeats: [-1, 2.5, 1e6, 'x', d + 1, d + 1] });
  assert.deepEqual(bad.forcedDownbeats, [d + 1]);

  const reset = s.relabel({ beatsPerBar: 'auto', forcedDownbeats: [] });
  assert.deepEqual(reset.downbeats, first.downbeats);
  assert.equal(reset.meterAuto, true);
  assert.deepEqual(reset.confidence, first.confidence);
});

test('retrack / relabel antes de analizar: error en español', () => {
  const s = new AnalysisSession(new Float32Array(1000), SR);
  assert.throws(() => s.retrack({}), /primero hay que analizar/);
  assert.throws(() => s.relabel({}), /primero hay que analizar/);
});

// ---------------------------------------------------------------- bordes y robustez

test('silencio, audio vacío y 10 muestras: resultado vacío válido, confianza 0', () => {
  for (const x of [new Float32Array(5 * SR), new Float32Array(0), new Float32Array(10).fill(0.1)]) {
    const r = analyze(x, SR);
    checkShape(r);
    assert.equal(r.beats.length, 0);
    assert.equal(r.bpm, 0);
    assert.deepEqual(r.confidence, { beats: 0, bars: 0 });
    assert.deepEqual(r.bpmRange, [0, 0]);
  }
});

test('ruido blanco: sin cuadrícula fiable', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const r = analyze(Float32Array.from({ length: 10 * SR }, () => 0.3 * rnd()), SR);
  checkShape(r);
  assert.ok(Math.min(r.confidence.beats, r.confidence.bars) < 0.5);
});

const shortRock = () => customSong('shortRock', { seed: 7, style: 'rock', bpm: 118, bars: 12, jitterMs: 6, ending: { type: 'ring', ringSec: [1.5, 2] } });

test('1 s y 2.5 s de audio: no falla y el resultado es coherente', () => {
  const g = shortRock();
  for (const sec of [1, 2.5]) {
    const r = analyze(g.samples.slice(2 * SR, Math.round((2 + sec) * SR)), SR);
    checkShape(r);
    assert.ok(Math.abs(r.duration - sec) < 1e-3);
  }
});

test('offset DC (y cola sólo DC): mismo resultado que sin él', () => {
  const g = shortRock();
  const clean = analyze(g.samples, SR);
  const x = new Float32Array(g.samples.length + 6 * SR);
  x.set(g.samples);
  for (let i = 0; i < x.length; i++) x[i] += 0.3;
  const r = analyze(x, SR);
  checkShape(r);
  assert.equal(r.beats.length, clean.beats.length);
  for (let i = 0; i < r.beats.length; i++) assert.ok(Math.abs(r.beats[i] - clean.beats[i]) < 0.002);
  assert.ok(Math.abs(r.musicEnd - clean.musicEnd) < 0.05, `musicEnd ${r.musicEnd} vs ${clean.musicEnd}`);
  assert.ok(Math.abs(r.lastOnset - clean.lastOnset) < 0.005);
  assert.deepEqual(r.downbeats, clean.downbeats);
});

test('audio saturado (recorte duro ×4) y muy bajo (−60 dB): beats y último compás correctos', () => {
  const g = shortRock();
  let peak = 0;
  for (const v of g.samples) peak = Math.max(peak, Math.abs(v));
  for (const f of [(v) => Math.max(-1, Math.min(1, (4 * v) / peak)), (v) => v * 0.001]) {
    const r = analyze(Float32Array.from(g.samples, f), SR);
    checkShape(r);
    assert.ok(beatF(r, g.truth) >= 0.95);
    assert.ok(lastBarOk(lastBarStart(r), g.truth));
  }
});

test('valores no finitos, 44.1 kHz y 16 kHz de entrada; la entrada no se modifica', () => {
  const g = shortRock();
  const x = g.samples.slice();
  x[1000] = NaN;
  x[5000] = Infinity;
  const copy = x.slice();
  const r = analyze(x, SR);
  checkShape(r);
  assert.ok(beatF(r, g.truth) >= 0.95);
  assert.ok(Object.is(x[1000], NaN) && x[5000] === Infinity && x.every((v, i) => Object.is(v, copy[i])), 'la entrada no cambia');
  // 44.1 kHz (interpolación lineal) y 16 kHz
  const up = new Float32Array(g.samples.length * 2);
  for (let i = 0; i < up.length; i++) up[i] = g.samples[Math.min(g.samples.length - 1, i >> 1)];
  const down = Float32Array.from({ length: Math.floor((g.samples.length * 16000) / SR) }, (_, i) => g.samples[Math.floor((i * SR) / 16000)]);
  for (const [y, rate] of [[up, 44100], [down, 16000]]) {
    const q = analyze(y, rate);
    checkShape(q);
    assert.ok(Math.abs(q.duration - g.samples.length / SR) < 0.01);
    assert.equal(tempoCheck(q.bpm, g.truth.tempo.bpm).label, 'ok', `${rate} Hz: ${q.bpm}`);
    assert.ok(beatF(q, g.truth) >= 0.95, `${rate} Hz: F ${beatF(q, g.truth)}`);
  }
});

test('entradas no válidas: Error con mensaje en español', () => {
  for (const sr of [0, NaN, -1, 1e7, 'x']) assert.throws(() => analyze(new Float32Array(100), sr), /frecuencia de muestreo no válida/);
  assert.throws(() => analyze(null, SR), /no hay muestras de audio/);
  assert.throws(() => analyze(undefined, SR), /no hay muestras de audio/);
});

test('progreso: etapas en orden (features, tempo, beats, bars) con 0 y 1; un callback que falla no rompe', () => {
  const g = shortRock();
  const seen = [];
  analyze(g.samples, SR, {}, (stage, fraction) => seen.push(`${stage}:${fraction}`));
  assert.deepEqual(seen, ANALYSIS_STAGES.flatMap((s) => [`${s}:0`, `${s}:1`]));
  const r = analyze(g.samples, SR, {}, () => {
    throw new Error('fallo de la interfaz');
  });
  checkShape(r);
  assert.deepEqual(Object.keys(r.timingsMs), ['features', 'tempo', 'beats', 'bars', 'total']);
});

test('opciones: minBpm/maxBpm/beatsPerBar se validan; beatsPerBar fijo desde el principio', () => {
  assert.deepEqual(normalizeOptions({}), { minBpm: 50, maxBpm: 220, beatsPerBar: 'auto' });
  assert.deepEqual(normalizeOptions({ minBpm: 'x', maxBpm: -1, beatsPerBar: 9 }), { minBpm: 50, maxBpm: 220, beatsPerBar: 'auto' });
  assert.deepEqual(normalizeOptions({ minBpm: 60, maxBpm: 200, beatsPerBar: '3' }), { minBpm: 60, maxBpm: 200, beatsPerBar: 3 });
  assert.equal(normalizeMeter('auto'), 'auto');
  assert.equal(normalizeMeter(7), 7);
  assert.equal(normalizeMeter(1), 'auto');
  const g = shortRock();
  const r = analyze(g.samples, SR, { beatsPerBar: 3 });
  assert.equal(r.beatsPerBar, 3);
  assert.equal(r.meterAuto, false);
});

// ---------------------------------------------------------------- piezas

test('refineBeats: lleva el beat al ataque, nunca > 5 ms más tarde, orden estricto y dentro de los límites', () => {
  const x = new Float32Array(3 * SR);
  const att = [0.5, 1.0, 1.5, 2.0];
  for (const t of att) for (let k = 0; k < 300; k++) x[Math.round(t * SR) + k] = 0.8 * Math.exp(-k / 80) * Math.sin(k * 0.7);
  const early = refineBeats(x, SR, att.map((t) => t - 0.02)); // beats 20 ms antes del ataque: no se retrasan > 5 ms
  early.forEach((t, i) => assert.ok(Math.abs(t - (att[i] - 0.02)) < 1e-9, `beat ${i}: ${t}`));
  const late = refineBeats(x, SR, att.map((t) => t + 0.012)); // 12 ms tarde: vuelve al ataque
  late.forEach((t, i) => assert.ok(Math.abs(t - att[i]) < 0.003, `beat ${i}: ${t}`));
  const clamped = refineBeats(x, SR, [0.49, 0.5005, 0.501], { musicStart: 0.495, musicEnd: 2.5 });
  assert.ok(clamped[0] >= 0.495 && clamped[1] > clamped[0] && clamped[2] > clamped[1]);
  assert.deepEqual(refineBeats(x, SR, []), []);
});

test('remapForced / sanitizeForced', () => {
  const beats = [0, 0.25, 0.5, 0.75, 1.0, 1.25];
  assert.deepEqual(remapForced([0.5, 1.01], beats), [2, 4]);
  assert.deepEqual(remapForced([0.375], beats), [], 'a medio camino entre dos beats: se descarta');
  assert.deepEqual(remapForced([0.5, 0.51, NaN], beats), [2]);
  assert.deepEqual(remapForced([0.5], []), []);
  assert.deepEqual(sanitizeForced([3, 1, 1, -2, 7, 2.2, '4'], 6), [1, 3, 4]);
  assert.deepEqual(sanitizeForced(null, 6), []);
});

test('analyze.js reexporta las piezas puras', () => {
  for (const fn of [computeFeatures, estimateTempo, trackBeats, labelBars, findMusicBounds, findLastOnset, prepareSamples]) {
    assert.equal(typeof fn, 'function');
  }
  const p = prepareSamples(Float32Array.from({ length: SR }, () => 0.5), SR);
  assert.ok(Math.abs(p[SR - 1]) < 1e-3, 'sin componente continua');
});

// ---------------------------------------------------------------- worker (protocolo) y cliente (modo sin worker)

test('worker.js: protocolo { id, type } con progreso, resultado y errores', async () => {
  const sent = [];
  const prevSelf = globalThis.self;
  globalThis.self = { postMessage: (m) => sent.push(m) };
  try {
    await import('../js/analysis/worker.js');
    assert.deepEqual(sent.shift(), { type: 'ready' });
    const send = (data) => globalThis.self.onmessage({ data });
    send({ id: 1, type: 'retrack', options: {} });
    assert.equal(sent.at(-1).type, 'error');
    assert.equal(sent.at(-1).id, 1);
    assert.match(sent.at(-1).message, /primero hay que analizar/);
    const g = shortRock();
    send({ id: 2, type: 'analyze', samples: g.samples.slice(), sampleRate: SR, options: {} });
    const res = sent.filter((m) => m.id === 2);
    assert.deepEqual(res.filter((m) => m.type === 'progress').map((m) => m.stage), ANALYSIS_STAGES.flatMap((s) => [s, s]));
    assert.equal(res.at(-1).type, 'result');
    checkShape(res.at(-1).result);
    send({ id: 3, type: 'relabel', options: { beatsPerBar: 3 } });
    assert.equal(sent.at(-1).result.beatsPerBar, 3);
    send({ id: 4, type: 'retrack', options: { bpmHint: res.at(-1).result.bpm * 2, strict: true } });
    assert.ok(sent.at(-1).result.bpm > 200);
    send({ id: 5, type: 'nada' });
    assert.equal(sent.at(-1).type, 'error');
    send({ id: 6, type: 'analyze', samples: new Float32Array(10), sampleRate: 0 });
    assert.match(sent.at(-1).message, /frecuencia de muestreo/);
  } finally {
    globalThis.self = prevSelf;
  }
});

test('AnalysisClient sin Worker (Node): analiza en el mismo hilo con la misma API', async () => {
  const { AnalysisClient } = await import('../js/analysis/client.js');
  const g = shortRock();
  const early = new AnalysisClient();
  await assert.rejects(early.retrack({}), (e) => e instanceof Error && /primero hay que analizar/.test(e.message));
  early.terminate();

  const client = new AnalysisClient();
  const stages = [];
  const r = await client.analyze(g.samples.slice(), SR, {}, (stage) => stages.push(stage));
  checkShape(r);
  assert.ok(beatF(r, g.truth) >= 0.95);
  assert.deepEqual([...new Set(stages)], ANALYSIS_STAGES);
  // peticiones simultáneas: cada una recibe su resultado
  const [a, b, c] = await Promise.all([
    client.relabel({ beatsPerBar: 3 }),
    client.relabel({ beatsPerBar: 4 }),
    client.retrack({ bpmHint: r.bpm / 2, strict: true }),
  ]);
  assert.equal(a.beatsPerBar, 3);
  assert.equal(b.beatsPerBar, 4);
  assert.ok(tempoCheck(c.bpm, r.bpm / 2).ok);
  await assert.rejects(client.retrack({ bpmHint: 1e5 }), /fuera de rango/);
  const pending = client.relabel({ beatsPerBar: 'auto' });
  client.terminate();
  await assert.rejects(pending, /cancelado/);
  await assert.rejects(client.relabel({}), /cerrado/);
});
