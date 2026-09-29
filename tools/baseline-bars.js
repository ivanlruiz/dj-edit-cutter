// Etiquetado de compases de referencia trivial para probar el benchmark: compás fijo (4, o el pedido) y
// fase elegida por la energía de graves (onsetLow) y el cambio de croma en cada tiempo.
export function labelBars(features, beats, opts = {}) {
  const bpb = Number.isInteger(opts.beatsPerBar) ? opts.beatsPerBar : 4;
  const { fps, onsetLow, chroma, numFrames } = features;
  const fr = (t) => Math.max(0, Math.min(numFrames - 1, Math.round(t * fps)));
  const score = new Float64Array(bpb);
  for (let i = 0; i < beats.length; i++) {
    const f = fr(beats[i]);
    let low = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < numFrames) low = Math.max(low, onsetLow[k]);
    // cambio de croma entre el tiempo anterior y el siguiente
    let ch = 0;
    if (i > 0 && i + 1 < beats.length) {
      const a = fr((beats[i - 1] + beats[i]) / 2);
      const b = fr((beats[i] + beats[i + 1]) / 2);
      for (let p = 0; p < 12; p++) ch += Math.abs(chroma[b * 12 + p] - chroma[a * 12 + p]);
    }
    score[i % bpb] += low + 0.5 * ch;
  }
  let phase = 0;
  for (let p = 1; p < bpb; p++) if (score[p] > score[phase]) phase = p;
  const positions = beats.map((_, i) => (((i - phase) % bpb) + bpb) % bpb);
  const downbeats = [];
  positions.forEach((p, i) => { if (p === 0) downbeats.push(i); });
  return { beatsPerBar: bpb, positions, downbeats, confidence: 0.5 };
}
