// Concatena rangos de la fuente con crossfades en cada empalme y un fade-out final. Lógica pura (sin DOM ni WebAudio).
// Crossfade adaptado a la correlación de lo que se mezcla (por canal): igual potencia si A y B no se parecen,
// igual ganancia si están en fase. Además, cerca del máximo (> −1 dBFS) nunca crea un pico mayor que el de las dos
// señales que une: en un master a −0,3 dBFS el crossfade de igual potencia recortaba al exportar.

import { ANTICLICK_SEC, fadeOutGains } from './edit.js';

const HALF_PI = Math.PI / 2;
// Mezclas de las ganancias adaptadas con las de igual ganancia (cos²/sin², nunca superan el pico de A o B)
const GUARD_BLENDS = [0, 0.25, 0.5, 0.75, 1];
// Por debajo de este nivel un pico nuevo en el empalme no puede recortar: no se toca la curva (−1 dBFS)
export const SPLICE_CEILING = 10 ** (-1 / 20);

// y[j] = a[j]·gA[j] + b[j]·gB[j] para j < L. c/s: cos/sin de la ventana de igual potencia.
// ρ = correlación de a y b en la ventana (limitada a [0, 1]); gA = c·k, gB = s·k con k = 1/√(1 + 2ρcs):
// potencia constante para señales con esa correlación (ρ = 0 → igual potencia, ρ = 1 → gA + gB = 1).
// Si la mezcla supera a la vez el pico de a y b y SPLICE_CEILING, se acerca a igual ganancia lo justo para no
// pasar de max(pico de a y b, SPLICE_CEILING).
export function mixCrossfade(a, b, L, c, s, y) {
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let peak = 0;
  for (let j = 0; j < L; j++) {
    const va = a[j];
    const vb = b[j];
    saa += va * va;
    sbb += vb * vb;
    sab += va * vb;
    const m = Math.max(Math.abs(va), Math.abs(vb));
    if (m > peak) peak = m;
  }
  const rho = saa > 0 && sbb > 0 ? Math.min(1, Math.max(0, sab / Math.sqrt(saa * sbb))) : 0;
  const limit = Math.max(peak, SPLICE_CEILING) * (1 + 1e-6);
  for (const t of GUARD_BLENDS) {
    let over = false;
    for (let j = 0; j < L; j++) {
      const cj = c[j];
      const sj = s[j];
      const k = (1 - t) / Math.sqrt(1 + 2 * rho * cj * sj);
      const v = a[j] * cj * (k + t * cj) + b[j] * sj * (k + t * sj);
      y[j] = v;
      if (Math.abs(v) > limit) over = true;
    }
    if (!over) break;
  }
  return y;
}

function toFloatArray(ch) {
  return ArrayBuffer.isView(ch) ? ch : Float32Array.from(ch || []);
}

function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Muestras de la salida de renderSegments (Σ round(end·sr) − round(start·sr) de los segmentos válidos)
export function renderedLength(segments, sampleRate) {
  const sr = Number(sampleRate);
  if (!(sr > 0) || !Number.isFinite(sr)) return 0;
  let total = 0;
  for (const s of segments || []) {
    if (!s) continue;
    const s0 = Math.round(s.start * sr);
    const s1 = Math.round(s.end * sr);
    if (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) total += s1 - s0;
  }
  return total;
}

// Fuente por tramos de la salida (para exportar sin renderizarla entera): read(s0, s1) en muestras de la salida
// devuelve exactamente esas muestras del render completo.
export function segmentSource(channels, sampleRate, segments, opts = {}) {
  const chans = Array.from(channels || []);
  const sr = Number(sampleRate);
  return {
    length: renderedLength(segments, sr),
    numberOfChannels: chans.length,
    read: (a, b) => renderSegments(chans, sr, segments, { ...opts, from: a / sr, to: b / sr }),
  };
}

// from / to (segundos de la SALIDA, opcionales): devuelve solo ese tramo de la salida, con exactamente las mismas
// muestras que tendría en el render completo (crossfades y fade-out dependen de la posición absoluta). Lo usa la
// vista previa para no renderizar toda la canción.
export function renderSegments(channels, sampleRate, segments,
                               { crossfadeSec = 0.010, fadeOutSec = 0, curve = 'smooth', from = 0, to = Infinity } = {}) {
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

  // Ventana de salida [w0, w1)
  const f = Number(from);
  const t = Number(to);
  const w0 = Number.isFinite(f) ? clampInt(Math.round(f * sr), 0, total) : 0;
  const w1 = Number.isFinite(t) ? clampInt(Math.round(t * sr), w0, total) : total;

  // Copia directa (bit a bit) de cada rango.
  const out = srcs.map((src) => {
    const dst = new Float32Array(w1 - w0);
    const n = src.length;
    for (const g of segs) {
      const o0 = Math.max(g.out, w0);
      const o1 = Math.min(g.out + g.len, w1);
      if (o1 <= o0) continue;
      const a0 = g.s0 + (o0 - g.out);
      const a = Math.max(a0, 0);
      const b = Math.min(g.s0 + (o1 - g.out), n);
      if (b > a) dst.set(src.subarray(a, b), o0 - w0 + (a - a0));
    }
    return dst;
  });

  // Crossfades centrados en cada empalme: A sigue sonando después de su fin, B empieza antes de su inicio.
  // Se acortan en los bordes de la fuente y en segmentos cortos (un segmento con empalmes en ambos lados cede
  // como mucho la mitad a cada uno). Las ganancias dependen de la ventana ENTERA (no de from/to).
  const xf = Math.max(0, Math.round((Number(crossfadeSec) || 0) * sr));
  if (xf >= 2 && segs.length > 1) {
    let srcLen = Infinity;
    for (const src of srcs) srcLen = Math.min(srcLen, src.length);
    const gA = new Float64Array(xf);
    const gB = new Float64Array(xf);
    const va = new Float64Array(xf);
    const vb = new Float64Array(xf);
    const mix = new Float64Array(xf);
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
      const o0 = B.out - h;
      const j0 = Math.max(0, w0 - o0);
      const j1 = Math.min(L, w1 - o0);
      if (j1 <= j0) continue;   // fuera de la ventana
      if (L !== gLen) {
        for (let j = 0; j < L; j++) {
          const x = (j + 0.5) / L;
          gA[j] = Math.cos(x * HALF_PI);
          gB[j] = Math.sin(x * HALF_PI);
        }
        gLen = L;
      }
      const ia0 = A.s1 - h;
      const ib0 = B.s0 - h;
      for (let c = 0; c < nCh; c++) {
        const src = srcs[c];
        const dst = out[c];
        const n = src.length;
        for (let j = 0; j < L; j++) {
          const ia = ia0 + j;
          const ib = ib0 + j;
          va[j] = ia >= 0 && ia < n ? src[ia] : 0;
          vb[j] = ib >= 0 && ib < n ? src[ib] : 0;
        }
        mixCrossfade(va, vb, L, gA, gB, mix);
        for (let j = j0; j < j1; j++) dst[o0 + j - w0] = mix[j];
      }
    }
  }

  // Fade-out final (siempre al menos el anti-clic); la última muestra queda en 0.
  // Mismas ganancias que renderEdit (edit.js): el modo 1 suena igual por las dos vías.
  const F = Math.min(total, Math.round(Math.max(Number(fadeOutSec) || 0, ANTICLICK_SEC) * sr));
  if (F > 0) {
    const start = total - F;
    const a = Math.max(start, w0);
    if (w1 > a) {
      const gains = fadeOutGains(F, curve, a - start, w1 - start);
      const off = a - w0;
      for (let c = 0; c < nCh; c++) {
        const dst = out[c];
        for (let i = 0; i < gains.length; i++) dst[off + i] *= gains[i];
      }
    }
  }
  return out;
}
