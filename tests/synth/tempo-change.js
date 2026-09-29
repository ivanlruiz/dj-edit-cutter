// Cambio de tempo brusco para el benchmark y los tests: empalme de dos versiones de la misma canción (misma semilla,
// otro tempo) en un "1". El generador sólo hace derivas y acelerandos graduales; un final más rápido (estribillo
// final, jam en directo) se simula así. La verdad se reconstruye con los beats de cada parte.
import { generateSong } from './generate.js';

const PRE = 0.008; // s: el empalme cae un poco antes del "1" para no partir su ataque
const XFADE = 0.01; // s de fundido cruzado (igual potencia)

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

/**
 * Empalma la canción A (hasta el "1" del compás `bar`, contando desde 0) con la B (desde su compás `bar`).
 * @param {{ samples: Float32Array, sampleRate: number, truth: object }} A
 * @param {{ samples: Float32Array, sampleRate: number, truth: object }} B
 * @returns {{ samples: Float32Array, sampleRate: number, truth: object }} truth con los campos de generateSong
 *   (beats, positions, downbeats, último compás, golpe final, límites, tempo mediano...); spliceAt = tiempo del empalme
 */
export function spliceSongs(A, B, bar) {
  const sr = A.sampleRate;
  const ta = A.truth.beats[A.truth.downbeats[bar]];
  const tb = B.truth.beats[B.truth.downbeats[bar]];
  const a = Math.round((ta - PRE) * sr);
  const b = Math.round((tb - PRE) * sr);
  const xf = Math.round(XFADE * sr);
  const n = a + (B.samples.length - b);
  const out = new Float32Array(n);
  out.set(A.samples.subarray(0, a));
  for (let i = 0; i < xf; i++) {
    const g = i / xf;
    out[a - xf + i] = A.samples[a - xf + i] * Math.cos(0.5 * Math.PI * g) + B.samples[b - xf + i] * Math.sin(0.5 * Math.PI * g);
  }
  out.set(B.samples.subarray(b), a);
  const d = (a - b) / sr; // desplazamiento de la parte B
  const sh = (v) => (v === null || v === undefined ? v : round6(v + d));
  const tA = A.truth;
  const tB = B.truth;
  const beats = [];
  const positions = [];
  tA.beats.forEach((t, i) => {
    if (t < ta - PRE) {
      beats.push(t);
      positions.push(tA.positions[i]);
    }
  });
  tB.beats.forEach((t, i) => {
    if (t >= tb - PRE) {
      beats.push(round6(t + d));
      positions.push(tB.positions[i]);
    }
  });
  const ibi = [];
  for (let i = 1; i < beats.length; i++) ibi.push(beats[i] - beats[i - 1]);
  const on = (list, from, shift) => (list || []).filter((t) => (from ? t >= tb - PRE : t < ta - PRE)).map((t) => round6(t + shift));
  const truth = {
    ...tB,
    duration: n / sr,
    beats,
    positions,
    downbeats: positions.map((p, i) => (p === 0 ? i : -1)).filter((i) => i >= 0),
    noteOnsets: [...on(tA.noteOnsets, false, 0), ...on(tB.noteOnsets, true, d)],
    noteOnsetsAttack: [...on(tA.noteOnsetsAttack, false, 0), ...on(tB.noteOnsetsAttack, true, d)],
    lastBarStart: sh(tB.lastBarStart),
    lastBarAlternatives: (tB.lastBarAlternatives || []).map(sh),
    lastOnset: sh(tB.lastOnset),
    finalHit: sh(tB.finalHit),
    musicStart: tA.musicStart,
    musicEnd: sh(tB.musicEnd),
    evalRange: [tA.evalRange[0], sh(tB.evalRange[1])],
    tempo: { ...tB.tempo, nominalBpm: tA.tempo.nominalBpm, bpm: round6(60 / median(ibi)), bpmAfter: tB.tempo.nominalBpm },
    spliceAt: round6(a / sr),
  };
  return { samples: out, sampleRate: sr, truth };
}

/** Canción con un cambio brusco de tempo: config hasta el compás `bar` y después la misma canción a `bpm`. */
export function tempoChangeSong(config, { bpm, bar }) {
  return spliceSongs(generateSong(config), generateSong({ ...config, bpm }), bar);
}
