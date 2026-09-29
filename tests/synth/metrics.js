// Métricas de evaluación (estilo MIREX / mir_eval) para beats, tempo, downbeats y último compás.

export const BEAT_WINDOW = 0.07; // s

/** Filtra a un rango [a, b] (con margen) si se indica. */
function clip(times, range, margin = 0) {
  if (!range) return times.slice();
  return times.filter((t) => t >= range[0] - margin && t <= range[1] + margin);
}

/**
 * Emparejamiento uno a uno entre detecciones y referencias dentro de ±window (voraz por distancia creciente,
 * equivalente al óptimo cuando window < medio intervalo entre eventos).
 * @returns {Array<[number, number]>} pares [iDet, iRef]
 */
export function matchEvents(detected, reference, window = BEAT_WINDOW) {
  const pairs = [];
  let j0 = 0;
  for (let i = 0; i < detected.length; i++) {
    const d = detected[i];
    while (j0 < reference.length && reference[j0] < d - window) j0++;
    for (let j = j0; j < reference.length && reference[j] <= d + window; j++) {
      pairs.push([Math.abs(d - reference[j]), i, j]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const ud = new Uint8Array(detected.length);
  const ur = new Uint8Array(reference.length);
  const out = [];
  for (const [, i, j] of pairs) {
    if (ud[i] || ur[j]) continue;
    ud[i] = 1;
    ur[j] = 1;
    out.push([i, j]);
  }
  return out;
}

/**
 * F-measure de eventos (beats, downbeats u onsets).
 * opts.range = [t0, t1]: sólo se evalúan referencias dentro del rango y detecciones dentro del rango ± window.
 * @returns {{ f, precision, recall, hits, nDet, nRef }}
 */
export function fMeasure(detected, reference, { window = BEAT_WINDOW, range = null } = {}) {
  const det = clip(sorted(detected), range, window);
  const ref = clip(sorted(reference), range, 0);
  if (!ref.length && !det.length) return { f: 1, precision: 1, recall: 1, hits: 0, nDet: 0, nRef: 0 };
  if (!ref.length || !det.length) return { f: 0, precision: det.length ? 0 : 1, recall: ref.length ? 0 : 1, hits: 0, nDet: det.length, nRef: ref.length };
  const hits = matchEvents(det, ref, window).length;
  const precision = hits / det.length;
  const recall = hits / ref.length;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { f, precision, recall, hits, nDet: det.length, nRef: ref.length };
}

export function beatFMeasure(detected, reference, opts = {}) {
  return fMeasure(detected, reference, opts).f;
}

function sorted(a) {
  return Array.from(a).sort((x, y) => x - y);
}

/** Continuidad (mir_eval.beat.continuity) para una variante de referencia. Devuelve { cmlc, cmlt }. */
function continuityOne(ref, est, phaseTh, periodTh) {
  const nAnn = Math.max(ref.length, est.length);
  const used = new Uint8Array(ref.length);
  const success = new Uint8Array(nAnn);
  for (let m = 0; m < est.length; m++) {
    // anotación más cercana
    let nearest = 0;
    let minD = Infinity;
    for (let j = 0; j < ref.length; j++) {
      const d = Math.abs(est[m] - ref[j]);
      if (d < minD) { minD = d; nearest = j; }
    }
    if (used[nearest]) continue;
    let refInt;
    let estInt;
    if (m === 0 || nearest === 0) {
      refInt = nearest + 1 < ref.length ? ref[nearest + 1] - ref[nearest] : ref[nearest] - ref[nearest - 1];
      estInt = m + 1 < est.length ? est[m + 1] - est[m] : est[m] - est[m - 1];
    } else {
      refInt = ref[nearest] - ref[nearest - 1];
      estInt = est[m] - est[m - 1];
    }
    if (!(refInt > 0)) continue;
    const phase = Math.abs(minD / refInt);
    const period = Math.abs(1 - estInt / refInt);
    if (phase < phaseTh && period < periodTh) {
      used[nearest] = 1;
      success[m] = 1;
    }
  }
  let longest = 0;
  let run = 0;
  let total = 0;
  for (let i = 0; i < nAnn; i++) {
    if (success[i]) { run++; total++; if (run > longest) longest = run; } else run = 0;
  }
  return { cmlc: longest / nAnn, cmlt: total / nAnn };
}

/**
 * Métricas de continuidad (CMLc, CMLt, AMLc, AMLt) al estilo mir_eval (tolerancias 17.5 %).
 * AML admite las variantes: doble, mitad (pares/impares) y contratiempo.
 */
export function continuity(detected, reference, { range = null, phaseThreshold = 0.175, periodThreshold = 0.175 } = {}) {
  const est = clip(sorted(detected), range, BEAT_WINDOW);
  const ref = clip(sorted(reference), range, 0);
  if (ref.length < 2 || est.length < 2) return { cmlc: 0, cmlt: 0, amlc: 0, amlt: 0 };
  const off = [];
  for (let i = 0; i + 1 < ref.length; i++) off.push((ref[i] + ref[i + 1]) / 2);
  const dbl = [];
  for (let i = 0; i < ref.length; i++) {
    dbl.push(ref[i]);
    if (i < off.length) dbl.push(off[i]);
  }
  const halfOdd = ref.filter((_, i) => i % 2 === 0);
  const halfEven = ref.filter((_, i) => i % 2 === 1);
  const variants = [ref, off, dbl, halfOdd, halfEven].filter((v) => v.length >= 2);
  const res = variants.map((v) => continuityOne(v, est, phaseThreshold, periodThreshold));
  return {
    cmlc: res[0].cmlc,
    cmlt: res[0].cmlt,
    amlc: Math.max(...res.map((r) => r.cmlc)),
    amlt: Math.max(...res.map((r) => r.cmlt)),
  };
}

/** Tempo representativo de una lista de beats: mediana de 60/IBI. */
export function medianBpm(beats, range = null) {
  const b = clip(sorted(beats), range, 0);
  const v = [];
  for (let i = 1; i < b.length; i++) if (b[i] > b[i - 1]) v.push(60 / (b[i] - b[i - 1]));
  if (!v.length) return NaN;
  v.sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
}

const OCTAVES = [
  [2, '×2'],
  [0.5, '÷2'],
  [1.5, '×3/2'],
  [2 / 3, '×2/3'],
  [3, '×3'],
  [1 / 3, '÷3'],
];

/**
 * Compara tempos. ok si |det/ref - 1| <= tol (4 %). octave = '×2' | '÷2' | '×3/2' | '×2/3' | '×3' | '÷3' | null.
 */
export function tempoCheck(detBpm, refBpm, tol = 0.04) {
  if (!(detBpm > 0) || !(refBpm > 0)) return { ok: false, octave: null, ratio: NaN, label: '—' };
  const ratio = detBpm / refBpm;
  if (Math.abs(ratio - 1) <= tol) return { ok: true, octave: null, ratio, label: 'ok' };
  for (const [r, name] of OCTAVES) {
    if (Math.abs(ratio / r - 1) <= tol) return { ok: false, octave: name, ratio, label: name };
  }
  return { ok: false, octave: null, ratio, label: 'mal' };
}

/** F-measure de downbeats (tiempos) con ±70 ms. */
export function downbeatFMeasure(detectedDownbeatTimes, referenceDownbeatTimes, opts = {}) {
  return fMeasure(detectedDownbeatTimes, referenceDownbeatTimes, opts).f;
}

/**
 * Inicio del último compás según la regla de la app: el último downbeat cuyo inicio <= lastOnset + tolerance.
 * @param {number[]} beats tiempos (s); @param {number[]} downbeats índices en beats
 * @returns {number|null}
 */
export function lastBarStartFrom(beats, downbeats, lastOnset, tolerance = 0.08) {
  let best = null;
  for (const i of downbeats) {
    const t = beats[i];
    if (t <= lastOnset + tolerance && (best === null || t > best)) best = t;
  }
  return best;
}

/** ¿El inicio del último compás detectado coincide (±70 ms) con la verdad (o alguna alternativa aceptable)? */
export function lastBarOk(detectedStart, truth, window = BEAT_WINDOW) {
  if (detectedStart == null || !Number.isFinite(detectedStart)) return false;
  const alts = truth.lastBarAlternatives && truth.lastBarAlternatives.length ? truth.lastBarAlternatives : [truth.lastBarStart];
  return alts.some((t) => Math.abs(detectedStart - t) <= window);
}

/** Onsets de referencia en un rango, para la F-measure de detección de notas (ventana típica 50 ms). */
export function onsetFMeasure(detected, reference, { window = 0.05, range = null } = {}) {
  return fMeasure(detected, reference, { window, range });
}
