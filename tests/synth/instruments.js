// Instrumentos sintéticos baratos pero realistas para el generador de pruebas.
// Todos devuelven Float32Array a `sr` Hz empezando en el instante del ataque (muestra 0 = onset).

const TWO_PI = 2 * Math.PI;

export function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Bus de mezcla: seco + envío a reverb. */
export function makeBus(numSamples) {
  return { dry: new Float32Array(numSamples), send: new Float32Array(numSamples) };
}

/** Suma `sig` al bus a partir de la muestra `start` con ganancia y nivel de envío. */
export function mixInto(bus, start, sig, gain = 1, send = 0) {
  const { dry, send: snd } = bus;
  let i0 = 0;
  if (start < 0) i0 = -start;
  const n = Math.min(sig.length, dry.length - start);
  if (send > 0) {
    const gs = gain * send;
    for (let i = i0; i < n; i++) {
      const v = sig[i];
      dry[start + i] += gain * v;
      snd[start + i] += gs * v;
    }
  } else {
    for (let i = i0; i < n; i++) dry[start + i] += gain * sig[i];
  }
}

// ---------------------------------------------------------------- batería

export function renderKick(sr, rng, { vel = 1, f0 = 150, f1 = 50, decay = 0.22, dur = 0.5, click = 0.35 } = {}) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const ks = Math.exp(-1 / (0.032 * sr));
  const ka = Math.exp(-1 / (decay * sr));
  const kc = Math.exp(-1 / (0.0025 * sr));
  const att = Math.max(1, Math.round(0.0015 * sr));
  let fd = f0 - f1;
  let ph = 0;
  let amp = 1;
  let ca = click;
  let lp = 0;
  const w = TWO_PI / sr;
  for (let i = 0; i < n; i++) {
    ph += w * (f1 + fd);
    fd *= ks;
    lp += 0.35 * (rng.next() * 2 - 1 - lp);
    const a = i < att ? i / att : 1;
    out[i] = vel * a * (amp * Math.sin(ph) + ca * lp);
    amp *= ka;
    ca *= kc;
  }
  return out;
}

export function renderSnare(sr, rng, { vel = 1, tone = 190, decay = 0.13, dur = 0.4, noiseMix = 0.75 } = {}) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const kn = Math.exp(-1 / (decay * sr));
  const kt = Math.exp(-1 / (0.07 * sr));
  const att = Math.max(1, Math.round(0.001 * sr));
  let an = 1;
  let at = 1;
  let hpPrev = 0;
  let hp = 0;
  let lp = 0;
  const w1 = (TWO_PI * tone) / sr;
  const w2 = (TWO_PI * tone * 1.72) / sr;
  // brillo algo menor con poca velocidad (golpes fantasma)
  const lpc = 0.35 + 0.45 * Math.min(1, vel);
  for (let i = 0; i < n; i++) {
    const x = rng.next() * 2 - 1;
    hp = 0.8 * (hp + x - hpPrev);
    hpPrev = x;
    lp += lpc * (hp - lp);
    const a = i < att ? i / att : 1;
    const toneS = Math.sin(w1 * i) * 0.6 + Math.sin(w2 * i) * 0.3;
    out[i] = vel * a * (noiseMix * an * lp * 1.4 + (1 - noiseMix) * at * toneS * 1.6);
    an *= kn;
    at *= kt;
  }
  return out;
}

export function renderHat(sr, rng, { vel = 1, open = false, dur } = {}) {
  const decay = open ? 0.28 : 0.035;
  const d = dur ?? (open ? 0.8 : 0.15);
  const n = Math.round(d * sr);
  const out = new Float32Array(n);
  const k = Math.exp(-1 / (decay * sr));
  let a = 1;
  let p1 = 0;
  let h1 = 0;
  let p2 = 0;
  let h2 = 0;
  for (let i = 0; i < n; i++) {
    const x = rng.next() * 2 - 1;
    h1 = 0.55 * (h1 + x - p1);
    p1 = x;
    h2 = 0.55 * (h2 + h1 - p2);
    p2 = h1;
    out[i] = vel * a * h2 * 1.6;
    a *= k;
  }
  return out;
}

const metalCache = new Map();
function metalTone(sr, ride, n) {
  // suma de parciales metálicos inarmónicos (cacheada: es lo caro del platillo)
  const key = `${sr}:${ride}`;
  let buf = metalCache.get(key);
  if (!buf || buf.length < n) {
    const partials = ride ? [620, 1373, 2217, 3150, 4712] : [431, 1117, 1893, 2741, 3911, 5210];
    buf = new Float32Array(Math.max(n, Math.round(sr * 8)));
    for (const f of partials) {
      const w = (TWO_PI * f) / sr;
      for (let i = 0; i < buf.length; i++) buf[i] += Math.sin(w * i);
    }
    metalCache.set(key, buf);
  }
  return buf;
}

export function renderCymbal(sr, rng, { vel = 1, decay = 1.3, dur = 3, ride = false } = {}) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const k = Math.exp(-1 / (decay * sr));
  const att = Math.max(1, Math.round(0.002 * sr));
  const metal = metalTone(sr, ride, n);
  const noiseAmt = ride ? 0.45 : 0.85;
  let a = 1;
  let p1 = 0;
  let h1 = 0;
  for (let i = 0; i < n; i++) {
    const x = rng.next() * 2 - 1;
    h1 = 0.7 * (h1 + x - p1);
    p1 = x;
    const e = i < att ? i / att : 1;
    out[i] = vel * e * a * (noiseAmt * h1 + (1 - noiseAmt) * 0.25 * metal[i]);
    a *= k;
  }
  return out;
}

export function renderTom(sr, rng, { vel = 1, freq = 110, decay = 0.25, dur = 0.6 } = {}) {
  return renderKick(sr, rng, { vel, f0: freq * 1.6, f1: freq, decay, dur, click: 0.5 });
}

// ---------------------------------------------------------------- aditivo

/**
 * Suma de parciales senoidales con decaimiento exponencial propio (osciladores recursivos).
 * partials: [{ f (Hz), a (amplitud), tau (s) }]. Aplica ataque lineal y liberación exponencial desde relAt (s).
 */
export function renderAdditive(sr, partials, { dur, attack = 0.003, relAt = Infinity, release = 0.08 } = {}) {
  const n = Math.max(1, Math.round(dur * sr));
  const out = new Float32Array(n);
  const nyq = sr / 2;
  for (const p of partials) {
    if (p.f >= nyq * 0.95 || p.a <= 0) continue;
    const w = (TWO_PI * p.f) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let x = Math.cos(p.phase || 0);
    let y = Math.sin(p.phase || 0);
    let env = p.a;
    const k = Math.exp(-1 / (p.tau * sr));
    // cortar cuando ya no se oye
    const nEff = Math.min(n, Math.ceil(p.tau * sr * Math.log(Math.max(1.0001, p.a / 1e-4))));
    for (let i = 0; i < nEff; i++) {
      out[i] += env * y;
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      env *= k;
    }
  }
  const na = Math.max(1, Math.round(attack * sr));
  for (let i = 0; i < Math.min(na, n); i++) out[i] *= i / na;
  if (relAt < dur) {
    const r0 = Math.max(0, Math.round(relAt * sr));
    const kr = Math.exp(-1 / (release * sr));
    let g = 1;
    for (let i = r0; i < n; i++) {
      g *= kr;
      out[i] *= g;
    }
  }
  return out;
}

/** Piano: parciales ligeramente inarmónicos, brillo según velocidad, golpe de martillo. */
export function renderPiano(sr, rng, { midi, vel = 0.7, hold = 1.0, maxDur = 3.5 } = {}) {
  const f0 = midiToHz(midi);
  const B = 0.00008 * Math.pow(2, (midi - 48) / 24); // inarmonicidad mayor en agudos
  const tau0 = Math.max(0.6, 4.5 * Math.pow(110 / f0, 0.45));
  const tilt = 1.7 - 0.9 * Math.min(1, vel);
  const partials = [];
  const nMax = Math.min(10, Math.floor((sr * 0.45) / f0));
  for (let k = 1; k <= nMax; k++) {
    const f = k * f0 * Math.sqrt(1 + B * k * k);
    const a = Math.pow(k, -tilt) * (k === 1 ? 1 : 0.8) * (1 + rng.uniform(-0.15, 0.15));
    const tau = tau0 / (1 + 0.45 * (k - 1));
    partials.push({ f, a, tau, phase: rng.uniform(0, TWO_PI) });
  }
  // cuerda doble levemente desafinada en el fundamental (batido)
  partials.push({ f: f0 * (1.0012 + rng.uniform(0, 0.001)), a: 0.35, tau: tau0 * 1.2, phase: rng.uniform(0, TWO_PI) });
  const dur = Math.min(maxDur, hold + 0.25);
  const out = renderAdditive(sr, partials, { dur, attack: 0.0015, relAt: hold, release: 0.07 });
  // martillo: ruido filtrado muy corto
  const nh = Math.round(0.012 * sr);
  let lp = 0;
  let a = 0.25 * vel;
  const kh = Math.exp(-1 / (0.003 * sr));
  for (let i = 0; i < Math.min(nh, out.length); i++) {
    lp += 0.2 * (rng.next() * 2 - 1 - lp);
    out[i] += a * lp;
    a *= kh;
  }
  const g = 0.35 * Math.pow(vel, 1.3);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** Bajo eléctrico: aditivo con brillo que decae rápido. */
export function renderBass(sr, rng, { midi, vel = 0.8, hold = 0.4, slap = false } = {}) {
  const f0 = midiToHz(midi);
  const partials = [];
  for (let k = 1; k <= 8; k++) {
    const a = Math.pow(k, -1.25) * (k === 2 ? 1.1 : 1);
    const tau = 1.2 / (1 + (slap ? 0.9 : 0.6) * (k - 1));
    partials.push({ f: k * f0, a, tau, phase: 0 });
  }
  const out = renderAdditive(sr, partials, { dur: hold + 0.06, attack: 0.004, relAt: hold, release: 0.025 });
  // ataque de dedo/púa
  const nh = Math.round(0.006 * sr);
  let lp = 0;
  for (let i = 0; i < Math.min(nh, out.length); i++) {
    lp += 0.4 * (rng.next() * 2 - 1 - lp);
    out[i] += (slap ? 0.5 : 0.15) * lp * (1 - i / nh);
  }
  const g = 0.45 * vel;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

// ---------------------------------------------------------------- Karplus-Strong

/** Cuerda pulsada (Karplus–Strong con retardo fraccional por interpolación lineal). */
export function renderPluck(sr, rng, { freq, vel = 0.8, bright = 0.5, t60 = 2.5, hold = 1.5, release = 0.06, pickPos = 0.2 } = {}) {
  const dur = hold + release * 4;
  const n = Math.max(1, Math.round(dur * sr));
  const out = new Float32Array(n);
  const L = sr / freq - 0.5; // el promedio de 2 muestras añade medio retardo
  const N = Math.max(2, Math.floor(L));
  const frac = L - N;
  const size = N + 2;
  const buf = new Float32Array(size);
  // excitación: ruido filtrado según brillo, con filtro peine de posición de púa
  const exc = new Float32Array(N);
  let lp = 0;
  const lc = 0.15 + 0.8 * bright * Math.min(1, 0.5 + vel);
  for (let i = 0; i < N; i++) {
    lp += lc * (rng.next() * 2 - 1 - lp);
    exc[i] = lp;
  }
  const pp = Math.max(1, Math.round(pickPos * N));
  let mean = 0;
  for (let i = 0; i < N; i++) mean += exc[i];
  mean /= N;
  for (let i = 0; i < N; i++) buf[i] = exc[i] - mean - 0.6 * ((exc[(i + pp) % N] || 0) - mean);
  const g = Math.pow(0.001, 1 / (freq * t60));
  const r0 = Math.round(hold * sr);
  const kr = Math.exp(-1 / (release * sr));
  let rel = 1;
  // lectura circular: y[n] = g * ((1-frac)*avg(y[n-N], y[n-N-1]) + frac*avg(y[n-N-1], y[n-N-2]))
  let w = 0; // índice de escritura (y[n] va a buf[w])
  const hist = new Float32Array(size + 2);
  // usamos hist como buffer circular de longitud M
  const M = size + 2;
  for (let i = 0; i < N; i++) hist[i] = buf[i];
  w = N;
  for (let i = 0; i < n; i++) {
    let y;
    if (i < N) {
      y = hist[i];
    } else {
      const a = hist[(w - N + M) % M];
      const b = hist[(w - N - 1 + M) % M];
      const c = hist[(w - N - 2 + M) % M];
      y = g * ((1 - frac) * 0.5 * (a + b) + frac * 0.5 * (b + c));
      hist[w] = y;
      w = (w + 1) % M;
    }
    if (i >= r0) {
      rel *= kr;
      y *= rel;
    }
    out[i] = y;
  }
  // ataque corto para evitar clic brusco en muestra 0
  const na = Math.max(1, Math.round(0.0008 * sr));
  for (let i = 0; i < Math.min(na, n); i++) out[i] *= i / na;
  const gain = 0.5 * vel;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

// ---------------------------------------------------------------- pad / cuerdas

const tableCache = new Map();
function sawTable(freq, sr, size = 2048) {
  const nh = Math.max(1, Math.min(14, Math.floor((sr * 0.45) / freq)));
  const key = nh;
  let t = tableCache.get(key);
  if (!t) {
    t = new Float32Array(size + 1);
    for (let k = 1; k <= nh; k++) {
      const a = 1 / k;
      for (let i = 0; i < size; i++) t[i] += a * Math.sin((TWO_PI * k * i) / size);
    }
    t[size] = t[0];
    tableCache.set(key, t);
  }
  return t;
}

/** Pad/cuerdas: 2 voces de diente de sierra limitadas en banda, ataque lento, legato. */
export function renderPad(sr, rng, { midi, vel = 0.5, hold = 2, attack = 0.5, release = 0.6, vibrato = 0, cutoff = 0.25 } = {}) {
  const f0 = midiToHz(midi);
  const dur = hold + release * 3;
  const n = Math.max(1, Math.round(dur * sr));
  const out = new Float32Array(n);
  const size = 2048;
  const table = sawTable(f0 * 1.01, sr, size);
  // 3 voces desiguales (ensamble): batido presente pero no con cancelación total
  const detunes = [1, 1 + 0.0028, 1 - 0.0022];
  const vAmps = [1, 0.55, 0.45];
  const na = Math.max(1, Math.round(attack * sr));
  const r0 = Math.round(hold * sr);
  const kr = Math.exp(-1 / (release * sr));
  for (let v = 0; v < detunes.length; v++) {
    const d = detunes[v];
    const va = vAmps[v];
    let ph = rng.uniform(0, size);
    const inc = (f0 * d * size) / sr;
    const vibW = (TWO_PI * rng.uniform(4.8, 5.8)) / sr;
    const vibD = vibrato * 0.0058; // vibrato en semitonos -> fracción aproximada
    for (let i = 0; i < n; i++) {
      const vf = vibrato > 0 && i > na ? 1 + vibD * Math.sin(vibW * i) : 1;
      ph += inc * vf;
      if (ph >= size) ph -= size;
      const k = ph | 0;
      const f = ph - k;
      out[i] += va * (table[k] + f * (table[k + 1] - table[k]));
    }
  }
  // paso bajo de un polo + envolvente
  let lp = 0;
  let rel = 1;
  const g = 0.16 * vel;
  for (let i = 0; i < n; i++) {
    lp += cutoff * (out[i] - lp);
    let e = i < na ? 0.5 - 0.5 * Math.cos((Math.PI * i) / na) : 1;
    if (i >= r0) {
      rel *= kr;
      e *= rel;
    }
    out[i] = g * e * lp;
  }
  return out;
}

// ---------------------------------------------------------------- voz

function vowelGain(f, formants) {
  let g = 0.02;
  for (const [fc, bw, amp] of formants) {
    const x = (f - fc) / bw;
    g += amp / (1 + x * x);
  }
  return g;
}

const VOWELS = [
  [[730, 90, 1], [1090, 110, 0.5], [2440, 160, 0.25]], // a
  [[530, 60, 1], [1840, 100, 0.45], [2480, 120, 0.3]], // e
  [[300, 50, 1], [2200, 120, 0.35], [2950, 150, 0.25]], // i
  [[570, 70, 1], [840, 80, 0.6], [2410, 140, 0.2]], // o
  [[440, 60, 1], [1020, 90, 0.4], [2240, 140, 0.15]], // u
];

/**
 * Melodía vocal legato: notas [{ t0, t1, midi, vel }] (s, relativas al inicio del render).
 * Glissandos entre notas contiguas, vibrato retardado, re-articulación suave (sin ataques duros).
 */
export function renderVocal(sr, rng, notes, { vibratoDepth = 0.35, glide = 0.07, breathiness = 0.04 } = {}) {
  if (!notes.length) return new Float32Array(1);
  const end = notes[notes.length - 1].t1 + 0.4;
  const n = Math.round(end * sr);
  const out = new Float32Array(n);
  const block = 64;
  const nh = 14;
  const amps = new Float64Array(nh + 1);
  let ph = 0;
  let noteIdx = 0;
  let lpN = 0;
  const vibW = TWO_PI * rng.uniform(5.2, 6.0);
  let vowel = VOWELS[rng.int(0, VOWELS.length - 1)];
  let nextVowel = vowel;
  let lastVowelNote = -1;
  for (let b = 0; b < n; b += block) {
    const t = b / sr;
    while (noteIdx < notes.length - 1 && t >= notes[noteIdx + 1].t0) noteIdx++;
    const cur = notes[noteIdx];
    const prev = noteIdx > 0 ? notes[noteIdx - 1] : null;
    // tono con glissando desde la nota anterior si es contigua
    let m = cur.midi;
    if (prev && cur.t0 - prev.t1 < 0.06 && t < cur.t0 + glide && t >= cur.t0) {
      const x = (t - cur.t0) / glide;
      m = prev.midi + (cur.midi - prev.midi) * (0.5 - 0.5 * Math.cos(Math.PI * x));
    }
    const since = t - cur.t0;
    const vibAmt = since > 0.18 ? Math.min(1, (since - 0.18) / 0.25) * vibratoDepth : 0;
    m += vibAmt * Math.sin(vibW * t);
    const f0 = midiToHz(m);
    // envolvente de amplitud: legato con caída leve entre notas, silencio en pausas
    let env;
    if (t < cur.t0) {
      env = 0;
    } else if (t <= cur.t1) {
      const contiguous = prev && cur.t0 - prev.t1 < 0.06;
      const att = contiguous ? 0.09 : 0.07;
      const a0 = contiguous ? 0.55 : 0;
      env = since < att ? a0 + (1 - a0) * (since / att) : 1;
      env *= cur.vel * (1 - 0.15 * Math.min(1, since / Math.max(0.2, cur.t1 - cur.t0)));
    } else {
      const next = noteIdx < notes.length - 1 ? notes[noteIdx + 1] : null;
      const r = t - cur.t1;
      env = cur.vel * 0.85 * Math.exp(-r / 0.06);
      if (next && next.t0 - cur.t1 < 0.06) env = cur.vel * 0.55;
    }
    if (noteIdx !== lastVowelNote) {
      lastVowelNote = noteIdx;
      vowel = nextVowel;
      nextVowel = VOWELS[rng.int(0, VOWELS.length - 1)];
    }
    let norm = 0;
    for (let k = 1; k <= nh; k++) {
      const fk = k * f0;
      amps[k] = fk < sr * 0.45 ? vowelGain(fk, vowel) / Math.sqrt(k) : 0;
      norm += amps[k];
    }
    const gA = (env * 0.5) / Math.max(1e-6, norm);
    const w = (TWO_PI * f0) / sr;
    const lim = Math.min(n, b + block);
    for (let i = b; i < lim; i++) {
      ph += w;
      if (ph > TWO_PI) ph -= TWO_PI;
      const s1 = Math.sin(ph);
      const c2 = 2 * Math.cos(ph);
      let sPrev = 0;
      let sCur = s1;
      let acc = 0;
      for (let k = 1; k <= nh; k++) {
        acc += amps[k] * sCur;
        const sNext = c2 * sCur - sPrev;
        sPrev = sCur;
        sCur = sNext;
      }
      lpN += 0.3 * (rng.next() * 2 - 1 - lpN);
      out[i] = gA * (acc + breathiness * norm * lpN * 2);
    }
  }
  return out;
}

// ---------------------------------------------------------------- reverb

/** Reverb tipo Schroeder/Freeverb (8 peines con amortiguación + 3 pasatodos). Devuelve la señal húmeda. */
export function reverb(input, sr, { size = 1, damping = 0.35, feedback = 0.8, predelay = 0.012 } = {}) {
  const n = input.length;
  const out = new Float32Array(n);
  const scale = sr / 44100;
  const combDelays = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.max(8, Math.round(d * scale * size)));
  const apDelays = [556, 441, 341].map((d) => Math.max(4, Math.round(d * scale)));
  const pd = Math.round(predelay * sr);
  const combs = combDelays.map((d) => ({ buf: new Float32Array(d), idx: 0, store: 0 }));
  const aps = apDelays.map((d) => ({ buf: new Float32Array(d), idx: 0 }));
  const d1 = 1 - damping;
  for (let i = 0; i < n; i++) {
    const x = i >= pd ? input[i - pd] * 0.12 : 0;
    let acc = 0;
    for (let c = 0; c < combs.length; c++) {
      const cb = combs[c];
      const y = cb.buf[cb.idx];
      cb.store = y * d1 + cb.store * damping;
      cb.buf[cb.idx] = x + cb.store * feedback;
      if (++cb.idx >= cb.buf.length) cb.idx = 0;
      acc += y;
    }
    for (let a = 0; a < aps.length; a++) {
      const ap = aps[a];
      const bo = ap.buf[ap.idx];
      ap.buf[ap.idx] = acc + bo * 0.5;
      acc = bo - acc;
      if (++ap.idx >= ap.buf.length) ap.idx = 0;
    }
    out[i] = acc;
  }
  return out;
}
