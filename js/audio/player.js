// Reproducción con Web Audio: canción completa, vistas previas del edit y metrónomo con planificador anticipado.
// Todos los tiempos públicos están en la línea de tiempo de la canción ORIGINAL (la vista previa del cambio de
// compás suena en la línea de tiempo de la salida y se traduce con toSource).

const LOOKAHEAD_SEC = 0.15; // cuánto se adelanta el planificador
const TICK_MS = 25;
const START_DELAY = 0.04; // margen para programar el primer clic junto al audio
// Vista previa por tramos (render): nunca hay más de ~2 tramos en memoria aunque suene la canción entera
const CHUNK_SEC = 20;
const AHEAD_SEC = 8; // el tramo siguiente se prepara cuando queda menos que esto por sonar
const FEED_MS = 250;
const OVERLAP = 256; // muestras que se solapan entre tramos, con fundidos complementarios (es el mismo audio)

export class Player extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.buffer = null;
    this._source = null; // la fuente que suena al final (su 'ended' es el final de la reproducción)
    this._chain = []; // tramos anteriores ya programados de una vista previa por tramos
    this._feed = null; // vista previa por tramos: { render, sr, a0, next, end, cur }
    this._feedTimer = 0;
    this._master = null;
    this._clickBus = null;
    this._playing = false;
    this._mode = 'song';
    this._offset = 0; // posición cuando está en pausa
    this._startCtx = 0; // ctx.currentTime en que empezó a sonar
    this._startOffset = 0; // posición de la línea de tiempo en ese instante
    this._end = 0; // fin (línea de tiempo) de lo que suena
    this._metro = { enabled: false, beats: [], downbeatSet: new Set() };
    this._map = null; // vista previa: línea de tiempo interna (salida) → original
    this._previewClicks = null; // vista previa: { beats, accents } en la línea de tiempo interna
    this._previewTag = null;
    this._nextBeat = 0;
    this._clicks = [];
    this._timer = 0;
    this._raf = 0;
  }

  // Crea o reanuda el AudioContext; llamar desde un gesto del usuario (iOS)
  unlock() {
    const ctx = this._ensureContext();
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
    return ctx;
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      // Safari: que suene aunque el iPhone esté en silencio
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {
      // no disponible
    }
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this._master = ctx.createGain();
    this._master.connect(ctx.destination);
    this._clickBus = ctx.createGain();
    this._clickBus.gain.value = 0.55;
    this._clickBus.connect(ctx.destination);
    return ctx;
  }

  setBuffer(audioBuffer) {
    this.stop();
    this.buffer = audioBuffer || null;
    this._offset = 0;
    this._end = this.duration;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get playing() {
    return this._playing;
  }

  get mode() {
    return this._mode;
  }

  // Etiqueta que se pasó a playPreview (qué vista previa suena), o null
  get previewTag() {
    return this._playing && this._mode === 'preview' ? this._previewTag : null;
  }

  // Línea de tiempo interna → original
  _toTimeline(t) {
    if (!this._map) return t;
    const v = this._map(t);
    return Number.isFinite(v) ? v : t;
  }

  // Posición audible (compensa la latencia de salida para que el cabezal coincida con lo que se oye)
  get currentTime() {
    if (!this._playing || !this.ctx) return this._offset;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this._startCtx - lat);
    return this._toTimeline(Math.min(this._end, this._startOffset + elapsed));
  }

  // Posición "de planificación" (sin latencia)
  _timelineNow() {
    return this._startOffset + (this.ctx.currentTime - this._startCtx);
  }

  play(fromTime) {
    if (!this.buffer) return;
    const ctx = this.unlock();
    if (!ctx) return;
    let t = Number.isFinite(fromTime) ? fromTime : this._mode === 'song' ? this._offset : this.currentTime;
    t = Math.max(0, Math.min(t, this.duration));
    if (t >= this.duration - 0.02) t = 0;
    this._startSource(this.buffer, t, t, this.duration, 'song');
  }

  pause() {
    if (!this._playing) return;
    this._offset = this.currentTime;
    this._stopSource();
    this._playing = false;
    this._stopLoops();
    this.dispatchEvent(new Event('pause'));
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  seek(time) {
    const t = Math.max(0, Math.min(Number(time) || 0, this.duration));
    if (this._playing) {
      this._startSource(this.buffer, t, t, this.duration, 'song');
    } else {
      this._offset = t;
      this._mode = 'song';
    }
    this.dispatchEvent(new Event('timeupdate'));
  }

  stop() {
    const was = this._playing;
    if (was) this._offset = this.currentTime;
    this._stopSource();
    this._playing = false;
    this._stopLoops();
    if (was) this.dispatchEvent(new Event('pause'));
  }

  // enabled, beats (s), downbeatSet (índices de beat que son "1")
  setMetronome({ enabled, beats, downbeatSet } = {}) {
    if (enabled !== undefined) this._metro.enabled = !!enabled;
    if (beats) this._metro.beats = beats;
    if (downbeatSet) this._metro.downbeatSet = downbeatSet;
    if (this._playing) {
      this._clearClicks();
      this._resetScheduler();
      if (this._metro.enabled) this._startScheduler();
    }
  }

  // Reproduce un fragmento renderizado que empieza en `startTime`.
  // Sin opciones, startTime está en la línea de tiempo original (fragmento de renderEdit).
  // Con toSource, startTime está en la línea de tiempo de la SALIDA del edit y toSource(t) da el instante del original
  // que suena (para el cabezal); clicks = { beats, accents } del metrónomo en la línea de tiempo de la salida.
  // tag: etiqueta libre para saber qué vista previa suena (previewTag).
  // Por tramos: con render(from, to) → Float32Array[] (segundos de la salida) y end, `channels` puede ser null; el
  // audio se va pidiendo de a CHUNK_SEC mientras suena, hasta `end`.
  playPreview(channels, sampleRate, startTime, { toSource = null, clicks = null, tag = null, render = null, end = null } = {}) {
    const ctx = this.unlock();
    if (!ctx) return false;
    const start = Math.max(0, startTime || 0);
    let feed = null;
    let first = channels;
    if (typeof render === 'function') {
      const a0 = Math.round(start * sampleRate);
      const endS = Math.round((Number.isFinite(end) ? end : start) * sampleRate);
      if (!(endS > a0)) return false;
      feed = { render, sr: sampleRate, a0, next: a0, end: endS, cur: null };
      first = this._renderChunk(feed);
    }
    if (!first || !first.length || !first[0].length) return false;
    const buf = this._makeBuffer(first, sampleRate);
    const timelineEnd = feed ? feed.end / sampleRate : start + first[0].length / sampleRate;
    this._startSource(buf, 0, start, timelineEnd, 'preview', {
      map: typeof toSource === 'function' ? toSource : null,
      clicks: clicks && clicks.beats ? clicks : null,
      tag,
      feed,
    });
    return true;
  }

  _makeBuffer(channels, sampleRate) {
    const len = channels[0].length;
    const buf = this.ctx.createBuffer(channels.length, len, sampleRate);
    for (let c = 0; c < channels.length; c++) {
      if (buf.copyToChannel) buf.copyToChannel(channels[c], c);
      else buf.getChannelData(c).set(channels[c]);
    }
    return buf;
  }

  // Siguiente tramo de la vista previa [next, next + CHUNK) (muestras de la salida). Se solapa OVERLAP muestras con
  // el anterior: el anterior termina con un fundido de salida y este empieza con el complementario (suman 1).
  _renderChunk(feed) {
    const s0 = feed.next;
    const s1 = Math.min(feed.end, s0 + Math.max(4 * OVERLAP, Math.round(CHUNK_SEC * feed.sr)));
    const chans = feed.render(s0 / feed.sr, s1 / feed.sr);
    if (!chans || !chans.length || chans[0].length !== s1 - s0) throw new Error('Tramo de la vista previa no válido.');
    const fadeIn = s0 !== feed.a0;
    const fadeOut = s1 < feed.end;
    const n = s1 - s0;
    for (const ch of chans) {
      for (let i = 0; i < OVERLAP && i < n; i++) {
        const g = (i + 0.5) / OVERLAP;
        if (fadeIn) ch[i] *= g;
        if (fadeOut) ch[n - OVERLAP + i] *= 1 - g;
      }
    }
    feed.cur = { s0, s1 };
    feed.next = fadeOut ? s1 - OVERLAP : null;
    return chans;
  }

  // Programa el tramo siguiente si lo que queda por sonar es poco
  _feedMore() {
    const f = this._feed;
    const ctx = this.ctx;
    if (!f || f.next === null || !this._playing || !ctx) return;
    const queuedEnd = this._startCtx + (f.cur.s1 - f.a0) / f.sr;
    if (queuedEnd - ctx.currentTime > AHEAD_SEC) return;
    let chans;
    try {
      chans = this._renderChunk(f);
    } catch {
      f.next = null; // la vista previa termina con lo que ya está programado
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._makeBuffer(chans, f.sr);
    src.connect(this._master);
    src.start(this._startCtx + (f.cur.s0 - f.a0) / f.sr);
    // la fuente nueva pasa a marcar el final; la anterior queda en la cadena (para poder pararla) hasta que acabe
    const prev = this._source;
    if (prev) {
      this._chain.push(prev);
      prev.onended = () => {
        const k = this._chain.indexOf(prev);
        if (k >= 0) this._chain.splice(k, 1);
        prev.disconnect();
      };
    }
    this._source = src;
    src.onended = this._endHandler(src);
  }

  _endHandler(src) {
    return () => {
      if (this._source !== src) return;
      this._source = null;
      this._playing = false;
      this._offset = this._toTimeline(this._end);
      this._dropChain();
      this._stopLoops();
      this.dispatchEvent(new Event('timeupdate'));
      this.dispatchEvent(new Event('ended'));
    };
  }

  _startSource(buffer, bufferOffset, timelineStart, timelineEnd, mode, { map = null, clicks = null, tag = null, feed = null } = {}) {
    const ctx = this.ctx;
    this._stopSource();
    this._stopLoops();
    this._map = map;
    this._previewClicks = clicks;
    this._previewTag = tag;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this._master);
    const when = ctx.currentTime + START_DELAY;
    src.start(when, Math.max(0, Math.min(bufferOffset, buffer.duration)));
    this._source = src;
    this._startCtx = when;
    this._startOffset = timelineStart;
    this._end = timelineEnd;
    this._mode = mode;
    this._playing = true;
    src.onended = this._endHandler(src);
    this._feed = feed;
    if (feed && feed.next !== null) this._feedTimer = setInterval(() => this._feedMore(), FEED_MS);
    this._resetScheduler();
    if (this._metro.enabled) this._startScheduler();
    this._startRaf();
    this.dispatchEvent(new Event('play'));
  }

  // Para y suelta los tramos anteriores de una vista previa por tramos y deja de pedir más
  _dropChain() {
    for (const src of this._chain) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // ya parado
      }
      src.disconnect();
    }
    this._chain = [];
    this._feed = null;
    if (this._feedTimer) clearInterval(this._feedTimer);
    this._feedTimer = 0;
  }

  _stopSource() {
    this._dropChain();
    const src = this._source;
    this._source = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // ya parado
      }
      src.disconnect();
    }
    this._clearClicks();
  }

  _stopLoops() {
    if (this._timer) clearInterval(this._timer);
    this._timer = 0;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _startRaf() {
    if (this._raf || typeof requestAnimationFrame === 'undefined') return;
    const loop = () => {
      if (!this._playing) {
        this._raf = 0;
        return;
      }
      this.dispatchEvent(new Event('timeupdate'));
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  // ----- metrónomo -----

  // Clics activos: los de la vista previa (línea de tiempo de la salida) o los de la canción
  _clickList() {
    const pc = this._previewClicks;
    if (pc) return { beats: pc.beats, isAccent: (i) => !!(pc.accents && pc.accents.has(i)) };
    const { beats, downbeatSet } = this._metro;
    return { beats, isAccent: (i) => downbeatSet.has(i) };
  }

  _resetScheduler() {
    const { beats } = this._clickList();
    const t = this._startOffset + Math.max(0, this.ctx.currentTime - this._startCtx);
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (beats[m] < t - 0.001) lo = m + 1;
      else hi = m;
    }
    this._nextBeat = lo;
  }

  _startScheduler() {
    if (this._timer) clearInterval(this._timer);
    this._schedule();
    this._timer = setInterval(() => this._schedule(), TICK_MS);
  }

  _schedule() {
    if (!this._playing || !this._metro.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const horizon = this._timelineNow() + LOOKAHEAD_SEC;
    const { beats, isAccent } = this._clickList();
    while (this._nextBeat < beats.length && beats[this._nextBeat] < horizon) {
      const i = this._nextBeat++;
      const bt = beats[i];
      if (bt >= this._end - 0.001) {
        this._nextBeat = beats.length;
        break;
      }
      const when = this._startCtx + (bt - this._startOffset);
      if (when >= now - 0.01) this._click(Math.max(when, now), isAccent(i));
    }
  }

  _click(when, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = accent ? 1760 : 1175;
    const peak = accent ? 1 : 0.55;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + (accent ? 0.07 : 0.045));
    osc.connect(g);
    g.connect(this._clickBus);
    osc.start(when);
    osc.stop(when + 0.08);
    const rec = { osc, g };
    this._clicks.push(rec);
    osc.onended = () => {
      g.disconnect();
      const k = this._clicks.indexOf(rec);
      if (k >= 0) this._clicks.splice(k, 1);
    };
  }

  _clearClicks() {
    for (const { osc, g } of this._clicks) {
      osc.onended = null;
      try {
        g.disconnect();
      } catch {
        // ya desconectado
      }
    }
    this._clicks = [];
  }
}
