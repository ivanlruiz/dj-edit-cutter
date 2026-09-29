// Vista de forma de onda (canvas): tira de resumen + vista con zoom, cuadrícula de beats/compases,
// marcador de corte arrastrable, fade, zona que se quita, trozos que quita o repite el cambio de compás
// y cabezal de reproducción.
// Las funciones puras exportadas (picos, imán, zoom) se prueban en Node.

import { clamp, nearestIndex, lowerBound, formatTime } from './format.js';

export const PEAK_BLOCK = 256;
export const MIN_VIEW_SPAN = 0.1; // s

// Mipmap de picos: nivel 0 = min/max/rms cada `blockSize` muestras (todas las pistas); cada nivel siguiente agrupa de a 2
export function buildPeakPyramid(channels, blockSize = PEAK_BLOCK) {
  const nch = channels.length;
  const n = nch ? channels[0].length : 0;
  const nb = Math.max(1, Math.ceil(n / blockSize));
  const min = new Float32Array(nb);
  const max = new Float32Array(nb);
  const rms = new Float32Array(nb);
  let peak = 0;
  for (let b = 0; b < nb; b++) {
    const i0 = b * blockSize;
    const i1 = Math.min(n, i0 + blockSize);
    let lo = Infinity;
    let hi = -Infinity;
    let sq = 0;
    for (let c = 0; c < nch; c++) {
      const d = channels[c];
      for (let i = i0; i < i1; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
      }
    }
    const cnt = (i1 - i0) * nch;
    if (cnt <= 0) {
      lo = 0;
      hi = 0;
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = cnt > 0 ? Math.sqrt(sq / cnt) : 0;
    const a = Math.max(-lo, hi);
    if (a > peak) peak = a;
  }
  const levels = [{ blockSize, min, max, rms }];
  let cur = levels[0];
  while (cur.min.length > 1) {
    const len = Math.ceil(cur.min.length / 2);
    const nmin = new Float32Array(len);
    const nmax = new Float32Array(len);
    const nrms = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const a = 2 * i;
      const b = Math.min(a + 1, cur.min.length - 1);
      nmin[i] = Math.min(cur.min[a], cur.min[b]);
      nmax[i] = Math.max(cur.max[a], cur.max[b]);
      nrms[i] = Math.sqrt((cur.rms[a] * cur.rms[a] + cur.rms[b] * cur.rms[b]) / 2);
    }
    cur = { blockSize: cur.blockSize * 2, min: nmin, max: nmax, rms: nrms };
    levels.push(cur);
  }
  return { levels, peak, length: n };
}

// Nivel más grueso cuyo bloque no supera las muestras por píxel (-1 = usar muestras crudas)
export function pickLevel(pyramid, samplesPerPixel) {
  const base = pyramid.levels[0].blockSize;
  if (samplesPerPixel < base) return -1;
  const k = Math.floor(Math.log2(samplesPerPixel / base));
  return clamp(k, 0, pyramid.levels.length - 1);
}

// Imán: el beat más cercano si está a menos de `thresholdSec`
export function snapToBeat(beats, time, thresholdSec) {
  const i = nearestIndex(beats, time);
  if (i >= 0 && Math.abs(beats[i] - time) <= thresholdSec) return { time: beats[i], index: i, snapped: true };
  return { time, index: i, snapped: false };
}

export function clampView(start, end, duration, minSpan = MIN_VIEW_SPAN) {
  if (!(duration > 0)) return { start: 0, end: 0 };
  let span = clamp(end - start, Math.min(minSpan, duration), duration);
  let s = start;
  if (s < 0) s = 0;
  if (s + span > duration) s = duration - span;
  if (s < 0) s = 0;
  return { start: s, end: s + span };
}

// Zoom manteniendo `anchor` (s) en el mismo sitio de la pantalla; factor < 1 acerca
// Gesto de un dedo/ratón que empezó como toque: 'pan' si se mueve en horizontal, 'cancel' si se mueve en vertical
// (el usuario quiere desplazar la página: ni paneo ni salto del cabezal), 'tap' mientras siga casi quieto.
export const PAN_START_PX = 6;
export const SCROLL_CANCEL_PX = 8;
export function classifyTapMove(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > PAN_START_PX && ax >= ay) return 'pan';
  if (ay > SCROLL_CANCEL_PX) return 'cancel';
  return 'tap';
}

export function zoomView(view, factor, anchor, duration, minSpan = MIN_VIEW_SPAN) {
  const span = view.end - view.start;
  if (!(span > 0)) return clampView(0, duration, duration, minSpan);
  const a = Number.isFinite(anchor) ? anchor : (view.start + view.end) / 2;
  const rel = clamp((a - view.start) / span, 0, 1);
  const nspan = clamp(span * factor, Math.min(minSpan, duration), duration);
  return clampView(a - rel * nspan, a - rel * nspan + nspan, duration, minSpan);
}

const RULER_H = 20; // franja superior con números de compás
export const PILL_W = 50; // ancho de la etiqueta CORTE

// x de la etiqueta CORTE: a la derecha de la línea (sobre la zona que se quita) si cabe; si no, a la izquierda
export function cutPillX(xCut, width) {
  if (xCut + PILL_W <= width) return Math.max(0, xCut - 1);
  return Math.max(0, xCut - PILL_W + 1);
}
const TIME_H = 16; // franja inferior con tiempos
const TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const COLOR_VARS = {
  bg: '--wf-bg', ruler: '--wf-ruler', peak: '--wf-peak', rms: '--wf-rms', ghost: '--wf-ghost',
  removed: '--wf-removed', removedRms: '--wf-removed-rms', dim: '--wf-dim', hatch: '--wf-hatch',
  beat: '--wf-beat', downbeat: '--wf-downbeat', barnum: '--wf-barnum', text: '--wf-text',
  cut: '--wf-cut', cutText: '--wf-cut-text', fade: '--wf-fade', playhead: '--wf-playhead',
  window: '--wf-window', windowBorder: '--wf-window-border', center: '--wf-center',
  meterRemoved: '--wf-meter-removed', meterHatch: '--wf-meter-hatch', meterRepeat: '--wf-meter-repeat',
  meterRepeatEdge: '--wf-meter-repeat-edge',
};

const FALLBACK_COLORS = {
  bg: '#070b10', ruler: '#0d141c', peak: '#1f8fff', rms: '#62e3ff', ghost: 'rgba(98,227,255,0.18)',
  removed: '#344150', removedRms: '#4b5968', dim: 'rgba(7,11,16,0.45)', hatch: 'rgba(255,255,255,0.05)',
  beat: 'rgba(255,255,255,0.14)', downbeat: 'rgba(255,255,255,0.55)', barnum: '#d6e6f5', text: '#7f90a3',
  cut: '#ff6a3d', cutText: '#1a0a04', fade: 'rgba(255,106,61,0.30)', playhead: '#ffffff',
  window: 'rgba(98,227,255,0.14)', windowBorder: '#62e3ff', center: 'rgba(255,255,255,0.08)',
  meterRemoved: 'rgba(255,77,77,0.30)', meterHatch: 'rgba(255,120,120,0.75)', meterRepeat: 'rgba(61,220,151,0.26)',
  meterRepeatEdge: '#3ddc97',
};

// Primer índice de una lista de tramos { start, end } (ordenada) cuyo final es > t
export function firstSliceEndingAfter(slices, t) {
  let lo = 0;
  let hi = slices.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (slices[m].end <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// Tramos que se ven en [t0, t1]: índices [i0, i1)
export function visibleSlices(slices, t0, t1) {
  if (!slices || !slices.length) return [0, 0];
  const i0 = firstSliceEndingAfter(slices, t0);
  let i1 = i0;
  while (i1 < slices.length && slices[i1].start < t1) i1++;
  return [i0, i1];
}

export class WaveformView extends EventTarget {
  constructor(root, { overviewHeight = 44 } = {}) {
    super();
    this.root = root;
    this.overviewHeight = overviewHeight;
    this.overview = document.createElement('canvas');
    this.overview.className = 'wf-overview';
    this.overview.setAttribute('role', 'img');
    this.overview.setAttribute('aria-label', 'Resumen de toda la canción. Toca para saltar a esa zona.');
    this.main = document.createElement('canvas');
    this.main.className = 'wf-main';
    this.main.setAttribute('role', 'img');
    this.main.setAttribute('aria-label', 'Forma de onda con la cuadrícula de compases y el punto de corte. Arrastra el marcador naranja para mover el corte.');
    root.append(this.overview, this.main);

    this.buffer = null;
    this.channels = [];
    this.sampleRate = 44100;
    this.duration = 0;
    this.pyramid = null;
    this.norm = 1;
    this.beats = [];
    this.bars = [];
    this.lastBarIndex = -1;
    this.meterRemoved = [];
    this.meterRepeated = [];
    this.cutTime = null;
    this.fadeSec = 0;
    this.gainFn = null;
    this.playhead = 0;
    this.snap = true;
    this.view = { start: 0, end: 0 };
    this.colors = { ...FALLBACK_COLORS };
    this._hatch = null;
    this._hatchRed = null;
    this._dirty = true;
    this._raf = 0;
    this._pointers = new Map();
    this._drag = null;
    this._ovDrag = null;
    this._gesture = false; // pellizco de trackpad en Safari (gesturestart … gestureend)
    this._lastInteraction = 0;
    this._hoverCut = false;
    this._cols = null;

    this._readColors();
    this._onResize = () => this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(root);
    } else {
      window.addEventListener('resize', this._onResize);
    }
    this._mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    this._onTheme = () => {
      this._readColors();
      this.invalidate();
    };
    if (this._mql && this._mql.addEventListener) this._mql.addEventListener('change', this._onTheme);

    this._bindMain();
    this._bindOverview();
    this._resize();
  }

  // ---------- API pública ----------

  setBuffer(audioBuffer) {
    this.buffer = audioBuffer || null;
    this.channels = [];
    this.pyramid = null;
    if (audioBuffer) {
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) this.channels.push(audioBuffer.getChannelData(c));
      this.sampleRate = audioBuffer.sampleRate;
      this.duration = audioBuffer.duration;
      this.pyramid = buildPeakPyramid(this.channels);
      this.norm = Math.min(8, 0.96 / Math.max(this.pyramid.peak, 1e-3));
      this.view = { start: 0, end: this.duration };
    } else {
      this.duration = 0;
      this.view = { start: 0, end: 0 };
      this.beats = [];
      this.bars = [];
      this.lastBarIndex = -1;
      this.meterRemoved = [];
      this.meterRepeated = [];
      this.cutTime = null;
      this.fadeSec = 0;
      this.playhead = 0;
    }
    this._emitView();
    this.invalidate();
  }

  // beats: tiempos (s); bars: [{ start, number, index }] (p. ej. getBars(result)); lastBarIndex: último compás que
  // cuenta (el del golpe final): los de la cola que resuena no llevan número. -1 = todos.
  setGrid({ beats = [], bars = [], lastBarIndex = -1 } = {}) {
    this.beats = beats;
    this.bars = bars;
    this.lastBarIndex = Number.isInteger(lastBarIndex) ? lastBarIndex : -1;
    this.invalidate();
  }

  // Cambio de compás: tramos que se quitan (rayado rojo) y que se repiten (verde), ordenados. null = ninguno.
  setMeterEdit(edit) {
    this.meterRemoved = (edit && edit.removed) || [];
    this.meterRepeated = (edit && edit.repeated) || [];
    this.invalidate();
  }

  setCut(time) {
    this.cutTime = Number.isFinite(time) ? time : null;
    this.invalidate();
  }

  setFade(sec, gainFn = null) {
    this.fadeSec = Math.max(0, sec || 0);
    this.gainFn = gainFn;
    this.invalidate();
  }

  setSnap(enabled) {
    this.snap = !!enabled;
  }

  // follow: durante la reproducción, pasa de página cuando el cabezal sale de la vista
  setPlayhead(time, { follow = false } = {}) {
    this.playhead = Number.isFinite(time) ? time : 0;
    if (follow && this.duration && !this._drag && performance.now() - this._lastInteraction > 1500) {
      const { start, end } = this.view;
      const span = end - start;
      if (this.playhead > start + span * 0.94 || this.playhead < start) {
        this.setView(this.playhead - span * 0.08, this.playhead + span * 0.92);
      }
    }
    this.invalidate();
  }

  setView(start, end) {
    const v = clampView(start, end, this.duration, this._minSpan());
    if (v.start === this.view.start && v.end === this.view.end) return;
    this.view = v;
    this._emitView();
    this.invalidate();
  }

  getView() {
    return { ...this.view };
  }

  zoomBy(factor, anchor) {
    const a = Number.isFinite(anchor) ? anchor : this._defaultAnchor();
    const v = zoomView(this.view, factor, a, this.duration, this._minSpan());
    this.setView(v.start, v.end);
  }

  showAll() {
    this.setView(0, this.duration);
  }

  // Centra la vista en `time` (con `span` opcional)
  centerOn(time, span) {
    const s = Number.isFinite(span) ? span : this.view.end - this.view.start;
    this.setView(time - s / 2, time + s / 2);
  }

  // Asegura que `time` sea visible (con margen)
  reveal(time) {
    const { start, end } = this.view;
    const span = end - start;
    const m = span * 0.06;
    if (time < start + m) this.setView(time - span * 0.25, time + span * 0.75);
    else if (time > end - m) this.setView(time - span * 0.75, time + span * 0.25);
  }

  get zoomLimits() {
    const span = this.view.end - this.view.start;
    return { canZoomIn: span > this._minSpan() * 1.01, canZoomOut: span < this.duration * 0.999 };
  }

  invalidate() {
    this._dirty = true;
    if (!this._raf && typeof requestAnimationFrame !== 'undefined') {
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        if (this._dirty) this._draw();
      });
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    else window.removeEventListener('resize', this._onResize);
    if (this._mql && this._mql.removeEventListener) this._mql.removeEventListener('change', this._onTheme);
    if (this._raf) cancelAnimationFrame(this._raf);
    this.overview.remove();
    this.main.remove();
  }

  // ---------- internos ----------

  _minSpan() {
    const w = this._w || 600;
    return Math.max(MIN_VIEW_SPAN, (w * 2) / (this.sampleRate || 44100));
  }

  _defaultAnchor() {
    const { start, end } = this.view;
    if (this.cutTime != null && this.cutTime >= start && this.cutTime <= end) return this.cutTime;
    return (start + end) / 2;
  }

  _emitView() {
    this.dispatchEvent(new CustomEvent('viewchange', { detail: { ...this.view } }));
  }

  _readColors() {
    const cs = getComputedStyle(this.root);
    for (const [k, v] of Object.entries(COLOR_VARS)) {
      const val = cs.getPropertyValue(v).trim();
      this.colors[k] = val || FALLBACK_COLORS[k];
    }
    this._hatch = null;
    this._hatchRed = null;
  }

  _resize() {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (dpr !== this._dpr) {
      this._hatch = null;
      this._hatchRed = null;
    }
    this._dpr = dpr;
    for (const cv of [this.overview, this.main]) {
      const r = cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
    }
    const r = this.main.getBoundingClientRect();
    this._w = r.width;
    this._h = r.height;
    const ro = this.overview.getBoundingClientRect();
    this._ow = ro.width;
    this._oh = ro.height;
    this._dirty = true;
    this._draw();
  }

  _xOf(t) {
    const { start, end } = this.view;
    return ((t - start) / (end - start)) * this._w;
  }

  _tOf(x) {
    const { start, end } = this.view;
    return start + (x / this._w) * (end - start);
  }

  _hatchPattern(ctx) {
    if (!this._hatch) this._hatch = this._makeHatch(ctx, this.colors.hatch, 10);
    return this._hatch;
  }

  _redHatchPattern(ctx) {
    if (!this._hatchRed) this._hatchRed = this._makeHatch(ctx, this.colors.meterHatch, 6);
    return this._hatchRed;
  }

  _makeHatch(ctx, color, size) {
    const c = document.createElement('canvas');
    const s = Math.round(size * (this._dpr || 1));
    c.width = s;
    c.height = s;
    const g = c.getContext('2d');
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, (this._dpr || 1) * 1.2);
    g.beginPath();
    g.moveTo(-1, s + 1);
    g.lineTo(s + 1, -1);
    g.moveTo(-1, 1);
    g.lineTo(1, -1);
    g.moveTo(s - 1, s + 1);
    g.lineTo(s + 1, s - 1);
    g.stroke();
    const pat = ctx.createPattern(c, 'repeat');
    if (pat && pat.setTransform && typeof DOMMatrix !== 'undefined') {
      const k = 1 / (this._dpr || 1);
      pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
    }
    return pat;
  }

  // Calcula min/max/rms por columna (ancho `cols`) para el intervalo [t0, t1]
  _columns(t0, t1, cols) {
    if (!this._cols || this._cols.lo.length < cols) {
      this._cols = { lo: new Float32Array(cols), hi: new Float32Array(cols), rms: new Float32Array(cols) };
    }
    const { lo, hi, rms } = this._cols;
    const sr = this.sampleRate;
    const spp = ((t1 - t0) * sr) / cols;
    const n = this.pyramid.length;
    const level = pickLevel(this.pyramid, spp);
    if (level < 0) {
      const chs = this.channels;
      const nch = chs.length;
      for (let x = 0; x < cols; x++) {
        let s0 = Math.floor((t0 * sr) + x * spp);
        let s1 = Math.floor((t0 * sr) + (x + 1) * spp);
        if (s1 <= s0) s1 = s0 + 1;
        if (s0 < 0) s0 = 0;
        if (s1 > n) s1 = n;
        let l = Infinity;
        let h = -Infinity;
        let sq = 0;
        for (let c = 0; c < nch; c++) {
          const d = chs[c];
          for (let i = s0; i < s1; i++) {
            const v = d[i];
            if (v < l) l = v;
            if (v > h) h = v;
            sq += v * v;
          }
        }
        const cnt = (s1 - s0) * nch;
        if (cnt <= 0) {
          lo[x] = 0;
          hi[x] = 0;
          rms[x] = 0;
        } else {
          lo[x] = l;
          hi[x] = h;
          rms[x] = Math.sqrt(sq / cnt);
        }
      }
      return this._cols;
    }
    const L = this.pyramid.levels[level];
    const B = L.blockSize;
    const nb = L.min.length;
    for (let x = 0; x < cols; x++) {
      const s0 = t0 * sr + x * spp;
      const s1 = s0 + spp;
      let b0 = Math.floor(s0 / B);
      let b1 = Math.floor(s1 / B);
      if (b1 <= b0) b1 = b0 + 1;
      if (b0 < 0) b0 = 0;
      if (b1 > nb) b1 = nb;
      if (b0 >= b1 || s0 >= n) {
        lo[x] = 0;
        hi[x] = 0;
        rms[x] = 0;
        continue;
      }
      let l = Infinity;
      let h = -Infinity;
      let sq = 0;
      for (let b = b0; b < b1; b++) {
        if (L.min[b] < l) l = L.min[b];
        if (L.max[b] > h) h = L.max[b];
        sq += L.rms[b] * L.rms[b];
      }
      lo[x] = l;
      hi[x] = h;
      rms[x] = Math.sqrt(sq / (b1 - b0));
    }
    return this._cols;
  }

  _draw() {
    this._dirty = false;
    if (!this._w) return;
    this._drawMain();
    this._drawOverview();
  }

  _drawMain() {
    const cv = this.main;
    const ctx = cv.getContext('2d');
    const dpr = this._dpr || 1;
    const W = this._w;
    const H = this._h;
    const C = this.colors;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillRect(0, H - TIME_H, W, TIME_H);
    if (!this.pyramid || !(this.view.end > this.view.start)) return;

    const { start, end } = this.view;
    const span = end - start;
    const pxPerSec = W / span;
    const waveTop = RULER_H + 2;
    const waveBot = H - TIME_H - 2;
    const mid = (waveTop + waveBot) / 2;
    const amp = ((waveBot - waveTop) / 2) * this.norm;
    const cut = this.cutTime;
    const fade = cut != null ? Math.max(0, Math.min(this.fadeSec, cut)) : 0;
    const fadeStart = cut != null ? cut - fade : Infinity;

    // línea central
    ctx.fillStyle = C.center;
    ctx.fillRect(0, Math.round(mid), W, 1);

    // forma de onda por columnas de píxel físico
    const cols = Math.max(1, Math.round(W * dpr));
    const colW = W / cols;
    const { lo, hi, rms } = this._columns(start, end, cols);
    const secPerCol = span / cols;
    const colOf = (t) => clamp(Math.floor((t - start) / secPerCol), 0, cols);
    const cFade = cut != null ? colOf(fadeStart) : cols;
    const cCut = cut != null ? colOf(cut) : cols;
    const gainAt = (x) => {
      if (!fade) return 1;
      const t = start + (x + 0.5) * secPerCol;
      const p = clamp((t - fadeStart) / fade, 0, 1);
      return this.gainFn ? clamp(this.gainFn(p), 0, 1) : 1 - p;
    };
    const drawRange = (x0, x1, peakColor, rmsColor, gain) => {
      if (x1 <= x0) return;
      ctx.fillStyle = peakColor;
      for (let x = x0; x < x1; x++) {
        const g = gain ? gain(x) : 1;
        const top = mid - hi[x] * amp * g;
        const bot = mid - lo[x] * amp * g;
        ctx.fillRect(x * colW, top, colW, Math.max(colW, bot - top));
      }
      if (!rmsColor) return;
      ctx.fillStyle = rmsColor;
      for (let x = x0; x < x1; x++) {
        const g = gain ? gain(x) : 1;
        const r = Math.min(rms[x], Math.max(hi[x], -lo[x])) * amp * g;
        if (r > 0.3) ctx.fillRect(x * colW, mid - r, colW, 2 * r);
      }
    };
    drawRange(0, cFade, C.peak, C.rms);
    if (cCut > cFade) {
      drawRange(cFade, cCut, C.ghost, null);
      drawRange(cFade, cCut, C.peak, C.rms, gainAt);
    }
    drawRange(cCut, cols, C.removed, C.removedRms);

    // cuadrícula: beats finos, compases más marcados
    const beats = this.beats;
    if (beats.length > 1) {
      const ibi = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
      if (ibi * pxPerSec >= 5) {
        ctx.fillStyle = C.beat;
        for (let i = lowerBound(beats, start); i < beats.length && beats[i] <= end; i++) {
          const x = Math.round(this._xOf(beats[i]));
          ctx.globalAlpha = cut != null && beats[i] >= cut ? 0.5 : 1;
          ctx.fillRect(x, waveTop, 1, waveBot - waveTop);
        }
        ctx.globalAlpha = 1;
      }
    }
    // caja de la etiqueta CORTE (a la derecha de la línea, sobre lo que se quita) para no pisarla con números de
    // compás: así se lee el número del último compás que queda
    let pill = null;
    if (cut != null && cut >= start && cut <= end) {
      const xc = Math.round(this._xOf(cut));
      const px = cutPillX(xc, W);
      // a la derecha la caja empieza en la línea; a la izquierda se deja un margen de 3 px
      pill = { x0: px >= xc - 1 ? px : px - 3, x1: px + PILL_W + 1 };
    }
    const bars = this.bars;
    if (bars.length) {
      const barLen = bars.length > 1 ? (bars[bars.length - 1].start - bars[0].start) / (bars.length - 1) : span;
      const pxPerBar = barLen * pxPerSec;
      let every = 1;
      while (pxPerBar * every < 26 && every < 1024) every *= 2;
      const lineStep = pxPerBar >= 3 ? 1 : every;
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const first = Math.max(0, lowerBoundBars(bars, start) - 1);
      for (let i = first; i < bars.length; i++) {
        const b = bars[i];
        if (b.start > end) break;
        if (b.start < start - barLen) continue;
        const removed = cut != null && b.start >= cut - 1e-6;
        const x = Math.round(this._xOf(b.start));
        if ((b.number - 1) % lineStep === 0) {
          ctx.globalAlpha = removed ? 0.45 : 1;
          ctx.fillStyle = C.downbeat;
          ctx.fillRect(x - 0.5, RULER_H - 6, 1.5, waveBot - RULER_H + 6);
        }
        const counted = this.lastBarIndex < 0 || b.index === undefined || b.index <= this.lastBarIndex;
        if (counted && (b.number - 1) % every === 0 && x >= -2 && x < W - 8) {
          const label = String(b.number);
          const lw = ctx.measureText(label).width;
          let lx = x + 3;
          // compás estrecho justo antes de la etiqueta CORTE: el número se arrima a su línea en vez de desaparecer
          if (pill && lx < pill.x0 && lx + lw >= pill.x0 && pill.x0 - lw - 1 >= x + 1) lx = pill.x0 - lw - 1;
          if (!pill || lx + lw < pill.x0 || lx > pill.x1) {
            ctx.globalAlpha = removed ? 0.5 : 1;
            ctx.fillStyle = C.barnum;
            ctx.fillText(label, lx, RULER_H / 2);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // cambio de compás: trozos que se quitan / se repiten en cada compás
    this._drawMeterSlices(ctx, waveTop, waveBot, start, end);

    // zona que se quita
    if (cut != null && cut < end) {
      const x0 = Math.max(0, this._xOf(cut));
      ctx.fillStyle = C.dim;
      ctx.fillRect(x0, 0, W - x0, H - TIME_H);
      ctx.fillStyle = this._hatchPattern(ctx) || C.dim;
      ctx.fillRect(x0, waveTop, W - x0, waveBot - waveTop);
      const wReg = W - x0;
      if (wReg > 70) {
        ctx.font = '700 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lx = x0 + Math.min(wReg / 2, 80);
        const label = 'Se quita';
        const tw = ctx.measureText(label).width + 16;
        ctx.fillStyle = C.bg;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, lx - tw / 2, waveTop + 8, tw, 22, 11);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.text;
        ctx.fillText(label, lx, waveTop + 19);
      }
    }

    // fade: degradado + curva de ganancia
    if (cut != null && fade > 0 && cut > start && fadeStart < end) {
      const x0 = this._xOf(fadeStart);
      const x1 = this._xOf(cut);
      if (x1 - x0 > 1) {
        const grad = ctx.createLinearGradient(x0, 0, x1, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, C.fade);
        ctx.fillStyle = grad;
        ctx.fillRect(x0, waveTop, x1 - x0, waveBot - waveTop);
        ctx.strokeStyle = C.cut;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const steps = Math.max(8, Math.min(200, Math.round(x1 - x0)));
        for (let k = 0; k <= steps; k++) {
          const p = k / steps;
          const g = this.gainFn ? clamp(this.gainFn(p), 0, 1) : 1 - p;
          const x = x0 + (x1 - x0) * p;
          const y = waveTop + 4 + (1 - g) * (waveBot - waveTop - 8);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // tiempos en la franja inferior
    this._drawTimeTicks(ctx, W, H, pxPerSec);

    // cabezal
    if (this.playhead >= start && this.playhead <= end) {
      const x = Math.round(this._xOf(this.playhead));
      ctx.fillStyle = C.playhead;
      ctx.fillRect(x - 0.75, RULER_H, 1.5, H - RULER_H - TIME_H);
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER_H);
      ctx.lineTo(x + 5, RULER_H);
      ctx.lineTo(x, RULER_H + 6);
      ctx.closePath();
      ctx.fill();
    }

    // marcador de corte con asa
    if (cut != null && cut >= start && cut <= end) {
      const x = Math.round(this._xOf(cut));
      ctx.fillStyle = C.cut;
      const lw = this._drag && this._drag.kind === 'cut' ? 3 : 2;
      ctx.fillRect(x - lw / 2, 0, lw, H - TIME_H);
      const pw = PILL_W;
      const px = cutPillX(x, W);
      roundRect(ctx, px, 1, pw, RULER_H - 2, 6);
      ctx.fill();
      ctx.fillStyle = C.cutText;
      ctx.font = '800 10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CORTE', px + pw / 2, RULER_H / 2 + 0.5);
      // asa inferior (para dedos)
      ctx.fillStyle = C.cut;
      const hy = waveBot - 12;
      roundRect(ctx, x - 7, hy - 12, 14, 24, 7);
      ctx.fill();
      ctx.fillStyle = C.cutText;
      ctx.fillRect(x - 3, hy - 5, 1.5, 10);
      ctx.fillRect(x + 1.5, hy - 5, 1.5, 10);
    }
  }

  _drawMeterSlices(ctx, top, bot, start, end) {
    const C = this.colors;
    const h = bot - top;
    const rm = this.meterRemoved;
    if (rm.length) {
      const [i0, i1] = visibleSlices(rm, start, end);
      if (i1 > i0) {
        const hatch = this._redHatchPattern(ctx);
        // relleno + rayado en una sola pasada por color
        for (const style of [C.meterRemoved, hatch]) {
          if (!style) continue;
          ctx.fillStyle = style;
          ctx.beginPath();
          for (let i = i0; i < i1; i++) {
            const x0 = this._xOf(rm[i].start);
            const w = Math.max(1, this._xOf(rm[i].end) - x0);
            ctx.rect(x0, top, w, h);
          }
          ctx.fill();
        }
      }
    }
    const rp = this.meterRepeated;
    if (rp.length) {
      const [i0, i1] = visibleSlices(rp, start, end);
      if (i1 > i0) {
        ctx.fillStyle = C.meterRepeat;
        ctx.beginPath();
        for (let i = i0; i < i1; i++) {
          const x0 = this._xOf(rp[i].start);
          ctx.rect(x0, top, Math.max(1, this._xOf(rp[i].end) - x0), h);
        }
        ctx.fill();
        ctx.fillStyle = C.meterRepeatEdge;
        ctx.font = '800 10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = i0; i < i1; i++) {
          const x0 = this._xOf(rp[i].start);
          const x1 = this._xOf(rp[i].end);
          ctx.fillRect(Math.round(x0), top, 1, 3);
          ctx.fillRect(Math.round(x0), top, Math.max(1, x1 - x0), 2);
          if (x1 - x0 >= 24) ctx.fillText('×2', (x0 + x1) / 2, top + 4);
        }
      }
    }
  }

  _drawTimeTicks(ctx, W, H, pxPerSec) {
    const C = this.colors;
    let step = TICK_STEPS[TICK_STEPS.length - 1];
    for (const s of TICK_STEPS) {
      if (s * pxPerSec >= 80) {
        step = s;
        break;
      }
    }
    const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    ctx.font = '500 10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    const { start, end } = this.view;
    const first = Math.ceil(start / step - 1e-9) * step;
    for (let t = first; t <= end + 1e-9; t += step) {
      const x = Math.round(this._xOf(t));
      ctx.fillRect(x, H - TIME_H, 1, 4);
      if (x < W - 30) ctx.fillText(formatTime(t, dec), x + 3, H - TIME_H / 2 + 1);
    }
  }

  _drawOverview() {
    const cv = this.overview;
    const ctx = cv.getContext('2d');
    const dpr = this._dpr || 1;
    const W = this._ow;
    const H = this._oh;
    const C = this.colors;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.pyramid || !this.duration) return;
    const cols = Math.max(1, Math.round(W * dpr));
    const colW = W / cols;
    // reutiliza el buffer de columnas sin pisar el de la vista principal
    const saved = this._cols;
    this._cols = this._ovCols;
    const { lo, hi, rms } = this._columns(0, this.duration, cols);
    this._ovCols = this._cols;
    this._cols = saved;
    const mid = H / 2;
    const amp = (H / 2 - 3) * this.norm;
    const cut = this.cutTime;
    const cCut = cut != null ? clamp(Math.floor((cut / this.duration) * cols), 0, cols) : cols;
    const pass = (x0, x1, color, useRms) => {
      ctx.fillStyle = color;
      for (let x = x0; x < x1; x++) {
        if (useRms) {
          const r = rms[x] * amp;
          if (r > 0.3) ctx.fillRect(x * colW, mid - r, colW, 2 * r);
        } else {
          const top = mid - hi[x] * amp;
          ctx.fillRect(x * colW, top, colW, Math.max(colW, (hi[x] - lo[x]) * amp));
        }
      }
    };
    pass(0, cCut, C.peak, false);
    pass(0, cCut, C.rms, true);
    pass(cCut, cols, C.removed, false);
    pass(cCut, cols, C.removedRms, true);
    const k = W / this.duration;
    if (cut != null) {
      ctx.fillStyle = C.dim;
      ctx.fillRect(cut * k, 0, W - cut * k, H);
    }
    // cambio de compás: marcas finas en la parte baja de la tira
    for (const [list, color] of [[this.meterRemoved, C.meterHatch], [this.meterRepeated, C.meterRepeatEdge]]) {
      if (!list.length) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const sl of list) ctx.rect(sl.start * k, H - 6, Math.max(1, (sl.end - sl.start) * k), 5);
      ctx.fill();
    }
    // ventana visible
    const vx0 = this.view.start * k;
    const vx1 = Math.max(vx0 + 3, this.view.end * k);
    ctx.fillStyle = C.window;
    ctx.fillRect(vx0, 0, vx1 - vx0, H);
    ctx.strokeStyle = C.windowBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx0 + 0.75, 0.75, Math.max(1, vx1 - vx0 - 1.5), H - 1.5);
    if (cut != null) {
      ctx.fillStyle = C.cut;
      ctx.fillRect(Math.round(cut * k) - 1, 0, 2, H);
    }
    ctx.fillStyle = C.playhead;
    ctx.fillRect(Math.round(this.playhead * k), 0, 1, H);
  }

  // ---------- interacción ----------

  _localX(e, el) {
    const r = el.getBoundingClientRect();
    return e.clientX - r.left;
  }

  _localY(e, el) {
    const r = el.getBoundingClientRect();
    return e.clientY - r.top;
  }

  _bindMain() {
    const cv = this.main;
    cv.addEventListener('pointerdown', (e) => this._onDown(e));
    cv.addEventListener('pointermove', (e) => this._onMove(e));
    cv.addEventListener('pointerup', (e) => this._onUp(e, false));
    cv.addEventListener('pointercancel', (e) => this._onUp(e, true));
    cv.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this._pointers.size) this._setHover(false);
    });
    cv.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => {
      if (this._drag) e.preventDefault();
    });
    // Safari de escritorio: el pellizco del trackpad llega como gesturestart/gesturechange (no como ctrl+rueda).
    // En iOS el pellizco táctil ya llega como dos punteros: ahí solo se evita el zoom de la página.
    if (typeof window !== 'undefined' && 'GestureEvent' in window) {
      let lastScale = 1;
      let anchor;
      cv.addEventListener('gesturestart', (e) => {
        e.preventDefault();
        this._gesture = true;
        lastScale = 1;
        anchor = Number.isFinite(e.clientX) ? this._tOf(this._localX(e, cv)) : undefined;
      });
      cv.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        const sc = Number(e.scale);
        if (this._pointers.size || !this.duration || !(sc > 0)) return;
        this._lastInteraction = performance.now();
        this.zoomBy(lastScale / sc, anchor);
        lastScale = sc;
      });
      cv.addEventListener('gestureend', (e) => {
        e.preventDefault();
        this._gesture = false;
      });
    }
  }

  _nearCut(x, pointerType) {
    if (this.cutTime == null) return false;
    const tol = pointerType === 'mouse' ? 8 : 22;
    return Math.abs(x - this._xOf(this.cutTime)) <= tol;
  }

  _setHover(on) {
    if (on === this._hoverCut) return;
    this._hoverCut = on;
    this.main.style.cursor = on ? 'ew-resize' : '';
  }

  _onDown(e) {
    if (!this.duration) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this._lastInteraction = performance.now();
    try {
      this.main.setPointerCapture(e.pointerId);
    } catch {
      // puntero ya liberado
    }
    const x = this._localX(e, this.main);
    const y = this._localY(e, this.main);
    this._pointers.set(e.pointerId, { x });
    if (this._pointers.size === 2) {
      // pellizco: cancela arrastre/paneo y hace zoom + paneo con dos dedos
      if (this._drag && this._drag.kind === 'cut' && this._drag.moved) {
        this._emitCut(this.cutTime, this._lastSnap || false, this._lastSnapIdx ?? -1, 'end');
      }
      const [a, b] = [...this._pointers.values()];
      const midX = (a.x + b.x) / 2;
      this._drag = {
        kind: 'pinch',
        d0: Math.max(12, Math.abs(a.x - b.x)),
        anchor: this._tOf(midX),
        span0: this.view.end - this.view.start,
      };
      return;
    }
    if (this._pointers.size > 2) return;
    if (this._nearCut(x, e.pointerType)) {
      this._drag = { kind: 'cut', id: e.pointerType, offset: x - this._xOf(this.cutTime), x0: x, y0: y, moved: false };
      this._emitCut(this.cutTime, false, -1, 'start');
      this.invalidate();
    } else {
      this._drag = { kind: 'tap', x0: x, y0: y, view0: { ...this.view } };
    }
  }

  _onMove(e) {
    const x = this._localX(e, this.main);
    if (!this._pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this._setHover(this._nearCut(x, 'mouse'));
      return;
    }
    this._pointers.get(e.pointerId).x = x;
    const d = this._drag;
    if (!d) return;
    this._lastInteraction = performance.now();
    if (d.kind === 'pinch') {
      const pts = [...this._pointers.values()];
      if (pts.length < 2) return;
      const dist = Math.max(12, Math.abs(pts[0].x - pts[1].x));
      const midX = (pts[0].x + pts[1].x) / 2;
      const span = clamp((d.span0 * d.d0) / dist, this._minSpan(), this.duration);
      const s = d.anchor - (midX / this._w) * span;
      this.setView(s, s + span);
      return;
    }
    if (d.kind === 'cut') {
      // un temblor de pocos píxeles no es un arrastre (un toque sobre el marcador no lo mueve)
      if (!d.moved && Math.abs(x - d.x0) <= 2) return;
      d.moved = true;
      const raw = clamp(this._tOf(x - d.offset), 0.05, this.duration);
      let t = raw;
      let snapped = false;
      let idx = -1;
      const free = e.altKey || e.shiftKey || !this.snap;
      if (!free && this.beats.length) {
        const tolPx = e.pointerType === 'mouse' ? 10 : 18;
        const secPerPx = (this.view.end - this.view.start) / this._w;
        const s = snapToBeat(this.beats, raw, tolPx * secPerPx);
        t = s.time;
        snapped = s.snapped;
        idx = s.snapped ? s.index : -1;
      }
      this.cutTime = t;
      this._emitCut(t, snapped, idx, 'move', raw);
      this.invalidate();
      return;
    }
    if (d.kind === 'tap') {
      const g = classifyTapMove(x - d.x0, this._localY(e, this.main) - d.y0);
      if (g === 'cancel') {
        // desplazamiento vertical de la página: el gesto no hace nada aquí
        d.kind = 'void';
        return;
      }
      if (g === 'pan') {
        d.kind = 'pan';
        this.main.style.cursor = 'grabbing';
      }
    }
    if (d.kind === 'pan') {
      const span = d.view0.end - d.view0.start;
      const dt = ((x - d.x0) / this._w) * span;
      this.setView(d.view0.start - dt, d.view0.end - dt);
    }
  }

  _onUp(e, cancelled) {
    if (!this._pointers.has(e.pointerId)) return;
    const x = this._localX(e, this.main);
    this._pointers.delete(e.pointerId);
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'pinch') {
      if (this._pointers.size === 1) {
        // sigue paneando con el dedo que queda
        const [p] = [...this._pointers.values()];
        this._drag = { kind: 'pan', x0: p.x, view0: { ...this.view } };
      } else if (!this._pointers.size) {
        this._drag = null;
      }
      return;
    }
    if (this._pointers.size) return;
    this._drag = null;
    this.main.style.cursor = this._hoverCut ? 'ew-resize' : '';
    if (d.kind === 'cut') {
      if (d.moved) {
        this._emitCut(this.cutTime, this._lastSnap || false, this._lastSnapIdx ?? -1, 'end');
      } else if (!cancelled) {
        // toque quieto sobre el marcador: el corte no cambia; salta ahí como cualquier otro toque
        const t = clamp(this._tOf(x), 0, this.duration);
        this.dispatchEvent(new CustomEvent('seek', { detail: { time: t } }));
      }
      this.invalidate();
    } else if (d.kind === 'tap' && !cancelled) {
      const t = clamp(this._tOf(x), 0, this.duration);
      this.dispatchEvent(new CustomEvent('seek', { detail: { time: t } }));
    }
  }

  _emitCut(time, snapped, beatIndex, phase, rawTime = time) {
    if (phase === 'move') {
      this._lastSnap = snapped;
      this._lastSnapIdx = beatIndex;
    } else if (phase === 'start') {
      this._lastSnap = false;
      this._lastSnapIdx = -1;
    }
    this.dispatchEvent(new CustomEvent('cutchange', { detail: { time, rawTime, snapped, beatIndex, phase } }));
  }

  _onWheel(e) {
    if (!this.duration) return;
    e.preventDefault();
    // si el navegador manda el pellizco como gesto Y como ctrl+rueda, solo cuenta el gesto
    if (this._gesture && e.ctrlKey) return;
    this._lastInteraction = performance.now();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this._h : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    const x = this._localX(e, this.main);
    if (Math.abs(dx) > Math.abs(dy)) {
      const span = this.view.end - this.view.start;
      const dt = (dx / this._w) * span;
      this.setView(this.view.start + dt, this.view.end + dt);
    } else if (dy) {
      const k = e.ctrlKey ? 0.01 : 0.0022;
      this.zoomBy(Math.exp(clamp(dy, -300, 300) * k), this._tOf(x));
    }
  }

  _bindOverview() {
    const cv = this.overview;
    const jump = (e) => {
      const x = this._localX(e, cv);
      const t = clamp((x / this._ow) * this.duration, 0, this.duration);
      this._lastInteraction = performance.now();
      this.centerOn(t);
    };
    // ratón: salta al pulsar; dedo: al soltar o al moverse en horizontal (un gesto vertical desplaza la página)
    cv.addEventListener('pointerdown', (e) => {
      if (!this.duration) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        // sin captura
      }
      const mouse = e.pointerType === 'mouse';
      this._ovDrag = { id: e.pointerId, x0: this._localX(e, cv), y0: this._localY(e, cv), state: mouse ? 'drag' : 'tap' };
      if (mouse) jump(e);
    });
    cv.addEventListener('pointermove', (e) => {
      const d = this._ovDrag;
      if (!d || d.id !== e.pointerId) return;
      if (d.state === 'tap') {
        const g = classifyTapMove(this._localX(e, cv) - d.x0, this._localY(e, cv) - d.y0);
        if (g === 'cancel') d.state = 'void';
        else if (g === 'pan') d.state = 'drag';
      }
      if (d.state === 'drag') jump(e);
    });
    const end = (e, cancelled) => {
      const d = this._ovDrag;
      if (!d || d.id !== e.pointerId) return;
      this._ovDrag = null;
      if (d.state === 'tap' && !cancelled) jump(e);
    };
    cv.addEventListener('pointerup', (e) => end(e, false));
    cv.addEventListener('pointercancel', (e) => end(e, true));
  }
}

function lowerBoundBars(bars, t) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].start < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
