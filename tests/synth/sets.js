// Conjuntos de validación adicionales (fuera de la suite oficial): semillas nuevas y ajustes más duros ("estrés") y
// casos extra de compases (3/4 y 4/4). Mismo generador que suite.js; los usa tools/bench.js (--sets stress,extra).
// Tags como en suite.js: 'band', 'nodrums', 'hard' (sin ataques: pads + voz), 'live', 'rit'.
import { generateSong } from './generate.js';

export const STRESS = [
  { name: 's_rit4_30_rock_100', tags: ['band', 'rit'], config: { seed: 501, style: 'rock', bpm: 100, bars: 24, jitterMs: 10, driftPct: 3, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4] } } },
  { name: 's_rit4_30_pop_128', tags: ['band', 'rit'], config: { seed: 502, style: 'pop', melody: true, bpm: 128, bars: 28, jitterMs: 8, driftPct: 2, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4] } } },
  { name: 's_rit4_30_piano_90', tags: ['nodrums', 'rit'], config: { seed: 503, style: 'pianoSolo', bpm: 90, bars: 20, jitterMs: 14, driftPct: 4, reverb: { wet: 0.25 }, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4] } } },
  { name: 's_rit4_30_acoustic_112', tags: ['nodrums', 'rit'], config: { seed: 504, style: 'acoustic', bpm: 112, bars: 24, jitterMs: 10, driftPct: 3, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4] } } },
  { name: 's_live_drift8_132', tags: ['band', 'live'], config: { seed: 505, style: 'rock', bpm: 132, bars: 32, jitterMs: 20, driftPct: 8, noiseDb: -58, ending: { type: 'ring' } } },
  { name: 's_live_drift6_95', tags: ['band', 'live'], config: { seed: 506, style: 'pop', melody: true, bpm: 95, bars: 26, jitterMs: 18, driftPct: 6, noiseDb: -60, ending: { type: 'ring' } } },
  { name: 's_rock_slow_76', tags: ['band'], config: { seed: 507, style: 'rock', bpm: 76, bars: 20, jitterMs: 8, driftPct: 2, ending: { type: 'ring' } } },
  { name: 's_punk_200', tags: ['band'], config: { seed: 508, style: 'punk', bpm: 200, bars: 44, jitterMs: 6, driftPct: 2, ending: { type: 'ring' } } },
  { name: 's_funk_94', tags: ['band'], config: { seed: 509, style: 'funk', bpm: 94, bars: 24, jitterMs: 7, syncopation: 0.9, ending: { type: 'anticipated' } } },
  { name: 's_shuffle_58', tags: ['band'], config: { seed: 510, style: 'shuffle', subdiv: 3, bpm: 58, bars: 16, jitterMs: 10, driftPct: 2, ending: { type: 'ring' } } },
  { name: 's_shuffle_92', tags: ['band'], config: { seed: 511, style: 'shuffle', subdiv: 3, bpm: 92, bars: 20, jitterMs: 8, driftPct: 3, ending: { type: 'abrupt' } } },
  { name: 's_pop_fade_128', tags: ['band'], config: { seed: 512, style: 'pop', pad: true, melody: true, bpm: 128, bars: 36, jitterMs: 6, ending: { type: 'fadeout', fadeBars: 8 } } },
  { name: 's_breakdown_120', tags: ['band'], config: { seed: 513, style: 'pop', pad: true, melody: true, bpm: 120, bars: 36, breakdowns: [[16, 4]], jitterMs: 8, driftPct: 2, ending: { type: 'ring' } } },
  { name: 's_intro_acoustic_104', tags: ['band'], config: { seed: 514, style: 'rock', introBars: 6, introGuitar: 'strum', bpm: 104, bars: 26, jitterMs: 9, driftPct: 3, ending: { type: 'ring' } } },
  { name: 's_ballad_piano_58', tags: ['nodrums'], config: { seed: 515, style: 'ballad', bpm: 58, bars: 14, jitterMs: 15, driftPct: 4, reverb: { wet: 0.3 }, ending: { type: 'ring', ringSec: [3.5, 5] } } },
  { name: 's_ballad_pad_78', tags: ['nodrums'], config: { seed: 516, style: 'ballad', pad: true, bpm: 78, bars: 18, jitterMs: 12, driftPct: 3, reverb: { wet: 0.3 }, ending: { type: 'ring' } } },
  { name: 's_acoustic_132', tags: ['nodrums'], config: { seed: 517, style: 'acoustic', bpm: 132, bars: 28, jitterMs: 10, driftPct: 3, ending: { type: 'ring' } } },
  { name: 's_acoustic_live_84', tags: ['nodrums', 'live'], config: { seed: 518, style: 'acoustic', bpm: 84, bars: 22, jitterMs: 18, driftPct: 6, noiseDb: -58, ending: { type: 'ring' } } },
  { name: 's_piano_rubato_72', tags: ['nodrums', 'live'], config: { seed: 519, style: 'pianoSolo', bpm: 72, bars: 18, jitterMs: 20, driftPct: 7, reverb: { wet: 0.3 }, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.65, ringSec: [3, 4] } } },
  { name: 's_piano_128', tags: ['nodrums'], config: { seed: 520, style: 'pianoSolo', bpm: 128, bars: 28, jitterMs: 12, driftPct: 3, ending: { type: 'ring' } } },
  { name: 's_waltz_100', tags: ['nodrums'], config: { seed: 521, style: 'waltz', beatsPerBar: 3, bpm: 100, bars: 32, jitterMs: 12, driftPct: 4, ending: { type: 'ring' } } },
  { name: 's_waltz_176', tags: ['nodrums'], config: { seed: 522, style: 'waltz', beatsPerBar: 3, bpm: 176, bars: 48, jitterMs: 10, driftPct: 3, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.7 } } },
  { name: 's_padvocal_70', tags: ['nodrums', 'hard'], config: { seed: 523, style: 'padVocal', bpm: 70, bars: 16, jitterMs: 15, driftPct: 2, reverb: { wet: 0.3 }, ending: { type: 'ring', ringSec: [3, 4] } } },
  { name: 's_padvocal_96', tags: ['nodrums', 'hard'], config: { seed: 524, style: 'padVocal', bpm: 96, bars: 20, jitterMs: 12, driftPct: 2, reverb: { wet: 0.3 }, ending: { type: 'ring', ringSec: [3, 4] } } },
  { name: 's_accel12_100', tags: ['band', 'live'], config: { seed: 525, style: 'rock', bpm: 100, bars: 32, jitterMs: 12, driftPct: 3, accelPct: 12, ending: { type: 'ring' } } },
  { name: 's_abrupt_165', tags: ['band'], config: { seed: 526, style: 'rock', bpm: 165, bars: 40, jitterMs: 6, driftPct: 2, ending: { type: 'abrupt' } } },
  { name: 's_pickup_pop_104', tags: ['band'], config: { seed: 527, style: 'pop', melody: true, pickupBeats: 3, bpm: 104, bars: 24, jitterMs: 8, driftPct: 2, ending: { type: 'anticipated' } } },
  { name: 's_live_rit_band_140', tags: ['band', 'live', 'rit'], config: { seed: 528, style: 'rock', bpm: 140, bars: 36, jitterMs: 14, driftPct: 5, noiseDb: -60, ending: { type: 'ritFermata', ritBars: 4, ritRatio: 0.7, ringSec: [3, 4.5] } } },
];

export const EXTRA = [
  { name: 'x3_waltz_a', tags: ['nodrums'], config: { seed: 201, style: 'waltz', beatsPerBar: 3, bpm: 96, bars: 40, jitterMs: 10, driftPct: 3, ending: { type: 'ring' } } },
  { name: 'x3_waltz_b', tags: ['nodrums'], config: { seed: 202, style: 'waltz', beatsPerBar: 3, bpm: 168, bars: 48, jitterMs: 14, driftPct: 4, reverb: { wet: 0.3 }, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.7 } } },
  { name: 'x3_rock', tags: ['band'], config: { seed: 203, style: 'rock', beatsPerBar: 3, bpm: 104, bars: 32, jitterMs: 8, driftPct: 2, ending: { type: 'ring' } } },
  { name: 'x3_pop', tags: ['band'], config: { seed: 204, style: 'pop', beatsPerBar: 3, melody: true, pad: true, bpm: 88, bars: 32, jitterMs: 8, driftPct: 2, ending: { type: 'ring' } } },
  { name: 'x3_acoustic', tags: ['nodrums'], config: { seed: 205, style: 'acoustic', beatsPerBar: 3, bpm: 112, bars: 32, jitterMs: 10, driftPct: 3, ending: { type: 'ring' } } },
  { name: 'x3_ballad', tags: ['nodrums'], config: { seed: 206, style: 'ballad', beatsPerBar: 3, pad: true, bpm: 72, bars: 24, jitterMs: 12, driftPct: 3, reverb: { wet: 0.3 }, ending: { type: 'ring' } } },
  { name: 'x3_piano', tags: ['nodrums'], config: { seed: 207, style: 'pianoSolo', beatsPerBar: 3, bpm: 92, bars: 30, jitterMs: 15, driftPct: 4, ending: { type: 'ring' } } },
  { name: 'x3_padvocal', tags: ['nodrums', 'hard'], config: { seed: 208, style: 'padVocal', beatsPerBar: 3, bpm: 84, bars: 28, jitterMs: 15, driftPct: 2, reverb: { wet: 0.3 }, ending: { type: 'ring' } } },
  { name: 'x3_funk', tags: ['band'], config: { seed: 209, style: 'funk', beatsPerBar: 3, bpm: 100, bars: 30, jitterMs: 6, ending: { type: 'ring' } } },
  { name: 'x4_rock', tags: ['band'], config: { seed: 211, style: 'rock', bpm: 95, bars: 30, jitterMs: 9, driftPct: 3, ending: { type: 'ring' } } },
  { name: 'x4_pop', tags: ['band'], config: { seed: 212, style: 'pop', pad: true, melody: true, bpm: 128, bars: 36, jitterMs: 6, driftPct: 2, ending: { type: 'ring' } } },
  { name: 'x4_funk', tags: ['band'], config: { seed: 213, style: 'funk', bpm: 108, bars: 28, jitterMs: 7, syncopation: 0.9, ending: { type: 'abrupt' } } },
  { name: 'x4_acoustic', tags: ['nodrums'], config: { seed: 214, style: 'acoustic', bpm: 84, bars: 26, jitterMs: 12, driftPct: 4, ending: { type: 'ring' } } },
  { name: 'x4_ballad', tags: ['nodrums'], config: { seed: 215, style: 'ballad', pad: true, bpm: 76, bars: 18, jitterMs: 12, driftPct: 3, reverb: { wet: 0.3 }, ending: { type: 'ring' } } },
  { name: 'x4_piano', tags: ['nodrums'], config: { seed: 216, style: 'pianoSolo', bpm: 120, bars: 28, jitterMs: 14, driftPct: 4, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.7 } } },
  { name: 'x4_punk', tags: ['band'], config: { seed: 217, style: 'punk', bpm: 168, bars: 40, jitterMs: 8, ending: { type: 'ring' } } },
  { name: 'x4_shuffle', tags: ['band'], config: { seed: 218, style: 'shuffle', subdiv: 3, bpm: 84, bars: 20, jitterMs: 9, ending: { type: 'ring' } } },
  { name: 'x4_padvocal', tags: ['nodrums', 'hard'], config: { seed: 219, style: 'padVocal', bpm: 92, bars: 22, jitterMs: 15, driftPct: 2, reverb: { wet: 0.3 }, ending: { type: 'ring' } } },
  { name: 'x4_pickup1', tags: ['band'], config: { seed: 220, style: 'pop', melody: true, pickupBeats: 1, bpm: 100, bars: 24, jitterMs: 8, ending: { type: 'anticipated' } } },
  { name: 'x4_pickup3_intro', tags: ['band'], config: { seed: 221, style: 'rock', pickupBeats: 3, introBars: 6, introGuitar: 'arp', bpm: 132, bars: 30, jitterMs: 8, driftPct: 3, ending: { type: 'ring' } } },
  { name: 'x4_fade', tags: ['band'], config: { seed: 222, style: 'rock', pad: true, bpm: 100, bars: 34, jitterMs: 9, driftPct: 3, ending: { type: 'fadeout', fadeBars: 8 } } },
];

export const SETS = { stress: STRESS, extra: EXTRA };

/** Genera un caso de un conjunto: { name, tags, samples, sampleRate, truth }. */
export function generateSetCase(set, name) {
  const list = SETS[set];
  if (!list) throw new Error(`Conjunto desconocido: ${set}`);
  const c = list.find((x) => x.name === name);
  if (!c) throw new Error(`Caso desconocido en ${set}: ${name}`);
  const { samples, sampleRate, truth } = generateSong(c.config);
  return { name: c.name, tags: c.tags, samples, sampleRate, truth: { name: c.name, ...truth } };
}
