// Corte + fade-out del final. Lógica pura (sin DOM ni WebAudio): corre igual en Node y en el navegador.

export const CUT_PREROLL_SEC = 0.004;   // el llamador corta este tanto antes del beat (renderEdit usa cutTime tal cual)
export const ANTICLICK_SEC = 0.005;     // fade mínimo que siempre se aplica en el corte
export const FADE_CURVES = ['linear', 'smooth', 'exp'];   // UI: Lineal / Suave / Exponencial

const EXP_RANGE_DB = 60;                // 'exp' es una recta en dB hasta -60 dB…
const EXP_FLOOR = 10 ** (-EXP_RANGE_DB / 20);   // …desplazada para terminar exactamente en 0

// x ∈ [0,1] = avance del fade. g(0)=1, g(1)=0, monótona no creciente.
export function fadeGain(x, curve) {
  if (!(x > 0)) return 1;   // también NaN
  if (x >= 1) return 0;
  switch (curve) {
    case 'linear':
      return 1 - x;
    case 'exp':
      return (10 ** (-EXP_RANGE_DB * x / 20) - EXP_FLOOR) / (1 - EXP_FLOOR);
    default:   // 'smooth': coseno elevado (pendiente 0 en ambos extremos)
      return 0.5 * (1 + Math.cos(Math.PI * x));
  }
}

function toSeconds(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Devuelve canales NUEVOS con el tramo [startTime, cutTime) de la fuente y el fade-out aplicado sobre
// [cutTime - max(fadeSec, ANTICLICK_SEC), cutTime). Índices: muestra = round(t · sampleRate).
// La ganancia depende de la posición absoluta, así que el preview (startTime > 0) suena igual que la exportación.
export function renderEdit(channels, sampleRate, { cutTime, fadeSec = 0, curve = 'smooth', startTime = 0 } = {}) {
  const srcs = Array.from(channels || []);
  if (!srcs.length) return [];
  let srcLen = Infinity;
  for (const ch of srcs) srcLen = Math.min(srcLen, ch && ch.length >= 0 ? ch.length : 0);
  const sr = Number(sampleRate);
  if (!(sr > 0) || !Number.isFinite(sr)) return srcs.map(() => new Float32Array(0));

  const cutSample = Math.max(0, Math.min(srcLen, Math.round(toSeconds(cutTime, srcLen / sr) * sr)));
  const startSample = Math.max(0, Math.min(cutSample, Math.round(Math.max(0, toSeconds(startTime, 0)) * sr)));
  const len = cutSample - startSample;
  const fadeSecSafe = Math.max(0, toSeconds(fadeSec, 0));
  const fadeLen = Math.min(cutSample, Math.round(Math.max(fadeSecSafe, ANTICLICK_SEC) * sr));
  const fadeStart = cutSample - fadeLen;
  const crv = FADE_CURVES.includes(curve) ? curve : 'smooth';

  // Ganancias sólo para la parte del fade que cae dentro del tramo pedido
  const from = Math.max(fadeStart, startSample);
  const gains = new Float32Array(cutSample - from);
  for (let i = from; i < cutSample; i++) gains[i - from] = fadeGain((i - fadeStart + 1) / fadeLen, crv);

  return srcs.map((src) => {
    const out = new Float32Array(len);
    if (len === 0) return out;
    if (src instanceof Float32Array) out.set(src.subarray(startSample, cutSample));
    else for (let i = 0; i < len; i++) out[i] = Number(src[startSample + i]) || 0;
    const off = from - startSample;
    for (let i = 0; i < gains.length; i++) out[off + i] *= gains[i];
    return out;
  });
}
