// PRNG determinista (mulberry32) con utilidades. Mismo seed => misma secuencia en cualquier motor JS.

export function hashSeed(value) {
  // FNV-1a de 32 bits sobre la representación en texto
  const s = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1) {
    this.state = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
    this._spare = null;
  }

  /** Uniforme en [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); } // entero en [a, b]
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  /** Normal N(mean, sd) (Box-Muller). */
  gauss(mean = 0, sd = 1) {
    if (this._spare !== null) {
      const v = this._spare;
      this._spare = null;
      return mean + sd * v;
    }
    let u = 0;
    let v = 0;
    while (u <= 1e-12) u = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }

  /** Normal truncada a ±k desviaciones. */
  gaussClipped(mean, sd, k = 3) {
    const g = this.gauss(0, 1);
    return mean + sd * Math.max(-k, Math.min(k, g));
  }

  /** Sub-generador independiente (para no alterar la secuencia principal al añadir pistas). */
  fork(label) {
    return new Rng((hashSeed(label) ^ Math.imul(this.state, 0x9e3779b1)) >>> 0);
  }
}
