// Cliente del análisis: ejecuta js/analysis/worker.js (worker de módulo) y lo envuelve en promesas.
// Varias peticiones a la vez se distinguen por id; el worker las atiende en orden de llegada.
// Si el navegador no puede arrancar el worker, el análisis se hace en el hilo principal (más lento, pero funciona).

const WORKER_URL = new URL('./worker.js', import.meta.url);

function pickAnalyzeOptions(o = {}) {
  const out = {};
  if (o && o.minBpm !== undefined) out.minBpm = Number(o.minBpm);
  if (o && o.maxBpm !== undefined) out.maxBpm = Number(o.maxBpm);
  if (o && o.beatsPerBar !== undefined) out.beatsPerBar = typeof o.beatsPerBar === 'string' ? o.beatsPerBar : Number(o.beatsPerBar);
  return out;
}

function pickRetrackOptions(o = {}) {
  const out = {};
  if (o && o.bpmHint !== undefined && o.bpmHint !== null) out.bpmHint = Number(o.bpmHint);
  if (o && o.strict !== undefined) out.strict = !!o.strict;
  return out;
}

function pickRelabelOptions(o = {}) {
  const out = {};
  if (o && o.beatsPerBar !== undefined) out.beatsPerBar = typeof o.beatsPerBar === 'string' ? o.beatsPerBar : Number(o.beatsPerBar);
  if (o && o.forcedDownbeats !== undefined && o.forcedDownbeats !== null) out.forcedDownbeats = Array.from(o.forcedDownbeats, Number);
  return out;
}

function callSafely(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch {
    // un fallo del callback de progreso no debe romper el análisis
  }
}

export class AnalysisClient {
  constructor() {
    this._pending = new Map(); // id -> { resolve, reject, onProgress, msg, transfer }
    this._queue = []; // peticiones que esperan a que el worker diga 'ready'
    this._nextId = 1;
    this._worker = null;
    this._state = 'starting'; // 'starting' | 'ready' | 'local' | 'dead' | 'closed'
    this._local = null; // modo sin worker: { mod, session, chain }
    this._spawn();
  }

  /**
   * Analiza una canción. samples (Float32Array mono, normalmente 22050 Hz) se TRANSFIERE al worker: no lo reutilices.
   * @returns {Promise<object>} AnalysisResult
   */
  analyze(samples, sampleRate, options = {}, onProgress = () => {}) {
    let s = samples;
    if (!(s instanceof Float32Array)) s = Float32Array.from(s || []);
    return this._request({ type: 'analyze', samples: s, sampleRate: Number(sampleRate), options: pickAnalyzeOptions(options) }, onProgress, [s.buffer]);
  }

  /** Rehace los beats con las características guardadas: { bpmHint, strict }. */
  retrack(options = {}) {
    return this._request({ type: 'retrack', options: pickRetrackOptions(options) });
  }

  /** Rehace sólo los compases: { beatsPerBar: 'auto' | 2..7, forcedDownbeats: índices de beat }. */
  relabel(options = {}) {
    return this._request({ type: 'relabel', options: pickRelabelOptions(options) });
  }

  /** Detiene el worker; las peticiones pendientes se rechazan. */
  terminate() {
    if (this._state === 'closed') return;
    this._state = 'closed';
    if (this._worker) this._worker.terminate();
    this._worker = null;
    this._local = null;
    this._rejectAll('análisis cancelado');
  }

  // ---------------------------------------------------------------- interno

  _spawn() {
    let w;
    try {
      w = new Worker(WORKER_URL, { type: 'module' });
    } catch {
      this._goLocal();
      return;
    }
    this._worker = w;
    this._state = 'starting';
    w.onmessage = (e) => this._onMessage(w, e.data);
    w.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      this._onWorkerError(w);
    };
    w.onmessageerror = () => {
      if (w === this._worker) this._rejectAll('no se pudo leer la respuesta del análisis');
    };
  }

  _request(msg, onProgress, transfer) {
    return new Promise((resolve, reject) => {
      if (this._state === 'closed') {
        reject(new Error('el analizador está cerrado'));
        return;
      }
      if (this._state === 'dead') {
        if (msg.type !== 'analyze') {
          reject(new Error('primero hay que analizar una canción'));
          return;
        }
        this._spawn();
      }
      const id = this._nextId++;
      const req = { id, msg: { ...msg, id }, transfer, resolve, reject, onProgress };
      this._pending.set(id, req);
      if (this._state === 'ready') this._post(req);
      else if (this._state === 'local') this._runLocal(req);
      else this._queue.push(req);
    });
  }

  _post(req) {
    try {
      this._worker.postMessage(req.msg, req.transfer || []);
    } catch {
      // un buffer que no se puede transferir se copia
      try {
        this._worker.postMessage(req.msg);
      } catch {
        this._settle(req.id, null, new Error('no se pudieron enviar los datos al análisis'));
      }
    }
  }

  _onMessage(w, data) {
    if (w !== this._worker || !data) return;
    if (data.type === 'ready') {
      this._state = 'ready';
      const q = this._queue;
      this._queue = [];
      for (const req of q) this._post(req);
      return;
    }
    const req = this._pending.get(data.id);
    if (!req) return;
    if (data.type === 'progress') callSafely(req.onProgress, data.stage, data.fraction);
    else if (data.type === 'result') this._settle(data.id, data.result, null);
    else if (data.type === 'error') this._settle(data.id, null, new Error(data.message || 'error desconocido en el análisis'));
  }

  _onWorkerError(w) {
    if (w !== this._worker) return;
    w.terminate();
    this._worker = null;
    if (this._state === 'starting') {
      // el worker no llegó a arrancar (navegador sin workers de módulo, CSP…): análisis en el hilo principal
      this._goLocal();
      return;
    }
    this._state = 'dead';
    this._rejectAll('el análisis se detuvo por un error inesperado');
  }

  _settle(id, result, error) {
    const req = this._pending.get(id);
    if (!req) return;
    this._pending.delete(id);
    if (error) req.reject(error);
    else req.resolve(result);
  }

  _rejectAll(message) {
    const reqs = [...this._pending.values()];
    this._pending.clear();
    this._queue = [];
    for (const req of reqs) req.reject(new Error(message));
  }

  _goLocal() {
    this._state = 'local';
    this._local = { mod: null, session: null, chain: Promise.resolve() };
    const q = this._queue;
    this._queue = [];
    for (const req of q) this._runLocal(req);
  }

  _runLocal(req) {
    const local = this._local;
    local.chain = local.chain.then(async () => {
      if (this._local !== local || !this._pending.has(req.id)) return;
      try {
        if (!local.mod) local.mod = await import('./analyze.js');
        await new Promise((r) => setTimeout(r, 0)); // deja pintar antes de bloquear el hilo
        const { msg } = req;
        const progress = (stage, fraction) => callSafely(req.onProgress, stage, fraction);
        let result;
        if (msg.type === 'analyze') {
          local.session = null;
          const s = new local.mod.AnalysisSession(msg.samples, msg.sampleRate, msg.options);
          result = s.run(progress);
          local.session = s;
        } else {
          if (!local.session) throw new Error('primero hay que analizar una canción');
          result = msg.type === 'retrack' ? local.session.retrack(msg.options, progress) : local.session.relabel(msg.options, progress);
        }
        this._settle(req.id, result, null);
      } catch (err) {
        this._settle(req.id, null, new Error(err && err.message ? err.message : 'error desconocido en el análisis'));
      }
    });
  }
}
