#!/usr/bin/env node
// Escribe casos de la suite sintética como WAV 44.1 kHz estéreo 16 bits + <nombre>.truth.json (para tests E2E).
// Uso: node tools/make-test-songs.js <dirSalida> [caso ...]   (sin casos: todos menos los 'long')
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUITE, generateCase } from '../tests/synth/suite.js';
import { writeWav } from '../tests/synth/wav-io.js';

/** Sobremuestreo ×2 con sinc enventanado (Blackman, 32 taps por lado). Los tiempos no cambian. */
export function upsample2x(x) {
  const taps = 32;
  const h = new Float32Array(2 * taps);
  // filtro de media banda: coeficientes para las muestras impares (entre dos originales)
  for (let k = 0; k < 2 * taps; k++) {
    const t = k - taps + 0.5; // distancia (en muestras originales) a la muestra intermedia
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
    const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / taps) + 0.08 * Math.cos((2 * Math.PI * t) / taps);
    h[k] = sinc * w;
  }
  const n = x.length;
  const y = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    y[2 * i] = x[i];
    let acc = 0;
    for (let k = 0; k < 2 * taps; k++) {
      const j = i - taps + 1 + k;
      if (j >= 0 && j < n) acc += h[k] * x[j];
    }
    y[2 * i + 1] = acc;
  }
  return y;
}

function main() {
  const [outDir, ...names] = process.argv.slice(2);
  if (!outDir) {
    console.error('Uso: node tools/make-test-songs.js <dirSalida> [caso ...]');
    console.error(`Casos: ${SUITE.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
  const list = names.length ? names : SUITE.filter((c) => !c.tags.includes('long')).map((c) => c.name);
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  for (const name of list) {
    const c = generateCase(name);
    if (c.sampleRate !== 22050) throw new Error(`Se esperaba 22050 Hz, no ${c.sampleRate}`);
    const up = upsample2x(c.samples);
    // evita saturar tras el filtro
    let pk = 0;
    for (let i = 0; i < up.length; i++) pk = Math.max(pk, Math.abs(up[i]));
    if (pk > 0.999) for (let i = 0; i < up.length; i++) up[i] *= 0.999 / pk;
    writeWav(join(dir, `${name}.wav`), [up, up], 44100, { bitDepth: 16 });
    const truth = { ...c.truth, file: `${name}.wav`, fileSampleRate: 44100, fileChannels: 2, description: c.description, tags: c.tags };
    writeFileSync(join(dir, `${name}.truth.json`), JSON.stringify(truth, null, 1));
    console.log(`${name}.wav  ${(up.length / 44100).toFixed(1)} s`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make-test-songs.js')) main();
