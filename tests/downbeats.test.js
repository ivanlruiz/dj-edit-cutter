import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSong } from './synth/generate.js';
import { fMeasure } from './synth/metrics.js';
import { Rng } from './synth/prng.js';
import { computeFeatures } from '../js/analysis/features.js';
import { labelBars, beatSyncFeatures, meterPeriodicity, localStandardize, DOWNBEAT_DEFAULTS } from '../js/analysis/downbeats.js';

// Canciones sintéticas cortas (se generan una vez; ~0.4 s cada una con sus características).
const SONGS = {
  rock: { seed: 31, style: 'rock', bpm: 124, bars: 14, jitterMs: 6, ending: { type: 'ring', ringSec: [1, 1.5] } },
  waltz: { seed: 32, style: 'waltz', beatsPerBar: 3, bpm: 150, bars: 22, jitterMs: 8, ending: { type: 'ring', ringSec: [1, 1.5] } },
  pickup: { seed: 33, style: 'pop', pickupBeats: 2, bpm: 104, bars: 12, jitterMs: 6, ending: { type: 'ring', ringSec: [1, 1.5] } },
  acoustic: { seed: 34, style: 'acoustic', bpm: 96, bars: 12, jitterMs: 8, ending: { type: 'ring', ringSec: [1, 1.5] } },
};
const cache = new Map();
function song(name) {
  if (!cache.has(name)) {
    const g = generateSong(SONGS[name]);
    cache.set(name, { ...g, features: computeFeatures(g.samples, g.sampleRate) });
  }
  return cache.get(name);
}

const dbTimes = (beats, res) => res.downbeats.map((i) => beats[i]);
const gtDbTimes = (truth) => truth.downbeats.map((i) => truth.beats[i]);

/** Coherencia interna del resultado. */
function checkShape(res, n, M) {
  assert.equal(res.positions.length, n);
  assert.equal(res.beatsPerBar, M);
  for (const p of res.positions) assert.ok(Number.isInteger(p) && p >= 0 && p <= M, `posición fuera de rango: ${p}`);
  const db = [];
  res.positions.forEach((p, i) => { if (p === 0) db.push(i); });
  assert.deepEqual(res.downbeats, db);
  // dentro de un compás las posiciones suben de 1 en 1; el beat extra (M) sólo sigue a M-1
  for (let i = 1; i < n; i++) {
    const p = res.positions[i];
    if (p !== 0) assert.equal(p, res.positions[i - 1] + 1, `salto de posición en ${i}`);
  }
  assert.ok(res.confidence >= 0 && res.confidence <= 1);
}

/** Corta (kind 'short') o duplica ('long') el audio de un beat en posición 1 hacia el 45 % de la canción. */
function splice(g, kind) {
  const { beats, positions } = g.truth;
  const sr = g.sampleRate;
  let k = Math.floor(beats.length * 0.45);
  while (positions[k] !== 1) k++;
  const a = Math.round(beats[k] * sr);
  const b = Math.round(beats[k + 1] * sr);
  const x = g.samples;
  let out;
  if (kind === 'short') {
    out = new Float32Array(x.length - (b - a));
    out.set(x.subarray(0, a), 0);
    out.set(x.subarray(b), a);
  } else {
    out = new Float32Array(x.length + (b - a));
    out.set(x.subarray(0, b), 0);
    out.set(x.subarray(a), b);
  }
  const d = (b - a) / sr;
  const nb = [];
  const np = [];
  for (let i = 0; i < beats.length; i++) {
    if (kind === 'short') {
      if (i === k + 1) continue;
      nb.push(i <= k ? beats[i] : beats[i] - d);
      np.push(positions[i]);
    } else {
      nb.push(i <= k ? beats[i] : beats[i] + d);
      np.push(positions[i]);
      if (i === k) {
        nb.push(beats[k + 1]);
        np.push(positions[k]);
      }
    }
  }
  const downbeats = [];
  np.forEach((p, i) => { if (p === 0) downbeats.push(i); });
  return { features: computeFeatures(out, sr), beats: nb, downbeats, spliceBeat: k };
}

test('rock 4/4 con beats de referencia: compás 4 automático y todos los "1" exactos', () => {
  const g = song('rock');
  const res = labelBars(g.features, g.truth.beats, { beatsPerBar: 'auto' });
  checkShape(res, g.truth.beats.length, 4);
  assert.equal(res.meterAuto, true);
  assert.deepEqual(res.downbeats, g.truth.downbeats);
  assert.ok(res.confidence > 0.7, `confianza ${res.confidence}`);
  assert.ok(res.meterScores[4] > res.meterScores[3]);
});

test('vals 3/4: compás 3 automático y "1" exactos', () => {
  const g = song('waltz');
  const res = labelBars(g.features, g.truth.beats);
  checkShape(res, g.truth.beats.length, 3);
  assert.deepEqual(res.downbeats, g.truth.downbeats);
  assert.ok(res.confidence > 0.7);
  assert.ok(res.meterScores[3] > res.meterScores[4] + DOWNBEAT_DEFAULTS.meterBias);
});

test('anacrusa de 2 tiempos y material sin batería', () => {
  const p = song('pickup');
  const rp = labelBars(p.features, p.truth.beats);
  assert.equal(rp.beatsPerBar, 4);
  assert.deepEqual(rp.downbeats, p.truth.downbeats);
  assert.equal(rp.downbeats[0], p.truth.downbeats[0]);
  assert.deepEqual(rp.positions.slice(0, p.truth.downbeats[0]), p.truth.positions.slice(0, p.truth.downbeats[0]));
  const a = song('acoustic');
  const ra = labelBars(a.features, a.truth.beats);
  assert.equal(ra.beatsPerBar, 4);
  assert.deepEqual(ra.downbeats, a.truth.downbeats);
});

test('robusto a errores del tracker: jitter, un beat perdido y uno insertado', () => {
  const g = song('rock');
  const rng = new Rng(5);
  const ref = gtDbTimes(g.truth);
  const lastRef = ref.slice(-4);
  const variants = {
    jitter: g.truth.beats.map((t) => t + rng.gauss(0, 0.015)),
    missing: g.truth.beats.filter((_, i) => i !== Math.floor(g.truth.beats.length * 0.4)),
    inserted: (() => {
      const b = g.truth.beats.slice();
      const i = Math.floor(b.length * 0.6);
      b.splice(i + 1, 0, (b[i] + b[i + 1]) / 2);
      return b;
    })(),
  };
  for (const [name, beats] of Object.entries(variants)) {
    const res = labelBars(g.features, beats);
    checkShape(res, beats.length, 4);
    const det = dbTimes(beats, res);
    const f = fMeasure(det, ref, { range: g.truth.evalRange }).f;
    assert.ok(f >= 0.9, `${name}: F de downbeats ${f.toFixed(3)}`);
    // los últimos compases (los que cuenta el corte) tienen que estar bien
    for (const t of lastRef) assert.ok(det.some((d) => Math.abs(d - t) < 0.07), `${name}: falta el downbeat ${t.toFixed(2)}`);
  }
  // con un beat perdido o insertado hay exactamente un compás irregular
  const miss = labelBars(g.features, variants.missing);
  const ins = labelBars(g.features, variants.inserted);
  const irregular = (r) => r.positions.filter((p, i) => (p === 0 && i > 0 && r.positions[i - 1] < r.beatsPerBar - 1) || p === r.beatsPerBar).length;
  assert.equal(irregular(miss), 1);
  assert.equal(irregular(ins), 1);
});

test('compás irregular real (un tiempo de menos / de más en el audio)', () => {
  const g = song('rock');
  const s = splice(g, 'short');
  const rs = labelBars(s.features, s.beats);
  checkShape(rs, s.beats.length, 4);
  assert.deepEqual(rs.downbeats, s.downbeats);
  const l = splice(g, 'long');
  const rl = labelBars(l.features, l.beats);
  checkShape(rl, l.beats.length, 4);
  assert.deepEqual(rl.downbeats, l.downbeats);
  assert.ok(rl.positions.includes(4), 'el compás largo usa la posición === beatsPerBar');
});

test('forcedDownbeats: un "1" forzado desplaza toda la rejilla de forma coherente', () => {
  const g = song('rock');
  const b = g.truth.beats;
  const db = g.truth.downbeats;
  const f = db[db.length - 2] + 1; // el 2 del penúltimo compás pasa a ser "1"
  const res = labelBars(g.features, b, { forcedDownbeats: [f] });
  checkShape(res, b.length, 4);
  assert.equal(res.positions[f], 0);
  const withGtPos = (p) => g.truth.positions.map((q, i) => (q === p ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(res.downbeats, withGtPos(1)); // los antiguos "2" son ahora "1"
  // forzar un "1" que ya lo era no cambia nada
  assert.deepEqual(labelBars(g.features, b, { forcedDownbeats: [db[5]] }).downbeats, db);
  // hacia atrás
  const back = labelBars(g.features, b, { forcedDownbeats: [db[db.length - 2] - 1] });
  assert.deepEqual(back.downbeats, withGtPos(3)); // los antiguos "4" son ahora "1"
});

test('forcedDownbeats incompatibles: se respetan todos con un compás irregular entre ellos', () => {
  const g = song('rock');
  const b = g.truth.beats;
  const db = g.truth.downbeats;
  const a = db[4];
  for (const gap of [7, 2, 5, 10]) {
    const res = labelBars(g.features, b, { forcedDownbeats: [a + gap, a] });
    checkShape(res, b.length, 4);
    assert.equal(res.positions[a], 0);
    assert.equal(res.positions[a + gap], 0);
    // antes del primero se conserva la rejilla detectada y después del último sigue la del forzado
    assert.deepEqual(res.downbeats.filter((i) => i <= a), db.filter((i) => i <= a));
    const shift = ((gap % 4) + 4) % 4;
    const after = res.downbeats.filter((i) => i >= a + gap);
    assert.deepEqual(after, db.map((i) => i + shift).filter((i) => i >= a + gap && i < b.length));
  }
  // índices inválidos se ignoran
  const auto = labelBars(g.features, b);
  const bad = labelBars(g.features, b, { forcedDownbeats: [-3, 9999, 'x', 2.5, null, NaN] });
  assert.deepEqual(bad.downbeats, auto.downbeats);
});

test('compás elegido por el usuario (2..7) y compás equivocado con confianza baja', () => {
  const g = song('rock');
  const b = g.truth.beats;
  for (const M of [2, 3, 4, 5, 6, 7]) {
    const res = labelBars(g.features, b, { beatsPerBar: M });
    checkShape(res, b.length, M);
    assert.equal(res.meterAuto, false);
  }
  assert.ok(labelBars(g.features, b, { beatsPerBar: 5 }).confidence < 0.3);
  assert.ok(labelBars(g.features, b, { beatsPerBar: 3 }).confidence < 0.3);
  // en 2 los "1" caen en los "1" y los "3" reales
  const two = labelBars(g.features, b, { beatsPerBar: 2 });
  for (const i of g.truth.downbeats) assert.equal(two.positions[i], 0);
  // compás de usuario + forzado
  const w = song('waltz');
  const f = w.truth.downbeats[10] + 1;
  const r3 = labelBars(w.features, w.truth.beats, { beatsPerBar: 3, forcedDownbeats: [f] });
  assert.equal(r3.positions[f], 0);
  assert.deepEqual(r3.downbeats, w.truth.downbeats.map((i) => i + 1).filter((i) => i < w.truth.beats.length));
  // valores fuera de 2..7: automático
  assert.equal(labelBars(w.features, w.truth.beats, { beatsPerBar: 9 }).meterAuto, true);
  assert.equal(labelBars(w.features, w.truth.beats, { beatsPerBar: '3' }).beatsPerBar, 3);
});

test('sin evidencia (ruido estable): confianza baja y compás 4 por defecto', () => {
  const sr = 22050;
  const rng = new Rng(9);
  const x = new Float32Array(sr * 20);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * rng.gauss(0, 1);
  const F = computeFeatures(x, sr);
  const beats = [];
  for (let t = 0.5; t < 19.5; t += 0.5) beats.push(t);
  const res = labelBars(F, beats);
  checkShape(res, beats.length, 4);
  assert.ok(res.confidence < 0.3, `confianza ${res.confidence}`);
});

test('casos límite: sin beats, pocos beats y Float32Array', () => {
  const g = song('rock');
  const empty = labelBars(g.features, []);
  assert.deepEqual(empty.positions, []);
  assert.deepEqual(empty.downbeats, []);
  assert.equal(empty.confidence, 0);
  assert.equal(empty.beatsPerBar, 4);
  assert.equal(labelBars(g.features, [], { beatsPerBar: 3 }).beatsPerBar, 3);
  for (const n of [1, 2, 3, 5]) {
    const res = labelBars(g.features, g.truth.beats.slice(0, n));
    checkShape(res, n, res.beatsPerBar);
  }
  const f32 = labelBars(g.features, Float32Array.from(g.truth.beats));
  assert.deepEqual(f32.downbeats, g.truth.downbeats);
  // beats más allá del final del audio no rompen nada
  const res = labelBars(g.features, [...g.truth.beats, g.features.duration + 1, g.features.duration + 2]);
  checkShape(res, g.truth.beats.length + 2, 4);
});

test('beatSyncFeatures, localStandardize y meterPeriodicity', () => {
  const g = song('waltz');
  const bf = beatSyncFeatures(g.features, g.truth.beats);
  assert.equal(bf.n, g.truth.beats.length);
  for (const k of ['low', 'ons', 'hc1', 'hc2', 'acc']) assert.equal(bf[k].length, bf.n);
  assert.ok(Number.isNaN(bf.hc1[0]));
  const z = localStandardize(Float64Array.from([1, 2, NaN, 4, 5, 6, 7, 8]), 3);
  assert.equal(z[2], 0);
  assert.ok(z.every(Number.isFinite));
  // patrón de periodo 3 frente a periodo 4 (una característica)
  const n = 96;
  const p3 = new Float64Array(n).map((_, i) => (i % 3 === 0 ? 1 : -0.5));
  const p4 = new Float64Array(n).map((_, i) => (i % 4 === 0 ? 1 : -0.33));
  assert.ok(meterPeriodicity(p3, n, 1, 3) > 0.9);
  assert.ok(meterPeriodicity(p3, n, 1, 4) < 0.1);
  assert.ok(meterPeriodicity(p4, n, 1, 4) > 0.9);
  assert.ok(meterPeriodicity(p4, n, 1, 3) < 0.1);
});
