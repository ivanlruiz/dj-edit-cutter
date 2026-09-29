// Controlador de la app: estados (vacío → cargando → analizando → listo / error) y cableado de la UI.
// Dos operaciones independientes y combinables: quitar compases del final (modo 1) y cambiar el compás (modo 2).
// Exportación y vistas previas usan el mismo plan de segmentos (ui/edit-plan.js) y el mismo render (audio/splice.js).

import { AnalysisClient } from './analysis/client.js';
import {
  getBars, findLastBarIndex, cutForBarsRemoved, barsRemovedAt, nearestBeatIndex, stepBeat, stepBar,
} from './core/bars.js';
import { describeMeterChange } from './core/meter.js';
import { decodeAudioFile, toAnalysisMono, yieldTask } from './audio/decode.js';
import { fadeGain, CUT_PREROLL_SEC } from './audio/edit.js';
import { renderSegments, renderedLength, segmentSource } from './audio/splice.js';
import { exportAudio, suggestFileName, buildTagBytes } from './audio/export.js';
import { Player } from './audio/player.js';
import { WaveformView } from './ui/waveform.js';
import {
  FADE_BEAT_STEPS, BAR_CHIPS, STAGE_LABELS, clamp, overallProgress, formatTime, formatDuration, formatBpm,
  formatBars, formatNumber, formatFade, meterText, confidenceInfo, cutReadout, nextBarsCount, initialViewRange,
  shiftedDownbeatIndex, fadeBeatsToSeconds, exportOptions, formatFileSize, shortcutAction, errorMessage, looksLikeAudio,
} from './ui/format.js';
import {
  XFADE_MS, METER_CHOICES, METER_DENS, MANUAL_BPM, buildEditPlan, exportBlocker, meterApplies, previewStartTime,
  outputToSourceFn, mapBeatsToOutput, makeTransientSnap, tapTempo, parseBpm, parseIntStrict, durationChange,
  barsChangedText, meterChangeLabel, targetMeter, meterLabel,
} from './ui/edit-plan.js';

const ANALYSIS_RATE = 22050;
const PREVIEW_SEC = 8;
const FADE_CURVES_UI = ['linear', 'smooth', 'exp'];
const PREFS_KEY = 'djEditCutter.prefs.v1';
const TOAST_MS = 2600;
const TOAST_ERROR_MS = 8000;
const TEMPO_MATCH = [0.92, 1.08]; // tempo resultante / pedido que cuenta como "el pedido"

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
  bpmInput: $('inp-bpm'), bpmApply: $('btn-bpm-apply'), tap: $('btn-tap'), tapValue: $('tap-value'),
  onePrev: $('btn-one-prev'), oneNext: $('btn-one-next'), thisOne: $('btn-this-one'), resetGrid: $('btn-reset-grid'),
  reviewBusy: $('review-busy'), reviewPanel: $('panel-review'),
  panelCut: $('panel-cut'), mode1: $('chk-mode1'), mode1Body: $('mode1-body'), mode1Off: $('mode1-off'),
  barsMinus: $('btn-bars-minus'), barsPlus: $('btn-bars-plus'), barsValue: $('bars-value'), chips: $('bar-chips'),
  manualNote: $('manual-note'), readout: $('cut-readout'),
  beatPrev: $('btn-beat-prev'), beatNext: $('btn-beat-next'), barPrev: $('btn-bar-prev'), barNext: $('btn-bar-next'),
  msPrev: $('btn-ms-prev'), msNext: $('btn-ms-next'), snap: $('chk-snap'),
  fade: $('rng-fade'), fadeValue: $('fade-value'), curve: $('sel-curve'), preview: $('btn-preview'),
  previewLabel: $('preview-label'), previewHelp: $('preview-help'),
  panelMeter: $('panel-meter'), mode2: $('chk-mode2'), mode2Body: $('mode2-body'), mode2Off: $('mode2-off'),
  meterChips: $('meter-chips'), meterOther: $('meter-other'), meterNum: $('inp-meter-num'), meterDen: $('sel-meter-den'),
  meterChange: $('meter-change'), meterDesc: $('meter-desc'), meterStats: $('meter-stats'), meterMsg: $('meter-msg'),
  xfade: $('rng-xfade'), xfadeValue: $('xfade-value'), meterPreview: $('btn-meter-preview'),
  meterPreviewLabel: $('meter-preview-label'),
  resultSummary: $('result-summary'), formats: $('formats'), keepTags: $('chk-tags'), tagsNote: $('tags-note'),
  outName: $('out-name'), outNameLine: $('out-name-line'), exportBtn: $('btn-export'), exportLabel: $('export-label'), exportProgress: $('export-progress'),
  exportFill: $('export-fill'), exportHint: $('export-hint'),
  status: $('status'), toast: $('toast'), toastText: $('toast-text'), toastClose: $('toast-close'),
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

function initialMeter() {
  const ids = METER_CHOICES.map((c) => c.id);
  const preset = ids.includes(prefs.meterPreset) ? prefs.meterPreset : '7/8';
  const num = Number.isInteger(prefs.meterNum) && prefs.meterNum >= 1 && prefs.meterNum <= 32 ? prefs.meterNum : 7;
  const den = METER_DENS.includes(prefs.meterDen) ? prefs.meterDen : 8;
  return { preset, num: String(num), den: String(den) };
}

const state = {
  phase: 'empty',
  gen: 0,
  loadReq: 0, // última carga pedida (una carga más nueva descarta las anteriores)
  pending: null, // { name, size } del archivo que se está leyendo (la canción anterior sigue hasta que decodifique)
  song: null, // { name, size, buffer, tagBytes, sampleRate, duration, hasTags }
  result: null,
  resultVersion: 0,
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
  meterChoice: 'auto', // tiempos por compás del análisis
  forced: [],
  tempoChanged: false,
  busy: false,
  exporting: false,
  downloadUrl: null,
  exportError: '', // último error al exportar (se muestra junto al botón hasta el siguiente intento o cambio)
  // modos
  mode1: true,
  mode2: false,
  newMeter: initialMeter(), // { preset: '7/8'|'3/4'|'5/4'|'other', num, den } (num/den: texto de "Otro")
  xfadeMs: clamp(Number.isFinite(prefs.xfadeMs) ? Math.round(prefs.xfadeMs) : XFADE_MS.def, XFADE_MS.min, XFADE_MS.max),
  snapFn: null, // imán de los límites internos del modo 2 (por canción)
  taps: [],
};

function savePrefs() {
  const num = parseIntStrict(state.newMeter.num);
  const den = parseIntStrict(state.newMeter.den);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      fadeIdx: state.fadeIdx, curve: state.curve, snap: state.snap, keepTags: state.keepTags, format: state.format,
      meterPreset: state.newMeter.preset,
      meterNum: Number.isInteger(num) && num >= 1 && num <= 32 ? num : undefined,
      meterDen: METER_DENS.includes(den) ? den : undefined,
      xfadeMs: state.xfadeMs,
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
function hideToast() {
  clearTimeout(toastTimer);
  el.toast.hidden = true;
}

// Aviso visual: abajo en el centro, salvo que tape los controles principales (entonces arriba)
function placeToast() {
  const t = el.toast;
  const avoid = [el.play, el.wave, el.metro, el.preview, el.meterPreview, el.exportBtn, el.barsValue,
    el.mode1.parentElement, el.mode2.parentElement, el.zoomAll.parentElement];
  const overlap = () => {
    const r = t.getBoundingClientRect();
    let area = 0;
    for (const e of avoid) {
      if (!e || !e.getClientRects().length) continue;
      const q = e.getBoundingClientRect();
      const w = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      const h = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
      if (w > 0 && h > 0) area += w * h;
    }
    return area;
  };
  t.dataset.pos = 'bottom';
  const bottom = overlap();
  if (!bottom) return;
  t.dataset.pos = 'top';
  if (overlap() > bottom) t.dataset.pos = 'bottom';
}

function announce(message, kind = 'info', { visual = true } = {}) {
  el.status.textContent = '';
  // cambio en dos pasos para que el lector de pantalla repita mensajes iguales
  requestAnimationFrame(() => {
    el.status.textContent = message;
  });
  if (!visual) return;
  el.toastText.textContent = message;
  el.toast.dataset.kind = kind;
  el.toast.hidden = false;
  placeToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, kind === 'error' ? TOAST_ERROR_MS : TOAST_MS);
}

function coarsePointer() {
  try {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  } catch {
    return false;
  }
}

function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

// Deja pintar la interfaz antes de un trabajo largo. En una pestaña oculta no hay requestAnimationFrame (y los
// temporizadores van a ~1 s): ahí se cede el hilo con un mensaje, para que la carga o la exportación no se paren.
function nextFrame() {
  if (document.hidden) return yieldTask();
  return new Promise((r) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      document.removeEventListener('visibilitychange', go);
      r();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    document.addEventListener('visibilitychange', go);   // si la pestaña se oculta mientras espera
  });
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function medianBarLength() {
  const b = state.bars;
  if (b.length > 1) return (b[b.length - 1].start - b[0].start) / (b.length - 1);
  const bpm = state.result && state.result.bpm;
  return bpm > 0 ? (240 / bpm) : 2;
}

// Imán del modo 2 con memoria: los límites internos solo dependen de los beats y del audio
function cachedSnap(buffer) {
  const raw = safe(() => makeTransientSnap(channelsOf(buffer), buffer.sampleRate), null);
  if (!raw) return null;
  const memo = new Map();
  return (t) => {
    let v = memo.get(t);
    if (v === undefined) {
      v = raw(t);
      memo.set(t, v);
    }
    return v;
  };
}

// ---------- fases ----------

function setPhase(phase) {
  state.phase = phase;
  document.body.dataset.phase = phase;
  const hasSong = !!((state.pending || state.song) && (state.pending || state.song).name);
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
  const s = state.pending || state.song;
  if (!s) return;
  el.songName.textContent = s.name;
  const parts = [];
  if (Number.isFinite(s.duration)) parts.push(formatDuration(s.duration));
  if (s.sampleRate) parts.push(`${formatNumber(s.sampleRate / 1000, 1)} kHz`);
  if (s.size) parts.push(formatFileSize(s.size));
  if (state.phase === 'loading' || state.phase === 'analyzing') parts.push(state.phase === 'loading' ? 'leyendo…' : 'analizando…');
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
  state.resultVersion++;
  state.bars = [];
  state.lastBarIndex = -1;
  state.downbeatSet = new Set();
  state.barByBeat = new Map();
  state.cut = null;
  state.meterChoice = 'auto';
  state.forced = [];
  state.tempoChanged = false;
  state.busy = false;
  state.snapFn = null;
  state.taps = [];
  el.selMeter.value = 'auto';
  el.bpmInput.value = '';
  el.tapValue.textContent = 'Toca al ritmo';
  el.reviewPanel.removeAttribute('aria-busy');
  el.reviewBusy.hidden = true;
  revokeDownload();
}

// ¿Hay una canción lista (analizada) que conservar si el archivo nuevo no sirve?
function hasReadySong() {
  return !!(state.song && state.song.buffer && state.result);
}

// El archivo elegido no se puede usar: si había una canción lista, se queda (y el editor vuelve); si no, pantalla
// de error.
function rejectFile(kind, file, err) {
  state.pending = null;
  const msg = errorMessage(kind, err);
  if (hasReadySong()) {
    setPhase('ready');
    renderSongBar();
    announce(`«${file.name}»: ${msg} Sigue cargada «${state.song.name}».`, 'error');
    return;
  }
  state.song = { name: file.name, size: file.size };
  fail(kind, err);
}

async function loadFile(file) {
  if (!file) return;
  // Validación sin decodificar: un archivo que no es audio no toca lo que ya está cargado (ni una carga en curso)
  const bad = file.type && !looksLikeAudio(file.name, file.type) ? 'no-audio' : !file.size ? 'empty' : null;
  if (bad) {
    if (state.phase === 'loading' || state.phase === 'analyzing') announce(errorMessage(bad), 'error');
    else rejectFile(bad, file);
    return;
  }
  const req = ++state.loadReq;
  // La canción lista se conserva hasta que la nueva se decodifique; sin canción lista, se descarta ya
  const keep = hasReadySong();
  let gen;
  if (!keep) {
    gen = ++state.gen;
    resetSong();
  } else {
    player.stop();
  }
  state.pending = { name: file.name, size: file.size };
  setPhase('loading');
  renderSongBar();
  setProgress('read', 0.05);
  announce(`Cargando «${file.name}»…`, 'info', { visual: false });

  let decoded;
  try {
    decoded = await decodeAudioFile(file);
  } catch (err) {
    if (req === state.loadReq) rejectFile('decode', file, err);
    return;
  }
  if (req !== state.loadReq) return;
  if (!decoded || !decoded.buffer || !decoded.buffer.length) {
    rejectFile('empty', file);
    return;
  }
  if (keep) {
    gen = ++state.gen;
    resetSong();
  }
  state.pending = null;
  const { buffer } = decoded;
  // de los bytes del archivo solo hacen falta las etiquetas: el resto no se guarda en memoria
  const tagBytes = safe(() => buildTagBytes(decoded.bytes), null);
  decoded = null;
  state.song = {
    name: file.name,
    size: file.size,
    buffer,
    tagBytes,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    hasTags: !!tagBytes,
  };
  state.snapFn = cachedSnap(buffer);
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
  const noBeats = !(result.beats && result.beats.length > 1);
  const parts = noBeats ? ['no se detectaron beats'] : [formatBpm(result.bpm), meterText(result.beatsPerBar)];
  if (state.mode1) parts.push(c.mode === 'bars' ? `se quita ${formatBars(c.n)}` : 'coloca el corte a mano');
  if (state.mode2 && !noBeats) {
    const tm = targetMeter(state.newMeter);
    parts.push(`compás nuevo ${meterLabel(tm.num, tm.den)}`);
  }
  announce(`Listo: ${parts.join(' · ')}`);
}

function setInitialView() {
  const r = state.result;
  const narrow = window.innerWidth < 640;
  const v = initialViewRange({
    bars: state.bars,
    lastBarIndex: state.lastBarIndex,
    musicEnd: r ? r.musicEnd : undefined,
    duration: state.song.duration,
    cutTime: state.mode1 && state.cut ? state.cut.time : undefined,
    barsBack: narrow ? 12 : 16,
  });
  wave.setView(v.start, v.end);
  wave.setPlayhead(player.currentTime);
}

// ---------- resultado del análisis ----------

function applyResult(result, { initial = false } = {}) {
  // la cuadrícula nueva cambia el plan: lo que suena ya no vale
  if (!initial) stopPreviewPlayback();
  state.result = result;
  state.resultVersion++;
  state.bars = safe(() => getBars(result), []) || [];
  state.lastBarIndex = safe(() => findLastBarIndex(result), -1);
  state.downbeatSet = new Set(result.downbeats || []);
  state.barByBeat = new Map(state.bars.map((b) => [b.beatIndex, b.index]));
  wave.setGrid({ beats: result.beats || [], bars: state.bars, lastBarIndex: state.lastBarIndex });
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

// ---------- plan de edición (los dos modos) ----------

let planMemo = { key: '', plan: null };

function currentPlan() {
  if (!state.result || !state.song || !state.song.buffer) return null;
  const tm = targetMeter(state.newMeter);
  const useCut = state.mode1 && !!state.cut;
  const fadeSec = useCut ? currentFadeSec() : 0;
  const key = [
    state.resultVersion, useCut ? state.cut.time : '-', fadeSec, state.mode2 ? `${tm.num}/${tm.den}` : '-', state.xfadeMs,
  ].join('|');
  if (planMemo.key === key) return planMemo.plan;
  const plan = buildEditPlan(state.result, {
    duration: state.song.duration,
    mode1: useCut,
    cutTime: useCut ? state.cut.time : null,
    fadeSec,
    mode2: state.mode2,
    targetNum: tm.num,
    targetDen: tm.den,
    crossfadeSec: state.xfadeMs / 1000,
    snap: state.snapFn,
  });
  planMemo = { key, plan };
  return plan;
}

// Algo que cambia el resultado: se para la vista previa y se redibuja todo lo que depende del plan
function onPlanChanged({ stopPreview = true } = {}) {
  if (stopPreview) stopPreviewPlayback();
  state.exportError = '';
  const plan = currentPlan();
  wave.setMeterEdit(state.mode2 && plan && plan.meter && !plan.meter.error ? plan.meter : null);
  renderMeter();
  renderCut();
  renderSave();
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
  wave.setCut(state.mode1 ? state.cut.time : null);
  renderFade();
  // el corte solo afecta al resultado con el modo 1 activo
  onPlanChanged({ stopPreview: state.mode1 });
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

// ---------- modos ----------

function setMode1(on) {
  state.mode1 = !!on;
  el.mode1.checked = state.mode1;
  el.panelCut.dataset.on = String(state.mode1);
  el.mode1Body.hidden = !state.mode1;
  el.mode1Off.hidden = state.mode1;
  wave.setCut(state.mode1 && state.cut ? state.cut.time : null);
  el.zoomCut.disabled = !state.mode1;
  renderFade();
  onPlanChanged();
}

function setMode2(on) {
  state.mode2 = !!on;
  el.mode2.checked = state.mode2;
  onPlanChanged();
}

function chooseMeter(preset) {
  if (!METER_CHOICES.some((c) => c.id === preset)) return;
  if (preset === 'other' && state.newMeter.preset !== 'other') {
    // "Otro" arranca con el compás que se estaba usando
    const cur = targetMeter(state.newMeter);
    if (Number.isInteger(cur.num)) state.newMeter.num = String(cur.num);
    if (Number.isInteger(cur.den)) state.newMeter.den = String(cur.den);
    el.meterNum.value = state.newMeter.num;
    el.meterDen.value = state.newMeter.den;
  }
  state.newMeter.preset = preset;
  savePrefs();
  onPlanChanged();
  if (preset === 'other' && !coarsePointer()) el.meterNum.focus();
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
  wave.setFade(state.mode1 ? sec : 0, (x) => fadeGain(x, curve));
}

// ---------- render de paneles ----------

function renderInfo() {
  const r = state.result;
  if (!r) return;
  const hasBeats = !!(r.beats && r.beats.length > 1);
  el.infoBpm.textContent = formatBpm(r.bpm, r.bpmRange);
  el.infoMeter.textContent = hasBeats ? meterText(r.beatsPerBar) : '–';
  if (r.meterAuto && hasBeats) {
    const sub = document.createElement('span');
    sub.className = 'info-sub';
    sub.textContent = ' auto';
    el.infoMeter.append(sub);
  }
  const count = state.lastBarIndex >= 0 ? state.lastBarIndex + 1 : state.bars.length;
  el.infoBars.textContent = count ? String(count) : '—';
  const noGrid = !state.bars.length || state.lastBarIndex < 1;
  el.noGrid.hidden = !noGrid;
  el.noGrid.textContent = state.bars.length && state.lastBarIndex === 0
    ? 'Solo se encontró un compás: no hay compases que quitar. Arrastra el marcador naranja para colocar el corte a mano.'
    : 'No se encontraron compases en este audio. Arrastra el marcador naranja para colocar el corte a mano.';
  // con un "1" fijado a mano el usuario ya revisó la cuadrícula: insignia neutra y sin el aviso
  const manual = !!(r.forcedDownbeats && r.forcedDownbeats.length);
  const ci = confidenceInfo(r.confidence, r);
  el.infoConf.textContent = manual ? 'Cuadrícula ajustada a mano' : ci.label;
  el.infoConf.dataset.level = manual ? 'manual' : ci.level;
  el.lowConf.hidden = manual || !ci.low || noGrid;
  el.lowConf.textContent = (ci.end
    ? 'El golpe final no cae en un «1» de la cuadrícula, así que el corte puede no estar donde crees. '
    : 'La detección no es segura. ') +
    'Activa el clic de metrónomo y escucha: si el acento no cae en el «1», prueba «Tempo ×2 / ÷2», cambia los tiempos por compás o usa «Mover el 1».';
}

function renderReview() {
  const r = state.result;
  const hasBeats = !!(r && r.beats && r.beats.length > 1);
  const dis = state.busy || !hasBeats;
  for (const b of [el.tempoDouble, el.tempoHalf, el.onePrev, el.oneNext, el.thisOne]) b.disabled = dis;
  el.resetGrid.disabled = state.busy || !r;
  el.selMeter.disabled = dis;
  el.metro.disabled = !hasBeats;
  el.bpmInput.disabled = state.busy || !r;
  el.bpmApply.disabled = state.busy || !r || parseBpm(el.bpmInput.value) === null;
  el.tap.disabled = state.busy || !r;
  el.bpmInput.placeholder = r && r.bpm > 0 ? formatNumber(r.bpm, 1) : 'BPM';
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
    const ok = hasBars && Number.isFinite(c.approx);
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
  const plan = currentPlan();
  const withMeter = state.mode2 && meterApplies(plan);
  el.readout.textContent = cutReadout(c.time, state.song.duration, withMeter ? plan.outputDuration : undefined);
  el.previewHelp.textContent = withMeter
    ? 'Reproduce los últimos 8 segundos con el corte, el fade y el compás nuevo aplicados.'
    : 'Reproduce los últimos 8 segundos con el corte y el fade aplicados.';
  const hasGrid = !!(state.result && state.result.beats && state.result.beats.length > 1);
  el.beatPrev.disabled = el.beatNext.disabled = !hasGrid;
  el.barPrev.disabled = el.barNext.disabled = !hasGrid || !(state.result.downbeats || []).length;
}

function renderMeter() {
  const on = state.mode2;
  el.panelMeter.dataset.on = String(on);
  el.mode2.checked = on;
  el.mode2Body.hidden = !on;
  el.mode2Off.hidden = on;
  const preset = state.newMeter.preset;
  for (const chip of el.meterChips.querySelectorAll('[data-meter]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.meter === preset));
  }
  el.meterOther.hidden = preset !== 'other';
  el.xfadeValue.textContent = `${state.xfadeMs} ms`;
  el.xfade.setAttribute('aria-valuetext', `${state.xfadeMs} milisegundos`);
  const r = state.result;
  if (!on || !r || !state.song) return;
  const tm = targetMeter(state.newMeter);
  el.meterChange.textContent = meterChangeLabel(r.beatsPerBar, tm.num, tm.den);
  const d = describeMeterChange(r.beatsPerBar, tm.num, tm.den);
  const plan = currentPlan();
  const m = plan && plan.meter;
  const desc = !d.error && d.delta !== 0 ? d.text : '';
  el.meterDesc.textContent = desc;
  el.meterDesc.hidden = !desc;
  const applies = meterApplies(plan);
  if (applies) {
    const before = state.mode1 && state.cut ? state.cut.time : state.song.duration;
    el.meterStats.textContent = `${barsChangedText(m.barsChanged)} · dura ${durationChange(before, plan.outputDuration)}`;
  }
  el.meterStats.hidden = !applies;
  const msg = m ? m.error || (applies ? '' : m.info) || '' : '';
  el.meterMsg.textContent = msg;
  el.meterMsg.dataset.kind = m && m.error ? 'error' : 'info';
  el.meterMsg.hidden = !msg;
  el.meterNum.setAttribute('aria-invalid', String(preset === 'other' && !!(m && m.error)));
  el.meterPreview.disabled = !applies;
}

function barsRemovedForName() {
  const c = state.cut;
  if (!c) return 0;
  if (c.mode === 'bars') return c.n;
  if (maxBars() < 1) return 0;   // sin compases que quitar, el corte a mano no se cuenta en compases
  return Number.isFinite(c.approx) ? Math.round(c.approx * 10) / 10 : 0;
}

function outputName() {
  const opt = exportOptions(state.format);
  const plan = currentPlan();
  const tm = targetMeter(state.newMeter);
  const meter = state.mode2 && meterApplies(plan) ? { num: tm.num, den: tm.den } : null;
  return safe(() => suggestFileName(state.song.name, {
    barsRemoved: state.mode1 ? barsRemovedForName() : null, format: opt.format, meter,
  }), `edit.${opt.format}`);
}

function renderOutName() {
  if (!state.song || !state.cut) return;
  el.outName.textContent = outputName();
}

// "7/8 · −2 compases · dura 1:04 → 0:51"
function summaryText(plan) {
  const parts = [];
  if (state.mode2 && meterApplies(plan)) {
    const tm = targetMeter(state.newMeter);
    parts.push(`Compás ${meterLabel(tm.num, tm.den)}`);
  }
  if (state.mode1 && state.cut) {
    const n = barsRemovedForName();
    parts.push(n > 0 ? `−${formatBars(n)} del final` : 'corte a mano');
  }
  parts.push(`dura ${durationChange(state.song.duration, plan.outputDuration)}`);
  return parts.join(' · ');
}

function renderSave() {
  for (const input of el.formats.querySelectorAll('input[name="format"]')) input.checked = input.value === state.format;
  const has = !!(state.song && state.song.hasTags);
  el.keepTags.disabled = !has;
  el.keepTags.checked = has && state.keepTags;
  el.tagsNote.textContent = has
    ? 'Se copian título, artista, álbum y carátula; se descartan los datos de análisis de otros programas.'
    : 'El archivo original no tiene etiquetas ID3 que conservar.';
  const plan = currentPlan();
  const blocker = plan ? exportBlocker(plan, { mode1: state.mode1, mode2: state.mode2 }) : null;
  el.exportBtn.disabled = state.exporting || state.phase !== 'ready' || !!blocker;
  const hint = blocker || state.exportError;
  el.exportHint.textContent = hint || '';
  el.exportHint.hidden = !hint;
  el.exportHint.dataset.kind = !blocker && state.exportError ? 'error' : 'info';
  el.outNameLine.hidden = !!blocker;
  if (plan && !blocker) {
    el.resultSummary.textContent = summaryText(plan);
    el.resultSummary.hidden = false;
    // duración exacta de la salida (la usan las pruebas de extremo a extremo)
    el.resultSummary.dataset.outputSec = plan.outputDuration.toFixed(6);
    el.resultSummary.dataset.barsChanged = String(plan.meter ? plan.meter.barsChanged : 0);
  } else {
    el.resultSummary.hidden = true;
    delete el.resultSummary.dataset.outputSec;
  }
  renderOutName();
}

function renderAllControls() {
  el.fade.value = String(state.fadeIdx);
  el.curve.value = state.curve;
  el.snap.checked = state.snap;
  el.xfade.value = String(state.xfadeMs);
  el.meterNum.value = state.newMeter.num;
  el.meterDen.value = state.newMeter.den;
  wave.setSnap(state.snap);
  setMetronome(state.metronome, { silent: true });
  el.timeTotal.textContent = formatTime(state.song.duration);
  el.mode1.checked = state.mode1;
  el.panelCut.dataset.on = String(state.mode1);
  el.mode1Body.hidden = !state.mode1;
  el.mode1Off.hidden = state.mode1;
  el.zoomCut.disabled = !state.mode1;
  wave.setCut(state.mode1 && state.cut ? state.cut.time : null);
  renderFade();
  renderInfo();
  renderReview();
  onPlanChanged({ stopPreview: false });
  renderTransport();
  renderZoomButtons();
}

function renderTransport() {
  const playing = player.playing;
  const previewing = playing && player.mode === 'preview';
  const tag = player.previewTag;
  // durante una vista previa el botón principal la detiene: se muestra como tal
  const label = previewing ? 'Detener' : playing ? 'Pausa' : 'Reproducir';
  el.play.setAttribute('aria-pressed', String(playing));
  el.play.dataset.state = playing ? 'playing' : 'paused';
  el.play.setAttribute('aria-label', previewing ? 'Detener la vista previa' : label);
  el.playLabel.textContent = label;
  el.preview.dataset.state = tag === 'end' ? 'playing' : 'idle';
  el.previewLabel.textContent = tag === 'end' ? 'Detener' : 'Escuchar el final';
  el.meterPreview.dataset.state = tag === 'meter' ? 'playing' : 'idle';
  el.meterPreviewLabel.textContent = tag === 'meter' ? 'Detener' : 'Escuchar con el nuevo compás';
}

function renderZoomButtons() {
  const z = wave.zoomLimits;
  el.zoomIn.disabled = !z.canZoomIn;
  el.zoomOut.disabled = !z.canZoomOut;
}

// ---------- revisar compases (worker) ----------

// describe(result) opcional → { text, kind } del aviso final (por defecto "Cuadrícula actualizada…")
async function runGridJob(message, job, describe = null) {
  if (!client || state.busy || !state.result) return;
  const gen = state.gen;
  state.busy = true;
  renderReview();
  announce(message, 'info', { visual: false });
  try {
    const result = await job();
    if (gen !== state.gen) return;
    state.busy = false;
    applyResult(result);
    renderSave();
    const d = describe && describe(result);
    if (d) announce(d.text, d.kind);
    else announce(`Cuadrícula actualizada: ${formatBpm(result.bpm)} · ${meterText(result.beatsPerBar)}`);
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

function retrackAt(bpmHint) {
  runGridJob(`Recalculando a ≈ ${formatNumber(bpmHint, 1)} BPM…`, async () => {
    const res = await client.retrack({ bpmHint, strict: true });
    state.tempoChanged = true;
    return res;
  }, (res) => tempoResultNotice(res, bpmHint));
}

// Aviso tras pedir un tempo: si la cuadrícula no quedó cerca del tempo pedido, se dice (no "actualizada")
function tempoResultNotice(res, bpmHint) {
  const asked = `${formatNumber(bpmHint, 1)} BPM`;
  if (!(res && res.beats && res.beats.length > 1)) {
    return { kind: 'error', text: `No se encontró un pulso cerca de ${asked}: este audio no tiene ataques claros. Coloca el corte a mano.` };
  }
  const ratio = res.bpm / bpmHint;
  if (!(ratio >= TEMPO_MATCH[0] && ratio <= TEMPO_MATCH[1])) {
    return {
      kind: 'error',
      text: `No se encontró un pulso cerca de ${asked}: la cuadrícula quedó en ${formatBpm(res.bpm)}. Escucha con el clic o pulsa «Restablecer».`,
    };
  }
  return null;
}

function changeTempo(factor) {
  const r = state.result;
  if (!r || !(r.bpm > 0)) return;
  const bpmHint = r.bpm * factor;
  if (bpmHint < 30 || bpmHint > 320) {
    announce('Ese tempo queda fuera del rango que se puede detectar.', 'error');
    return;
  }
  retrackAt(bpmHint);
}

// "Tempo manual": el BPM escrito o marcado con toques
function applyManualTempo() {
  if (!state.result || state.busy) return;
  const bpm = parseBpm(el.bpmInput.value);
  if (bpm === null) {
    announce(`Escribe un tempo entre ${MANUAL_BPM.min} y ${MANUAL_BPM.max} BPM.`, 'error');
    el.bpmInput.focus();
    return;
  }
  retrackAt(bpm);
}

// "Marcar tempo": mediana de los últimos toques
function tapBeat() {
  if (!state.result || state.busy) return;
  const res = tapTempo(state.taps, performance.now());
  state.taps = res.taps;
  if (res.bpm === null) {
    el.tapValue.textContent = 'Sigue tocando…';
    return;
  }
  const bpm = clamp(res.bpm, MANUAL_BPM.min, MANUAL_BPM.max);
  el.tapValue.textContent = `≈ ${formatNumber(bpm, 1)} BPM`;
  el.bpmInput.value = formatNumber(bpm, 1);
  renderReview();
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
  el.bpmInput.value = '';
  state.taps = [];
  el.tapValue.textContent = 'Toca al ritmo';
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

// iOS sin navigator.audioSession: Web Audio obedece al interruptor de silencio y no hay forma de saberlo
let silentHintShown = false;
function iosSilentHint() {
  if (silentHintShown) return;
  const nav = globalThis.navigator || {};
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (!ios || nav.audioSession) return;
  silentHintShown = true;
  announce('Si no oyes nada, quita el modo silencio del iPhone o iPad.');
}

function togglePlay() {
  if (state.phase !== 'ready') return;
  if (player.playing && player.mode === 'preview') {
    player.stop();
    return;
  }
  player.toggle();
  if (player.playing) iosSilentHint();
}

function stopPreviewPlayback() {
  if (player.playing && player.mode === 'preview') player.stop();
}

// Vista previa del resultado (mismo plan y mismo render que la exportación), renderizada por tramos mientras suena.
// 'end': los últimos 8 s de la salida; 'meter': desde el cabezal con el compás nuevo.
// at (opcional): instante del original desde el que sonar (un toque en la onda durante la vista previa).
function startPreview(kind, { at = null } = {}) {
  if (state.phase !== 'ready') return;
  const plan = currentPlan();
  if (!plan || !(plan.outputDuration > 0)) return;
  if (kind === 'meter' && !meterApplies(plan)) return;
  const { buffer } = state.song;
  const sr = buffer.sampleRate;
  const out = renderedLength(plan.segments, sr) / sr;
  if (!(out > 0)) return;
  let from;
  if (Number.isFinite(at)) from = previewStartTime(plan.segments, at, out, PREVIEW_SEC);
  else if (kind === 'end') from = Math.max(0, out - PREVIEW_SEC);
  else from = previewStartTime(plan.segments, player.currentTime, out, PREVIEW_SEC);
  try {
    const chans = channelsOf(buffer);
    const opts = { crossfadeSec: plan.crossfadeSec, fadeOutSec: plan.fadeOutSec, curve: state.curve };
    const render = (a, b) => renderSegments(chans, sr, plan.segments, { ...opts, from: a, to: b });
    const toSource = outputToSourceFn(plan.segments);
    const clicks = mapBeatsToOutput(plan.segments, (state.result && state.result.beats) || [], state.downbeatSet);
    // que se vea lo que va a sonar (salvo si viene de un toque en la onda: el usuario ya está mirando ahí)
    const s0 = toSource(from);
    if (!Number.isFinite(at) && kind === 'end') {
      const s1 = plan.sourceEnd;
      const v = wave.getView();
      if (s0 < v.start || s1 > v.end) {
        const pad = (s1 - s0) * 0.15;
        wave.setView(Math.min(v.start, s0 - pad), Math.max(s1 + pad, Math.min(v.end, s1 + (s1 - s0))));
      }
    } else if (!Number.isFinite(at)) {
      wave.reveal(s0);
    }
    if (player.playPreview(null, sr, from, { toSource, clicks, tag: kind, render, end: out })) iosSilentHint();
  } catch (err) {
    announce(errorMessage('preview', err), 'error');
  }
}

function togglePreview(kind) {
  if (state.phase !== 'ready') return;
  if (player.previewTag === kind) {
    player.stop();
    return;
  }
  startPreview(kind);
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
    el.exportBtn.removeAttribute('aria-busy');
    renderSave();
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
  const plan = currentPlan();
  if (!plan || exportBlocker(plan, { mode1: state.mode1, mode2: state.mode2 })) return;
  const gen = state.gen;
  state.exporting = true;
  state.exportError = '';
  if (player.playing) player.pause();
  renderExportProgress(0);
  try {
    await nextFrame();
    const { buffer, tagBytes } = state.song;
    const opt = exportOptions(state.format);
    const name = outputName();
    // la salida se lee por tramos al codificar: no hay un render completo en memoria
    const source = segmentSource(channelsOf(buffer), buffer.sampleRate, plan.segments, {
      crossfadeSec: plan.crossfadeSec, fadeOutSec: plan.fadeOutSec, curve: state.curve,
    });
    const blob = await exportAudio({
      source,
      sampleRate: buffer.sampleRate,
      format: opt.format,
      bitDepth: opt.bitDepth,
      kbps: opt.kbps,
      tagBytes: state.keepTags ? tagBytes : null,
      keepTags: state.keepTags && state.song.hasTags,
      onProgress: (f) => {
        if (gen === state.gen) renderExportProgress(clamp(Number(f) || 0, 0, 1));
      },
    });
    if (gen !== state.gen) return;
    triggerDownload(blob, name);
    announce(`Listo: se descargó «${name}» (${formatFileSize(blob.size)}).`);
  } catch (err) {
    if (gen === state.gen) {
      state.exportError = errorMessage('export', err);
      announce(state.exportError, 'error');
    }
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

  // avisos: se cierran con la X (el resto del aviso deja pasar los toques)
  el.toastClose.addEventListener('click', hideToast);

  // forma de onda
  wave.addEventListener('seek', (e) => {
    const tag = player.previewTag;
    if (tag) player.stop();
    player.seek(e.detail.time);
    // durante una vista previa (final o compás nuevo) sigue sonando el resultado desde el punto tocado, nunca el
    // original; si el punto ya no está en la salida, los últimos segundos
    if (tag) startPreview(tag, { at: e.detail.time });
    onTimeUpdate();
  });
  wave.addEventListener('cutchange', (e) => {
    const { time, snapped, beatIndex, phase } = e.detail;
    if (phase === 'start' || !state.mode1) return;
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
    if (!state.cut || !state.mode1) return;
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
  el.bpmInput.addEventListener('input', () => {
    el.bpmApply.disabled = state.busy || !state.result || parseBpm(el.bpmInput.value) === null;
  });
  el.bpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyManualTempo();
    }
  });
  el.bpmApply.addEventListener('click', applyManualTempo);
  // el toque cuenta al bajar el dedo (menos retardo que el clic); el teclado activa el botón con 'click'
  el.tap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tapBeat();
  });
  el.tap.addEventListener('click', (e) => {
    if (e.detail === 0) tapBeat();
  });
  el.selMeter.addEventListener('change', () => {
    state.meterChoice = el.selMeter.value;
    state.forced = [];
    relabel(state.meterChoice === 'auto' ? 'Detectando el compás…' : `Aplicando ${state.meterChoice}/4…`);
  });
  el.onePrev.addEventListener('click', () => moveOne(-1));
  el.oneNext.addEventListener('click', () => moveOne(1));
  el.thisOne.addEventListener('click', thisBeatIsOne);
  el.resetGrid.addEventListener('click', resetGrid);

  // modo 1: corte
  el.mode1.addEventListener('change', () => setMode1(el.mode1.checked));
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

  // modo 1: final
  el.fade.addEventListener('input', () => {
    state.fadeIdx = clamp(Number(el.fade.value) || 0, 0, FADE_BEAT_STEPS.length - 1);
    renderFade();
    onPlanChanged();
    savePrefs();
  });
  el.curve.addEventListener('change', () => {
    state.curve = FADE_CURVES_UI.includes(el.curve.value) ? el.curve.value : 'smooth';
    stopPreviewPlayback();
    renderFade();
    savePrefs();
  });
  el.preview.addEventListener('click', () => togglePreview('end'));

  // modo 2: cambiar el compás
  el.mode2.addEventListener('change', () => setMode2(el.mode2.checked));
  el.meterChips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-meter]');
    if (b) chooseMeter(b.dataset.meter);
  });
  el.meterNum.addEventListener('input', () => {
    state.newMeter.num = el.meterNum.value;
    savePrefs();
    onPlanChanged();
  });
  el.meterDen.addEventListener('change', () => {
    state.newMeter.den = el.meterDen.value;
    savePrefs();
    onPlanChanged();
  });
  el.xfade.addEventListener('input', () => {
    state.xfadeMs = clamp(Math.round(Number(el.xfade.value) || XFADE_MS.def), XFADE_MS.min, XFADE_MS.max);
    savePrefs();
    onPlanChanged();
  });
  el.meterPreview.addEventListener('click', () => togglePreview('meter'));

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
    if (e.repeat && (action === 'toggle-play' || action === 'metronome' || action === 'preview' || action === 'tap-tempo')) return;
    const cutKeys = state.mode1;
    switch (action) {
      case 'toggle-play': togglePlay(); break;
      case 'cut-beat-prev': if (cutKeys) nudgeBeat(-1); break;
      case 'cut-beat-next': if (cutKeys) nudgeBeat(1); break;
      case 'cut-bar-prev': if (cutKeys) nudgeBar(-1); break;
      case 'cut-bar-next': if (cutKeys) nudgeBar(1); break;
      case 'zoom-in': wave.zoomBy(0.5); break;
      case 'zoom-out': wave.zoomBy(2); break;
      case 'metronome': if (!el.metro.disabled) setMetronome(!state.metronome); break;
      case 'preview':
        if (state.mode1) togglePreview('end');
        else if (state.mode2) togglePreview('meter');
        break;
      case 'tap-tempo': if (!el.tap.disabled) tapBeat(); break;
      default: break;
    }
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
