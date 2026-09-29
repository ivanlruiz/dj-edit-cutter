// Tests rápidos de la base de análisis: FFT, features, tempo, límites, métricas y generador sintético.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRealFFT, getComplexFFT, autocorrelation, hannWindow } from '../js/analysis/fft.js';
import { computeFeatures, pickPeaks, detectOnsets, frameTime, timeToFrame } from '../js/analysis/features.js';
import { estimateTempo } from '../js/analysis/tempo.js';
import { findMusicBounds, findLastOnset, refineToTransients } from '../js/analysis/bounds.js';
import {
  fMeasure, beatFMeasure, continuity, tempoCheck, lastBarStartFrom, lastBarOk, medianBpm, matchEvents,
} from './synth/metrics.js';
import { generateSong } from './synth/generate.js';
import { SUITE, CASE_NAMES, getCase } from './synth/suite.js';
import { encodeWavFile, decodeWav, toMono } from './synth/wav-io.js';
import { Rng } from './synth/prng.js';
import { brickwallLimit, hardClip, MASTERING_VARIANTS } from './synth/mastering.js';
import { SETS } from './synth/sets.js';

const SR = 22050;

/** Tren de clics (ráfagas cortas de ruido con decaimiento) en los instantes dados. */
function clickTrain(times, duration, { amp = 0.8, decay = 0.004, seed = 3 } = {}) {
  const x = new Float32Array(Math.round(duration * SR));
  const rng = new Rng(seed);
  for (const t of times) {
    const s = Math.round(t * SR);
    const n = Math.round(decay * 8 * SR);
    for (let i = 0; i < n && s + i < x.length; i++) x[s + i] += amp * (rng.next() * 2 - 1) * Math.exp(-i / (decay * SR));
  }
  return x;
}

function grid(start, period, end) {
  const out = [];
  for (let t = start; t < end; t += period) out.push(t);
  return out;
}

// ---------------------------------------------------------------- FFT

test('FFT real coincide con la DFT ingenua', () => {
  for (const n of [4, 8, 64, 512, 2048]) {
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * i * 0.01) + (i % 7) * 0.05);
    const f = getRealFFT(n).forward(x);
    let err = 0;
    for (let k = 0; k <= n / 2; k += n > 64 ? 7 : 1) {
      let re = 0;
      let im = 0;
      for (let t = 0; t < n; t++) {
        re += x[t] * Math.cos((2 * Math.PI * k * t) / n);
        im -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      err = Math.max(err, Math.abs(re - f.re[k]), Math.abs(im - f.im[k]));
    }
    assert.ok(err < 1e-8 * n, `n=${n} error ${err}`);
  }
});

test('FFT compleja: ida y vuelta recupera la señal', () => {
  const n = 256;
  const f = getComplexFFT(n);
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
  const im = Float64Array.from({ length: n }, (_, i) => Math.cos(3 * i));
  const r0 = re.slice();
  const i0 = im.slice();
  f.transform(re, im, false);
  f.transform(re, im, true);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] / n - r0[i]) < 1e-10);
    assert.ok(Math.abs(im[i] / n - i0[i]) < 1e-10);
  }
});

test('autocorrelación y ventana de Hann', () => {
  const ac = autocorrelation([1, 2, 3, 0, -1], 4);
  const expected = [15, 8, 0, -2, -1];
  expected.forEach((v, i) => assert.ok(Math.abs(ac[i] - v) < 1e-9, `lag ${i}: ${ac[i]}`));
  const w = hannWindow(8);
  assert.equal(w.length, 8);
  assert.ok(Math.abs(w[0]) < 1e-9 && Math.abs(w[4] - 1) < 1e-9);
  assert.equal(hannWindow(8), w, 'la ventana está cacheada');
});

// ---------------------------------------------------------------- features

test('features: forma, convención de tiempo centrada y picos de onset en los clics', () => {
  const clicks = grid(0.3, 0.5, 9.8);
  const x = clickTrain(clicks, 10);
  const f = computeFeatures(x, SR);
  assert.equal(f.hop, 256);
  assert.equal(f.frameSize, 1024);
  assert.equal(f.numFrames, Math.floor(x.length / 256) + 1);
  assert.ok(Math.abs(f.fps - SR / 256) < 1e-9);
  assert.ok(Math.abs(f.duration - 10) < 1e-3);
  for (const k of ['onset', 'onsetLow', 'rms']) {
    assert.ok(f[k] instanceof Float32Array, k);
    assert.equal(f[k].length, f.numFrames, k);
  }
  assert.equal(f.chroma.length, f.numFrames * 12);
  assert.ok(Math.abs(frameTime(f, 100) - (100 * 256) / SR) < 1e-12);
  assert.equal(timeToFrame(f, frameTime(f, 57)), 57);
  // cada clic tiene un pico de onset a ±1 trama
  for (const t of clicks) {
    const c = timeToFrame(f, t);
    let best = c;
    for (let i = c - 4; i <= c + 4; i++) if (f.onset[i] > f.onset[best]) best = i;
    assert.ok(Math.abs(best - c) <= 1, `clic en ${t}: pico en trama ${best}, esperado ${c}`);
    assert.ok(f.onset[best] > 0.5, `pico débil ${f.onset[best]}`);
  }
  const det = detectOnsets(f);
  const r = fMeasure(det, clicks, { window: 0.025 });
  assert.ok(r.f > 0.97, `F de onsets ${r.f}`);
});

test('features: el nivel de entrada no cambia la envolvente normalizada', () => {
  const clicks = grid(0.2, 0.37, 4.8);
  const a = computeFeatures(clickTrain(clicks, 5, { amp: 0.9 }), SR);
  const b = computeFeatures(clickTrain(clicks, 5, { amp: 0.009 }), SR);
  let d = 0;
  for (let i = 0; i < a.numFrames; i++) d = Math.max(d, Math.abs(a.onset[i] - b.onset[i]));
  assert.ok(d < 1e-3, `diferencia ${d}`);
  assert.ok(Math.abs(a.rms[50] / b.rms[50] - 100) < 1, 'rms queda en la escala original');
});

test('features: croma de un La (440 Hz) marca la clase 9', () => {
  const x = new Float32Array(SR * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 880 * i) / SR);
  const f = computeFeatures(x, SR);
  const i = Math.floor(f.numFrames / 2);
  const c = Array.from(f.chroma.subarray(i * 12, i * 12 + 12));
  assert.equal(c.indexOf(Math.max(...c)), 9);
  assert.ok(Math.abs(Math.max(...c) - 1) < 1e-6, 'normalizado al máximo');
});

test('pickPeaks: máximos locales por encima de la media', () => {
  const env = new Float32Array(200);
  for (const p of [20, 60, 61, 120]) env[p] = 1;
  env[61] = 0.9;
  const peaks = pickPeaks(env, 100, { threshold: 0.1 });
  assert.deepEqual(peaks, [20, 60, 120]);
});

// ---------------------------------------------------------------- tempo

test('tempo de trenes de clics a 60/90/120/150 BPM', () => {
  for (const bpm of [60, 90, 120, 150]) {
    const x = clickTrain(grid(0.25, 60 / bpm, 19.9), 20);
    const r = estimateTempo(computeFeatures(x, SR));
    assert.ok(Math.abs(r.bpm / bpm - 1) < 0.02, `${bpm} BPM -> ${r.bpm}`);
    assert.equal(r.localBpm.length, Math.floor(x.length / 256) + 1);
    const mid = r.localBpm[Math.floor(r.localBpm.length / 2)];
    assert.ok(Math.abs(mid / bpm - 1) < 0.04, `local ${mid}`);
    assert.ok(r.candidates.length >= 1 && r.candidates[0].score === 1);
  }
});

test('tempo: bpmHint + strict restringe a [0.8, 1.25] × hint', () => {
  const x = clickTrain(grid(0.25, 0.5, 19.9), 20); // 120 BPM
  const f = computeFeatures(x, SR);
  const half = estimateTempo(f, { bpmHint: 60, strict: true });
  assert.ok(half.bpm >= 48 && half.bpm <= 75, `hint 60 -> ${half.bpm}`);
  const dbl = estimateTempo(f, { bpmHint: 240, strict: true, maxBpm: 300 });
  assert.ok(Math.abs(dbl.bpm / 240 - 1) < 0.05, `hint 240 -> ${dbl.bpm}`);
});

test('features: rms sin componente continua (offset DC) y rmsHigh sólo con la banda > 2 kHz', () => {
  const n = 3 * SR;
  const tone = (hz, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
  const lowTone = tone(220, 0.5);
  const a = computeFeatures(lowTone, SR);
  const b = computeFeatures(Float32Array.from(lowTone, (v) => v + 0.3), SR);
  for (const i of [20, 100, 200]) assert.ok(Math.abs(b.rms[i] / a.rms[i] - 1) < 0.01, `trama ${i}: ${b.rms[i]} vs ${a.rms[i]}`);
  assert.ok(Math.abs(a.rms[100] - 0.5 / Math.SQRT2) < 0.01, 'RMS de un seno');
  const dc = computeFeatures(new Float32Array(n).fill(0.4), SR);
  assert.ok(Math.max(...dc.rms) < 1e-4, 'sólo DC: rms 0');
  assert.ok(dc.rmsHigh instanceof Float32Array && dc.rmsHigh.length === dc.numFrames);
  // un tono de 5 kHz está entero en la banda alta; uno de 220 Hz no
  const hi = computeFeatures(tone(5000, 0.5), SR);
  assert.ok(Math.abs(hi.rmsHigh[100] / hi.rms[100] - 1) < 0.05, `5 kHz: ${hi.rmsHigh[100]} vs ${hi.rms[100]}`);
  assert.ok(a.rmsHigh[100] < 0.01 * a.rms[100], `220 Hz: ${a.rmsHigh[100]}`);
});

test('features: sin flujo espurio en las tramas cuya ventana cruza los extremos del archivo', () => {
  // música desde la primera muestra hasta la última, con offset DC y sin silencio en los bordes
  const n = 4 * SR;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.35 + 0.3 * Math.sin((2 * Math.PI * 330 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 97 * i) / SR);
  const f = computeFeatures(x, SR);
  assert.ok(f.firstValidFrame >= 2 && f.lastValidFrame < f.numFrames - 1);
  for (let i = 0; i < f.firstValidFrame; i++) assert.equal(f.onset[i], 0, `trama ${i}`);
  for (let i = f.lastValidFrame + 1; i < f.numFrames; i++) assert.equal(f.onset[i], 0, `trama ${i}`);
  // junto a los bordes el flujo no supera al del interior (un tono estable: sólo ruido numérico)
  const interior = Math.max(...f.onset.subarray(20, f.numFrames - 20));
  const nearEdges = Math.max(...f.onset.subarray(f.firstValidFrame, f.firstValidFrame + 4), ...f.onset.subarray(f.lastValidFrame - 3, f.lastValidFrame + 1));
  assert.ok(nearEdges <= interior + 1e-6, `bordes ${nearEdges} vs interior ${interior}`);
});

test('findMusicBounds: un offset DC no cuenta como música (ni al principio ni en la cola)', () => {
  const x = new Float32Array(SR * 5);
  for (let i = SR; i < 3 * SR; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const clean = findMusicBounds(x, SR);
  const d = findMusicBounds(Float32Array.from(x, (v) => v + 0.2), SR);
  assert.ok(Math.abs(d.musicStart - clean.musicStart) < 0.02 && Math.abs(d.musicEnd - clean.musicEnd) < 0.02, `${d.musicStart} ${d.musicEnd}`);
  const onlyDc = findMusicBounds(new Float32Array(SR).fill(0.5), SR);
  assert.equal(onlyDc.musicEnd, 0);
});

test('findLastOnset: golpe final en un master muy limitado (el nivel total no sube, los agudos sí)', () => {
  // clics con un "platillo" (ruido agudo) en el golpe final; después, limitador a −12 dB con compensación
  const hits = grid(0.5, 0.5, 8);
  const x = clickTrain(hits, 12, { amp: 0.9 });
  const rng = new Rng(21);
  const t0 = Math.round(8 * SR);
  let lp = 0;
  for (let i = 0; t0 + i < x.length; i++) {
    const e = Math.exp(-i / (0.8 * SR));
    const w = rng.next() * 2 - 1;
    lp += 0.2 * (w - lp);
    x[t0 + i] += 0.5 * e * Math.sin((2 * Math.PI * 82 * i) / SR) + 0.4 * e * (w - lp);
  }
  for (const y of [x, brickwallLimit(x, SR, { thresholdDb: -12 }), hardClip(x, 8)]) {
    const f = computeFeatures(y, SR);
    const b = findMusicBounds(y, SR);
    const lo = findLastOnset(f, b.musicEnd);
    assert.ok(Math.abs(lo - 8) <= 2 / f.fps, `último onset ${lo}`);
  }
});

test('mastering: limitador brick-wall (techo, envolvente aplastada) y recorte duro; variantes con nombre', () => {
  const x = clickTrain(grid(0.2, 0.25, 3.8), 4, { amp: 0.9 });
  for (let i = 0; i < x.length; i++) x[i] += 0.02 * Math.sin((2 * Math.PI * 200 * i) / SR);
  const lim = brickwallLimit(x, SR, { thresholdDb: -12, ceilingDb: -0.3 });
  let peak = 0;
  for (const v of lim) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= Math.pow(10, -0.3 / 20) + 1e-6, `pico ${peak}`);
  assert.equal(lim.length, x.length);
  const clip = hardClip(x, 8);
  assert.ok(clip.every((v) => v >= -1 && v <= 1));
  assert.ok(clip.filter((v) => Math.abs(v) === 1).length > 100, 'hay muestras recortadas');
  assert.deepEqual(Object.keys(MASTERING_VARIANTS), ['limit12', 'clip4', 'clip8']);
  for (const v of Object.values(MASTERING_VARIANTS)) assert.equal(v.apply(x, SR).length, x.length);
  // conjuntos extra: nombres únicos y distintos de la suite
  const names = [...SETS.stress, ...SETS.extra].map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((nm) => !CASE_NAMES.includes(nm)));
});

// ---------------------------------------------------------------- límites

test('findMusicBounds con silencio y con ruido de fondo', () => {
  const x = new Float32Array(SR * 5);
  for (let i = SR; i < 3 * SR; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const b = findMusicBounds(x, SR);
  assert.ok(Math.abs(b.musicStart - 1) < 0.02, `start ${b.musicStart}`);
  assert.ok(Math.abs(b.musicEnd - 3) < 0.03, `end ${b.musicEnd}`);
  const rng = new Rng(5);
  const y = x.map((v) => v + 0.003 * (rng.next() * 2 - 1)); // ruido a ~-50 dB del tono
  const c = findMusicBounds(y, SR);
  assert.ok(Math.abs(c.musicStart - 1) < 0.03 && Math.abs(c.musicEnd - 3) < 0.04, `con ruido ${c.musicStart} ${c.musicEnd}`);
  // un clic aislado en el silencio final no cuenta
  const z = x.slice();
  z[Math.round(4.2 * SR)] = 0.9;
  const d = findMusicBounds(z, SR);
  assert.ok(Math.abs(d.musicEnd - 3) < 0.03, `clic aislado ${d.musicEnd}`);
  const s = findMusicBounds(new Float32Array(SR), SR);
  assert.equal(s.musicStart, 0);
  assert.equal(s.musicEnd, 0);
});

test('findLastOnset: golpe final con cola larga', () => {
  const hits = grid(0.5, 0.5, 8);
  const x = clickTrain(hits, 12, { amp: 0.5 });
  // golpe final en 8.0 s con resonancia de 3 s (ruido + tono que decae)
  const rng = new Rng(11);
  const t0 = Math.round(8 * SR);
  for (let i = 0; t0 + i < x.length; i++) {
    const e = Math.exp(-i / (0.9 * SR));
    x[t0 + i] += 0.8 * e * (0.5 * Math.sin((2 * Math.PI * 110 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 165.3 * i) / SR) + 0.1 * (rng.next() * 2 - 1));
  }
  const f = computeFeatures(x, SR);
  const b = findMusicBounds(x, SR);
  const lo = findLastOnset(f, b.musicEnd);
  assert.ok(Math.abs(lo - 8) <= 1.5 / f.fps, `último onset ${lo}`);
});

test('refineToTransients: ajusta al inicio del ataque y deja igual si no hay transitorio', () => {
  const x = new Float32Array(SR * 3);
  const rng = new Rng(2);
  // fondo tonal suave + bombo en 1.5 s
  for (let i = 0; i < x.length; i++) x[i] = 0.02 * Math.sin((2 * Math.PI * 330 * i) / SR);
  const s = Math.round(1.5 * SR);
  for (let i = 0; i < 0.3 * SR; i++) {
    const f = 55 + 100 * Math.exp(-i / (0.03 * SR));
    x[s + i] += 0.7 * Math.exp(-i / (0.15 * SR)) * Math.sin((2 * Math.PI * f * i) / SR) + 0.2 * Math.exp(-i / (0.002 * SR)) * (rng.next() * 2 - 1);
  }
  const [a, b, c] = refineToTransients(x, SR, [1.52, 1.475, 0.7]);
  assert.ok(Math.abs(a - 1.5) <= 0.002, `desde +20 ms: ${a}`);
  assert.ok(Math.abs(b - 1.5) <= 0.002, `desde -25 ms: ${b}`);
  assert.equal(c, 0.7, 'sin transitorio cerca queda igual');
});

// ---------------------------------------------------------------- métricas

test('métricas de beats, continuidad y tempo', () => {
  const ref = grid(1, 0.5, 30);
  assert.equal(beatFMeasure(ref, ref), 1);
  assert.equal(beatFMeasure(ref.map((t) => t + 0.1), ref), 0);
  const half = ref.filter((_, i) => i % 2 === 0);
  const r = fMeasure(half, ref);
  assert.equal(r.precision, 1);
  assert.ok(Math.abs(r.recall - 0.5) < 0.02);
  assert.ok(Math.abs(r.f - 2 / 3) < 0.02);
  assert.equal(matchEvents([1, 1.01], [1], 0.07).length, 1, 'emparejamiento uno a uno');
  const c1 = continuity(ref, ref);
  assert.equal(c1.cmlt, 1);
  assert.equal(c1.amlt, 1);
  const dbl = [];
  for (const t of ref) dbl.push(t, t + 0.25);
  const c2 = continuity(dbl, ref);
  assert.ok(c2.cmlt < 0.1 && c2.amlt > 0.95, `doble tempo ${JSON.stringify(c2)}`);
  const off = ref.map((t) => t + 0.25);
  const c3 = continuity(off, ref);
  assert.ok(c3.cmlt < 0.1 && c3.amlt > 0.95, 'contratiempo');
  assert.equal(fMeasure([0.5, 10, 50], ref, { range: [5, 20] }).nDet, 1, 'rango de evaluación');
  assert.equal(tempoCheck(121, 120).label, 'ok');
  assert.equal(tempoCheck(240, 120).label, '×2');
  assert.equal(tempoCheck(60.5, 120).label, '÷2');
  assert.equal(tempoCheck(180, 120).label, '×3/2');
  assert.equal(tempoCheck(80, 120).label, '×2/3');
  assert.equal(tempoCheck(100, 120).label, 'mal');
  assert.ok(Math.abs(medianBpm(ref) - 120) < 1e-6);
});

test('métricas del último compás', () => {
  const beats = grid(0, 0.5, 10);
  const downbeats = beats.map((_, i) => i).filter((i) => i % 4 === 0);
  assert.equal(lastBarStartFrom(beats, downbeats, 8.05), 8);
  assert.equal(lastBarStartFrom(beats, downbeats, 7.95), 8, 'tolerancia de 80 ms');
  assert.equal(lastBarStartFrom(beats, downbeats, 7.8), 6);
  assert.equal(lastBarStartFrom(beats, [], 5), null);
  assert.equal(lastBarOk(8.03, { lastBarStart: 8 }), true);
  assert.equal(lastBarOk(6, { lastBarStart: 8 }), false);
  assert.equal(lastBarOk(6, { lastBarStart: 8, lastBarAlternatives: [6, 8] }), true);
  assert.equal(lastBarOk(null, { lastBarStart: 8 }), false);
});

// ---------------------------------------------------------------- generador

test('generador determinista y verdad coherente', () => {
  const cfg = { seed: 42, style: 'rock', bpm: 130, bars: 6, jitterMs: 10, driftPct: 3, ending: { type: 'ring', ringSec: 2 } };
  const a = generateSong(cfg);
  const b = generateSong(cfg);
  assert.equal(a.samples.length, b.samples.length);
  for (let i = 0; i < a.samples.length; i += 97) assert.equal(a.samples[i], b.samples[i]);
  assert.deepEqual(a.truth, b.truth);
  const c = generateSong({ ...cfg, seed: 43 });
  assert.notDeepEqual(c.truth.beats, a.truth.beats);
  const t = a.truth;
  assert.equal(a.sampleRate, 22050);
  assert.equal(t.beatsPerBar, 4);
  for (let i = 1; i < t.beats.length; i++) assert.ok(t.beats[i] > t.beats[i - 1]);
  for (const i of t.downbeats) assert.equal(t.positions[i], 0);
  assert.ok(t.downbeats.map((i) => t.beats[i]).some((x) => Math.abs(x - t.lastBarStart) < 1e-6), 'lastBarStart es un downbeat');
  assert.ok(t.lastBarStart <= t.lastOnset + 0.08 && t.lastOnset < t.musicEnd && t.musicEnd <= t.duration);
  assert.ok(t.musicStart > 0 && t.musicStart < t.beats[0] + 0.1);
  for (let i = 1; i < t.noteOnsets.length; i++) assert.ok(t.noteOnsets[i] > t.noteOnsets[i - 1]);
  let pk = 0;
  for (const v of a.samples) pk = Math.max(pk, Math.abs(v));
  assert.ok(pk > 0.3 && pk < 1, `pico ${pk}`);
});

test('generador: finales, anacrusa y 3/4', () => {
  const ant = generateSong({ seed: 7, style: 'rock', bpm: 120, bars: 5, ending: { type: 'anticipated', ringSec: 2 } }).truth;
  // golpe en el "y" del 4: el último compás empieza 3.5 tiempos antes del golpe
  assert.ok(Math.abs(ant.finalHit - ant.lastBarStart - 3.5 * 0.5) < 0.01);
  const abr = generateSong({ seed: 7, style: 'rock', bpm: 120, bars: 5, ending: { type: 'abrupt' } }).truth;
  assert.ok(Math.abs(abr.musicEnd - (abr.lastBarStart + 2)) < 0.8, 'corte seco en la barra (más la cola de sala)');
  const fade = generateSong({ seed: 7, style: 'pop', bpm: 120, bars: 14, ending: { type: 'fadeout', fadeBars: 8 } }).truth;
  assert.equal(fade.lastBarAmbiguous, true);
  assert.ok(fade.lastBarAlternatives.length >= 1);
  const pick = generateSong({ seed: 7, style: 'pop', bpm: 100, bars: 4, pickupBeats: 2, ending: { type: 'ring', ringSec: 2 } }).truth;
  assert.ok(pick.downbeats[0] >= 1, 'hay tiempos de anacrusa antes del primer "1"');
  const waltz = generateSong({ seed: 7, style: 'waltz', beatsPerBar: 3, bpm: 150, bars: 6, ending: { type: 'ring', ringSec: 2 } }).truth;
  assert.equal(waltz.beatsPerBar, 3);
  assert.deepEqual(waltz.positions.slice(0, 6), [0, 1, 2, 0, 1, 2]);
  const rit = generateSong({ seed: 7, style: 'rock', bpm: 120, bars: 8, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.6 } }).truth;
  const ibi = rit.beats.slice(1).map((x, i) => x - rit.beats[i]);
  assert.ok(ibi[ibi.length - 1] > ibi[2] * 1.3, 'ritardando al final');
});

test('suite: nombres únicos y casos requeridos', () => {
  assert.equal(new Set(CASE_NAMES).size, CASE_NAMES.length);
  assert.ok(SUITE.length >= 16);
  for (const n of ['rock_steady_120', 'pad_vocal_only_80_nodrums', 'shuffle_12_8_70', 'long_song_4m30']) assert.ok(getCase(n));
  assert.throws(() => getCase('no_existe'));
});

test('wav-io: ida y vuelta 16/24/32f y mono', () => {
  const n = 1000;
  const l = Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin(i * 0.05));
  const r = Float32Array.from({ length: n }, (_, i) => -0.5 * Math.cos(i * 0.03));
  for (const bitDepth of [16, 24, 32]) {
    const d = decodeWav(encodeWavFile([l, r], 44100, { bitDepth }));
    assert.equal(d.sampleRate, 44100);
    assert.equal(d.channels.length, 2);
    const tol = bitDepth === 16 ? 1e-4 : 1e-6;
    for (let i = 0; i < n; i += 13) {
      assert.ok(Math.abs(d.channels[0][i] - l[i]) < tol && Math.abs(d.channels[1][i] - r[i]) < tol, `${bitDepth} bits`);
    }
    const m = toMono(d.channels);
    assert.ok(Math.abs(m[10] - (l[10] + r[10]) / 2) < tol * 2);
  }
});
