import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  XFADE_MS, METER_AMOUNTS, DEFAULT_METER_AMOUNT, buildEditPlan, exportBlocker, meterApplies, previewStartTime,
  outputToSourceFn, mapBeatsToOutput, makeTransientSnap, tapTempo, parseBpm, parseIntStrict, targetMeter, meterLabel,
  durationChange, barsChangedText, meterChangeLabel, meterAmountChips, readyMessage, SNAP_WINDOW_SEC,
  SPLICE_GUARD_SEC,
} from '../js/ui/edit-plan.js';
import { planMeterChange, sourceToOutputTime, describeMeterChange } from '../js/core/meter.js';
import { CUT_PREROLL_SEC } from '../js/audio/edit.js';
import { refineToTransients } from '../js/analysis/bounds.js';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} ≉ ${b} (±${eps})`);

// 120 BPM, 2 beats de anacrusa, 16 compases de 4/4 + compás final; golpe final en el "1" del compás 17
function song({ bars = 16 } = {}) {
  const beats = [];
  const positions = [];
  const downbeats = [];
  for (let i = 0; i < 2; i++) positions.push(2 + i);
  for (let b = 0; b <= bars; b++) {
    downbeats.push(positions.length);
    for (let i = 0; i < 4; i++) positions.push(i);
  }
  for (let i = 0; i < positions.length; i++) beats.push(0.3 + i * 0.5);
  const last = beats[beats.length - 1];
  return {
    duration: last + 2, musicEnd: last + 1.5, lastOnset: beats[downbeats[bars]] + 0.01, bpm: 120, beats,
    beatsPerBar: 4, positions, downbeats,
  };
}

test('constantes de la UI del modo 2', () => {
  assert.deepEqual(XFADE_MS, { min: 5, max: 40, def: 10 });
  assert.deepEqual(METER_AMOUNTS.map((c) => c.id), ['eighth', 'beat', 'two-beats', 'sixteenth', 'extend', 'other']);
  assert.equal(DEFAULT_METER_AMOUNT, 'eighth');
  assert.equal(SNAP_WINDOW_SEC, 0.025);
});

test('buildEditPlan: solo modo 1 = un segmento [0, corte) con el fade del corte', () => {
  const r = song();
  const p = buildEditPlan(r, { duration: 40, mode1: true, cutTime: 20.5, fadeSec: 1.2, mode2: false });
  assert.deepEqual(p.segments, [{ start: 0, end: 20.5 }]);
  assert.equal(p.outputDuration, 20.5);
  assert.equal(p.sourceEnd, 20.5);
  assert.equal(p.fadeOutSec, 1.2);
  assert.equal(p.meter, null);
  // corte fuera de la canción → se limita
  assert.deepEqual(buildEditPlan(r, { duration: 10, mode1: true, cutTime: 99 }).segments, [{ start: 0, end: 10 }]);
  // sin ningún modo: la canción entera, sin fade
  const none = buildEditPlan(r, { duration: 40, mode1: false, cutTime: 20.5, fadeSec: 3, mode2: false });
  assert.deepEqual(none.segments, [{ start: 0, end: 40 }]);
  assert.equal(none.fadeOutSec, 0);
});

test('buildEditPlan: modo 2 usa planMeterChange con pre-roll = máx(CUT_PREROLL_SEC, crossfade/2 + margen)', () => {
  const r = song();
  const dur = r.duration + 0.25;   // la canción decodificada manda sobre result.duration
  for (const xfMs of [5, 10, 16, 40]) {
    const xf = xfMs / 1000;
    const p = buildEditPlan(r, { duration: dur, mode1: false, mode2: true, targetNum: 7, targetDen: 8, crossfadeSec: xf });
    const preroll = Math.max(CUT_PREROLL_SEC, xf / 2 + SPLICE_GUARD_SEC);
    assert.equal(p.preroll, preroll);
    // el fade-in de B (xf/2 después del empalme) acaba al menos SPLICE_GUARD_SEC antes del "1"
    assert.ok(preroll - xf / 2 >= SPLICE_GUARD_SEC - 1e-12);
    assert.equal(p.crossfadeSec, xf);
    assert.equal(p.fadeOutSec, 0);
    const ref = planMeterChange({ ...r, duration: dur }, { targetNum: 7, targetDen: 8, preroll });
    assert.deepEqual(p.segments, ref.segments);
    assert.equal(p.meter.barsChanged, 16);
    close(p.outputDuration, dur - 16 * 0.25, 1e-9);
    assert.equal(p.segments[p.segments.length - 1].end, dur);
    for (const rm of p.meter.removed) close(rm.end % 2, (0.3 + 1 - preroll) % 2, 1e-9);   // p antes del "1"
  }
});

test('buildEditPlan: los dos modos juntos → el cambio de compás termina en el corte', () => {
  const r = song();
  const cut = r.beats[r.downbeats[10]] - CUT_PREROLL_SEC;
  const p = buildEditPlan(r, {
    duration: r.duration, mode1: true, cutTime: cut, fadeSec: 2, mode2: true, targetNum: 5, targetDen: 4,
  });
  assert.equal(p.meter.barsChanged, 10);
  assert.equal(p.fadeOutSec, 2);
  assert.equal(p.segments[p.segments.length - 1].end, cut);
  close(p.outputDuration, cut + 10 * 0.5, 1e-9);
  const ref = planMeterChange(r, { targetNum: 5, targetDen: 4, limitTime: cut, preroll: p.preroll });
  assert.deepEqual(p.segments, ref.segments);
});

test('buildEditPlan: pasa el imán a planMeterChange', () => {
  const r = song();
  const calls = [];
  const p = buildEditPlan(r, {
    duration: r.duration, mode1: false, mode2: true, targetNum: 7, targetDen: 8, snap: (t) => { calls.push(t); return t; },
  });
  assert.equal(calls.length, p.meter.barsChanged);
});

test('exportBlocker y meterApplies', () => {
  const r = song();
  const base = { duration: r.duration, cutTime: 20 };
  const m1 = buildEditPlan(r, { ...base, mode1: true });
  assert.equal(exportBlocker(m1, { mode1: true, mode2: false }), null);
  assert.match(exportBlocker(m1, { mode1: false, mode2: false }), /Activa/);
  const ok = buildEditPlan(r, { ...base, mode1: false, mode2: true, targetNum: 7, targetDen: 8 });
  assert.equal(exportBlocker(ok, { mode1: false, mode2: true }), null);
  assert.equal(meterApplies(ok), true);
  const bad = buildEditPlan(r, { ...base, mode1: true, mode2: true, targetNum: 40, targetDen: 8 });
  assert.ok(bad.meter.error);
  assert.equal(meterApplies(bad), false);
  assert.match(exportBlocker(bad, { mode1: true, mode2: true }), /compás válido/);
  const same = buildEditPlan(r, { ...base, mode1: false, mode2: true, targetNum: 4, targetDen: 4 });
  assert.equal(meterApplies(same), false);
  assert.match(exportBlocker(same, { mode1: false, mode2: true }), /no cambia/);
  // con el modo 1 activo, un compás que no cambia nada no impide guardar el corte
  const same1 = buildEditPlan(r, { ...base, mode1: true, mode2: true, targetNum: 8, targetDen: 8 });
  assert.equal(exportBlocker(same1, { mode1: true, mode2: true }), null);
  assert.match(exportBlocker(null, { mode1: true, mode2: false }), /No queda audio/);
  assert.equal(meterApplies(null), false);
  // audio sin beats: ningún compás serviría, el aviso lo dice (no "elige un compás válido")
  const beatless = { duration: 30, musicStart: 0, musicEnd: 30, bpm: 0, beats: [], positions: [], downbeats: [], beatsPerBar: 4 };
  const nb = buildEditPlan(beatless, { duration: 30, mode1: true, cutTime: 29, mode2: true, targetNum: 7, targetDen: 8 });
  assert.match(exportBlocker(nb, { mode1: true, mode2: true }), /Sin beats ni compases/);
});

test('previewStartTime: cabezal → salida; en audio quitado, el siguiente punto conservado; al final, los últimos 8 s', () => {
  const r = song();
  const p = buildEditPlan(r, { duration: r.duration, mode1: false, mode2: true, targetNum: 7, targetDen: 8 });
  const segs = p.segments;
  const out = p.outputDuration;
  close(previewStartTime(segs, 0, out), 0);
  close(previewStartTime(segs, 4.1, out), sourceToOutputTime(segs, 4.1));
  const rm = p.meter.removed[3];
  const inside = (rm.start + rm.end) / 2;
  assert.equal(sourceToOutputTime(segs, inside), null);
  close(previewStartTime(segs, inside, out), sourceToOutputTime(segs, rm.end));
  close(previewStartTime(segs, r.duration, out), out - 8);
  close(previewStartTime(segs, r.duration + 5, out), out - 8);
  close(previewStartTime(segs, NaN, out, 3), out - 3);
  assert.equal(previewStartTime([], 3, 0), 0);
  // modo 1: el cabezal después del corte → el final
  const m1 = buildEditPlan(r, { duration: r.duration, mode1: true, cutTime: 10 });
  close(previewStartTime(m1.segments, 12, m1.outputDuration), 2);
  // outputToSourceFn deshace el mapeo
  const f = outputToSourceFn(segs);
  close(f(previewStartTime(segs, 4.1, out)), 4.1);
});

test('mapBeatsToOutput: clics en la salida (7/8 cada 1,75 s; 5/4 repite el 4)', () => {
  const r = song();
  const down = new Set(r.downbeats);
  const p78 = buildEditPlan(r, { duration: r.duration, mode1: false, mode2: true, targetNum: 7, targetDen: 8 });
  const m = mapBeatsToOutput(p78.segments, r.beats, down);
  assert.equal(m.beats.length, r.beats.length);   // en 7/8 no se quita ningún beat entero
  for (let i = 1; i < m.beats.length; i++) assert.ok(m.beats[i] > m.beats[i - 1]);
  const acc = [...m.accents].sort((a, b) => a - b).map((i) => m.beats[i]);
  assert.equal(acc.length, r.downbeats.length);
  for (let j = 1; j < 17; j++) close(acc[j] - acc[j - 1], 1.75, 1e-9);

  const p54 = buildEditPlan(r, { duration: r.duration, mode1: false, mode2: true, targetNum: 5, targetDen: 4 });
  const m54 = mapBeatsToOutput(p54.segments, r.beats, down);
  assert.equal(m54.beats.length, r.beats.length + 16);   // el tiempo 4 suena dos veces en 16 compases
  const acc54 = [...m54.accents].sort((a, b) => a - b).map((i) => m54.beats[i]);
  for (let j = 1; j < 17; j++) close(acc54[j] - acc54[j - 1], 2.5, 1e-9);

  const p34 = buildEditPlan(r, { duration: r.duration, mode1: false, mode2: true, targetNum: 3, targetDen: 4 });
  assert.equal(mapBeatsToOutput(p34.segments, r.beats, down).beats.length, r.beats.length - 16);
  assert.deepEqual(mapBeatsToOutput([], r.beats, down), { beats: [], accents: new Set() });
  assert.equal(mapBeatsToOutput(p34.segments, [], down).beats.length, 0);
});

function clicks(sr, seconds, times, amp = 0.8) {
  const x = new Float32Array(Math.round(seconds * sr));
  let s = 7;
  for (let i = 0; i < x.length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    x[i] = ((s / 2147483648) * 2 - 1) * 0.002;   // ruido de fondo
  }
  for (const t of times) {
    const i0 = Math.round(t * sr);
    for (let i = 0; i < 0.03 * sr && i0 + i < x.length; i++) x[i0 + i] += amp * Math.exp(-i / (0.004 * sr)) * Math.sin(i * 0.9);
  }
  return x;
}

test('makeTransientSnap: lleva el límite al ataque cercano (±25 ms) igual que refineToTransients', () => {
  const sr = 44100;
  const hits = [1.012, 2.4, 3.0 - 0.018];
  const L = clicks(sr, 4, hits);
  const R = L.map((v) => v * 0.5);
  const snap = makeTransientSnap([L, R], sr);
  const mono = L.map((v, i) => (v + R[i]) / 2);
  for (const t of [1.0, 2.41, 3.0]) {
    const s = snap(t);
    const ref = refineToTransients(mono, sr, [t], { window: 0.025 })[0];
    close(s, ref, 1e-6, `${t}: ${s} vs ${ref}`);
  }
  assert.ok(Math.abs(snap(1.0) - 1.012) < 0.003, `${snap(1.0)}`);
  assert.ok(Math.abs(snap(3.0) - 2.982) < 0.003, `${snap(3.0)}`);
  // sin ataques cerca: no se mueve
  assert.equal(snap(1.7), 1.7);
  // ataque a más de 25 ms: no se mueve
  assert.equal(snap(2.44), 2.44);
  assert.ok(Number.isNaN(snap(NaN)));
  assert.equal(snap(-1), -1);
  assert.equal(makeTransientSnap([], sr), null);
  assert.equal(makeTransientSnap([L], 0), null);
});

test('tapTempo: mediana de los últimos 8 intervalos, se reinicia tras 2 s', () => {
  let st = { taps: [] };
  st = tapTempo(st.taps, 1000);
  assert.equal(st.bpm, null);
  for (const t of [1500, 2000, 2500]) st = tapTempo(st.taps, t);
  assert.equal(st.bpm, 120);
  // un toque desviado no cambia la mediana
  st = tapTempo(st.taps, 3100);
  st = tapTempo(st.taps, 3500);
  assert.equal(st.bpm, 120);
  // solo cuentan los últimos 9 toques (8 intervalos)
  let s2 = { taps: [] };
  for (let i = 0; i < 6; i++) s2 = tapTempo(s2.taps, 10000 + i * 400);           // 150 BPM
  for (let i = 1; i <= 9; i++) s2 = tapTempo(s2.taps, 12000 + i * 600);          // 100 BPM
  assert.equal(s2.taps.length, 9);
  assert.equal(s2.bpm, 100);
  // pausa de más de 2 s: empieza de nuevo
  const s3 = tapTempo(s2.taps, 12000 + 9 * 600 + 2500);
  assert.equal(s3.taps.length, 1);
  assert.equal(s3.bpm, null);
  // tiempos que no avanzan también reinician; entradas raras no rompen
  assert.equal(tapTempo([5000], 4000).taps.length, 1);
  assert.deepEqual(tapTempo(null, 100), { taps: [100], bpm: null });
  assert.equal(tapTempo([0, 700], NaN).bpm, 85.7);
  // 3/2 de 80 = 120: el tap tempo da 80
  let s4 = { taps: [] };
  for (let i = 0; i < 5; i++) s4 = tapTempo(s4.taps, 50000 + i * 750);
  assert.equal(s4.bpm, 80);
});

test('parseBpm, parseIntStrict y targetMeter', () => {
  assert.equal(parseBpm('97,5'), 97.5);
  assert.equal(parseBpm(' 120 '), 120);
  assert.equal(parseBpm(96.04), 96);
  assert.equal(parseBpm('30'), 30);
  assert.equal(parseBpm('300'), 300);
  for (const v of ['29.9', '301', 'abc', '', null, undefined, NaN]) assert.equal(parseBpm(v), null, String(v));
  assert.equal(parseIntStrict('7'), 7);
  assert.ok(Number.isNaN(parseIntStrict('7.5')));
  assert.ok(Number.isNaN(parseIntStrict('')));
  assert.ok(Number.isNaN(parseIntStrict('x')));
  // la cantidad elegida + el compás detectado → compás nuevo
  assert.deepEqual(targetMeter({ amount: 'eighth' }, 4), { amount: 'eighth', num: 7, den: 8 });
  assert.deepEqual(targetMeter({ amount: 'beat', num: '15', den: '16' }, 4), { amount: 'beat', num: 3, den: 4 });
  assert.deepEqual(targetMeter({ amount: 'extend' }, 4), { amount: 'extend', num: 5, den: 4 });
  assert.deepEqual(targetMeter({ amount: 'sixteenth' }, 4), { amount: 'sixteenth', num: 15, den: 16 });
  assert.deepEqual(targetMeter({ amount: 'two-beats' }, 4), { amount: 'two-beats', num: 2, den: 4 });
  assert.deepEqual(targetMeter({ amount: 'eighth' }, 3), { amount: 'eighth', num: 5, den: 8 });
  assert.deepEqual(targetMeter({ amount: 'beat' }, 3), { amount: 'beat', num: 2, den: 4 });
  assert.deepEqual(targetMeter({ amount: 'other', num: '15', den: '16' }, 3), { amount: 'other', num: 15, den: 16 });
  const bad = targetMeter({ amount: 'other', num: '', den: '8' }, 4);
  assert.ok(Number.isNaN(bad.num));
  assert.equal(bad.den, 8);
  // por defecto: ½ tiempo sobre 4/4
  assert.deepEqual(targetMeter(), { amount: 'eighth', num: 7, den: 8 });
  assert.deepEqual(targetMeter({}, 4), { amount: 'eighth', num: 7, den: 8 });
  // una cantidad que no existe para este compás (2 tiempos en 2/4) o desconocida → la de por defecto
  assert.deepEqual(targetMeter({ amount: 'two-beats' }, 2), { amount: 'eighth', num: 3, den: 8 });
  assert.deepEqual(targetMeter({ amount: '7/8' }, 3), { amount: 'eighth', num: 5, den: 8 });
  // compás desconocido: se calcula como si fuera 4/4
  assert.deepEqual(targetMeter({ amount: 'beat' }, NaN), { amount: 'beat', num: 3, den: 4 });
});

test('textos del panel', () => {
  assert.equal(meterLabel(7, 8), '7/8');
  assert.equal(meterLabel(NaN, 8), '–');
  assert.equal(durationChange(232.9, 205.2), '3:52 → 3:25');
  assert.equal(barsChangedText(1), 'Se cambia 1 compás');
  assert.equal(barsChangedText(28), 'Se cambian 28 compases');
  assert.equal(barsChangedText(0), 'No cambia ningún compás');
  assert.equal(meterChangeLabel(4, 7, 8), 'Original: 4/4 → Nuevo: 7/8');
  assert.equal(meterChangeLabel(3, 15, 16), 'Original: 3/4 → Nuevo: 15/16');
  assert.equal(meterChangeLabel(4, NaN, 8), 'Original: 4/4 → Nuevo: ?');
});

test('meterAmountChips: cuánto se quita de cada compás → compás nuevo, según el compás detectado', () => {
  const res = (m) => Object.fromEntries(meterAmountChips(m).map((c) => [c.id, c.result]));
  assert.deepEqual(res(4), { eighth: '7/8', beat: '3/4', 'two-beats': '2/4', sixteenth: '15/16', extend: '5/4', other: '' });
  assert.deepEqual(res(3), { eighth: '5/8', beat: '2/4', 'two-beats': '1/4', sixteenth: '11/16', extend: '4/4', other: '' });
  // 2/4: «2 tiempos» dejaría el compás vacío → no aparece
  assert.deepEqual(res(2), { eighth: '3/8', beat: '1/4', sixteenth: '7/16', extend: '3/4', other: '' });
  assert.deepEqual(res(6), { eighth: '11/8', beat: '5/4', 'two-beats': '4/4', sixteenth: '23/16', extend: '7/4', other: '' });
  // numeradores fuera de 1..32 no se ofrecen (¼ tiempo en 9/4 daría 35/16)
  assert.equal(res(9).sixteenth, undefined);
  assert.equal(res(9).eighth, '17/8');
  // compás desconocido → como 4/4
  assert.deepEqual(res(undefined), res(4));
  // textos de los botones y coherencia con describeMeterChange (lo que dice el panel)
  const c4 = meterAmountChips(4);
  assert.deepEqual(c4.map((c) => c.name), [
    '½ tiempo (corchea)', '1 tiempo', '2 tiempos', '¼ tiempo (semicorchea)', 'Alargar: repetir el último tiempo', 'Otro compás…',
  ]);
  const text = (m, id) => {
    const c = meterAmountChips(m).find((x) => x.id === id);
    return describeMeterChange(m, c.num, c.den).text;
  };
  for (const m of [3, 4, 5, 7]) {
    assert.equal(text(m, 'eighth'), 'Se quita la última corchea de cada compás.');
    assert.equal(text(m, 'beat'), 'Se quita el último tiempo de cada compás.');
    assert.equal(text(m, 'two-beats'), 'Se quitan los últimos 2 tiempos de cada compás.');
    assert.equal(text(m, 'sixteenth'), 'Se quita la última semicorchea de cada compás.');
    assert.equal(text(m, 'extend'), 'Se repite el último tiempo de cada compás.');
  }
  // el plan de 4/4 con la opción por defecto quita 1/8 de compás (0,25 s a 120 BPM) en cada compás
  const r = song();
  const tm = targetMeter({}, r.beatsPerBar);
  const p = buildEditPlan(r, { duration: r.duration, mode1: false, mode2: true, targetNum: tm.num, targetDen: tm.den });
  assert.equal(p.meter.barsChanged, 16);
  for (const rm of p.meter.removed) close(rm.end - rm.start, 0.25, 1e-9);
});

test('readyMessage: el aviso «Listo» dice el cambio de compás por defecto', () => {
  const d = describeMeterChange(4, 7, 8);
  assert.equal(readyMessage({ bpm: 120, beatsPerBar: 4, meter: { num: 7, den: 8, text: d.text } }),
    'Listo: ≈ 120 BPM · 4/4 → 7/8 · se quita la última corchea de cada compás');
  const e = describeMeterChange(3, 4, 4);
  assert.equal(readyMessage({ bpm: 96.5, beatsPerBar: 3, meter: { num: 4, den: 4, text: e.text } }),
    'Listo: ≈ 96,5 BPM · 3/4 → 4/4 · se repite el último tiempo de cada compás');
  // sin el recorte de cada compás (o si no se puede aplicar): solo el compás detectado y lo demás
  assert.equal(readyMessage({ bpm: 120, beatsPerBar: 4, extra: ['se quita 1 compás del final'] }),
    'Listo: ≈ 120 BPM · 4/4 · se quita 1 compás del final');
  assert.equal(readyMessage({ bpm: 120, beatsPerBar: 4, meter: { num: 7, den: 8, text: d.text }, extra: ['se quitan 2 compases del final', ''] }),
    'Listo: ≈ 120 BPM · 4/4 → 7/8 · se quita la última corchea de cada compás · se quitan 2 compases del final');
  assert.equal(readyMessage({ bpm: 0, beatsPerBar: 4, hasBeats: false, meter: { num: 7, den: 8, text: d.text } }),
    'Listo: no se detectaron beats');
  assert.equal(readyMessage({ hasBeats: false, extra: ['coloca el corte a mano'] }), 'Listo: no se detectaron beats · coloca el corte a mano');
  assert.equal(readyMessage({ bpm: 120, beatsPerBar: 4, meter: { num: NaN, den: 8, text: '' } }), 'Listo: ≈ 120 BPM · 4/4');
});
