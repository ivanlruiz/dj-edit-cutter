import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime, formatDuration, formatBpm, formatBars, formatBeats, formatSeconds, formatFade, formatNumber,
  meterText, nearestIndex, lowerBound, medianBeatInterval, fadeBeatsToSeconds, confidenceInfo, cutReadout,
  nextBarsCount, initialViewRange, shiftedDownbeatIndex, exportOptions, overallProgress, shortcutAction,
  errorMessage, looksLikeAudio, formatFileSize, FADE_BEAT_STEPS, BAR_CHIPS,
} from '../js/ui/format.js';

test('formatTime: m:ss.cc con redondeo y horas', () => {
  assert.equal(formatTime(221.25), '3:41.25');
  assert.equal(formatTime(0), '0:00.00');
  assert.equal(formatTime(59.999), '1:00.00');
  assert.equal(formatTime(5.5, 1), '0:05.5');
  assert.equal(formatTime(3723.5), '1:02:03.50');
  assert.equal(formatTime(-1.5), '−0:01.50');
  assert.equal(formatTime(NaN), '–:––');
  assert.equal(formatTime(61, 0), '1:01');
});

test('formatDuration trunca a segundos', () => {
  assert.equal(formatDuration(232.9), '3:52');
  assert.equal(formatDuration(221.25), '3:41');
  assert.equal(formatDuration(60), '1:00');
});

test('formatBpm muestra rango solo si hay deriva', () => {
  assert.equal(formatBpm(124, [118.2, 127.9]), '≈ 124 BPM (118–128)');
  assert.equal(formatBpm(124, [123.6, 124.4]), '≈ 124 BPM');
  assert.equal(formatBpm(123.5), '≈ 123.5 BPM');
  assert.equal(formatBpm(0), 'Tempo desconocido');
});

test('compases y beats con singular/plural', () => {
  assert.equal(formatBars(1), '1 compás');
  assert.equal(formatBars(4), '4 compases');
  assert.equal(formatBars(2.46), '2.5 compases');
  assert.equal(formatBars(0.5), '0.5 compases');
  assert.equal(formatBeats(0.5), '½ beat');
  assert.equal(formatBeats(1), '1 beat');
  assert.equal(formatBeats(8), '8 beats');
  assert.equal(formatNumber(2.0), '2');
  assert.equal(formatNumber(2.25, 2), '2.25');
  assert.equal(meterText(3), '3/4');
});

test('fade: segundos a partir de la mediana de los beats previos al corte', () => {
  // 120 BPM (0.5 s) y luego ritardando tras el corte, que no debe influir
  const beats = [];
  for (let i = 0; i < 20; i++) beats.push(i * 0.5);
  beats.push(10.2, 11.0, 12.0);
  const cut = 9.5 - 0.004; // justo antes del beat 19
  assert.ok(Math.abs(medianBeatInterval(beats, cut) - 0.5) < 1e-9);
  assert.ok(Math.abs(fadeBeatsToSeconds(2, beats, cut, 120) - 1.0) < 1e-9);
  assert.equal(fadeBeatsToSeconds(0, beats, cut, 120), 0);
  assert.equal(medianBeatInterval([], 3, 8, 100), 0.6);
  assert.equal(formatFade(0, 0), 'Corte seco (sin fade)');
  assert.equal(formatFade(2, 0.968), '2 beats ≈ 0.97 s');
  assert.equal(formatSeconds(12.34), '12.3 s');
  assert.deepEqual(FADE_BEAT_STEPS, [0, 0.5, 1, 2, 4, 8, 16]);
  assert.deepEqual(BAR_CHIPS, [1, 2, 4, 8, 16, 32]);
});

test('nearestIndex / lowerBound', () => {
  const a = [0, 1, 2, 3];
  assert.equal(nearestIndex(a, 1.4), 1);
  assert.equal(nearestIndex(a, 1.6), 2);
  assert.equal(nearestIndex(a, -5), 0);
  assert.equal(nearestIndex(a, 9), 3);
  assert.equal(nearestIndex([], 1), -1);
  assert.equal(lowerBound(a, 1.5), 2);
  assert.equal(lowerBound(a, 4), 4);
});

test('confianza', () => {
  assert.equal(confidenceInfo({ beats: 0.9, bars: 0.8 }).level, 'high');
  assert.equal(confidenceInfo({ beats: 0.9, bars: 0.6 }).level, 'medium');
  const low = confidenceInfo({ beats: 0.4, bars: 0.9 });
  assert.equal(low.low, true);
  assert.equal(low.label, 'Revisa la cuadrícula');
  assert.equal(confidenceInfo(null).low, true);
});

test('cutReadout', () => {
  assert.equal(cutReadout(221.246, 232.5), 'Corte en 3:41.25 · la canción pasa de 3:52 a 3:41');
});

test('nextBarsCount desde compases y desde ajuste manual', () => {
  assert.equal(nextBarsCount({ n: 1, delta: 1 }), 2);
  assert.equal(nextBarsCount({ n: 1, delta: -1 }), 1);
  assert.equal(nextBarsCount({ n: 8, delta: 1, max: 8 }), 8);
  assert.equal(nextBarsCount({ manual: true, approx: 2.3, delta: 1 }), 3);
  assert.equal(nextBarsCount({ manual: true, approx: 2.3, delta: -1 }), 2);
  assert.equal(nextBarsCount({ manual: true, approx: 2.0, delta: 1 }), 3);
  assert.equal(nextBarsCount({ manual: true, approx: 2.0, delta: -1 }), 1);
  assert.equal(nextBarsCount({ manual: true, approx: 0.4, delta: -1 }), 1);
});

test('initialViewRange muestra los últimos compases y el corte', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ index: i, number: i + 1, start: 1 + i * 2, end: 3 + i * 2 });
  const v = initialViewRange({ bars, lastBarIndex: 39, musicEnd: 82.5, duration: 85, cutTime: 78.996, barsBack: 14 });
  assert.ok(v.start < bars[26].start && v.start > bars[25].start - 1, `start ${v.start}`);
  assert.ok(v.end >= 82.5 && v.end <= 85);
  assert.ok(v.start < 78.996 && v.end > 78.996);
  // corte muy atrás: se incluye
  const w = initialViewRange({ bars, lastBarIndex: 39, musicEnd: 82.5, duration: 85, cutTime: 10, barsBack: 14 });
  assert.ok(w.start <= 10);
  // sin compases: últimos 30 s
  const z = initialViewRange({ bars: [], lastBarIndex: -1, musicEnd: 100, duration: 102, cutTime: 99 });
  assert.ok(z.start > 65 && z.start < 71 && z.end <= 102);
});

test('shiftedDownbeatIndex mueve el 1 más cercano', () => {
  const beats = Array.from({ length: 16 }, (_, i) => i * 0.5);
  const result = { beats, downbeats: [0, 4, 8, 12] };
  assert.equal(shiftedDownbeatIndex(result, 4.1, 1), 9);
  assert.equal(shiftedDownbeatIndex(result, 4.1, -1), 7);
  assert.equal(shiftedDownbeatIndex(result, 0, -1), 0);
  assert.equal(shiftedDownbeatIndex({ beats: [], downbeats: [] }, 1, 1), -1);
});

test('exportOptions y progreso', () => {
  assert.deepEqual(exportOptions('mp3-256'), { id: 'mp3-256', format: 'mp3', kbps: 256, label: 'MP3 · 256 kbps' });
  assert.equal(exportOptions('xx').id, 'wav16');
  assert.equal(overallProgress('read', 0), 0);
  assert.equal(overallProgress('bars', 1), 1);
  assert.ok(overallProgress('tempo', 0.5) > overallProgress('features', 1));
  assert.equal(overallProgress('nope', 1), null);
});

test('shortcutAction ignora campos de texto y modificadores', () => {
  assert.equal(shortcutAction({ key: ' ', targetTag: 'BODY' }), 'toggle-play');
  assert.equal(shortcutAction({ key: ' ', targetTag: 'BUTTON' }), 'toggle-play');
  assert.equal(shortcutAction({ key: 'ArrowLeft', shiftKey: true, targetTag: 'DIV' }), 'cut-bar-prev');
  assert.equal(shortcutAction({ key: 'ArrowRight', targetTag: 'DIV' }), 'cut-beat-next');
  assert.equal(shortcutAction({ key: 'ArrowRight', targetTag: 'INPUT', targetType: 'range' }), null);
  assert.equal(shortcutAction({ key: 'm', targetTag: 'SELECT' }), null);
  assert.equal(shortcutAction({ key: 'p', targetTag: 'BODY', ctrlKey: true }), null);
  assert.equal(shortcutAction({ key: '+', targetTag: 'BODY' }), 'zoom-in');
  assert.equal(shortcutAction({ key: '-', targetTag: 'BODY' }), 'zoom-out');
  assert.equal(shortcutAction({ key: 'M', targetTag: 'BODY' }), 'metronome');
  assert.equal(shortcutAction({ key: 'P', targetTag: 'BODY' }), 'preview');
  assert.equal(shortcutAction({ key: 'x', targetTag: 'BODY' }), null);
  assert.equal(shortcutAction({ key: ' ', targetTag: 'DIV', targetEditable: true }), null);
  assert.equal(shortcutAction({ key: ' ', targetTag: 'SUMMARY' }), null);
  assert.equal(shortcutAction({ key: 'm', targetTag: 'SUMMARY' }), 'metronome');
});

test('mensajes y utilidades varias', () => {
  assert.match(errorMessage('decode'), /formato/);
  assert.match(errorMessage('export', new Error('sin memoria')), /sin memoria/);
  assert.equal(looksLikeAudio('tema.MP3', ''), true);
  assert.equal(looksLikeAudio('foto.jpg', 'image/jpeg'), false);
  assert.equal(looksLikeAudio('x', 'audio/flac'), true);
  assert.equal(formatFileSize(5 * 1024 * 1024), '5 MB');
});
