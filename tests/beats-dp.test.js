// Tests del tracker de beats por programación dinámica (js/analysis/beats-dp.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../js/analysis/features.js';
import { findMusicBounds } from '../js/analysis/bounds.js';
import { trackBeats, dpForward, tempoPath, beatEnvelope, octaveEvidence, DP_DEFAULTS } from '../js/analysis/beats-dp.js';
import { generateSong } from './synth/generate.js';
import { fMeasure, tempoCheck } from './synth/metrics.js';

const SR = 22050;

/** Tren de clics con tempo que puede variar: bpmAt(t) en BPM. Devuelve { x, times }. */
function clickTrain({ sec = 20, bpm = 120, bpmAt = null, lead = 0.5, tail = 0, amp = 0.8, noise = 0 } = {}) {
  const x = new Float32Array(Math.round((lead + sec + tail) * SR));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  if (noise > 0) for (let i = 0; i < x.length; i++) x[i] = noise * rnd();
  const times = [];
  for (let t = lead; t < lead + sec; t += 60 / (bpmAt ? bpmAt(t - lead) : bpm)) {
    times.push(t);
    const i0 = Math.round(t * SR);
    for (let k = 0; k < 400 && i0 + k < x.length; k++) x[i0 + k] += amp * Math.exp(-k / 60) * Math.sin(k * 0.9);
  }
  return { x, times };
}

function analyse(x, extra = {}) {
  const f = computeFeatures(x, SR);
  const b = findMusicBounds(x, SR);
  const res = trackBeats(f, { musicStart: b.musicStart, musicEnd: b.musicEnd, samples: x, sampleRate: SR, ...extra });
  return { f, b, res };
}

function song(config) {
  const g = generateSong(config);
  return { ...g, ...analyse(g.samples) };
}

function checkInvariants(res, b) {
  assert.equal(res.strength.length, res.beats.length);
  assert.equal(res.tempi.length, res.beats.length);
  for (let i = 0; i < res.beats.length; i++) {
    assert.ok(Number.isFinite(res.beats[i]));
    if (i) assert.ok(res.beats[i] > res.beats[i - 1], 'beats ascendentes');
    assert.ok(res.strength[i] >= 0 && res.strength[i] <= 1);
    assert.ok(res.tempi[i] > 0);
  }
  if (b && res.beats.length) {
    assert.ok(res.beats[0] >= b.musicStart - 1e-9, 'ningún beat antes de musicStart');
    assert.ok(res.beats[res.beats.length - 1] <= b.musicEnd + 1e-9, 'ningún beat después de musicEnd');
  }
  assert.ok(res.confidence >= 0 && res.confidence <= 1);
  assert.ok(res.extrapolated >= 0 && res.extrapolated <= res.beats.length);
}

test('clics a 120 BPM: todos los beats en su sitio (±30 ms), tempo y forma del resultado', () => {
  const { x, times } = clickTrain({ sec: 20, bpm: 120 });
  const { b, res } = analyse(x);
  checkInvariants(res, b);
  assert.ok(Math.abs(res.bpm / 120 - 1) < 0.01, `bpm ${res.bpm}`);
  const fm = fMeasure(res.beats, times, { window: 0.03 });
  assert.ok(fm.f > 0.99, `F ${fm.f}`);
  assert.ok(res.confidence > 0.9);
  assert.ok(res.strength.slice(0, res.beats.length - res.extrapolated).every((v) => v > 0.5));
});

test('tempo variable: acelerando continuo de 100 a 130 BPM en 30 s', () => {
  const { x, times } = clickTrain({ sec: 30, bpmAt: (t) => 100 + t, noise: 0.01 });
  const { res } = analyse(x);
  const fm = fMeasure(res.beats, times, { window: 0.05 });
  assert.ok(fm.f > 0.98, `F ${fm.f}`);
  // el tempo local sigue la rampa
  const early = res.tempi[Math.floor(res.tempi.length * 0.1)];
  const late = res.tempi[Math.floor(res.tempi.length * 0.9)];
  assert.ok(late / early > 1.15, `tempi ${early} -> ${late}`);
});

test('ritardando de −30 % en los 4 últimos compases + fermata: sigue el tempo y no inventa beats en el silencio', () => {
  const s = song({ seed: 501, style: 'rock', bpm: 100, bars: 14, jitterMs: 10, driftPct: 3, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4] } });
  checkInvariants(s.res, s.b);
  const fm = fMeasure(s.res.beats, s.truth.beats, { range: s.truth.evalRange });
  assert.ok(fm.f >= 0.95, `F ${fm.f}`);
  // el último beat decodificado (antes de la cola extrapolada) es el golpe final
  const lastDecoded = s.res.beats[s.res.beats.length - 1 - s.res.extrapolated];
  assert.ok(Math.abs(lastDecoded - s.truth.finalHit) < 0.07, `último beat ${lastDecoded} vs golpe ${s.truth.finalHit}`);
  assert.ok(s.res.extrapolated <= DP_DEFAULTS.maxTailBeats);
  // la cola extrapolada no tiene onsets: strength baja
  for (let i = s.res.beats.length - s.res.extrapolated; i < s.res.beats.length; i++) assert.ok(s.res.strength[i] < 0.5);
});

test('banda en vivo: deriva ±6 % y jitter de 15 ms', () => {
  const s = song({ seed: 102, style: 'rock', bpm: 128, bars: 16, jitterMs: 15, driftPct: 6, noiseDb: -64, ending: { type: 'ring' } });
  const fm = fMeasure(s.res.beats, s.truth.beats, { range: s.truth.evalRange });
  assert.ok(fm.f >= 0.95, `F ${fm.f}`);
  assert.ok(tempoCheck(s.res.bpm, s.truth.tempo.bpm).ok);
});

test('piano solo sin batería con rubato', () => {
  const s = song({ seed: 106, style: 'pianoSolo', bpm: 100, bars: 12, jitterMs: 18, driftPct: 5, reverb: { wet: 0.28 }, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.7, ringSec: [3, 4] } });
  const fm = fMeasure(s.res.beats, s.truth.beats, { range: s.truth.evalRange });
  assert.ok(fm.f >= 0.9, `F ${fm.f}`);
});

test('octava: un rock lento a 76 BPM no se queda en ×2 (evidencia de paridad)', () => {
  const s = song({ seed: 507, style: 'rock', bpm: 76, bars: 12, jitterMs: 8, driftPct: 2, ending: { type: 'ring' } });
  assert.ok(tempoCheck(s.res.bpm, s.truth.tempo.bpm).ok, `bpm ${s.res.bpm} vs ${s.truth.tempo.bpm}`);
  const fm = fMeasure(s.res.beats, s.truth.beats, { range: s.truth.evalRange });
  assert.ok(fm.f >= 0.95, `F ${fm.f}`);
});

test('octava: arrancando con un tempo global a la mitad, se corrige al doble', () => {
  const g = generateSong({ seed: 101, style: 'rock', bpm: 120, bars: 12, jitterMs: 5, ending: { type: 'ring' } });
  const f = computeFeatures(g.samples, SR);
  const b = findMusicBounds(g.samples, SR);
  const res = trackBeats(f, { musicStart: b.musicStart, musicEnd: b.musicEnd, tempo: { bpm: 60 } });
  assert.ok(tempoCheck(res.bpm, 120).ok, `bpm ${res.bpm}`);
  assert.ok(res.octave && res.octave.to > res.octave.from);
});

test('silencio final tras los clics: ningún beat en el silencio', () => {
  const { x, times } = clickTrain({ sec: 20, bpm: 120, tail: 5 });
  const { b, res } = analyse(x);
  checkInvariants(res, b);
  assert.ok(res.beats[res.beats.length - 1] <= times[times.length - 1] + 0.05);
  assert.equal(fMeasure(res.beats, times).f, 1);
});

test('corte seco en la barra de compás: no se añade el "1" que no suena', () => {
  const s = song({ seed: 511, style: 'shuffle', subdiv: 3, bpm: 92, bars: 10, jitterMs: 8, driftPct: 3, ending: { type: 'abrupt' } });
  checkInvariants(s.res, s.b);
  assert.ok(s.res.beats[s.res.beats.length - 1] <= s.truth.beats[s.truth.beats.length - 1] + 0.07);
  assert.equal(s.res.extrapolated, 0);
  assert.ok(fMeasure(s.res.beats, s.truth.beats, { range: s.truth.evalRange }).f >= 0.95);
});

test('golpe anticipado (en el "y" del 4): el último beat decodificado es el 4, no el golpe', () => {
  const s = song({ seed: 115, style: 'rock', bpm: 124, bars: 12, jitterMs: 7, driftPct: 2, ending: { type: 'anticipated' } });
  const lastDecoded = s.res.beats[s.res.beats.length - 1 - s.res.extrapolated];
  const beat4 = s.truth.beats[s.truth.beats.length - 1];
  assert.ok(Math.abs(lastDecoded - beat4) < 0.07, `${lastDecoded} vs ${beat4}`);
  assert.ok(fMeasure(s.res.beats, s.truth.beats, { range: s.truth.evalRange }).f >= 0.95);
});

test('acorde final que resuena: se extrapolan beats por la cola, dentro de musicEnd', () => {
  const s = song({ seed: 101, style: 'rock', bpm: 120, bars: 10, jitterMs: 5, ending: { type: 'ring', ringSec: [3, 3.5] } });
  checkInvariants(s.res, s.b);
  assert.ok(s.res.extrapolated >= 1, 'hay cola extrapolada');
  const lastDecoded = s.res.beats[s.res.beats.length - 1 - s.res.extrapolated];
  assert.ok(Math.abs(lastDecoded - s.truth.finalHit) < 0.07);
});

test('robustez: vacío, muy corto, silencio, sólo DC y ruido blanco no lanzan y no dan beats', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const inputs = {
    vacío: new Float32Array(0),
    '100 muestras': new Float32Array(100).fill(0.1),
    silencio: new Float32Array(5 * SR),
    'sólo DC': new Float32Array(5 * SR).fill(0.5),
    'ruido blanco': Float32Array.from({ length: 5 * SR }, () => 0.1 * rnd()),
  };
  for (const [name, x] of Object.entries(inputs)) {
    const f = computeFeatures(x, SR);
    const b = x.length ? findMusicBounds(x, SR) : { musicStart: 0, musicEnd: 0 };
    const res = trackBeats(f, { musicStart: b.musicStart, musicEnd: b.musicEnd, samples: x, sampleRate: SR });
    assert.deepEqual(res.beats, [], name);
    assert.equal(res.confidence, 0, name);
  }
  assert.deepEqual(trackBeats(null).beats, []);
  assert.deepEqual(trackBeats({}).beats, []);
});

test('robustez: audio de menos de 3 s da una salida corta y válida', () => {
  for (const sec of [1, 2.5]) {
    const { x, times } = clickTrain({ sec, bpm: 120 });
    const { b, res } = analyse(x);
    checkInvariants(res, b);
    assert.ok(res.beats.length <= times.length + 1);
    assert.ok(fMeasure(res.beats, times).f >= 0.8, `${sec} s`);
  }
});

test('robustez: audio saturado y con offset DC', () => {
  const g = generateSong({ seed: 7, style: 'rock', bpm: 124, bars: 10, jitterMs: 8, ending: { type: 'ring' } });
  const clipped = Float32Array.from(g.samples, (v) => Math.max(-1, Math.min(1, v * 8)));
  const withDc = Float32Array.from(g.samples, (v) => v + 0.3);
  for (const [name, x] of [['saturado', clipped], ['DC', withDc]]) {
    const { b, res } = analyse(x);
    checkInvariants(res, b);
    const fm = fMeasure(res.beats, g.truth.beats, { range: g.truth.evalRange });
    assert.ok(fm.f >= 0.95, `${name}: F ${fm.f}`);
  }
  // DC + silencio final: el "silencio" con DC no es música (sin beats extrapolados en él)
  const { x, times } = clickTrain({ sec: 15, bpm: 120, tail: 5 });
  const dc = Float32Array.from(x, (v) => v + 0.4);
  const { res } = analyse(dc);
  assert.equal(fMeasure(res.beats, times).f, 1);
});

test('sin musicStart/musicEnd: límites calculados a partir de las muestras o del RMS', () => {
  const { x, times } = clickTrain({ sec: 12, bpm: 110, lead: 1, tail: 2 });
  const f = computeFeatures(x, SR);
  for (const opts of [{ samples: x, sampleRate: SR }, {}]) {
    const res = trackBeats(f, opts);
    assert.ok(fMeasure(res.beats, times, { window: 0.03 }).f > 0.98);
  }
});

test('bpmHint + strict (botones ×2 / ÷2) y bpmHint sin strict', () => {
  const g = generateSong({ seed: 7, style: 'rock', bpm: 124, bars: 10, jitterMs: 8, ending: { type: 'ring' } });
  const f = computeFeatures(g.samples, SR);
  const b = findMusicBounds(g.samples, SR);
  const base = { musicStart: b.musicStart, musicEnd: b.musicEnd };
  for (const [hint, strict] of [[62, true], [248, true], [62, false], [124, false]]) {
    const res = trackBeats(f, { ...base, bpmHint: hint, strict });
    assert.ok(Math.abs(res.bpm / hint - 1) < 0.04, `hint ${hint} strict ${strict}: bpm ${res.bpm}`);
    assert.equal(res.octave, null, 'con hint no se toca la octava');
  }
});

test('sin pulso claro (pad + voz): confianza baja y rejilla estable; con hint, el tempo del usuario', () => {
  const g = generateSong({ seed: 111, style: 'padVocal', bpm: 80, bars: 10, jitterMs: 15, driftPct: 2, reverb: { wet: 0.3 }, ending: { type: 'ring', ringSec: [3, 4] } });
  const { res } = analyse(g.samples);
  assert.ok(res.confidence < 0.5, `confidence ${res.confidence}`);
  const ibi = res.beats.slice(1, res.beats.length - res.extrapolated).map((t, i) => t - res.beats[i]);
  const mean = ibi.reduce((a, v) => a + v, 0) / ibi.length;
  assert.ok(ibi.every((v) => Math.abs(v / mean - 1) < 0.1), 'rejilla estable');
  const { res: r2 } = analyse(g.samples, { bpmHint: 79.2, strict: true });
  assert.ok(Math.abs(r2.bpm / 79.2 - 1) < 0.01, `bpm ${r2.bpm}`);
});

test('dpForward recupera una rejilla de impulsos y tempoPath sigue un cambio de tempo', () => {
  const n = 2000;
  const score = new Float32Array(n);
  for (let i = 10; i < n; i += 40) score[i] = 5;
  const { cum, back } = dpForward(score, new Float64Array(n).fill(41), 300);
  let e = 0;
  for (let i = n - 60; i < n; i++) if (cum[i] > cum[e]) e = i;
  const beats = [];
  for (let i = e; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  assert.equal(beats[0], 10);
  assert.ok(beats.every((v, i) => v === 10 + 40 * i));

  // clics a 100 BPM y luego 120 BPM: el camino pasa de un periodo a otro
  const { x } = clickTrain({ sec: 40, bpmAt: (t) => (t < 20 ? 100 : 120) });
  const f = computeFeatures(x, SR);
  const { env } = beatEnvelope(f, 0, f.numFrames - 1);
  const period = tempoPath(env, f.fps, 110);
  const bpmAt = (t) => (60 * f.fps) / period[Math.round(t * f.fps)];
  assert.ok(Math.abs(bpmAt(8) / 100 - 1) < 0.03, `8 s: ${bpmAt(8)}`);
  assert.ok(Math.abs(bpmAt(32) / 120 - 1) < 0.03, `32 s: ${bpmAt(32)}`);
});

test('octaveEvidence: paridad y contratiempos', () => {
  const beats = Array.from({ length: 20 }, (_, i) => i * 10);
  const strongWeak = (f) => (f % 20 === 0 ? 10 : f % 10 === 0 ? 2 : 0.5);
  const ev = octaveEvidence(beats, strongWeak);
  assert.ok(ev.parity < 0.3);
  const even = (f) => (f % 10 === 0 ? 10 : f % 5 === 0 ? 9 : 0.5);
  const ev2 = octaveEvidence(beats, even);
  assert.ok(ev2.parity > 0.9 && ev2.mid > 0.8);
});

test('rendimiento: 4:30 de audio en menos de 1.5 s', () => {
  const { x } = clickTrain({ sec: 270, bpmAt: (t) => 122 + 3 * Math.sin(t / 20), noise: 0.02 });
  const f = computeFeatures(x, SR);
  const b = findMusicBounds(x, SR);
  const t0 = performance.now();
  const res = trackBeats(f, { musicStart: b.musicStart, musicEnd: b.musicEnd, samples: x, sampleRate: SR });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  assert.ok(res.beats.length > 500);
});
