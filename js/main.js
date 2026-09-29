// Controlador de la app: estados (vacío → cargando → analizando → listo / error) y cableado de la UI.

import { AnalysisClient } from './analysis/client.js';
import {
  getBars, findLastBarIndex, cutForBarsRemoved, barsRemovedAt, nearestBeatIndex, stepBeat, stepBar,
} from './core/bars.js';
import { decodeAudioFile, toAnalysisMono } from './audio/decode.js';
import { renderEdit, fadeGain, CUT_PREROLL_SEC } from './audio/edit.js';
import { exportAudio, suggestFileName } from './audio/export.js';
import { readId3v2 } from './audio/id3.js';
import { Player } from './audio/player.js';
import { WaveformView } from './ui/waveform.js';
import {
  FADE_BEAT_STEPS, BAR_CHIPS, STAGE_LABELS, clamp, overallProgress, formatTime, formatDuration, formatBpm,
  formatBars, formatNumber, formatFade, meterText, confidenceInfo, cutReadout, nextBarsCount, initialViewRange,
  shiftedDownbeatIndex, fadeBeatsToSeconds, exportOptions, formatFileSize, shortcutAction, errorMessage, looksLikeAudio,
} from './ui/format.js';

const ANALYSIS_RATE = 22050;
const PREVIEW_SEC = 8;
const FADE_CURVES_UI = ['linear', 'smooth', 'exp'];
const PREFS_KEY = 'djEditCutter.prefs.v1';

const $ = (id) => document.getElementById(id);
const el = {
  loader: $('loader'), dropzone: $('dropzone'), fileInput: $('file-input'), songBar: $('song-bar'),
  songName: $('song-name'), songSub: $('song-sub'), btnChange: $('btn-change'),
  progressBox: $('progress-box'), progress: $('progress'), progressFill: $('progress-fill'),
  progressStage: $('progress-stage'), progressPct: $('progress-pct'), stages: $('stages'),
  errorBox: $('error-box'), errorText: $('error-text'),
  editor: $('editor'), wave: $('wave'),
  zoomIn: $('btn-zoom-in'), zoomOut: $('btn-zoom-out'), zoomAll: $('btn-zoom-all'), zoomCut: $('btn-zoom-cut'),
  play: $('btn-play'), playLabel: $('play-label'), timeNow: $('time-now'), timeTotal: $('time-total'),
  metro: $('btn-metro'),
  infoBpm: $('info-bpm'), infoMeter: $('info-meter'), infoBars: $('info-bars'), infoConf: $('info-conf'),
  lowConf: $('low-conf-hint'), noGrid: $('no-grid-hint'),
  tempoDouble: $('btn-tempo-double'), tempoHalf: $('btn-tempo-half'), selMeter: $('sel-meter'),
  onePrev: $('btn-one-prev'), oneNext: $('btn-one-next'), thisOne: $('btn-this-one'), resetGrid: $('btn-reset-grid'),
  reviewBusy: $('review-busy'), reviewPanel: $('panel-review'),
  barsMinus: $('btn-bars-minus'), barsPlus: $('btn-bars-plus'), barsValue: $('bars-value'), chips: $('bar-chips'),
  manualNote: $('manual-note'), readout: $('cut-readout'),
  beatPrev: $('btn-beat-prev'), beatNext: $('btn-beat-next'), barPrev: $('btn-bar-prev'), barNext: $('btn-bar-next'),
  msPrev: $('btn-ms-prev'), msNext: $('btn-ms-next'), snap: $('chk-snap'),
  fade: $('rng-fade'), fadeValue: $('fade-value'), curve: $('sel-curve'), preview: $('btn-preview'),
  previewLabel: $('preview-label'),
  formats: $('formats'), keepTags: $('chk-tags'), tagsNote: $('tags-note'), outName: $('out-name'),
  exportBtn: $('btn-export'), exportLabel: $('export-label'), exportProgress: $('export-progress'),
  exportFill: $('export-fill'),
  status: $('status'), toast: $('toast'),
};

// ---------- preferencias (solo comodidad local) ----------

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

const prefs = loadPrefs();

const state = {
  phase: 'empty',
  gen: 0,
  song: null, // { name, size, buffer, bytes, sampleRate, duration, hasTags }
  result: null,
  bars: [],
  lastBarIndex: -1,
  downbeatSet: new Set(),
  barByBeat: new Map(),
  cut: null, // { mode: 'bars'|'manual', n, time, approx }
  fadeIdx: Number.isInteger(prefs.fadeIdx) && FADE_BEAT_STEPS[prefs.fadeIdx] !== undefined ? prefs.fadeIdx : 0,
  curve: FADE_CURVES_UI.includes(prefs.curve) ? prefs.curve : 'smooth',
  snap: prefs.snap !== false,
  keepTags: prefs.keepTags !== false,
  format: exportOptions(prefs.format).id,
  metronome: false,
  meterChoice: 'auto',
  forced: [],
  tempoChanged: false,
  busy: false,
  exporting: false,
  downloadUrl: null,
};

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      fadeIdx: state.fadeIdx, curve: state.curve, snap: state.snap, keepTags: state.keepTags, format: state.format,
    }));
  } catch {
    // almacenamiento no disponible
  }
}

let client = null;
const player = new Player();
const wave = new WaveformView(el.wave);

// ---------- utilidades ----------

let toastTimer = 0;
function announce(message, kind = 'info', { visual = true } = {}) {
  el.status.textContent = '';
  // cambio en dos pasos para que el lector de pantalla repita mensajes iguales
  requestAnimationFrame(() => {
    el.status.textContent = message;
  });
  if (!visual) return;
  el.toast.textContent = message;
  el.toast.dataset.kind = kind;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, kind === 'error' ? 9000 : 4000);
}

function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function detectTags(bytes) {
  if (!bytes) return false;
  try {
    const r = readId3v2(bytes);
    return !!(r && r.frames && r.frames.length);
  } catch {
    return false;
  }
}

function medianBarLength() {
  const b = state.bars;
  if (b.length > 1) return (b[b.length - 1].start - b[0].start) / (b.length - 1);
  const bpm = state.result && state.result.bpm;
  return bpm > 0 ? (240 / bpm) : 2;
}

// ---------- fases ----------

function setPhase(phase) {
  state.phase = phase;
  document.body.dataset.phase = phase;
  const hasSong = !!(state.song && state.song.name);
  el.dropzone.hidden = phase === 'loading' || phase === 'analyzing' || phase === 'ready';
  // el input oculto solo recibe foco cuando se ve la zona de carga
  el.fileInput.tabIndex = el.dropzone.hidden ? -1 : 0;
  el.songBar.hidden = !hasSong || phase === 'empty';
  el.progressBox.hidden = !(phase === 'loading' || phase === 'analyzing');
  el.errorBox.hidden = phase !== 'error';
  el.editor.hidden = phase !== 'ready';
  el.loader.dataset.state = phase;
}

function renderSongBar() {
  const s = state.song;
  if (!s) return;
  el.songName.textContent = s.name;
  const parts = [];
  if (Number.isFinite(s.duration)) parts.push(formatDuration(s.duration));
  if (s.sampleRate) parts.push(`${formatNumber(s.sampleRate / 1000, 1)} kHz`);
  if (s.size) parts.push(formatFileSize(s.size));
  if (state.phase === 'loading' || state.phase === 'analyzing') parts.push('analizando…');
  el.songSub.textContent = parts.join(' · ');
}

function setProgress(stage, fraction) {
  const p = overallProgress(stage, fraction);
  if (p == null) return;
  const pct = Math.round(p * 100);
  el.progressFill.style.transform = `scaleX(${p})`;
  el.progress.setAttribute('aria-valuenow', String(pct));
  el.progress.setAttribute('aria-valuetext', `${STAGE_LABELS[stage]}: ${pct} %`);
  el.progressStage.textContent = `${STAGE_LABELS[stage]}…`;
  el.progressPct.textContent = `${pct} %`;
  const order = Object.keys(STAGE_LABELS);
  const k = order.indexOf(stage);
  for (const li of el.stages.children) {
    const i = order.indexOf(li.dataset.stage);
    li.dataset.status = i < k ? 'done' : i === k ? 'current' : 'todo';
  }
}

function fail(kind, err) {
  if (client) {
    client.terminate();
    client = null;
  }
  el.errorText.textContent = errorMessage(kind, err);
  setPhase('error');
  renderSongBar();
  announce(el.errorText.textContent, 'error');
}

// ---------- carga de canción ----------

function resetSong() {
  player.stop();
  player.setBuffer(null);
  wave.setBuffer(null);
  if (client) {
    client.terminate();
    client = null;
  }
  state.song = null;
  state.result = null;
  state.bars = [];
  state.lastBarIndex = -1;
  state.downbeatSet = new Set();
  state.barByBeat = new Map();
  state.cut = null;
  state.meterChoice = 'auto';
  state.forced = [];
  state.tempoChanged = false;
  state.busy = false;
  el.selMeter.value = 'auto';
  el.reviewPanel.removeAttribute('aria-busy');
  el.reviewBusy.hidden = true;
  revokeDownload();
}

async function loadFile(file) {
  if (!file) return;
  const gen = ++state.gen;
  resetSong();
  if (file.type && !looksLikeAudio(file.name, file.type)) {
    state.song = { name: file.name, size: file.size };
    fail('no-audio');
    return;
  }
  state.song = { name: file.name, size: file.size };
  if (!file.size) {
    fail('empty');
    return;
  }
  setPhase('loading');
  renderSongBar();
  setProgress('read', 0.05);
  announce(`Cargando «${file.name}»…`);

  let decoded;
  try {
    decoded = await decodeAudioFile(file);
  } catch (err) {
    if (gen === state.gen) fail('decode', err);
    return;
  }
  if (gen !== state.gen) return;
  if (!decoded || !decoded.buffer || !decoded.buffer.length) {
    fail('empty');
    return;
  }
  const { buffer } = decoded;
  state.song = {
    name: decoded.name || file.name,
    size: file.size,
    buffer,
    bytes: decoded.bytes,
    sampleRate: decoded.sampleRate || buffer.sampleRate,
    duration: buffer.duration,
    hasTags: detectTags(decoded.bytes),
  };
  renderSongBar();
  setProgress('read', 0.55);
  player.setBuffer(buffer);
  wave.setBuffer(buffer);
  await nextFrame();
  if (gen !== state.gen) return;

  let mono;
  try {
    mono = await toAnalysisMono(buffer, ANALYSIS_RATE);
  } catch (err) {
    if (gen === state.gen) fail('decode', err);
    return;
  }
  if (gen !== state.gen) return;
  setPhase('analyzing');
  renderSongBar();
  setProgress('read', 1);

  let result;
  try {
    client = new AnalysisClient();
    result = await client.analyze(mono, ANALYSIS_RATE, {}, (stage, fraction) => {
      if (gen === state.gen) setProgress(stage, fraction);
    });
  } catch (err) {
    if (gen === state.gen) fail('analysis', err);
    return;
  }
  if (gen !== state.gen) return;
  mono = null;

  applyResult(result, { initial: true });
  setPhase('ready');
  renderSongBar();
  renderAllControls();
  setInitialView();
  const c = state.cut;
  announce(`Listo: ${formatBpm(result.bpm)} · ${meterText(result.beatsPerBar)} · ` +
    (c.mode === 'bars' ? `se quita ${formatBars(c.n)}` : 'coloca el corte a mano'));
}

function setInitialView() {
  const r = state.result;
  const narrow = window.innerWidth < 640;
  const v = initialViewRange({
    bars: state.bars,
    lastBarIndex: state.lastBarIndex,
    musicEnd: r ? r.musicEnd : undefined,
    duration: state.song.duration,
    cutTime: state.cut ? state.cut.time : undefined,
    barsBack: narrow ? 12 : 16,
  });
  wave.setView(v.start, v.end);
  wave.setPlayhead(player.currentTime);
}

// ---------- resultado del análisis ----------

function applyResult(result, { initial = false } = {}) {
  state.result = result;
  state.bars = safe(() => getBars(result), []) || [];
  state.lastBarIndex = safe(() => findLastBarIndex(result), -1);
  state.downbeatSet = new Set(result.downbeats || []);
  state.barByBeat = new Map(state.bars.map((b) => [b.beatIndex, b.index]));
  wave.setGrid({ beats: result.beats || [], bars: state.bars });
  player.setMetronome({ enabled: state.metronome, beats: result.beats || [], downbeatSet: state.downbeatSet });
  if (initial || !state.cut || state.cut.mode === 'bars') {
    const n = initial || !state.cut ? 1 : state.cut.n;
    if (!setCutBars(n)) setCutManual(defaultManualCut());
  } else {
    setCutManual(state.cut.time);
  }
  renderInfo();
  renderReview();
}

function defaultManualCut() {
  const r = state.result;
  const dur = state.song.duration;
  if (r && Number.isFinite(r.lastOnset) && r.lastOnset > 0.5) return r.lastOnset - CUT_PREROLL_SEC;
  return Math.max(0.05, dur - 1);
}

function maxBars() {
  return Math.max(0, state.lastBarIndex);
}

// ---------- corte ----------

function setCutBars(n) {
  const r = state.result;
  if (!r || state.lastBarIndex < 1) return false;
  const c = safe(() => cutForBarsRemoved(r, n), null);
  if (!c || !Number.isFinite(c.time)) return false;
  const eff = Math.max(1, state.lastBarIndex - c.barIndex + 1);
  state.cut = { mode: 'bars', n: eff, time: Math.max(0, c.time - CUT_PREROLL_SEC), approx: eff, beatIndex: c.beatIndex };
  onCutChanged();
  return true;
}

function setCutManual(time) {
  const dur = state.song.duration;
  const t = clamp(time, 0.05, dur);
  const approx = state.result ? safe(() => barsRemovedAt(state.result, t), NaN) : NaN;
  state.cut = { mode: 'manual', n: state.cut ? state.cut.n : 1, time: t, approx };
  onCutChanged();
}

// Corte sobre un beat: si es un "1" dentro de la canción vuelve al modo compases
function setCutAtBeat(i) {
  const r = state.result;
  if (!r || !r.beats || i < 0 || i >= r.beats.length) return;
  const barIdx = state.barByBeat.get(i);
  if (barIdx !== undefined && barIdx >= 1 && barIdx <= state.lastBarIndex) {
    const n = state.lastBarIndex - barIdx + 1;
    const c = safe(() => cutForBarsRemoved(r, n), null);
    if (c && c.beatIndex === i) {
      setCutBars(n);
      return;
    }
  }
  setCutManual(r.beats[i] - CUT_PREROLL_SEC);
}

function onCutChanged() {
  if (!state.cut) return;
  if (player.playing && player.mode === 'preview') player.stop();
  wave.setCut(state.cut.time);
  renderFade();
  renderCut();
  renderOutName();
}

function refTime() {
  return state.cut.time + CUT_PREROLL_SEC;
}

function nudgeBeat(delta) {
  const r = state.result;
  if (!state.cut) return;
  if (!r || !r.beats || r.beats.length < 2) {
    nudgeMs(delta * 100);
    return;
  }
  const t = safe(() => stepBeat(r, refTime(), delta), NaN);
  if (!Number.isFinite(t)) return;
  setCutAtBeat(safe(() => nearestBeatIndex(r, t), -1));
  wave.reveal(state.cut.time);
}

function nudgeBar(delta) {
  const r = state.result;
  if (!state.cut || !r || !r.downbeats || !r.downbeats.length) return;
  const t = safe(() => stepBar(r, refTime(), delta), NaN);
  if (!Number.isFinite(t)) return;
  setCutAtBeat(safe(() => nearestBeatIndex(r, t), -1));
  wave.reveal(state.cut.time);
}

function nudgeMs(ms) {
  if (!state.cut) return;
  setCutManual(state.cut.time + ms / 1000);
  wave.reveal(state.cut.time);
}

function changeBars(delta) {
  const c = state.cut;
  if (!c) return;
  const n = nextBarsCount({ manual: c.mode === 'manual', n: c.n, approx: c.approx, delta, max: maxBars() });
  if (setCutBars(n)) showCutAndEnd();
}

// Tras cambiar N: que se vean el corte y el final de la música
function showCutAndEnd() {
  const v = wave.getView();
  const cut = state.cut.time;
  if (cut >= v.start && cut <= v.end) return;
  const bar = medianBarLength();
  const end = Math.max(v.end, state.result ? state.result.musicEnd : v.end);
  wave.setView(Math.min(v.start, cut - bar * 2), end + bar * 0.5);
}

// ---------- fade ----------

function fadeBeats() {
  return FADE_BEAT_STEPS[state.fadeIdx] || 0;
}

function currentFadeSec() {
  const r = state.result;
  if (!state.cut) return 0;
  return fadeBeatsToSeconds(fadeBeats(), r ? r.beats : [], state.cut.time, r ? r.bpm : 120);
}

function renderFade() {
  const sec = currentFadeSec();
  const text = formatFade(fadeBeats(), sec);
  el.fadeValue.textContent = text;
  el.fade.setAttribute('aria-valuetext', text);
  const curve = state.curve;
  wave.setFade(sec, (x) => fadeGain(x, curve));
}

// ---------- render de paneles ----------

function renderInfo() {
  const r = state.result;
  if (!r) return;
  el.infoBpm.textContent = formatBpm(r.bpm, r.bpmRange);
  el.infoMeter.textContent = meterText(r.beatsPerBar);
  if (r.meterAuto) {
    const sub = document.createElement('span');
    sub.className = 'info-sub';
    sub.textContent = ' auto';
    el.infoMeter.append(sub);
  }
  const count = state.lastBarIndex >= 0 ? state.lastBarIndex + 1 : state.bars.length;
  el.infoBars.textContent = count ? String(count) : '—';
  const ci = confidenceInfo(r.confidence);
  el.infoConf.textContent = ci.label;
  el.infoConf.dataset.level = ci.level;
  const noGrid = !state.bars.length || state.lastBarIndex < 1;
  el.noGrid.hidden = !noGrid;
  el.lowConf.hidden = !ci.low || noGrid;
}

function renderReview() {
  const r = state.result;
  const hasBeats = !!(r && r.beats && r.beats.length > 1);
  const dis = state.busy || !hasBeats;
  for (const b of [el.tempoDouble, el.tempoHalf, el.onePrev, el.oneNext, el.thisOne]) b.disabled = dis;
  el.resetGrid.disabled = state.busy || !r;
  el.selMeter.disabled = dis;
  el.metro.disabled = !hasBeats;
  el.reviewBusy.hidden = !state.busy;
  if (state.busy) el.reviewPanel.setAttribute('aria-busy', 'true');
  else el.reviewPanel.removeAttribute('aria-busy');
}

function renderCut() {
  const c = state.cut;
  if (!c) return;
  const maxN = maxBars();
  const hasBars = maxN >= 1;
  if (c.mode === 'bars') {
    el.barsValue.textContent = String(c.n);
    el.manualNote.hidden = true;
  } else {
    const ok = Number.isFinite(c.approx);
    el.barsValue.textContent = ok ? `≈${formatNumber(c.approx, 1)}` : '–';
    el.manualNote.hidden = false;
    el.manualNote.textContent = ok ? `Ajuste manual ≈ ${formatBars(Math.max(0, c.approx))}` : 'Ajuste manual';
  }
  el.barsMinus.disabled = !hasBars || (c.mode === 'bars' && c.n <= 1);
  el.barsPlus.disabled = !hasBars || (c.mode === 'bars' && c.n >= maxN);
  for (const chip of el.chips.children) {
    const v = Number(chip.dataset.bars);
    chip.disabled = !hasBars || v > maxN;
    chip.setAttribute('aria-pressed', String(c.mode === 'bars' && c.n === v));
  }
  el.readout.textContent = cutReadout(c.time, state.song.duration);
  const hasGrid = !!(state.result && state.result.beats && state.result.beats.length > 1);
  el.beatPrev.disabled = el.beatNext.disabled = !hasGrid;
  el.barPrev.disabled = el.barNext.disabled = !hasGrid || !(state.result.downbeats || []).length;
}

function barsRemovedForName() {
  const c = state.cut;
  if (!c) return 0;
  if (c.mode === 'bars') return c.n;
  return Number.isFinite(c.approx) ? Math.round(c.approx * 10) / 10 : 0;
}

function outputName() {
  const opt = exportOptions(state.format);
  return safe(() => suggestFileName(state.song.name, { barsRemoved: barsRemovedForName(), format: opt.format }),
    `edit.${opt.format}`);
}

function renderOutName() {
  if (!state.song || !state.cut) return;
  el.outName.textContent = outputName();
}

function renderSave() {
  for (const input of el.formats.querySelectorAll('input[name="format"]')) input.checked = input.value === state.format;
  const has = !!(state.song && state.song.hasTags);
  el.keepTags.disabled = !has;
  el.keepTags.checked = has && state.keepTags;
  el.tagsNote.textContent = has
    ? 'Se copian título, artista, álbum y carátula; se descartan los datos de análisis de otros programas.'
    : 'El archivo original no tiene etiquetas ID3 que conservar.';
  el.exportBtn.disabled = state.exporting || state.phase !== 'ready';
  renderOutName();
}

function renderAllControls() {
  el.fade.value = String(state.fadeIdx);
  el.curve.value = state.curve;
  el.snap.checked = state.snap;
  wave.setSnap(state.snap);
  setMetronome(state.metronome, { silent: true });
  el.timeTotal.textContent = formatTime(state.song.duration);
  renderFade();
  renderCut();
  renderInfo();
  renderReview();
  renderSave();
  renderTransport();
  renderZoomButtons();
}

function renderTransport() {
  const playing = player.playing;
  const previewing = playing && player.mode === 'preview';
  el.play.setAttribute('aria-pressed', String(playing && !previewing));
  el.play.dataset.state = playing && !previewing ? 'playing' : 'paused';
  el.play.setAttribute('aria-label', playing && !previewing ? 'Pausa' : 'Reproducir');
  el.playLabel.textContent = playing && !previewing ? 'Pausa' : 'Reproducir';
  el.preview.dataset.state = previewing ? 'playing' : 'idle';
  el.previewLabel.textContent = previewing ? 'Detener' : 'Escuchar el final';
}

function renderZoomButtons() {
  const z = wave.zoomLimits;
  el.zoomIn.disabled = !z.canZoomIn;
  el.zoomOut.disabled = !z.canZoomOut;
}

// ---------- revisar compases (worker) ----------

async function runGridJob(message, job) {
  if (!client || state.busy || !state.result) return;
  const gen = state.gen;
  state.busy = true;
  renderReview();
  announce(message);
  try {
    const result = await job();
    if (gen !== state.gen) return;
    state.busy = false;
    applyResult(result);
    announce(`Cuadrícula actualizada: ${formatBpm(result.bpm)} · ${meterText(result.beatsPerBar)}`);
  } catch (err) {
    if (gen !== state.gen) return;
    announce(errorMessage('retrack', err), 'error');
  } finally {
    if (gen === state.gen) {
      state.busy = false;
      renderReview();
    }
  }
}

function meterOption() {
  return state.meterChoice === 'auto' ? 'auto' : Number(state.meterChoice);
}

function changeTempo(factor) {
  const r = state.result;
  if (!r || !(r.bpm > 0)) return;
  const bpmHint = r.bpm * factor;
  if (bpmHint < 30 || bpmHint > 320) {
    announce('Ese tempo queda fuera del rango que se puede detectar.', 'error');
    return;
  }
  runGridJob(`Recalculando a ≈ ${formatNumber(bpmHint, 1)} BPM…`, async () => {
    const res = await client.retrack({ bpmHint, strict: true });
    state.tempoChanged = true;
    return res;
  });
}

function relabel(message) {
  runGridJob(message, () => client.relabel({ beatsPerBar: meterOption(), forcedDownbeats: state.forced.slice() }));
}

function moveOne(delta) {
  const r = state.result;
  if (!r || !state.cut) return;
  const idx = shiftedDownbeatIndex(r, refTime(), delta);
  if (idx < 0) return;
  state.forced = [idx];
  relabel(delta < 0 ? 'Moviendo el 1 un beat antes…' : 'Moviendo el 1 un beat después…');
}

function thisBeatIsOne() {
  const r = state.result;
  if (!r || !r.beats || !r.beats.length) return;
  const idx = safe(() => nearestBeatIndex(r, player.currentTime), -1);
  if (idx < 0) return;
  state.forced = [idx];
  relabel(`Marcando el beat de ${formatTime(r.beats[idx])} como «1»…`);
}

function resetGrid() {
  state.forced = [];
  state.meterChoice = 'auto';
  el.selMeter.value = 'auto';
  const needRetrack = state.tempoChanged;
  runGridJob('Restableciendo la detección…', async () => {
    if (needRetrack) await client.retrack({});
    state.tempoChanged = false;
    return client.relabel({ beatsPerBar: 'auto', forcedDownbeats: [] });
  });
}

// ---------- reproducción ----------

function setMetronome(on, { silent = false } = {}) {
  state.metronome = !!on;
  el.metro.setAttribute('aria-pressed', String(state.metronome));
  const r = state.result;
  player.setMetronome({ enabled: state.metronome, beats: r ? r.beats || [] : [], downbeatSet: state.downbeatSet });
  if (!silent) {
    announce(state.metronome ? 'Clic de metrónomo activado' : 'Clic de metrónomo desactivado', 'info', { visual: false });
  }
}

function togglePlay() {
  if (state.phase !== 'ready') return;
  if (player.playing && player.mode === 'preview') {
    player.stop();
    return;
  }
  player.toggle();
}

function togglePreview() {
  if (state.phase !== 'ready' || !state.cut) return;
  if (player.playing && player.mode === 'preview') {
    player.stop();
    return;
  }
  const { buffer } = state.song;
  const cut = state.cut.time;
  const start = Math.max(0, cut - PREVIEW_SEC);
  try {
    const out = renderEdit(channelsOf(buffer), buffer.sampleRate, {
      cutTime: cut, fadeSec: currentFadeSec(), curve: state.curve, startTime: start,
    });
    const v = wave.getView();
    if (start < v.start || cut > v.end) {
      const pad = (cut - start) * 0.15;
      wave.setView(Math.min(v.start, start - pad), Math.max(cut + pad, Math.min(v.end, cut + (cut - start))));
    }
    player.playPreview(out, buffer.sampleRate, start);
  } catch (err) {
    announce(errorMessage('preview', err), 'error');
  }
}

function onTimeUpdate() {
  const t = player.currentTime;
  wave.setPlayhead(t, { follow: player.playing });
  el.timeNow.textContent = formatTime(t);
}

// ---------- exportar ----------

function revokeDownload() {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}

function triggerDownload(blob, name) {
  revokeDownload();
  const url = URL.createObjectURL(blob);
  state.downloadUrl = url;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // se libera más tarde: algunos navegadores leen la URL después del clic
  setTimeout(() => {
    if (state.downloadUrl === url) revokeDownload();
  }, 60000);
}

function renderExportProgress(fraction) {
  if (fraction == null) {
    el.exportProgress.hidden = true;
    el.exportLabel.textContent = 'Descargar';
    el.exportBtn.disabled = state.phase !== 'ready';
    el.exportBtn.removeAttribute('aria-busy');
    return;
  }
  const pct = Math.round(clamp(fraction, 0, 1) * 100);
  el.exportProgress.hidden = false;
  el.exportFill.style.transform = `scaleX(${pct / 100})`;
  el.exportProgress.setAttribute('aria-valuenow', String(pct));
  el.exportLabel.textContent = `Preparando… ${pct} %`;
  el.exportBtn.disabled = true;
  el.exportBtn.setAttribute('aria-busy', 'true');
}

async function doExport() {
  if (state.exporting || state.phase !== 'ready' || !state.cut) return;
  const gen = state.gen;
  state.exporting = true;
  if (player.playing) player.pause();
  renderExportProgress(0);
  try {
    await nextFrame();
    const { buffer, bytes } = state.song;
    const opt = exportOptions(state.format);
    const channels = renderEdit(channelsOf(buffer), buffer.sampleRate, {
      cutTime: state.cut.time, fadeSec: currentFadeSec(), curve: state.curve,
    });
    if (gen !== state.gen) return;
    renderExportProgress(0.05);
    const blob = await exportAudio({
      channels,
      sampleRate: buffer.sampleRate,
      format: opt.format,
      bitDepth: opt.bitDepth,
      kbps: opt.kbps,
      sourceBytes: bytes,
      keepTags: state.keepTags && state.song.hasTags,
      onProgress: (f) => {
        if (gen === state.gen) renderExportProgress(0.05 + 0.95 * clamp(Number(f) || 0, 0, 1));
      },
    });
    if (gen !== state.gen) return;
    const name = outputName();
    triggerDownload(blob, name);
    announce(`Listo: se descargó «${name}» (${formatFileSize(blob.size)}).`);
  } catch (err) {
    if (gen === state.gen) announce(errorMessage('export', err), 'error');
  } finally {
    state.exporting = false;
    renderExportProgress(null);
  }
}

// ---------- eventos ----------

function bind() {
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    if (f) loadFile(f);
  });
  el.btnChange.addEventListener('click', () => el.fileInput.click());

  // arrastrar y soltar en toda la página
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // desbloqueo de audio en iOS: primer gesto con canción cargada
  const unlock = () => {
    if (state.song && state.song.buffer) player.unlock();
  };
  document.addEventListener('pointerup', unlock, true);
  document.addEventListener('keydown', unlock, true);

  // forma de onda
  wave.addEventListener('seek', (e) => {
    player.seek(e.detail.time);
    onTimeUpdate();
  });
  wave.addEventListener('cutchange', (e) => {
    const { time, snapped, beatIndex, phase } = e.detail;
    if (phase === 'start') return;
    if (phase === 'end' && !Number.isFinite(time)) return;
    if (snapped && beatIndex >= 0) setCutAtBeat(beatIndex);
    else setCutManual(time);
    if (phase === 'end') announce(el.readout.textContent, 'info', { visual: false });
  });
  wave.addEventListener('viewchange', renderZoomButtons);
  el.zoomIn.addEventListener('click', () => wave.zoomBy(0.5));
  el.zoomOut.addEventListener('click', () => wave.zoomBy(2));
  el.zoomAll.addEventListener('click', () => wave.showAll());
  el.zoomCut.addEventListener('click', () => {
    if (!state.cut) return;
    const v = wave.getView();
    const span = v.end - v.start;
    wave.centerOn(state.cut.time, span > 45 ? medianBarLength() * 8 : span);
  });

  // transporte
  el.play.addEventListener('click', togglePlay);
  el.metro.addEventListener('click', () => setMetronome(!state.metronome));
  player.addEventListener('timeupdate', onTimeUpdate);
  for (const ev of ['play', 'pause', 'ended']) player.addEventListener(ev, renderTransport);

  // revisar
  el.tempoDouble.addEventListener('click', () => changeTempo(2));
  el.tempoHalf.addEventListener('click', () => changeTempo(0.5));
  el.selMeter.addEventListener('change', () => {
    state.meterChoice = el.selMeter.value;
    state.forced = [];
    relabel(state.meterChoice === 'auto' ? 'Detectando el compás…' : `Aplicando ${state.meterChoice}/4…`);
  });
  el.onePrev.addEventListener('click', () => moveOne(-1));
  el.oneNext.addEventListener('click', () => moveOne(1));
  el.thisOne.addEventListener('click', thisBeatIsOne);
  el.resetGrid.addEventListener('click', resetGrid);

  // corte
  el.barsMinus.addEventListener('click', () => changeBars(-1));
  el.barsPlus.addEventListener('click', () => changeBars(1));
  for (const n of BAR_CHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.bars = String(n);
    b.textContent = String(n);
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `Quitar ${formatBars(n)}`);
    b.addEventListener('click', () => {
      if (setCutBars(n)) showCutAndEnd();
    });
    el.chips.append(b);
  }
  el.beatPrev.addEventListener('click', () => nudgeBeat(-1));
  el.beatNext.addEventListener('click', () => nudgeBeat(1));
  el.barPrev.addEventListener('click', () => nudgeBar(-1));
  el.barNext.addEventListener('click', () => nudgeBar(1));
  el.msPrev.addEventListener('click', () => nudgeMs(-10));
  el.msNext.addEventListener('click', () => nudgeMs(10));
  el.snap.addEventListener('change', () => {
    state.snap = el.snap.checked;
    wave.setSnap(state.snap);
    savePrefs();
  });

  // final
  el.fade.addEventListener('input', () => {
    state.fadeIdx = clamp(Number(el.fade.value) || 0, 0, FADE_BEAT_STEPS.length - 1);
    if (player.playing && player.mode === 'preview') player.stop();
    renderFade();
    savePrefs();
  });
  el.curve.addEventListener('change', () => {
    state.curve = FADE_CURVES_UI.includes(el.curve.value) ? el.curve.value : 'smooth';
    if (player.playing && player.mode === 'preview') player.stop();
    renderFade();
    savePrefs();
  });
  el.preview.addEventListener('click', togglePreview);

  // guardar
  el.formats.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'format') {
      state.format = exportOptions(e.target.value).id;
      renderOutName();
      savePrefs();
    }
  });
  el.keepTags.addEventListener('change', () => {
    state.keepTags = el.keepTags.checked;
    savePrefs();
  });
  el.exportBtn.addEventListener('click', doExport);

  // teclado
  document.addEventListener('keydown', (e) => {
    const t = e.target || {};
    const action = shortcutAction({
      key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      targetTag: t.tagName, targetType: t.type, targetEditable: t.isContentEditable,
    });
    if (!action || state.phase !== 'ready') return;
    e.preventDefault();
    if (e.repeat && (action === 'toggle-play' || action === 'metronome' || action === 'preview')) return;
    switch (action) {
      case 'toggle-play': togglePlay(); break;
      case 'cut-beat-prev': nudgeBeat(-1); break;
      case 'cut-beat-next': nudgeBeat(1); break;
      case 'cut-bar-prev': nudgeBar(-1); break;
      case 'cut-bar-next': nudgeBar(1); break;
      case 'zoom-in': wave.zoomBy(0.5); break;
      case 'zoom-out': wave.zoomBy(2); break;
      case 'metronome': if (!el.metro.disabled) setMetronome(!state.metronome); break;
      case 'preview': togglePreview(); break;
      default: break;
    }
  });
  // que Espacio no "pulse" además el botón con foco al soltar la tecla
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && state.phase === 'ready' && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
  });
}

function init() {
  const hasAudio = !!(globalThis.AudioContext || globalThis.webkitAudioContext) &&
    !!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext);
  bind();
  setPhase('empty');
  if (!hasAudio) {
    el.errorText.textContent = errorMessage('webaudio');
    setPhase('error');
    el.fileInput.disabled = true;
  }
  document.documentElement.classList.add('js-ready');
}

init();
