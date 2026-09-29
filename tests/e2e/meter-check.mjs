// Comprobación musical de un audio exportado con el compás cambiado, usando el análisis de la propia app (Node).
//
// 1. Se siguen los beats a la unidad del compás nuevo (corcheas para x/8, negras para x/4; si la unidad pasa de
//    300 BPM, a la mitad: 15/16 a 120 BPM se sigue en corcheas).
// 2. Periodicidad de compás (meterPeriodicity de downbeats.js) para M = 2..16 beats: el período fundamental (el M más
//    pequeño con puntuación >= 80 % de la máxima) debe ser el número de unidades del compás nuevo (7 en 7/8, 3 en 3/4,
//    5 en 5/4; 15 corcheas = 2 compases de 15/16). En el original en 4/4 da 4 (control).
// 3. Si el compás cabe en labelBars (<= 7), los "1" que encuentra están a ~num unidades entre sí.

import { analyze, computeFeatures, prepareSamples } from '../../js/analysis/analyze.js';
import { beatSyncFeatures, localStandardize, meterPeriodicity, labelBars } from '../../js/analysis/downbeats.js';

const KEYS = ['low', 'ons', 'hc1', 'hc2', 'acc'];
const MAX_TRACK_BPM = 300;

function median(a) {
  const s = Array.from(a).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function standardized(bf) {
  const n = bf.n;
  const K = KEYS.length;
  const Z = new Float64Array(n * K);
  KEYS.forEach((key, k) => {
    const z = localStandardize(bf[key], 12, 0.5);
    for (let i = 0; i < n; i++) Z[i * K + k] = Math.max(-4, Math.min(4, z[i]));
  });
  return Z;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/**
 * @param {Float32Array[]} channels audio exportado
 * @param {number} sampleRate
 * @param {{ num:number, den:number, sourceBpm:number }} meter compás nuevo y tempo (negras) del original
 * @returns {{ ok, detail, period, expectedPeriod, trackedBpm, unitBpm, scores, barMedianUnits, barIntervals }}
 */
export function checkMeter(channels, sampleRate, { num, den, sourceBpm }) {
  const n = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
  // rejilla que se sigue: la unidad del compás, o su doble si es demasiado rápida
  let grid = den;
  while (sourceBpm * (grid / 4) > MAX_TRACK_BPM && grid > 4) grid /= 2;
  const unitBpm = sourceBpm * (grid / 4);
  const res = analyze(mono, sampleRate, { minBpm: unitBpm * 0.75, maxBpm: unitBpm * 1.33 });
  const beats = res.beats;
  const feats = computeFeatures(prepareSamples(mono, sampleRate), 22050);
  const bf = beatSyncFeatures(feats, beats);
  const Z = standardized(bf);
  const scores = {};
  let best = -Infinity;
  for (let M = 2; M <= 16; M++) {
    scores[M] = meterPeriodicity(Z, bf.n, KEYS.length, M, 48, 24);
    best = Math.max(best, scores[M]);
  }
  let period = null;
  for (let M = 2; M <= 16; M++) {
    if (scores[M] >= 0.8 * best) {
      period = M;
      break;
    }
  }
  // unidades de la rejilla por compás: num · grid / den; si no es entero, el patrón se repite cada 2 compases
  const perBar = (num * grid) / den;
  const reps = den / gcd(num * grid, den);
  const expectedPeriod = perBar * reps;
  const tempoOk = Math.abs(res.bpm / unitBpm - 1) < 0.08;
  let barMedianUnits = null;
  let barIntervals = [];
  if (Number.isInteger(perBar) && perBar >= 2 && perBar <= 7) {
    const lb = labelBars(feats, beats, { beatsPerBar: perBar });
    const ibi = median(beats.slice(1).map((b, i) => b - beats[i]));
    const db = lb.downbeats.map((i) => beats[i]);
    barIntervals = db.slice(1).map((t, i) => t - db[i]);
    barMedianUnits = median(barIntervals) / ibi;
  }
  const barsOk = barMedianUnits === null || Math.abs(barMedianUnits - perBar) < 0.2;
  const ok = tempoOk && period === expectedPeriod && barsOk;
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, v]) => `${m}:${v.toFixed(2)}`).join(' ');
  const detail = `rejilla 1/${grid} a ${res.bpm} BPM (esperado ≈ ${unitBpm.toFixed(1)}), período ${period} ` +
    `(esperado ${expectedPeriod}; mejores ${top})` +
    (barMedianUnits !== null ? `, "1" cada ${barMedianUnits.toFixed(2)} unidades (esperado ${perBar}, ${barIntervals.length} compases)` : '');
  return { ok, detail, period, expectedPeriod, trackedBpm: res.bpm, unitBpm, scores, barMedianUnits, barIntervals };
}
