// Suite de casos sintéticos con nombre para el benchmark y los tests.
import { generateSong } from './generate.js';

/**
 * tags: 'band' (con batería), 'nodrums', 'live' (deriva/jitter altos), 'hard', 'long'.
 * Los casos 'long' se excluyen por defecto del bench rápido salvo que se pidan (ver tools/bench.js).
 */
export const SUITE = [
  {
    name: 'rock_steady_120',
    tags: ['band'],
    description: 'Rock 4/4 estable, batería completa, final con golpe y resonancia',
    config: { seed: 101, style: 'rock', bpm: 120, bars: 30, jitterMs: 5, ending: { type: 'ring' } },
  },
  {
    name: 'live_rock_drift_128',
    tags: ['band', 'live'],
    description: 'Rock en vivo: deriva de tempo ±6 %, jitter 15 ms, ruido de fondo',
    config: { seed: 102, style: 'rock', bpm: 128, bars: 32, jitterMs: 15, driftPct: 6, noiseDb: -64, ending: { type: 'ring' } },
  },
  {
    name: 'punk_180',
    tags: ['band'],
    description: 'Punk rápido a 180 BPM (riesgo de ÷2)',
    config: { seed: 103, style: 'punk', bpm: 180, bars: 40, jitterMs: 8, driftPct: 2, ending: { type: 'ring', ringSec: [2, 3] } },
  },
  {
    name: 'ballad_piano_pad_66_nodrums',
    tags: ['nodrums'],
    description: 'Balada lenta: piano arpegiado + pad, sin batería (riesgo de ×2)',
    config: { seed: 104, style: 'ballad', pad: true, bpm: 66, bars: 16, jitterMs: 12, driftPct: 3, reverb: { wet: 0.3 }, ending: { type: 'ring', ringSec: [3.5, 5] } },
  },
  {
    name: 'acoustic_strum_96_nodrums',
    tags: ['nodrums'],
    description: 'Guitarra acústica rasgueada (D-DU-UDU), sin batería',
    config: { seed: 105, style: 'acoustic', bpm: 96, bars: 24, jitterMs: 10, driftPct: 3, ending: { type: 'ring' } },
  },
  {
    name: 'piano_solo_100_nodrums',
    tags: ['nodrums', 'live'],
    description: 'Piano solo con rubato (deriva 5 %, jitter 18 ms), ritardando + fermata',
    config: { seed: 106, style: 'pianoSolo', bpm: 100, bars: 22, jitterMs: 18, driftPct: 5, reverb: { wet: 0.28 }, ending: { type: 'ritFermata', ritBars: 2, ritRatio: 0.7, ringSec: [3, 4] } },
  },
  {
    name: 'waltz_piano_3_4_nodrums',
    tags: ['nodrums'],
    description: 'Vals 3/4 al piano (bajo en el 1, acordes en 2 y 3)',
    config: { seed: 107, style: 'waltz', beatsPerBar: 3, bpm: 144, bars: 40, jitterMs: 12, driftPct: 3, sectionBars: 8, ending: { type: 'ring' } },
  },
  {
    name: 'pop_fadeout_110',
    tags: ['band'],
    description: 'Pop con voz y pad, termina con fade out de 12 compases (último compás ambiguo)',
    config: { seed: 108, style: 'pop', pad: true, melody: true, bpm: 110, bars: 36, jitterMs: 6, ending: { type: 'fadeout', fadeBars: 12 } },
  },
  {
    name: 'live_band_ritardando_fermata_104',
    tags: ['band', 'live'],
    description: 'Banda en vivo, ritardando en los últimos 3 compases + fermata',
    config: { seed: 109, style: 'rock', bpm: 104, bars: 28, jitterMs: 14, driftPct: 4, noiseDb: -62, ending: { type: 'ritFermata', ritBars: 3, ritRatio: 0.6, ringSec: [3, 4.5] } },
  },
  {
    name: 'intro_nodrums_then_band_118',
    tags: ['band'],
    description: 'Intro de 8 compases con guitarra arpegiada sola y luego banda completa',
    config: { seed: 110, style: 'rock', introBars: 8, introGuitar: 'arp', bpm: 118, bars: 30, jitterMs: 8, driftPct: 2, ending: { type: 'ring' } },
  },
  {
    name: 'pad_vocal_only_80_nodrums',
    tags: ['nodrums', 'hard'],
    description: 'Sólo pad legato + voz con vibrato: casi sin ataques (caso difícil)',
    config: { seed: 111, style: 'padVocal', bpm: 80, bars: 20, jitterMs: 15, driftPct: 2, reverb: { wet: 0.3 }, chordHoldTwoBars: 0.1, ending: { type: 'ring', ringSec: [3, 4] } },
  },
  {
    name: 'shuffle_12_8_70',
    tags: ['band'],
    description: 'Shuffle 12/8 anotado en negra con puntillo (4 tiempos por compás)',
    config: { seed: 112, style: 'shuffle', subdiv: 3, bpm: 70, bars: 18, jitterMs: 9, driftPct: 2, sectionBars: 4, ending: { type: 'ring' } },
  },
  {
    name: 'funk_syncopated_100',
    tags: ['band'],
    description: 'Funk sincopado: bombo desplazado, fantasmas, guitarra en contratiempo',
    config: { seed: 113, style: 'funk', bpm: 100, bars: 26, jitterMs: 6, syncopation: 0.8, ending: { type: 'ring' } },
  },
  {
    name: 'abrupt_stop_140',
    tags: ['band'],
    description: 'Rock a 140 que se corta en seco justo en la barra de compás',
    config: { seed: 114, style: 'rock', bpm: 140, bars: 34, jitterMs: 7, driftPct: 2, ending: { type: 'abrupt' } },
  },
  {
    name: 'anticipated_final_hit_124',
    tags: ['band'],
    description: 'Golpe final anticipado en el "y" del 4 (el último compás es el que contiene el golpe)',
    config: { seed: 115, style: 'rock', bpm: 124, bars: 30, jitterMs: 7, driftPct: 2, ending: { type: 'anticipated' } },
  },
  {
    name: 'pickup_bar_start_92',
    tags: ['band'],
    description: 'Pop con anacrusa de 2 tiempos antes del compás 1',
    config: { seed: 116, style: 'pop', melody: true, pickupBeats: 2, bpm: 92, bars: 24, jitterMs: 8, driftPct: 2, ending: { type: 'ring' } },
  },
  {
    name: 'live_accelerando_112',
    tags: ['band', 'live'],
    description: 'Banda en vivo que acelera un 8 % a lo largo del tema',
    config: { seed: 117, style: 'rock', bpm: 112, bars: 30, jitterMs: 12, driftPct: 3, accelPct: 8, ending: { type: 'ring' } },
  },
  {
    name: 'long_song_4m30',
    tags: ['band', 'long'],
    description: 'Tema de banda de 4:30 (rendimiento): intro, voz, pad, deriva leve, 8 compases sin batería a mitad',
    config: { seed: 118, style: 'pop', pad: true, melody: true, introBars: 4, introPiano: true, breakdowns: [[68, 8]], bpm: 122, bars: 137, jitterMs: 9, driftPct: 3, ending: { type: 'ring' } },
  },
];

export const CASE_NAMES = SUITE.map((c) => c.name);

export function getCase(name) {
  const c = SUITE.find((x) => x.name === name);
  if (!c) throw new Error(`Caso desconocido: ${name}`);
  return c;
}

/** Genera un caso de la suite: { name, tags, description, samples, sampleRate, truth }. */
export function generateCase(name) {
  const c = getCase(name);
  const { samples, sampleRate, truth } = generateSong(c.config);
  return { name: c.name, tags: c.tags, description: c.description, samples, sampleRate, truth: { name: c.name, ...truth } };
}
