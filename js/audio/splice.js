// Concatena rangos de la fuente con crossfades de igual potencia en cada empalme
// y un fade-out final. Lógica pura (sin DOM ni WebAudio).

const ANTICLICK_SEC = 0.005;  // mismo mínimo que edit.js
const EXP_RANGE_DB = 60;      // rango del fade 'exp' (lineal en dB)
const EXP_FLOOR = 10 ** (-EXP_RANGE_DB / 20);
const HALF_PI = Math.PI / 2;

// x ∈ [0,1] = avance del fade; g(0)=1, g(1)=0, monótona.
function fadeGain(x, curve) {
  if (!(x > 0)) return 1;
  if (x >= 1) return 0;
  switch (curve) {
    case 'linear':
      return 1 - x;
    case 'exp':
      // Recta en dB hasta -60 dB, desplazada para llegar exactamente a 0.
      return (10 ** (-EXP_RANGE_DB * x / 20) - EXP_FLOOR) / (1 - EXP_FLOOR);
    default: // 'smooth': coseno elevado
      return 0.5 * (1 + Math.cos(Math.PI * x));
  }
}

function toFloatArray(ch) {
  return ArrayBuffer.isView(ch) ? ch : Float32Array.from(ch || []);
}

export function renderSegments(channels, sampleRate, segments,
                               { crossfadeSec = 0.010, fadeOutSec = 0, curve = 'smooth' } = {}) {
  const srcs = Array.from(channels || [], toFloatArray);
  const nCh = srcs.length;
  if (!nCh) return [];
  const sr = Number(sampleRate);
  if (!(sr > 0) || !Number.isFinite(sr)) return srcs.map(() => new Float32Array(0));

  // Rangos en muestras (índice = round(t · sr)); lo que cae fuera de la fuente es silencio.
  const segs = [];
  let total = 0;
  for (const s of segments || []) {
    if (!s) continue;
    const s0 = Math.round(s.start * sr);
    const s1 = Math.round(s.end * sr);
    if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) continue;
    segs.push({ s0, s1, len: s1 - s0, out: total, spliceIn: false, spliceOut: false });
    total += s1 - s0;
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    if (Math.abs(segs[i].s1 - segs[i + 1].s0) > 1) {
      segs[i].spliceOut = true;
      segs[i + 1].spliceIn = true;
    }
  }

  // Copia directa (bit a bit) de cada rango.
  const out = srcs.map((src) => {
    const dst = new Float32Array(total);
    const n = src.length;
    for (const g of segs) {
      const from = Math.max(g.s0, 0);
      const to = Math.min(g.s1, n);
      if (to > from) dst.set(src.subarray(from, to), g.out + (from - g.s0));
    }
    return dst;
  });

  // Crossfades de igual potencia centrados en cada empalme: A sigue sonando después de su fin,
  // B empieza antes de su inicio. Se acortan en los bordes de la fuente y en segmentos cortos
  // (un segmento con empalmes en ambos lados cede como mucho la mitad a cada uno).
  const xf = Math.max(0, Math.round((Number(crossfadeSec) || 0) * sr));
  if (xf >= 2 && segs.length > 1) {
    let srcLen = Infinity;
    for (const src of srcs) srcLen = Math.min(srcLen, src.length);
    const gA = new Float64Array(xf);
    const gB = new Float64Array(xf);
    let gLen = 0;
    for (let i = 0; i + 1 < segs.length; i++) {
      const A = segs[i];
      const B = segs[i + 1];
      if (!A.spliceOut) continue;
      let h = xf >> 1;
      let r = xf - h;
      h = Math.max(0, Math.min(h, A.spliceIn ? Math.floor(A.len / 2) : A.len, B.s0));
      r = Math.max(0, Math.min(r, B.spliceOut ? Math.floor(B.len / 2) : B.len, srcLen - A.s1));
      const L = h + r;
      if (L < 2) continue;
      if (L !== gLen) {
        for (let j = 0; j < L; j++) {
          const x = (j + 0.5) / L;
          gA[j] = Math.cos(x * HALF_PI);
          gB[j] = Math.sin(x * HALF_PI);
        }
        gLen = L;
      }
      const o0 = B.out - h;
      const ia0 = A.s1 - h;
      const ib0 = B.s0 - h;
      for (let c = 0; c < nCh; c++) {
        const src = srcs[c];
        const dst = out[c];
        const n = src.length;
        for (let j = 0; j < L; j++) {
          const ia = ia0 + j;
          const ib = ib0 + j;
          const va = ia >= 0 && ia < n ? src[ia] : 0;
          const vb = ib >= 0 && ib < n ? src[ib] : 0;
          dst[o0 + j] = va * gA[j] + vb * gB[j];
        }
      }
    }
  }

  // Fade-out final (siempre al menos el anti-clic); la última muestra queda en 0.
  const F = Math.min(total, Math.round(Math.max(Number(fadeOutSec) || 0, ANTICLICK_SEC) * sr));
  if (F > 0) {
    const start = total - F;
    for (let i = 0; i < F; i++) {
      const g = fadeGain((i + 1) / F, curve);
      for (let c = 0; c < nCh; c++) out[c][start + i] *= g;
    }
  }
  return out;
}
