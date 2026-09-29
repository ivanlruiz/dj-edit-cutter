// Worker de análisis (módulo). Protocolo: peticiones { id, type: 'analyze' | 'retrack' | 'relabel', ... };
// respuestas { id, type: 'progress', stage, fraction } | { id, type: 'result', result } | { id, type: 'error', message }.
// Al arrancar envía { type: 'ready' }. Guarda la sesión de la última canción analizada para retrack / relabel.
import { AnalysisSession } from './analyze.js';

let session = null;

function errorMessage(err) {
  const m = err && err.message ? String(err.message) : String(err || '');
  if (err instanceof RangeError && /memory|allocation|Array buffer|Invalid (typed )?array length/i.test(m)) {
    return 'no hay memoria suficiente para analizar este audio';
  }
  return m || 'error desconocido';
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  const { id, type } = msg;
  const progress = (stage, fraction) => self.postMessage({ id, type: 'progress', stage, fraction });
  try {
    let result;
    if (type === 'analyze') {
      session = null; // libera la canción anterior antes de reservar memoria para la nueva
      const s = new AnalysisSession(msg.samples, msg.sampleRate, msg.options || {});
      result = s.run(progress);
      session = s;
    } else if (type === 'retrack' || type === 'relabel') {
      if (!session) throw new Error('primero hay que analizar una canción');
      result = type === 'retrack' ? session.retrack(msg.options || {}, progress) : session.relabel(msg.options || {}, progress);
    } else {
      throw new Error(`petición desconocida: ${type}`);
    }
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: errorMessage(err) });
  }
};

self.postMessage({ type: 'ready' });
