// FFT radix-2 (compleja y real) con tablas de giro y ventanas cacheadas. Sin dependencias ni DOM.

const complexCache = new Map();
const realCache = new Map();
const windowCache = new Map();

function isPow2(n) {
  return n >= 2 && (n & (n - 1)) === 0;
}

/** FFT compleja in-place de tamaño n (potencia de 2). */
export class ComplexFFT {
  constructor(n) {
    if (!isPow2(n)) throw new Error(`Tamaño de FFT no potencia de 2: ${n}`);
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    // tablas de giro para el tamaño completo: w_k = exp(-2πik/n), k < n/2
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** Transforma (re, im) in-place. inverse=true calcula la inversa SIN normalizar (dividir por n aparte). */
  transform(re, im, inverse = false) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    this._butterflies(re, im, inverse);
  }

  /** Etapas de mariposas sobre datos ya en orden de bits invertidos. */
  _butterflies(re, im, inverse) {
    const n = this.n;
    // etapa de tamaño 2 sin multiplicaciones
    for (let a = 0; a < n; a += 2) {
      const b = a + 1;
      const xr = re[b];
      const xi = im[b];
      re[b] = re[a] - xr;
      im[b] = im[a] - xi;
      re[a] += xr;
      im[a] += xi;
    }
    if (n < 4) return;
    // etapa de tamaño 4: giros 1 y -i (o +i en la inversa)
    const s4 = inverse ? -1 : 1;
    for (let a = 0; a < n; a += 4) {
      let xr = re[a + 2];
      let xi = im[a + 2];
      re[a + 2] = re[a] - xr;
      im[a + 2] = im[a] - xi;
      re[a] += xr;
      im[a] += xi;
      // w = -i (directa): (xr + i xi)(-i) = xi - i xr
      const br = re[a + 3];
      const bi = im[a + 3];
      xr = s4 * bi;
      xi = -s4 * br;
      re[a + 3] = re[a + 1] - xr;
      im[a + 3] = im[a + 1] - xi;
      re[a + 1] += xr;
      im[a + 1] += xi;
    }
    const cosT = this.cos;
    const sinT = this.sin;
    const sgn = inverse ? -1 : 1;
    for (let size = 8; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step];
        const wi = sgn * sinT[k * step];
        for (let a = k; a < n; a += size) {
          const b = a + half;
          const rb = re[b];
          const ib = im[b];
          const xr = rb * wr - ib * wi;
          const xi = rb * wi + ib * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export function getComplexFFT(n) {
  let f = complexCache.get(n);
  if (!f) {
    f = new ComplexFFT(n);
    complexCache.set(n, f);
  }
  return f;
}

/**
 * FFT real de tamaño n (potencia de 2 >= 4) mediante una FFT compleja de n/2.
 * forward(x) llena this.re / this.im (n/2+1 bins, reutilizados entre llamadas: copiar si hay que guardarlos).
 */
export class RealFFT {
  constructor(n) {
    if (!isPow2(n) || n < 4) throw new Error(`Tamaño de FFT real inválido: ${n}`);
    this.n = n;
    this.half = n / 2;
    this.cfft = getComplexFFT(n / 2);
    this.zr = new Float64Array(n / 2);
    this.zi = new Float64Array(n / 2);
    this.re = new Float64Array(n / 2 + 1);
    this.im = new Float64Array(n / 2 + 1);
    this.twr = new Float64Array(n / 2);
    this.twi = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.twr[k] = Math.cos((2 * Math.PI * k) / n);
      this.twi[k] = -Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** x: array de longitud n (se lee, no se modifica). Resultado en this.re / this.im (bins 0..n/2). */
  forward(x) {
    const h = this.half;
    const zr = this.zr;
    const zi = this.zi;
    const rev = this.cfft.rev;
    for (let k = 0; k < h; k++) {
      const j = rev[k];
      zr[j] = x[2 * k];
      zi[j] = x[2 * k + 1];
    }
    this.cfft._butterflies(zr, zi, false);
    const re = this.re;
    const im = this.im;
    const twr = this.twr;
    const twi = this.twi;
    re[0] = zr[0] + zi[0];
    im[0] = 0;
    re[h] = zr[0] - zi[0];
    im[h] = 0;
    for (let k = 1; k < h; k++) {
      const ar = zr[k];
      const ai = zi[k];
      const br = zr[h - k];
      const bi = -zi[h - k];
      // E = (Z[k] + conj Z[h-k]) / 2 ; O = (Z[k] - conj Z[h-k]) / (2i)
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi);
      const oi = -0.5 * (ar - br);
      const wr = twr[k];
      const wi = twi[k];
      re[k] = er + wr * or - wi * oi;
      im[k] = ei + wr * oi + wi * or;
    }
    return this;
  }

  /** Magnitudes |X[k]| (k = 0..n/2) en `out` (Float32Array o Float64Array de n/2+1). */
  magnitude(x, out) {
    this.forward(x);
    const re = this.re;
    const im = this.im;
    for (let k = 0; k <= this.half; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return out;
  }
}

export function getRealFFT(n) {
  let f = realCache.get(n);
  if (!f) {
    f = new RealFFT(n);
    realCache.set(n, f);
  }
  return f;
}

/** Ventana de Hann periódica de longitud n (cacheada; no modificar). */
export function hannWindow(n) {
  let w = windowCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windowCache.set(n, w);
  }
  return w;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Autocorrelación (no normalizada, sesgada) de x para retardos 0..maxLag vía FFT.
 * @returns {Float64Array} r[lag] = sum_i x[i] x[i+lag]
 */
export function autocorrelation(x, maxLag) {
  const n = x.length;
  const size = nextPow2(2 * n);
  const f = getComplexFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i];
  f.transform(re, im, false);
  for (let k = 0; k < size; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  f.transform(re, im, true);
  const L = Math.min(maxLag, n - 1);
  const out = new Float64Array(L + 1);
  for (let l = 0; l <= L; l++) out[l] = re[l] / size;
  return out;
}
