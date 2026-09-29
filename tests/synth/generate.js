// Generador de canciones sintéticas con verdad de referencia (ground truth) para evaluar el análisis.
// Todo es determinista a partir de `seed`. Salida: mono Float32Array a 22050 Hz.
import { Rng } from './prng.js';
import {
  makeBus, mixInto, midiToHz, renderKick, renderSnare, renderHat, renderCymbal, renderTom,
  renderPiano, renderBass, renderPluck, renderPad, renderVocal, reverb,
} from './instruments.js';

export const GENERATOR_VERSION = 3;
export const SYNTH_SAMPLE_RATE = 22050;

// Umbral de "hay música" usado para la verdad de musicStart/musicEnd (RMS en ventanas de 20 ms, relativo al máximo).
export const GT_SILENCE_DB = -50;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

// Progresiones en grados (0 = I). q: 'M' mayor, 'm' menor.
const PROGRESSIONS = {
  pop: [[[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], [[9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']], [[0, 'M'], [9, 'm'], [5, 'M'], [7, 'M']]],
  rock: [[[0, 'M'], [5, 'M'], [7, 'M'], [5, 'M']], [[0, 'M'], [10, 'M'], [5, 'M'], [0, 'M']], [[9, 'm'], [5, 'M'], [0, 'M'], [7, 'M']]],
  ballad: [[[0, 'M'], [4, 'm'], [9, 'm'], [5, 'M'], [2, 'm'], [7, 'M']], [[0, 'M'], [7, 'M'], [9, 'm'], [4, 'm'], [5, 'M'], [0, 'M'], [5, 'M'], [7, 'M']]],
  blues: [[[0, 'M'], [0, 'M'], [0, 'M'], [0, 'M'], [5, 'M'], [5, 'M'], [0, 'M'], [0, 'M'], [7, 'M'], [5, 'M'], [0, 'M'], [7, 'M']]],
  waltz: [[[0, 'M'], [5, 'M'], [7, 'M'], [0, 'M'], [9, 'm'], [2, 'm'], [7, 'M'], [0, 'M']]],
  funk: [[[9, 'm'], [9, 'm'], [2, 'M'], [9, 'm']], [[2, 'm'], [7, 'M'], [2, 'm'], [7, 'M']]],
};

function chordTones(root, q) {
  return q === 'm' ? [root, root + 3, root + 7] : [root, root + 4, root + 7];
}

/** Configuración por defecto; ver suite.js para los casos. */
export const DEFAULTS = {
  seed: 1,
  sampleRate: SYNTH_SAMPLE_RATE,
  bpm: 120,
  beatsPerBar: 4,
  subdiv: 2, // 2 = corcheas, 3 = tresillos (12/8 anotado en negra con puntillo)
  bars: 24, // compases contados, incluido el del golpe final
  pickupBeats: 0, // anacrusa (tiempos antes del compás 1)
  introBars: 0, // compases iniciales sin batería
  breakdowns: [], // [[compás, cantidad], ...]: tramos sin batería a mitad de canción
  style: 'rock', // rock | punk | pop | funk | shuffle | ballad | acoustic | pianoSolo | waltz | padVocal
  progression: null, // nombre en PROGRESSIONS; por defecto según estilo
  keyRoot: null, // clase de altura 0..11; aleatoria si null
  sectionBars: 8,
  jitterMs: 8, // desvío típico por evento (ms)
  driftPct: 0, // deriva de tempo máxima (±%), paseo aleatorio
  accelPct: 0, // acelerando total a lo largo de la canción (%)
  syncopation: 0.3, // 0..1
  chordChangeMidBar: 0.12, // prob. de cambio de acorde a mitad de compás
  chordHoldTwoBars: 0.2, // prob. de mantener el acorde 2 compases
  melody: false, // voz legato
  ending: { type: 'ring' }, // ring | fadeout | ritFermata | abrupt | anticipated
  leadSilence: [0.05, 0.8], // s (rango aleatorio)
  tailSilence: [0.2, 2.5],
  noiseDb: null, // ruido de fondo (dBFS), null = sin ruido
  peakDb: [-6, -1], // nivel de pico final (dBFS)
  reverb: { wet: 0.18, size: 1, feedback: 0.8 },
  levels: {}, // ganancias por instrumento
};

function resolveRange(rng, v) {
  return Array.isArray(v) ? rng.uniform(v[0], v[1]) : v;
}

/**
 * Genera una canción.
 * @returns {{ samples: Float32Array, sampleRate: number, truth: object }}
 */
export function generateSong(userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg, ending: { ...DEFAULTS.ending, ...(userCfg.ending || {}) } };
  cfg.reverb = { ...DEFAULTS.reverb, ...(userCfg.reverb || {}) };
  const sr = cfg.sampleRate;
  const rng = new Rng(cfg.seed);
  const bpb = cfg.beatsPerBar;
  const nBars = cfg.bars;
  const P = cfg.pickupBeats;
  const ending = cfg.ending;
  const lastBar = nBars - 1;

  // ---------------------------------------------------------------- mapa de tempo (por tiempo)
  const trng = rng.fork('tempo');
  const totalBeats = P + nBars * bpb + 16; // margen para la cola
  const bpmArr = new Float64Array(totalBeats);
  const drift = cfg.driftPct / 100;
  const sigma = drift > 0 ? drift * 0.2 : 0;
  let u = 0;
  const accelTotal = Math.log(1 + cfg.accelPct / 100);
  const musicBeats = P + nBars * bpb;
  for (let k = 0; k < totalBeats; k++) {
    if (drift > 0) {
      u = 0.98 * u + trng.gauss(0, sigma);
      if (u > Math.log(1 + drift)) u = Math.log(1 + drift) - Math.abs(u - Math.log(1 + drift));
      if (u < Math.log(1 - drift)) u = Math.log(1 - drift) + Math.abs(u - Math.log(1 - drift));
    }
    const acc = accelTotal * Math.min(1, k / musicBeats);
    bpmArr[k] = cfg.bpm * Math.exp(u + acc);
  }
  // ritardando antes del golpe final
  if (ending.type === 'ritFermata') {
    const ritBeats = Math.round((ending.ritBars ?? 3) * bpb);
    const finalK = P + lastBar * bpb;
    const ratio = ending.ritRatio ?? 0.65;
    for (let k = finalK - ritBeats; k < totalBeats; k++) {
      const x = Math.min(1, Math.max(0, (k - (finalK - ritBeats) + 0.5) / ritBeats));
      bpmArr[k] *= 1 - (1 - ratio) * x * x;
    }
  }
  // T[k] = instante del tiempo global k (k = 0 es el primer tiempo de la anacrusa, P es el "1" del compás 1)
  const lead = resolveRange(rng, cfg.leadSilence);
  const T = new Float64Array(totalBeats + 1);
  T[0] = lead;
  for (let k = 0; k < totalBeats; k++) T[k + 1] = T[k] + 60 / bpmArr[k];
  const beatTime = (pos) => {
    // pos en tiempos relativos al "1" del compás 1 (puede ser negativo en la anacrusa)
    const g = pos + P;
    const k = Math.max(0, Math.min(totalBeats - 1, Math.floor(g)));
    return T[k] + (g - k) * (T[k + 1] - T[k]);
  };

  // ---------------------------------------------------------------- armonía
  const hrng = rng.fork('harmony');
  const keyRoot = cfg.keyRoot ?? hrng.int(0, 11);
  const styleProg = {
    rock: 'rock', punk: 'rock', pop: 'pop', funk: 'funk', shuffle: 'blues', ballad: 'ballad',
    acoustic: 'pop', pianoSolo: 'ballad', waltz: 'waltz', padVocal: 'ballad',
  }[cfg.style] || 'pop';
  const progList = PROGRESSIONS[cfg.progression || styleProg];
  const prog = hrng.pick(progList);
  // acordes por compás: lista de { pos (tiempo dentro del compás), tones (clases), root }
  const barChords = [];
  let pi = 0;
  let held = false;
  for (let b = 0; b < nBars; b++) {
    const [deg, q] = prog[pi % prog.length];
    const root = (keyRoot + deg) % 12;
    const list = [{ pos: 0, root, q }];
    if (held) {
      list[0] = { ...barChords[b - 1][barChords[b - 1].length - 1], pos: 0 };
      held = false;
      pi++;
    } else if (bpb >= 4 && hrng.chance(cfg.chordChangeMidBar) && b < nBars - 2) {
      const [deg2, q2] = prog[(pi + 1) % prog.length];
      list.push({ pos: Math.floor(bpb / 2), root: (keyRoot + deg2) % 12, q: q2 });
      pi += 2;
    } else if (hrng.chance(cfg.chordHoldTwoBars) && b < nBars - 2) {
      held = true;
    } else {
      pi++;
    }
    barChords.push(list);
  }
  // acorde final = tónica
  barChords[lastBar] = [{ pos: 0, root: keyRoot, q: 'M' }];
  if (ending.type === 'anticipated') barChords[lastBar].push({ pos: bpb - 0.5, root: keyRoot, q: 'M' });
  const chordAt = (bar, pos) => {
    const list = barChords[Math.max(0, Math.min(nBars - 1, bar))];
    let c = list[0];
    for (const x of list) if (x.pos <= pos + 1e-9) c = x;
    return c;
  };

  // ---------------------------------------------------------------- secciones
  const sectionOf = (bar) => {
    if (bar < cfg.introBars) return 'intro';
    const s = Math.floor((bar - cfg.introBars) / cfg.sectionBars);
    return s % 2 === 0 ? 'verse' : 'chorus';
  };
  const isSectionStart = (bar) => bar === cfg.introBars || (bar > cfg.introBars && (bar - cfg.introBars) % cfg.sectionBars === 0);
  const energyOf = (bar) => ({ intro: 0.7, verse: 0.82, chorus: 1 })[sectionOf(bar)];

  // ---------------------------------------------------------------- eventos
  // evento: { pos, inst, vel, ...params }. pos en tiempos (float) relativos al "1" del compás 1.
  const events = [];
  const erng = rng.fork('events');
  const push = (e) => events.push(e);
  const style = cfg.style;
  const sub = cfg.subdiv;
  const inBreakdown = (bar) => (cfg.breakdowns || []).some(([b0, n]) => bar >= b0 && bar < b0 + n);
  const drumsOn = (bar) => ['rock', 'punk', 'pop', 'funk', 'shuffle'].includes(style) && bar >= cfg.introBars && !inBreakdown(bar);
  const vj = (v, amt = 0.08) => Math.max(0.05, v * (1 + erng.gauss(0, amt)));

  // fin de la música tocada (en tiempos) según el final
  let playEndPos; // eventos normales sólo con pos < playEndPos
  let finalHitPos = null;
  if (ending.type === 'ring' || ending.type === 'ritFermata') {
    finalHitPos = lastBar * bpb;
    playEndPos = finalHitPos;
  } else if (ending.type === 'anticipated') {
    finalHitPos = lastBar * bpb + bpb - 0.5;
    playEndPos = finalHitPos;
  } else {
    playEndPos = nBars * bpb; // abrupt / fadeout: todos los compases completos
  }

  const guitarVoicing = (root, q, power) => {
    let r = 40 + ((root - 40) % 12 + 12) % 12; // entre E2 y D#3
    if (r > 47) r -= 12;
    if (power) return [r, r + 7, r + 12];
    const third = q === 'm' ? 15 : 16;
    return [r, r + 7, r + 12, r + third, r + 19, r + 24];
  };
  const pianoVoicing = (root, q, base = 60) => {
    const tones = chordTones(root, q).map((t) => base + ((t - base) % 12 + 12) % 12);
    return tones.sort((a, b) => a - b);
  };
  const bassNote = (root) => 28 + ((root - 28) % 12 + 12) % 12 + (root % 12 < 4 ? 12 : 0);

  for (let bar = 0; bar < nBars; bar++) {
    const b0 = bar * bpb;
    const section = sectionOf(bar);
    const energy = energyOf(bar) * (1 + 0.05 * Math.sin(bar * 0.7));
    const fillBar = drumsOn(bar) && bar < lastBar - 1 && isSectionStart(bar + 1);
    const inBar = (p) => b0 + p < playEndPos - 1e-9;
    const drums = drumsOn(bar);

    // --- batería
    if (drums) {
      if (isSectionStart(bar) || (bar === cfg.introBars)) push({ pos: b0, inst: 'crash', vel: vj(0.8 * energy) });
      const kickPat = {
        rock: erng.chance(cfg.syncopation) ? [0, 2, 2.5] : [0, 2],
        punk: [0, 1.5, 2],
        pop: erng.chance(0.5) ? [0, 1.5, 2] : [0, 2, 2.75],
        funk: erng.chance(0.5) ? [0, 0.75, 2.5] : [0, 1.75, 2.5, 3.25],
        shuffle: erng.chance(0.4) ? [0, 1 + 2 / 3, 2] : [0, 2],
      }[style];
      const snarePat = [1, 3];
      for (const p of kickPat) {
        if (p >= bpb || !inBar(p)) continue;
        if (fillBar && p >= bpb - 2 + 0.01) continue;
        push({ pos: b0 + p, inst: 'kick', vel: vj((p === 0 ? 1 : 0.8) * energy) });
      }
      for (const p of snarePat) {
        if (p >= bpb || !inBar(p)) continue;
        if (fillBar && p >= bpb - 2 + 0.01) continue;
        push({ pos: b0 + p, inst: 'snare', vel: vj(0.85 * energy) });
      }
      if (style === 'funk') {
        for (const p of [1.75, 2.25, 3.5]) if (inBar(p) && !fillBar && erng.chance(0.6)) push({ pos: b0 + p, inst: 'snare', vel: vj(0.18) });
      }
      // charles / ride
      const hatStep = style === 'pop' || style === 'funk' ? 0.25 : style === 'shuffle' ? 1 / 3 : 0.5;
      for (let p = 0; p < bpb - 1e-9; p += hatStep) {
        if (!inBar(p)) continue;
        if (fillBar && p >= bpb - 2) continue;
        if (style === 'shuffle' && Math.abs((p % 1) - 1 / 3) < 0.01) continue; // shuffle: 1 y "a"
        const onBeat = Math.abs(p - Math.round(p)) < 1e-6;
        const acc = onBeat ? 1 : 0.6;
        const open = style === 'rock' && Math.abs(p - (bpb - 0.5)) < 1e-6 && erng.chance(0.3);
        push({ pos: b0 + p, inst: style === 'punk' ? 'ride' : 'hat', vel: vj(0.42 * acc * energy, 0.15), open });
      }
      // redoble de fin de sección
      if (fillBar) {
        const step = sub === 3 ? 1 / 3 : 0.25;
        let k = 0;
        for (let p = bpb - 2; p < bpb - 1e-9; p += step, k++) {
          const inst = k % 4 < 2 ? 'snare' : 'tom';
          push({ pos: b0 + p, inst, vel: vj(0.5 + 0.4 * (p - (bpb - 2)) / 2), freq: 180 - k * 12 });
        }
      }
    }

    // --- bajo
    if (['rock', 'punk', 'pop', 'funk', 'shuffle', 'ballad'].includes(style) && (bar >= cfg.introBars || style === 'ballad')) {
      let pat;
      if (style === 'rock' || style === 'punk') pat = Array.from({ length: bpb * 2 }, (_, i) => [i * 0.5, 0.45]);
      else if (style === 'pop') pat = [[0, 1.4], [1.5, 0.45], [2, 0.9], [3, 0.45], [3.5, 0.45]];
      else if (style === 'funk') pat = [[0, 0.4], [0.75, 0.2], [1.5, 0.2], [2, 0.4], [2.5, 0.2], [2.75, 0.2], [3.5, 0.4]];
      else if (style === 'shuffle') pat = [0, 1, 2, 3].flatMap((b) => [[b, 0.6], [b + 2 / 3, 0.3]]);
      else pat = [[0, bpb * 0.9]];
      for (const [p, d] of pat) {
        if (p >= bpb || !inBar(p)) continue;
        const ch = chordAt(bar, p);
        let m = bassNote(ch.root);
        if (style === 'funk' && p === 2.5) m += 12;
        if (style === 'shuffle' && p % 1 > 0.1) m += [7, 9, 7, 10][Math.floor(p) % 4];
        const vel = (Math.abs(p) < 1e-6 ? 1 : 0.72) * energy;
        push({ pos: b0 + p, inst: 'bass', midi: m, vel: vj(vel), durBeats: d, slap: style === 'funk' });
      }
    }

    // --- guitarra
    const ch0 = chordAt(bar, 0);
    if (cfg.introGuitar === 'arp' && bar < cfg.introBars) {
      // arpegio punteado en corcheas (ataques suaves, sin acentos marcados)
      for (let i = 0; i < bpb * 2; i++) {
        const p = i * 0.5;
        if (!inBar(p)) continue;
        const ch = chordAt(bar, p);
        const v = guitarVoicing(ch.root, ch.q, false);
        const order = [0, 2, 4, 3, 5, 3, 4, 2];
        push({ pos: b0 + p, inst: 'pluck', midi: v[order[i % order.length]], vel: vj(i === 0 ? 0.75 : 0.6), durBeats: 1.5 });
      }
    } else if (style === 'rock' || style === 'punk' || style === 'acoustic' || style === 'funk' || (cfg.introGuitar && bar < cfg.introBars)) {
      let strums;
      if (style === 'acoustic' || bar < cfg.introBars) {
        // D - D U - U D U (sin ataque en el tiempo 3 => síncopa)
        strums = bpb === 3 ? [[0, 'D'], [1, 'D'], [1.5, 'U'], [2, 'D'], [2.5, 'U']] : [[0, 'D'], [1, 'D'], [1.5, 'U'], [2.5, 'U'], [3, 'D'], [3.5, 'U']];
      } else if (style === 'funk') {
        strums = [[0.5, 'U'], [1.25, 'M'], [1.75, 'U'], [2.5, 'U'], [3.25, 'M'], [3.75, 'U']];
      } else {
        strums = Array.from({ length: bpb * 2 }, (_, i) => [i * 0.5, 'D']);
      }
      const power = style === 'rock' || style === 'punk';
      for (const [p, dir] of strums) {
        if (p >= bpb || !inBar(p)) continue;
        const ch = chordAt(bar, p);
        const voicing = guitarVoicing(ch.root, ch.q, power);
        const muted = dir === 'M' || (power && section === 'verse');
        const acc = Math.abs(p) < 1e-6 ? 1 : Math.abs(p % 1) < 1e-6 ? 0.85 : 0.7;
        push({ pos: b0 + p, inst: 'strum', voicing, dir: dir === 'U' ? 'U' : 'D', muted, vel: vj(0.8 * acc * energy), durBeats: dir === 'M' ? 0.1 : 0.5 });
      }
    }

    // --- piano
    if (style === 'ballad' || style === 'pianoSolo' || style === 'waltz' || style === 'pop' || style === 'shuffle' || (cfg.introPiano && bar < cfg.introBars)) {
      const ch = ch0;
      if (style === 'waltz') {
        push({ pos: b0, inst: 'piano', midi: 36 + ((ch.root - 36) % 12 + 12) % 12, vel: vj(0.75), durBeats: 0.9 });
        for (const p of [1, 2]) {
          if (!inBar(p)) continue;
          for (const m of pianoVoicing(chordAt(bar, p).root, chordAt(bar, p).q, 55)) push({ pos: b0 + p, inst: 'piano', midi: m, vel: vj(0.38), durBeats: 0.7, chordNote: true });
        }
        // melodía (mano derecha) con ritmo con puntillo
        if (bar >= 1) {
          const mpat = erng.chance(0.5) ? [0, 1.5, 2] : [0, 2];
          for (const p of mpat) if (inBar(p)) push({ pos: b0 + p, inst: 'piano', midi: pianoVoicing(ch.root, ch.q, 70)[erng.int(0, 2)], vel: vj(0.6), durBeats: 1 });
        }
      } else if (style === 'pianoSolo') {
        // mano izquierda: bajo + acorde; derecha: melodía en corcheas/negras
        push({ pos: b0, inst: 'piano', midi: 36 + ((ch.root - 36) % 12 + 12) % 12, vel: vj(0.8), durBeats: 1.8 });
        if (inBar(2)) push({ pos: b0 + 2, inst: 'piano', midi: 43 + ((chordAt(bar, 2).root + 7 - 43) % 12 + 12) % 12, vel: vj(0.6), durBeats: 1.8 });
        for (const p of [1, 3]) {
          if (!inBar(p)) continue;
          const c2 = chordAt(bar, p);
          for (const m of pianoVoicing(c2.root, c2.q, 52)) push({ pos: b0 + p, inst: 'piano', midi: m, vel: vj(0.4), durBeats: 0.9, chordNote: true });
        }
        let p = erng.chance(0.3) ? 0.5 : 0;
        while (p < bpb) {
          const d = erng.pick([0.5, 0.5, 1, 1, 1.5]);
          if (inBar(p) && erng.chance(0.85)) {
            const c2 = chordAt(bar, p);
            const tones = pianoVoicing(c2.root, c2.q, 67);
            const scaleTone = 67 + ((keyRoot + MAJOR[erng.int(0, 6)] - 67) % 12 + 12) % 12;
            push({ pos: b0 + p, inst: 'piano', midi: erng.chance(0.6) ? tones[erng.int(0, 2)] : scaleTone, vel: vj(0.62), durBeats: d });
          }
          p += d;
        }
      } else if (style === 'ballad') {
        // acorde en el 1 (y a veces en el 3) + arpegio en corcheas
        for (const m of pianoVoicing(ch.root, ch.q, 55)) push({ pos: b0, inst: 'piano', midi: m, vel: vj(0.5), durBeats: bpb - 0.2, chordNote: true });
        push({ pos: b0, inst: 'piano', midi: 36 + ((ch.root - 36) % 12 + 12) % 12, vel: vj(0.6), durBeats: bpb - 0.2 });
        const arp = pianoVoicing(ch.root, ch.q, 67);
        for (let i = 1; i < bpb * 2; i++) {
          const p = i * 0.5;
          if (!inBar(p) || erng.chance(0.25)) continue;
          const c2 = chordAt(bar, p);
          const a2 = pianoVoicing(c2.root, c2.q, 67);
          push({ pos: b0 + p, inst: 'piano', midi: (a2 || arp)[i % 3], vel: vj(0.33), durBeats: 1 });
        }
      } else if (style === 'shuffle') {
        for (const p of [0, 1 + 2 / 3, 2, 3 + 2 / 3]) {
          if (!inBar(p) || (p > 0 && erng.chance(0.3))) continue;
          const c2 = chordAt(bar, p);
          for (const m of pianoVoicing(c2.root, c2.q, 58)) push({ pos: b0 + p, inst: 'piano', midi: m, vel: vj(p === 0 ? 0.45 : 0.32), durBeats: 0.5, chordNote: true });
        }
      } else if (style === 'pop') {
        for (const p of [0, 1.5, 2.5]) {
          if (!inBar(p)) continue;
          const c2 = chordAt(bar, p);
          for (const m of pianoVoicing(c2.root, c2.q, 60)) push({ pos: b0 + p, inst: 'piano', midi: m, vel: vj(0.28), durBeats: 0.8, chordNote: true });
        }
      } else if (bar < cfg.introBars) {
        for (const m of pianoVoicing(ch.root, ch.q, 55)) push({ pos: b0, inst: 'piano', midi: m, vel: vj(0.5), durBeats: bpb - 0.3, chordNote: true });
      }
    }

    // --- pad / cuerdas: una nota larga por acorde (pocos ataques)
    if (cfg.pad || style === 'padVocal') {
      for (let ci = 0; ci < barChords[bar].length; ci++) {
        const c = barChords[bar][ci];
        const prev = ci > 0 ? barChords[bar][ci - 1] : bar > 0 ? barChords[bar - 1][barChords[bar - 1].length - 1] : null;
        if (prev && prev.root === c.root && prev.q === c.q && ci === 0 && bar > 0 && !isSectionStart(bar)) continue; // legato: mantiene
        if (!inBar(c.pos)) continue;
        // duración: hasta el próximo cambio de acorde
        let endPos = null;
        for (let b2 = bar, first = true; b2 < nBars && endPos === null; b2++, first = false) {
          for (const c2 of barChords[b2]) {
            const gp = b2 * bpb + c2.pos;
            if (gp <= b0 + c.pos + 1e-9) continue;
            if (c2.root !== c.root || c2.q !== c.q || (isSectionStart(b2) && c2.pos === 0)) { endPos = gp; break; }
          }
        }
        if (endPos === null) endPos = playEndPos;
        endPos = Math.min(endPos, playEndPos);
        for (const m of pianoVoicing(c.root, c.q, 52)) push({ pos: b0 + c.pos, inst: 'pad', midi: m, vel: vj(0.7 * energy, 0.05), durBeats: endPos - (b0 + c.pos) + 0.1, soft: true });
      }
    }
  }

  // --- anacrusa: notas antes del compás 1 (melodía/redoble)
  if (P > 0) {
    const ch = barChords[0][0];
    for (let i = 0; i < P * 2; i++) {
      const p = -P + i * 0.5;
      if (i % 2 === 1 && erng.chance(0.5)) continue;
      const tones = pianoVoicing(ch.root, ch.q, 64);
      push({ pos: p, inst: cfg.pickupInst || 'piano', midi: tones[(i + 1) % 3], vel: vj(0.55), durBeats: 0.5 });
    }
    if (drumsOn(0)) for (let p = -Math.min(P, 1); p < 0; p += 0.25) push({ pos: p, inst: 'snare', vel: vj(0.5 + 0.3 * (p + 1)) });
  }

  // --- melodía vocal legato (frases de 2 compases, a veces anticipadas)
  let vocalNotes = [];
  if (cfg.melody || style === 'padVocal') {
    let lastMidi = 64 + ((keyRoot - 64) % 12 + 12) % 12;
    const startBar = Math.max(cfg.introBars, 1);
    for (let bar = startBar; bar < nBars - 1; bar += 2) {
      let p = bar * bpb + (erng.chance(0.3) ? -0.5 : 0);
      const phraseEnd = bar * bpb + 2 * bpb - erng.pick([1, 1.5, 2]);
      while (p < phraseEnd - 0.25 && p < playEndPos - 0.5) {
        const d = erng.pick([0.5, 1, 1, 1.5, 2]);
        const barI = Math.floor(p / bpb);
        const c = chordAt(barI, p - barI * bpb);
        const ct = chordTones(c.root, c.q);
        let best = lastMidi;
        let bestD = 99;
        const target = lastMidi + erng.int(-4, 4);
        for (let m = 57; m <= 76; m++) {
          const isChord = ct.some((t) => (m - t) % 12 === 0);
          const inScale = MAJOR.some((s) => ((m - keyRoot - s) % 12 + 12) % 12 === 0);
          if (!inScale) continue;
          const dd = Math.abs(m - target) + (isChord ? 0 : 1.5);
          if (dd < bestD) { bestD = dd; best = m; }
        }
        lastMidi = best;
        const dur = Math.min(d, phraseEnd - p);
        vocalNotes.push({ pos: p, durBeats: dur, midi: best, vel: vj(0.8, 0.1) });
        p += d;
      }
    }
  }

  // --- golpe final
  if (finalHitPos !== null) {
    const ringSec = resolveRange(rng, ending.ringSec ?? [2.5, 4.5]);
    const ch = barChords[lastBar][barChords[lastBar].length - 1];
    const fvel = 1;
    if (['rock', 'punk', 'pop', 'funk', 'shuffle'].includes(style)) {
      push({ pos: finalHitPos, inst: 'crash', vel: 1, ringSec });
      push({ pos: finalHitPos, inst: 'kick', vel: 1 });
      push({ pos: finalHitPos, inst: 'bass', midi: bassNote(ch.root), vel: 1, holdSec: ringSec * 0.7 });
      // redoble previo en el compás anterior
      const fb = finalHitPos - 1;
      if (ending.type !== 'anticipated') for (let p = fb; p < finalHitPos - 1e-9; p += sub === 3 ? 1 / 3 : 0.25) push({ pos: p, inst: 'tom', vel: vj(0.6), freq: 150 - (p - fb) * 60 });
    }
    if (['rock', 'punk', 'acoustic', 'funk'].includes(style)) push({ pos: finalHitPos, inst: 'strum', voicing: guitarVoicing(ch.root, ch.q, false), dir: 'D', vel: fvel, holdSec: ringSec, t60: ringSec * 1.3 });
    if (['ballad', 'pianoSolo', 'waltz', 'pop', 'shuffle'].includes(style)) {
      for (const m of [36 + ((ch.root - 36) % 12 + 12) % 12, ...pianoVoicing(ch.root, ch.q, 55), ...pianoVoicing(ch.root, ch.q, 67)]) {
        push({ pos: finalHitPos, inst: 'piano', midi: m, vel: 0.75, holdSec: ringSec, maxDur: ringSec + 0.3 });
      }
    }
    if (cfg.pad || style === 'padVocal') {
      for (const m of pianoVoicing(ch.root, ch.q, 52)) push({ pos: finalHitPos, inst: 'pad', midi: m, vel: 0.8, holdSec: ringSec * 0.8, soft: true, attackSec: 0.15 });
    }
    if (style === 'padVocal') {
      // la voz termina con una nota larga sobre el acorde final
      vocalNotes = vocalNotes.filter((n) => n.pos + n.durBeats <= finalHitPos - 0.25);
      vocalNotes.push({ pos: finalHitPos, durBeats: 0, holdSec: ringSec * 0.6, midi: 60 + ((keyRoot - 60) % 12 + 12) % 12 + 12, vel: 0.85 });
    }
  }
  vocalNotes = vocalNotes.filter((n) => n.pos < playEndPos || (finalHitPos !== null && Math.abs(n.pos - finalHitPos) < 1e-6));

  // ---------------------------------------------------------------- tiempos humanizados
  const jr = rng.fork('jitter');
  const jit = cfg.jitterMs / 1000;
  const common = new Map();
  const commonJ = (pos) => {
    const key = Math.round(pos * 12);
    if (!common.has(key)) common.set(key, jr.gaussClipped(0, jit * 0.6, 2.5));
    return common.get(key);
  };
  const lagOf = { kick: 0, snare: 0.002, hat: -0.002, ride: -0.002, bass: 0.006, strum: 0.004, pluck: 0.003, piano: 0.003, pad: 0.03, tom: 0.001, crash: 0 };
  for (const e of events) {
    const base = beatTime(e.pos);
    const isFinal = finalHitPos !== null && Math.abs(e.pos - finalHitPos) < 1e-6;
    const ind = jr.gaussClipped(0, jit * 0.8, 2.5) * (e.chordNote ? 0.3 : 1);
    e.time = base + (isFinal ? commonJ(e.pos) * 0.5 : commonJ(e.pos) + ind) + (lagOf[e.inst] || 0);
    const durBeats = e.durBeats ?? 0.5;
    e.endTime = e.holdSec != null ? e.time + e.holdSec : beatTime(e.pos + durBeats) + (lagOf[e.inst] || 0);
  }
  for (const n of vocalNotes) {
    n.time = beatTime(n.pos) + jr.gaussClipped(0.015, jit * 1.5 + 0.01, 2.5);
    n.endTime = n.holdSec != null ? n.time + n.holdSec : beatTime(n.pos + n.durBeats) - 0.01;
  }
  vocalNotes.sort((a, b) => a.time - b.time);
  for (let i = 0; i + 1 < vocalNotes.length; i++) vocalNotes[i].endTime = Math.min(vocalNotes[i].endTime, vocalNotes[i + 1].time - 0.005);

  // ---------------------------------------------------------------- render
  const ringMax = 6;
  let lastEventEnd = 0;
  for (const e of events) lastEventEnd = Math.max(lastEventEnd, e.endTime);
  for (const n of vocalNotes) lastEventEnd = Math.max(lastEventEnd, n.endTime);
  const fermataExtra = ending.type === 'ritFermata' ? 0.5 : 0;
  const renderEnd = Math.max(lastEventEnd, beatTime(playEndPos)) + ringMax + fermataExtra;
  const N = Math.ceil(renderEnd * sr);
  const bus = makeBus(N);
  const lv = { kick: 1, snare: 0.8, hat: 0.35, ride: 0.3, crash: 0.35, tom: 0.7, bass: 0.9, strum: 0.55, pluck: 0.5, piano: 1, pad: 0.8, vocal: 0.9, ...cfg.levels };
  const sendLv = { kick: 0.05, snare: 0.25, hat: 0.1, ride: 0.15, crash: 0.2, tom: 0.2, bass: 0.02, strum: 0.35, pluck: 0.4, piano: 0.45, pad: 0.6, vocal: 0.5 };
  const irng = rng.fork('render');
  const kickF = irng.uniform(135, 165);
  const snareF = irng.uniform(175, 215);
  for (const e of events) {
    const start = Math.round(e.time * sr);
    const hold = Math.max(0.03, e.endTime - e.time);
    let sig;
    switch (e.inst) {
      case 'kick': sig = renderKick(sr, irng, { vel: e.vel, f0: kickF, f1: kickF / 3 }); break;
      case 'snare': sig = renderSnare(sr, irng, { vel: e.vel, tone: snareF }); break;
      case 'tom': sig = renderTom(sr, irng, { vel: e.vel, freq: e.freq || 120 }); break;
      case 'hat': sig = renderHat(sr, irng, { vel: e.vel, open: e.open }); break;
      case 'ride': sig = renderCymbal(sr, irng, { vel: e.vel * 0.7, decay: 0.5, dur: 1.2, ride: true }); break;
      case 'crash': sig = renderCymbal(sr, irng, { vel: e.vel, decay: e.ringSec ? e.ringSec * 0.45 : 1.1, dur: e.ringSec ? e.ringSec + 1 : 2.8 }); break;
      case 'bass': sig = renderBass(sr, irng, { midi: e.midi, vel: e.vel, hold, slap: e.slap }); break;
      case 'piano': sig = renderPiano(sr, irng, { midi: e.midi, vel: e.vel, hold, maxDur: e.maxDur ?? 3.2 }); break;
      case 'pad': sig = renderPad(sr, irng, { midi: e.midi, vel: e.vel, hold, attack: e.attackSec ?? irng.uniform(0.25, 0.6), release: 0.5, vibrato: style === 'padVocal' ? 0.25 : 0 }); break;
      case 'pluck': sig = renderPluck(sr, irng, { freq: midiToHz(e.midi), vel: e.vel, bright: 0.45, t60: 2.5, hold, release: 0.08 }); break;
      case 'strum': {
        // rasgueo: cuerdas escalonadas (abajo: grave->agudo; arriba: agudo->grave y sólo 4 cuerdas)
        let v = e.voicing.slice();
        if (e.dir === 'U') v = v.slice(-4).reverse();
        const spread = e.dir === 'U' ? irng.uniform(0.006, 0.012) : irng.uniform(0.008, 0.02);
        for (let s = 0; s < v.length; s++) {
          const off = Math.round(s * spread * sr);
          const t60 = e.muted ? 0.12 : e.t60 ?? 2.2;
          const hs = e.muted ? Math.min(hold, 0.09) : hold;
          const sg = renderPluck(sr, irng, { freq: midiToHz(v[s]), vel: e.vel * (e.dir === 'U' ? 0.7 : 1) * irng.uniform(0.8, 1.1), bright: e.muted ? 0.3 : 0.55, t60, hold: hs, release: 0.05 });
          mixInto(bus, start + off, sg, lv.strum / Math.sqrt(v.length / 3), sendLv.strum);
        }
        continue;
      }
      default: continue;
    }
    mixInto(bus, start, sig, lv[e.inst] ?? 1, sendLv[e.inst] ?? 0.2);
  }
  if (vocalNotes.length) {
    const t0 = vocalNotes[0].time - 0.05;
    const rel = vocalNotes.map((n) => ({ t0: n.time - t0, t1: n.endTime - t0, midi: n.midi, vel: n.vel }));
    const sig = renderVocal(sr, irng, rel, { vibratoDepth: 0.35 });
    mixInto(bus, Math.round(t0 * sr), sig, lv.vocal, sendLv.vocal);
  }

  // corte seco: todo se apaga en la barra (el eco de sala sigue)
  if (ending.type === 'abrupt') {
    const tStop = beatTime(nBars * bpb) + 0.004;
    const i0 = Math.round(tStop * sr);
    const nr = Math.round(0.012 * sr);
    for (const arr of [bus.dry, bus.send]) {
      for (let i = i0; i < arr.length; i++) arr[i] *= i - i0 < nr ? 1 - (i - i0) / nr : 0;
    }
  }

  const wet = reverb(bus.send, sr, { size: cfg.reverb.size, feedback: cfg.reverb.feedback, damping: 0.4 });
  const mix = bus.dry;
  const wg = cfg.reverb.wet * 4;
  for (let i = 0; i < N; i++) mix[i] += wg * wet[i];

  // fade out del máster
  let fadeInfo = null;
  if (ending.type === 'fadeout') {
    const fadeBars = ending.fadeBars ?? 12;
    const fStart = beatTime((nBars - fadeBars) * bpb);
    const fEnd = beatTime(nBars * bpb);
    const pw = ending.fadePower ?? 2;
    const i0 = Math.round(fStart * sr);
    const i1 = Math.round(fEnd * sr);
    for (let i = i0; i < N; i++) {
      // ganancia (1-x)^pw; silencio después del final del fade
      mix[i] *= i >= i1 ? 0 : Math.pow(1 - (i - i0) / Math.max(1, i1 - i0), pw);
    }
    fadeInfo = { start: fStart, end: fEnd, power: pw };
  }
  const fadeGainAt = (t) => {
    if (!fadeInfo) return 1;
    if (t <= fadeInfo.start) return 1;
    if (t >= fadeInfo.end) return 0;
    const x = (t - fadeInfo.start) / (fadeInfo.end - fadeInfo.start);
    return Math.pow(1 - x, fadeInfo.power);
  };

  // ---------------------------------------------------------------- límites de la música (sin ruido)
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix[i]));
  const peakDb = resolveRange(rng, cfg.peakDb);
  const norm = Math.pow(10, peakDb / 20) / Math.max(1e-9, peak);
  for (let i = 0; i < N; i++) mix[i] *= norm;
  const { musicStart, musicEnd } = gtBounds(mix, sr);

  // silencio final + ruido de fondo
  const tail = resolveRange(rng, cfg.tailSilence);
  const outLen = Math.ceil((musicEnd + tail) * sr);
  const out = new Float32Array(outLen);
  out.set(mix.subarray(0, Math.min(N, outLen)));
  if (cfg.noiseDb != null) {
    const nrng = rng.fork('noise');
    const na = Math.pow(10, cfg.noiseDb / 20) * Math.sqrt(3);
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      lp += 0.5 * (nrng.next() * 2 - 1 - lp);
      out[i] += na * lp * 1.6;
    }
  }

  // ---------------------------------------------------------------- verdad de referencia
  const allOnsets = [];
  const attackOnsets = [];
  for (const e of events) {
    const g = fadeGainAt(e.time);
    if (e.time > musicEnd || g < 0.01 || e.vel * g < 0.04) continue;
    allOnsets.push(e.time);
    if (e.inst !== 'pad') attackOnsets.push(e.time);
  }
  for (const n of vocalNotes) if (n.time <= musicEnd && fadeGainAt(n.time) >= 0.01) allOnsets.push(n.time);
  const noteOnsets = mergeOnsets(allOnsets, 0.03);
  const noteOnsetsAttack = mergeOnsets(attackOnsets, 0.03);

  // tiempos: desde la anacrusa (o el primer evento) hasta musicEnd (sin extrapolar en silencio)
  const firstEvent = Math.min(...events.map((e) => e.time), ...(vocalNotes.length ? [vocalNotes[0].time] : [Infinity]));
  const beats = [];
  const positions = [];
  const lastBeatPos = finalHitPos !== null && ending.type === 'ritFermata' ? finalHitPos : ending.type === 'abrupt' || ending.type === 'fadeout' ? nBars * bpb - 1 : lastBar * bpb + bpb - 1;
  for (let g = -P; g <= lastBeatPos + 1e-9; g++) {
    const t = beatTime(g);
    if (t < firstEvent - 0.06 || t > musicEnd) continue;
    beats.push(round6(t));
    positions.push(((g % bpb) + bpb) % bpb);
  }
  const downbeats = [];
  positions.forEach((p, i) => { if (p === 0) downbeats.push(i); });

  const finalHitTime = finalHitPos !== null ? beatTime(finalHitPos) : null;
  let lastBarStart;
  let lastBarAlternatives;
  let lastBarAmbiguous = false;
  let evalEnd;
  let lastOnsetGT;
  if (ending.type === 'fadeout') {
    // ambiguo: aceptamos cualquier compás cuyo último evento esté entre -36 y -18 dB de fade
    lastBarAmbiguous = true;
    const barStartT = (b) => beatTime(b * bpb);
    const lastEvWithGain = (minG) => {
      let best = -Infinity;
      for (const e of events) if (fadeGainAt(e.time) >= minG && e.inst !== 'pad') best = Math.max(best, e.time);
      return best;
    };
    const barOf = (t) => {
      let b = 0;
      while (b + 1 < nBars && barStartT(b + 1) <= t + 1e-9) b++;
      return b;
    };
    const bLo = barOf(lastEvWithGain(Math.pow(10, -18 / 20)));
    const bHi = barOf(lastEvWithGain(Math.pow(10, -36 / 20)));
    lastBarAlternatives = [];
    for (let b = bLo; b <= bHi; b++) lastBarAlternatives.push(round6(barStartT(b)));
    const bMid = barOf(lastEvWithGain(Math.pow(10, -27 / 20)));
    lastBarStart = round6(barStartT(bMid));
    evalEnd = lastEvWithGain(Math.pow(10, -30 / 20)) + 0.05;
    lastOnsetGT = lastEvWithGain(Math.pow(10, -27 / 20));
  } else if (ending.type === 'abrupt') {
    lastBarStart = round6(beatTime(lastBar * bpb));
    lastBarAlternatives = [lastBarStart];
    evalEnd = beatTime(nBars * bpb) - 0.02;
    lastOnsetGT = Math.max(...events.map((e) => e.time));
  } else {
    lastBarStart = round6(beatTime(ending.type === 'anticipated' ? lastBar * bpb : finalHitPos));
    lastBarAlternatives = [lastBarStart];
    evalEnd = finalHitTime + 0.1;
    lastOnsetGT = finalHitTime;
  }
  const evalStart = Math.max(firstEvent - 0.06, musicStart - 0.06);

  // tempo de referencia: mediana de 60/IBI de los tiempos evaluables
  const ibis = [];
  for (let i = 1; i < beats.length; i++) if (beats[i] <= evalEnd) ibis.push(beats[i] - beats[i - 1]);
  const bpmLocal = ibis.map((d) => 60 / d).sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))] : NaN);

  const truth = {
    generatorVersion: GENERATOR_VERSION,
    sampleRate: sr,
    duration: out.length / sr,
    beats,
    positions,
    downbeats,
    beatsPerBar: bpb,
    noteOnsets: noteOnsets.map(round6),
    noteOnsetsAttack: noteOnsetsAttack.map(round6),
    lastBarStart,
    lastBarAlternatives,
    lastBarAmbiguous,
    lastOnset: round6(lastOnsetGT),
    finalHit: finalHitTime !== null ? round6(finalHitTime) : null,
    musicStart: round6(musicStart),
    musicEnd: round6(musicEnd),
    evalRange: [round6(evalStart), round6(evalEnd)],
    ending: ending.type,
    tempo: {
      nominalBpm: cfg.bpm,
      bpm: round6(q(bpmLocal, 0.5)),
      minBpm: round6(q(bpmLocal, 0)),
      maxBpm: round6(q(bpmLocal, 1)),
      p10: round6(q(bpmLocal, 0.1)),
      p90: round6(q(bpmLocal, 0.9)),
    },
    style: cfg.style,
    meter: cfg.subdiv === 3 ? `${bpb * 3}/8` : `${bpb}/4`,
  };
  return { samples: out, sampleRate: sr, truth };
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function mergeOnsets(times, win) {
  const s = times.slice().sort((a, b) => a - b);
  const out = [];
  for (const t of s) if (!out.length || t - out[out.length - 1] > win) out.push(t);
  return out;
}

/** musicStart/musicEnd de referencia: RMS en ventanas de 20 ms (salto 10 ms) > máximo - 50 dB. */
export function gtBounds(x, sr, db = GT_SILENCE_DB) {
  const win = Math.round(0.02 * sr);
  const hop = Math.round(0.01 * sr);
  const nW = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const rms = new Float64Array(nW);
  let mx = 0;
  for (let w = 0; w < nW; w++) {
    let s = 0;
    const o = w * hop;
    for (let i = 0; i < win && o + i < x.length; i++) s += x[o + i] * x[o + i];
    rms[w] = Math.sqrt(s / win);
    if (rms[w] > mx) mx = rms[w];
  }
  const th = mx * Math.pow(10, db / 20);
  let a = 0;
  while (a < nW - 1 && rms[a] < th) a++;
  let b = nW - 1;
  while (b > 0 && rms[b] < th) b--;
  return { musicStart: (a * hop) / sr, musicEnd: Math.min(x.length, b * hop + win) / sr };
}
