// Helpers puros de la interfaz: formato de textos y cálculos pequeños (sin DOM, testeables en Node).

export const FADE_BEAT_STEPS = [0, 0.5, 1, 2, 4, 8, 16];
export const BAR_CHIPS = [1, 2, 4, 8, 16, 32];

// Etapas del análisis → texto en español
export const STAGE_LABELS = {
  read: 'Leyendo archivo',
  features: 'Detectando notas',
  tempo: 'Calculando tempo',
  beats: 'Buscando beats',
  bars: 'Buscando compases',
};

// Tramo de la barra de progreso global que ocupa cada etapa [inicio, fin]
export const STAGE_SPANS = {
  read: [0, 0.22],
  features: [0.22, 0.6],
  tempo: [0.6, 0.72],
  beats: [0.72, 0.9],
  bars: [0.9, 1],
};

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// Progreso global 0..1 a partir de la etapa y la fracción dentro de ella
export function overallProgress(stage, fraction) {
  const span = STAGE_SPANS[stage];
  if (!span) return null;
  const f = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
  return span[0] + (span[1] - span[0]) * f;
}

// Número con decimales solo si hacen falta y coma decimal (como en el nombre del archivo): 2 → "2", 2.5 → "2,5"
export function formatNumber(x, maxDecimals = 1) {
  if (!Number.isFinite(x)) return '–';
  const f = 10 ** maxDecimals;
  const r = Math.round(x * f) / f;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(maxDecimals).replace(/0+$/, '').replace('.', ',');
}

// "3:41.25" (m:ss.cc); con horas "1:03:41.25"
export function formatTime(sec, decimals = 2) {
  if (!Number.isFinite(sec)) return '–:––';
  const neg = sec < 0;
  const f = 10 ** decimals;
  const total = Math.round(Math.abs(sec) * f);
  const whole = Math.floor(total / f);
  const frac = total - whole * f;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  let out = (h > 0 ? `${h}:` : '') + `${mm}:${ss}`;
  if (decimals > 0) out += '.' + String(frac).padStart(decimals, '0');
  return (neg && total > 0 ? '−' : '') + out;
}

// Duración sin decimales ("3:52"), truncando como los reproductores
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '–:––';
  return formatTime(Math.floor(Math.max(0, sec) + 1e-6), 0);
}

// "≈ 124 BPM (118–128)"; sin rango si no hay deriva apreciable
export function formatBpm(bpm, range) {
  if (!Number.isFinite(bpm) || bpm <= 0) return 'Tempo desconocido';
  let text = `≈ ${formatNumber(bpm, 1)} BPM`;
  if (Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    const lo = Math.round(Math.min(range[0], range[1]));
    const hi = Math.round(Math.max(range[0], range[1]));
    if (hi - lo >= 2) text += ` (${lo}–${hi})`;
  }
  return text;
}

// "1 compás" / "4 compases" / "2,5 compases"
export function formatBars(n) {
  const s = formatNumber(n, 1);
  return s === '1' ? '1 compás' : `${s} compases`;
}

export function formatBeats(n) {
  if (n === 0.5) return '½ beat';
  const s = formatNumber(n, 2);
  return s === '1' ? '1 beat' : `${s} beats`;
}

// Segundos cortos para el fade: "0,97 s", "12,4 s"
export function formatSeconds(sec) {
  if (!Number.isFinite(sec)) return '– s';
  const a = Math.abs(sec);
  return `${(a < 10 ? sec.toFixed(2) : sec.toFixed(1)).replace('.', ',')} s`;
}

export function meterText(beatsPerBar) {
  return Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? `${beatsPerBar}/4` : '–';
}

// Etiqueta del fade: "Corte seco" o "2 beats ≈ 0.97 s"
export function formatFade(beats, sec) {
  if (!beats) return 'Corte seco (sin fade)';
  return `${formatBeats(beats)} ≈ ${formatSeconds(sec)}`;
}

// Índice del valor más cercano en un array ordenado (-1 si está vacío)
export function nearestIndex(sorted, t) {
  const n = sorted ? sorted.length : 0;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) <= Math.abs(sorted[lo] - t)) return lo - 1;
  return lo;
}

// Primer índice con sorted[i] >= t (n si no hay)
export function lowerBound(sorted, t) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Mediana de los intervalos entre los `count` beats anteriores al corte (beats <= time + 20 ms)
export function medianBeatInterval(beats, time, count = 8, fallbackBpm = 120) {
  const fallback = 60 / (Number.isFinite(fallbackBpm) && fallbackBpm > 0 ? fallbackBpm : 120);
  if (!beats || beats.length < 2) return fallback;
  let end = lowerBound(beats, time + 0.02); // exclusivo
  if (end < 2) end = Math.min(beats.length, count);
  const start = Math.max(0, end - count);
  const ibis = [];
  for (let i = start + 1; i < end; i++) {
    const d = beats[i] - beats[i - 1];
    if (d > 0) ibis.push(d);
  }
  const m = median(ibis);
  return Number.isFinite(m) && m > 0 ? m : fallback;
}

export function fadeBeatsToSeconds(fadeBeats, beats, cutTime, bpm) {
  if (!fadeBeats) return 0;
  return fadeBeats * medianBeatInterval(beats, cutTime, 8, bpm);
}

export const END_HIT_TOLERANCE = 0.08;   // s: el golpe final "cae" en un beat si está a menos de esto

// Coherencia del final: ¿el golpe final (lastOnset) cae en un "1" de la cuadrícula, en el último tiempo de un compás
// (final seco) o es una anticipación (entre el último tiempo y el "1" siguiente)? Si cae en un tiempo interior o a
// contratiempo, lo más probable es que la cuadrícula esté mal (tempo ×2/÷2, el "1" corrido, compás equivocado…) y el
// corte de "N compases" también. Medido en el banco (suite + stress + extra × none/limit12/applause, 192 casos):
// avisa en 15 de 16 cortes de 1 compás incorrectos (antes 14) y en 17 de 176 correctos (antes 13; fade outs sobre todo).
// → { ok: true | false | null (no se puede evaluar), beat, position, offsetMs }
export function endConsistency(result) {
  const r = result || {};
  const beats = r.beats;
  const pos = r.positions;
  const bpb = r.beatsPerBar;
  if (!beats || beats.length < 4 || !pos || pos.length < beats.length || !Number.isFinite(r.lastOnset) || !(bpb > 1)) {
    return { ok: null };
  }
  const j = nearestIndex(beats, r.lastOnset);
  const d = beats[j] - r.lastOnset;   // > 0: el beat va después del golpe
  const p = pos[j];
  const onBeat = Math.abs(d) < END_HIT_TOLERANCE;
  // en el "1"; o en el último tiempo (final seco en el 4); o anticipado entre el último tiempo y el "1"
  const onOne = p === 0 && onBeat;
  const onLast = p >= bpb - 1 && onBeat;
  const anticipation = (p >= bpb - 1 && d < -END_HIT_TOLERANCE) || (p === 0 && d > END_HIT_TOLERANCE);
  return { ok: onOne || onLast || anticipation, beat: j, position: p, offsetMs: Math.round(-d * 1000) };
}

// Confianza → nivel y texto de la insignia. Con el resultado del análisis, un final incoherente (endConsistency)
// baja el nivel a "Revisa la cuadrícula" aunque las confianzas sean altas (end: el motivo, para el aviso).
export function confidenceInfo(conf, result = null) {
  const b = conf && Number.isFinite(conf.beats) ? conf.beats : 0;
  const k = conf && Number.isFinite(conf.bars) ? conf.bars : 0;
  const v = Math.min(b, k);
  if (result && endConsistency(result).ok === false) {
    return { level: 'low', label: 'Revisa la cuadrícula', low: true, value: v, end: true };
  }
  if (v >= 0.75) return { level: 'high', label: 'Detección fiable', low: false, value: v };
  if (v >= 0.5) return { level: 'medium', label: 'Detección aceptable', low: false, value: v };
  return { level: 'low', label: 'Revisa la cuadrícula', low: true, value: v };
}

// "Corte en 3:41.25 · la canción pasa de 3:52 a 3:41"; con el compás nuevo (outputDuration) la duración final es
// otra: "Corte en 3:41.25 · con el compás nuevo pasa de 3:52 a 3:18"
export function cutReadout(cutTime, duration, outputDuration) {
  if (Number.isFinite(outputDuration)) {
    return `Corte en ${formatTime(cutTime)} · con el compás nuevo pasa de ${formatDuration(duration)} a ${formatDuration(outputDuration)}`;
  }
  return `Corte en ${formatTime(cutTime)} · la canción pasa de ${formatDuration(duration)} a ${formatDuration(cutTime)}`;
}

// Nuevo número de compases al pulsar −/+ (desde modo compases o desde ajuste manual)
export function nextBarsCount({ manual = false, n = 1, approx = 1, delta = 1, max = Infinity }) {
  let next;
  if (manual) {
    const a = Number.isFinite(approx) ? approx : 1;
    next = delta > 0 ? Math.floor(a + 1e-6) + 1 : Math.ceil(a - 1e-6) - 1;
  } else {
    next = n + delta;
  }
  const hi = Number.isFinite(max) ? Math.max(1, max) : Infinity;
  return clamp(next, 1, hi);
}

// Vista inicial: los últimos ~`barsBack` compases hasta el final de la música, con el corte visible
export function initialViewRange({ bars = [], lastBarIndex = -1, musicEnd, duration, cutTime, barsBack = 14 }) {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (!dur) return { start: 0, end: 0 };
  const endMusic = Number.isFinite(musicEnd) && musicEnd > 0 ? Math.min(musicEnd, dur) : dur;
  let start;
  let end;
  if (bars.length && lastBarIndex >= 0) {
    const li = Math.min(lastBarIndex, bars.length - 1);
    const first = Math.max(0, li - barsBack + 1);
    start = bars[first].start;
    end = Math.max(bars[li].end, endMusic);
  } else {
    end = endMusic;
    start = Math.max(0, end - 30);
  }
  if (Number.isFinite(cutTime) && cutTime < start) start = cutTime;
  const pad = Math.max(0.2, (end - start) * 0.04);
  start = Math.max(0, start - pad);
  end = Math.min(dur, end + pad);
  if (end - start < 0.5) {
    start = Math.max(0, end - 0.5);
  }
  return { start, end };
}

// Índice de beat que pasa a ser "1" al mover el downbeat más cercano a `refTime` `delta` beats
export function shiftedDownbeatIndex(result, refTime, delta) {
  if (!result || !result.beats || !result.beats.length) return -1;
  const downs = result.downbeats || [];
  let base;
  if (downs.length) {
    const times = downs.map((i) => result.beats[i]);
    base = downs[nearestIndex(times, refTime)];
  } else {
    base = nearestIndex(result.beats, refTime);
  }
  return clamp(base + delta, 0, result.beats.length - 1);
}

// Opciones de exportación a partir del valor del radio ("wav16", "wav24", "mp3-320"...)
export const EXPORT_FORMATS = [
  { id: 'wav16', format: 'wav', bitDepth: 16, label: 'WAV · 16 bits' },
  { id: 'wav24', format: 'wav', bitDepth: 24, label: 'WAV · 24 bits' },
  { id: 'mp3-320', format: 'mp3', kbps: 320, label: 'MP3 · 320 kbps' },
  { id: 'mp3-256', format: 'mp3', kbps: 256, label: 'MP3 · 256 kbps' },
  { id: 'mp3-192', format: 'mp3', kbps: 192, label: 'MP3 · 192 kbps' },
];

export function exportOptions(id) {
  return EXPORT_FORMATS.find((f) => f.id === id) || EXPORT_FORMATS[0];
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 0)} KB`;
  return `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
}

// Atajos de teclado → acción (o null). `e` imita un KeyboardEvent + tagName/type del destino.
export function shortcutAction(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const tag = (e.targetTag || '').toUpperCase();
  const type = (e.targetType || '').toLowerCase();
  if (e.targetEditable || tag === 'TEXTAREA' || tag === 'SELECT') return null;
  if (tag === 'INPUT' && type !== 'button' && type !== 'submit') return null;
  const k = e.key;
  // Espacio sobre un control con foco lo activa (comportamiento nativo); si no, reproduce / pausa
  if (k === ' ' || k === 'Spacebar') return tag === 'SUMMARY' || tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' ? null : 'toggle-play';
  if (k === 'ArrowLeft') return e.shiftKey ? 'cut-bar-prev' : 'cut-beat-prev';
  if (k === 'ArrowRight') return e.shiftKey ? 'cut-bar-next' : 'cut-beat-next';
  if (k === '+' || k === '=') return 'zoom-in';
  if (k === '-' || k === '_') return 'zoom-out';
  if (k === 'm' || k === 'M') return 'metronome';
  if (k === 'p' || k === 'P') return 'preview';
  if (k === 't' || k === 'T') return 'tap-tempo';
  return null;
}

// Mensajes de error en español según el origen
export function errorMessage(kind, err) {
  const detail = err && err.message ? String(err.message) : '';
  switch (kind) {
    case 'no-audio':
      return 'Ese archivo no parece ser de audio. Elige un MP3, WAV, FLAC, M4A u OGG.';
    case 'decode':
      return 'No se pudo leer el audio. Puede que el formato no sea compatible con este navegador: prueba con MP3 o WAV.';
    case 'empty':
      return 'El archivo está vacío o no contiene audio.';
    case 'analysis':
      return 'No se pudo analizar la canción.' + (detail ? ` (${detail})` : '');
    case 'retrack':
      return 'No se pudo recalcular la cuadrícula.' + (detail ? ` (${detail})` : '');
    case 'export':
      return 'No se pudo exportar el archivo.' + (detail ? ` (${detail})` : '');
    case 'preview':
      return 'No se pudo reproducir la vista previa.' + (detail ? ` (${detail})` : '');
    case 'webaudio':
      return 'Este navegador no puede procesar audio (falta Web Audio). Prueba con Chrome, Firefox o Safari actualizados.';
    default:
      return 'Algo salió mal.' + (detail ? ` (${detail})` : '');
  }
}

// ¿Parece un archivo de audio? (por tipo MIME o extensión)
const AUDIO_EXT = /\.(mp3|wav|wave|flac|m4a|mp4|aac|ogg|oga|opus|webm|aif|aiff|aifc|caf|wma)$/i;
export function looksLikeAudio(name, mime) {
  if (mime && /^audio\//i.test(mime)) return true;
  if (mime && /^video\/(mp4|webm|ogg)/i.test(mime)) return true;
  return AUDIO_EXT.test(name || '');
}
