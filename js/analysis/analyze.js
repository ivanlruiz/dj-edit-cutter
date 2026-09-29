// Orquestador del análisis (puro, sin DOM): características → límites → tempo → beats → compases.
//
// analyze() hace el análisis completo y devuelve un AnalysisResult (objeto JSON plano, ver SPEC).
// AnalysisSession guarda las características para rehacer sólo los beats (retrack: botones ×2 / ÷2) o sólo los
// compases (relabel: compás elegido, "mover el 1") sin volver a calcular el espectro. El worker usa la sesión.
import { computeFeatures } from './features.js';
import { estimateTempo } from './tempo.js';
import { findMusicBounds, findLastOnset } from './bounds.js';
import { trackBeats, refineBeats } from './beats.js';
import { labelBars } from './downbeats.js';

export { computeFeatures, estimateTempo, findMusicBounds, findLastOnset, trackBeats, refineBeats, labelBars };

export const ANALYSIS_SAMPLE_RATE = 22050; // las características y el tempo están ajustados a esta frecuencia
export const ANALYSIS_DEFAULTS = Object.freeze({ minBpm: 50, maxBpm: 220, beatsPerBar: 'auto' });
export const ANALYSIS_STAGES = Object.freeze(['features', 'tempo', 'beats', 'bars']);

const DC_CUTOFF_HZ = 10; // paso alto de 1 polo contra offset DC (las características empiezan en 30 Hz)
const FORCED_CONFIDENCE = 0.75; // compases con un "1" fijado a mano: el usuario ya los ha revisado
const REMAP_MAX_SEC = 0.1; // retrack: un "1" forzado sigue al beat nuevo más cercano si está a menos de esto
const REMAP_MAX_IBI = 0.25; // … y a menos de 1/4 del intervalo entre beats nuevo

const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
const round = (x, d) => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = q * (sorted.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return quantile(s, 0.5);
}

/** Opciones de analyze(): { minBpm=50, maxBpm=220, beatsPerBar='auto' } con valores fuera de rango corregidos. */
export function normalizeOptions(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  let minBpm = Number(o.minBpm);
  let maxBpm = Number(o.maxBpm);
  if (!(minBpm >= 20 && minBpm <= 300)) minBpm = ANALYSIS_DEFAULTS.minBpm;
  if (!(maxBpm >= 40 && maxBpm <= 400)) maxBpm = ANALYSIS_DEFAULTS.maxBpm;
  if (maxBpm < minBpm * 1.5) {
    minBpm = ANALYSIS_DEFAULTS.minBpm;
    maxBpm = ANALYSIS_DEFAULTS.maxBpm;
  }
  return { minBpm, maxBpm, beatsPerBar: normalizeMeter(o.beatsPerBar) };
}

/** 'auto' o un entero 2..7 (acepta '3'); cualquier otra cosa es 'auto'. */
export function normalizeMeter(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2 && n <= 7 ? n : 'auto';
}

/** Índices de beat enteros, dentro de [0, n), ordenados y sin repetir. */
export function sanitizeForced(list, n) {
  if (!list || typeof list.length !== 'number') return [];
  const out = [];
  for (const v of Array.from(list).map(Number).sort((a, b) => a - b)) {
    if (Number.isInteger(v) && v >= 0 && v < n && out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/**
 * Después de un retrack los índices viejos no valen: cada "1" forzado pasa al beat nuevo más cercano a su tiempo si
 * está cerca (tras ×2 los beats viejos siguen existiendo); si no (tras ÷2 un contratiempo desaparece) se descarta.
 */
export function remapForced(oldTimes, newBeats) {
  const out = [];
  if (!newBeats.length) return out;
  const ibis = [];
  for (let i = 1; i < newBeats.length; i++) ibis.push(newBeats[i] - newBeats[i - 1]);
  const tol = Math.min(REMAP_MAX_SEC, ibis.length ? REMAP_MAX_IBI * median(ibis) : REMAP_MAX_SEC);
  for (const t of oldTimes) {
    if (!Number.isFinite(t)) continue;
    let lo = 0;
    let hi = newBeats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newBeats[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let j = lo;
    if (j > 0 && Math.abs(newBeats[j - 1] - t) <= Math.abs(newBeats[j] - t)) j -= 1;
    if (Math.abs(newBeats[j] - t) <= tol) out.push(j);
  }
  return sanitizeForced(out, newBeats.length);
}

/**
 * Copia de la señal lista para analizar: 22050 Hz, sin valores no finitos y sin componente continua (resta de la
 * media + paso alto de 1 polo a 10 Hz). Con offset DC el RMS nunca baja (límites y último golpe fallan) y el relleno
 * de ceros de los bordes produce onsets falsos; el paso alto también deja en silencio una cola "sólo DC".
 */
export function prepareSamples(samples, sampleRate) {
  if (!samples || typeof samples.length !== 'number') throw new Error('no hay muestras de audio');
  const sr = Number(sampleRate);
  if (!(sr >= 3000 && sr <= 384000)) throw new Error('frecuencia de muestreo no válida');
  let x = samples;
  if (Math.abs(sr - ANALYSIS_SAMPLE_RATE) > 0.5) x = resample(samples, sr, ANALYSIS_SAMPLE_RATE);
  const n = x.length;
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) sum += v;
  }
  const mean = n ? sum / n : 0;
  const r = Math.exp((-2 * Math.PI * DC_CUTOFF_HZ) / ANALYSIS_SAMPLE_RATE);
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(x[i]) ? x[i] - mean : 0;
    py = v - px + r * py;
    px = v;
    out[i] = py;
  }
  return out;
}

/**
 * Remuestreo sencillo (sólo de respaldo: la app ya entrega 22050 Hz). Al bajar, media móvil de ~1.5 × ratio
 * muestras contra el aliasing; después interpolación lineal.
 */
function resample(x, from, to) {
  const ratio = from / to;
  const n = Math.max(0, Math.floor(x.length / ratio));
  let src = x;
  if (ratio > 1.01) {
    const w = Math.max(2, Math.round(1.5 * ratio));
    const cs = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + (Number.isFinite(x[i]) ? x[i] : 0);
    src = new Float32Array(x.length);
    const h = w >> 1;
    for (let i = 0; i < x.length; i++) {
      const a = Math.max(0, i - h);
      const b = Math.min(x.length, a + w);
      src[i] = (cs[b] - cs[a]) / (b - a);
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    const f = p - k;
    const a = src[k];
    const b = k + 1 < src.length ? src[k + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

function progressReporter(onProgress) {
  if (typeof onProgress !== 'function') return () => {};
  return (stage, fraction) => {
    try {
      onProgress(stage, fraction);
    } catch {
      // un fallo en la interfaz no debe parar el análisis
    }
  };
}

/** BPM (mediana de 60/IBI) y rango p10–p90 del tempo local (60 / mediana de 4 IBI alrededor de cada beat). */
function tempoSummary(beats) {
  if (beats.length < 2) return { bpm: 0, bpmRange: [0, 0] };
  const inst = [];
  const ibi = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1];
    ibi.push(d);
    inst.push(60 / d);
  }
  const local = [];
  for (let i = 0; i < beats.length; i++) {
    const a = Math.max(0, i - 2);
    const b = Math.min(ibi.length - 1, i + 1);
    local.push(60 / median(ibi.slice(a, b + 1)));
  }
  const s = Float64Array.from(local).sort();
  return { bpm: round(median(inst), 1), bpmRange: [round(quantile(s, 0.1), 1), round(quantile(s, 0.9), 1)] };
}

export class AnalysisSession {
  /**
   * @param {Float32Array} samples mono (normalmente 22050 Hz; otras frecuencias se remuestrean)
   * @param {number} sampleRate
   * @param {object} [options] { minBpm=50, maxBpm=220, beatsPerBar='auto' }
   */
  constructor(samples, sampleRate, options = {}) {
    if (!samples || typeof samples.length !== 'number') throw new Error('no hay muestras de audio');
    const sr = Number(sampleRate);
    if (!(sr >= 3000 && sr <= 384000)) throw new Error('frecuencia de muestreo no válida');
    this._input = samples;
    this._inputRate = sr;
    this.options = normalizeOptions(options);
    this.duration = samples.length / sr;
    this.sampleRate = ANALYSIS_SAMPLE_RATE;
    this.samples = null;
    this.features = null;
    this.bounds = null;
    this.tempo = null;
    this.lastOnset = 0;
    this.track = null; // { beats (afinados), strength, confidence }
    this.beatsPerBar = this.options.beatsPerBar;
    this.forced = [];
    this.bars = null;
  }

  /** Análisis completo. onProgress(stage, fraction) con stage en ANALYSIS_STAGES. */
  run(onProgress) {
    const report = progressReporter(onProgress);
    const timings = {};
    const tAll = now();
    let t = now();
    report('features', 0);
    if (!this.samples) {
      this.samples = prepareSamples(this._input, this._inputRate);
      this._input = null; // la copia preparada basta desde aquí
    }
    this.beatsPerBar = this.options.beatsPerBar;
    this.forced = [];
    this.features = computeFeatures(this.samples, this.sampleRate);
    this.bounds = findMusicBounds(this.samples, this.sampleRate);
    this.lastOnset = findLastOnset(this.features, this.bounds.musicEnd);
    timings.features = now() - t;
    report('features', 1);

    t = now();
    report('tempo', 0);
    this.tempo = estimateTempo(this.features, { minBpm: this.options.minBpm, maxBpm: this.options.maxBpm });
    timings.tempo = now() - t;
    report('tempo', 1);

    t = now();
    report('beats', 0);
    this._track({});
    timings.beats = now() - t;
    report('beats', 1);

    t = now();
    report('bars', 0);
    this._label();
    timings.bars = now() - t;
    report('bars', 1);
    timings.total = now() - tAll;
    return this.result(timings);
  }

  /**
   * Rehace los beats con las características guardadas. { bpmHint, strict }: strict limita el tempo a ≈ [0.8, 1.25] ×
   * bpmHint (botones ×2 / ÷2); sin bpmHint repite la detección automática. Se conservan el compás elegido y los "1"
   * forzados (pasados por tiempo a los beats nuevos, o descartados si ya no caen en un beat).
   */
  retrack(options = {}, onProgress) {
    this._requireAnalysis();
    const o = options && typeof options === 'object' ? options : {};
    const report = progressReporter(onProgress);
    const timings = {};
    const tAll = now();
    let hint;
    if (o.bpmHint !== undefined && o.bpmHint !== null) {
      hint = Number(o.bpmHint);
      if (!(hint >= 20 && hint <= 400)) throw new Error('tempo fuera de rango (20–400 BPM)');
    }
    const oldBeats = this.track.beats;
    const forcedTimes = this.forced.map((i) => oldBeats[i]);
    let t = now();
    report('beats', 0);
    this._track({ bpmHint: hint, strict: !!(hint && o.strict) });
    timings.beats = now() - t;
    report('beats', 1);
    this.forced = remapForced(forcedTimes, this.track.beats);
    t = now();
    report('bars', 0);
    this._label();
    timings.bars = now() - t;
    report('bars', 1);
    timings.total = now() - tAll;
    return this.result(timings);
  }

  /**
   * Rehace sólo los compases sobre los beats actuales. { beatsPerBar: 'auto' | 2..7, forcedDownbeats: índices de
   * beat que son "1" }. Una opción que falta conserva el valor actual.
   */
  relabel(options = {}, onProgress) {
    this._requireAnalysis();
    const o = options && typeof options === 'object' ? options : {};
    const report = progressReporter(onProgress);
    const tAll = now();
    if (o.beatsPerBar !== undefined) this.beatsPerBar = normalizeMeter(o.beatsPerBar);
    if (o.forcedDownbeats !== undefined) this.forced = sanitizeForced(o.forcedDownbeats, this.track.beats.length);
    report('bars', 0);
    this._label();
    report('bars', 1);
    const dt = now() - tAll;
    return this.result({ bars: dt, total: dt });
  }

  _requireAnalysis() {
    if (!this.features || !this.track) throw new Error('primero hay que analizar una canción');
  }

  _track({ bpmHint, strict }) {
    const { minBpm, maxBpm } = this.options;
    const { musicStart, musicEnd } = this.bounds;
    const tr = trackBeats(this.features, {
      minBpm, maxBpm, musicStart, musicEnd, samples: this.samples, sampleRate: this.sampleRate, tempo: this.tempo, bpmHint, strict,
    });
    const raw = Array.from(tr.beats || []);
    const beats = refineBeats(this.samples, this.sampleRate, raw, { musicStart, musicEnd });
    const strength = beats.map((_, i) => {
      const v = tr.strength ? Number(tr.strength[i]) : 0;
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    });
    const conf = Number(tr.confidence);
    this.track = { beats, strength, confidence: beats.length >= 2 && Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0 };
  }

  _label() {
    const beats = this.track.beats;
    this.forced = sanitizeForced(this.forced, beats.length);
    const lb = labelBars(this.features, beats, { beatsPerBar: this.beatsPerBar, forcedDownbeats: this.forced });
    let conf = Number(lb.confidence);
    conf = beats.length >= 2 && Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0;
    if (this.forced.length && beats.length >= 2) conf = Math.max(conf, FORCED_CONFIDENCE);
    this.bars = {
      beatsPerBar: lb.beatsPerBar,
      meterAuto: !!lb.meterAuto,
      positions: Array.from(lb.positions || []),
      downbeats: Array.from(lb.downbeats || []),
      confidence: conf,
    };
  }

  /** AnalysisResult del estado actual. */
  result(timings = {}) {
    this._requireAnalysis();
    const beats = this.track.beats.slice();
    const { bpm, bpmRange } = tempoSummary(beats);
    const timingsMs = {};
    for (const [k, v] of Object.entries(timings)) timingsMs[k] = round(v, 1);
    return {
      duration: this.duration,
      musicStart: this.bounds.musicStart,
      musicEnd: this.bounds.musicEnd,
      lastOnset: this.lastOnset,
      bpm,
      bpmRange,
      beats,
      beatStrength: this.track.strength.slice(),
      beatsPerBar: this.bars.beatsPerBar,
      meterAuto: this.bars.meterAuto,
      positions: this.bars.positions.slice(),
      downbeats: this.bars.downbeats.slice(),
      forcedDownbeats: this.forced.slice(),
      confidence: { beats: round(this.track.confidence, 3), bars: round(this.bars.confidence, 3) },
      timingsMs,
    };
  }
}

/**
 * Análisis completo de una canción.
 * @param {Float32Array} samples mono (normalmente 22050 Hz); no se modifica
 * @param {number} sampleRate
 * @param {object} [options] { minBpm=50, maxBpm=220, beatsPerBar='auto' }
 * @param {(stage: string, fraction: number) => void} [onProgress]
 * @returns {object} AnalysisResult
 */
export function analyze(samples, sampleRate, options = {}, onProgress) {
  return new AnalysisSession(samples, sampleRate, options).run(onProgress);
}
