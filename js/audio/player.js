// Reproducción con Web Audio: canción completa, vista previa del final y metrónomo con planificador anticipado.
// Todos los tiempos públicos están en la línea de tiempo de la canción ORIGINAL.

const LOOKAHEAD_SEC = 0.15; // cuánto se adelanta el planificador
const TICK_MS = 25;
const START_DELAY = 0.04; // margen para programar el primer clic junto al audio

export class Player extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.buffer = null;
    this._source = null;
    this._master = null;
    this._clickBus = null;
    this._playing = false;
    this._mode = 'song';
    this._offset = 0; // posición cuando está en pausa
    this._startCtx = 0; // ctx.currentTime en que empezó a sonar
    this._startOffset = 0; // posición de la línea de tiempo en ese instante
    this._end = 0; // fin (línea de tiempo) de lo que suena
    this._metro = { enabled: false, beats: [], downbeatSet: new Set() };
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

  // Posición audible (compensa la latencia de salida para que el cabezal coincida con lo que se oye)
  get currentTime() {
    if (!this._playing || !this.ctx) return this._offset;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this._startCtx - lat);
    return Math.min(this._end, this._startOffset + elapsed);
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

  // Reproduce un fragmento renderizado (renderEdit) que empieza en `startTimeOnTimeline` de la canción original
  playPreview(channels, sampleRate, startTimeOnTimeline) {
    const ctx = this.unlock();
    if (!ctx || !channels || !channels.length || !channels[0].length) return;
    const len = channels[0].length;
    const buf = ctx.createBuffer(channels.length, len, sampleRate);
    for (let c = 0; c < channels.length; c++) {
      if (buf.copyToChannel) buf.copyToChannel(channels[c], c);
      else buf.getChannelData(c).set(channels[c]);
    }
    const start = Math.max(0, startTimeOnTimeline || 0);
    this._startSource(buf, 0, start, start + len / sampleRate, 'preview');
  }

  _startSource(buffer, bufferOffset, timelineStart, timelineEnd, mode) {
    const ctx = this.ctx;
    this._stopSource();
    this._stopLoops();
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
    src.onended = () => {
      if (this._source !== src) return;
      this._source = null;
      this._playing = false;
      this._offset = this._end;
      this._stopLoops();
      this.dispatchEvent(new Event('timeupdate'));
      this.dispatchEvent(new Event('ended'));
    };
    this._resetScheduler();
    if (this._metro.enabled) this._startScheduler();
    this._startRaf();
    this.dispatchEvent(new Event('play'));
  }

  _stopSource() {
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

  _resetScheduler() {
    const beats = this._metro.beats;
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
    const { beats, downbeatSet } = this._metro;
    while (this._nextBeat < beats.length && beats[this._nextBeat] < horizon) {
      const i = this._nextBeat++;
      const bt = beats[i];
      if (bt >= this._end - 0.001) {
        this._nextBeat = beats.length;
        break;
      }
      const when = this._startCtx + (bt - this._startOffset);
      if (when >= now - 0.01) this._click(Math.max(when, now), downbeatSet.has(i));
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
