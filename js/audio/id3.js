// Lectura y reconstrucción de etiquetas ID3v2 (título, artista, carátula…). Lógica pura.
//
// readId3v2 busca la etiqueta al principio del archivo (MP3, FLAC con ID3), en el chunk 'id3 '/'ID3 ' de un
// WAV o AIFF; si no hay ID3v2, convierte a frames v2.3 los comentarios Vorbis/imagen de FLAC, los átomos de
// iTunes de M4A, el LIST/INFO de WAV o un ID3v1 del final (campo `source` indica el origen).
// v2.2 se convierte a v2.3 (IDs de 3 letras → 4, PIC → APIC) y se devuelve con version 3.
// Los frames comprimidos o cifrados se descartan. `data` es siempre el cuerpo limpio del frame
// (sin unsync, sin bytes de agrupación ni indicador de longitud), listo para buildId3v2 con la misma versión.

const FRAME_ID_RE = /^[A-Z0-9]{4}$/;

function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  return null;
}

function ascii(b, off, n) {
  let s = '';
  for (let i = 0; i < n && off + i < b.length; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

function syncsafe(b, off) {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
}

function u32be(b, off) {
  return ((b[off] << 24) >>> 0) + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]);
}

// Deshace la "unsynchronisation": FF 00 → FF
function deunsync(b) {
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0x00 && i > 0 && b[i - 1] === 0xff) n++;
  if (!n) return b;
  const out = new Uint8Array(b.length - n);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x00 && i > 0 && b[i - 1] === 0xff) continue;
    out[o++] = b[i];
  }
  return out;
}

// ---------- texto ----------

function decodeLatin1(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decodeUtf16(b, bigEndian) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(bigEndian ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
  return s;
}

function decodeText(b, enc) {
  if (enc === 1) {
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b.subarray(2), true);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b.subarray(2), false);
    return decodeUtf16(b, false);
  }
  if (enc === 2) return decodeUtf16(b, true);
  if (enc === 3) return new TextDecoder('utf-8').decode(b);
  return decodeLatin1(b);
}

// Posición del terminador de cadena según la codificación (-1 si no hay)
function findTerminator(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return -1;
  }
  return b.indexOf(0, start);
}

function termLen(enc) {
  return enc === 1 || enc === 2 ? 2 : 1;
}

function stripNulls(s) {
  return s.replace(/\u0000+$/, '').replace(/\u0000/g, ' / ').replace(/^﻿/, '');
}

// Texto legible de un frame T*** / TXXX / COMM / USLT / W*** (null si no aplica)
export function frameText(frame) {
  if (!frame || !frame.data || !frame.data.length) return null;
  const { id } = frame;
  const d = frame.data;
  if (id[0] === 'W' && id !== 'WXXX') return stripNulls(decodeLatin1(d));
  const enc = d[0];
  if (id === 'TXXX' || id === 'WXXX') {
    const t = findTerminator(d, 1, enc);
    if (t < 0) return stripNulls(decodeText(d.subarray(1), enc));
    const value = id === 'WXXX' ? decodeLatin1(d.subarray(t + termLen(enc))) : decodeText(d.subarray(t + termLen(enc)), enc);
    return stripNulls(value);
  }
  if (id === 'COMM' || id === 'USLT') {
    const t = findTerminator(d, 4, enc);
    return t < 0 ? null : stripNulls(decodeText(d.subarray(t + termLen(enc)), enc));
  }
  if (id[0] === 'T') return stripNulls(decodeText(d.subarray(1), enc));
  return null;
}

// Descripción de TXXX / COMM / WXXX (para filtrar frames de iTunes con datos de tiempo)
function frameDescription(frame) {
  const d = frame.data;
  if (!d || !d.length) return '';
  const enc = d[0];
  const start = frame.id === 'COMM' || frame.id === 'USLT' ? 4 : 1;
  const t = findTerminator(d, start, enc);
  return t < 0 ? '' : stripNulls(decodeText(d.subarray(start, t), enc));
}

// ---------- localización ----------

function findTagOffset(b) {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 0;
  const head = ascii(b, 0, 4);
  // WAV / RF64: chunk 'id3 ' o 'ID3 '
  if ((head === 'RIFF' || head === 'RF64') && ascii(b, 8, 4) === 'WAVE') {
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      const size = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16)) + b[p + 7] * 16777216;
      if ((id === 'id3 ' || id === 'ID3 ') && ascii(b, p + 8, 3) === 'ID3') return p + 8;
      if (size === 0xffffffff) break;   // RF64: tamaño real en ds64
      p += 8 + size + (size & 1);
    }
    return -1;
  }
  // AIFF / AIFC: chunk 'ID3 ' (big endian)
  if (head === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC')) {
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      const size = u32be(b, p + 4);
      if ((id === 'ID3 ' || id === 'id3 ') && ascii(b, p + 8, 3) === 'ID3') return p + 8;
      p += 8 + size + (size & 1);
    }
  }
  return -1;
}

// ---------- lectura ----------

export function readId3v2(arrayBuffer) {
  const all = toBytes(arrayBuffer);
  if (!all) return null;
  const off = findTagOffset(all);
  if (off < 0) return readNativeTags(all) || readId3v1(all);
  const b = all.subarray(off);
  if (b.length < 10) return null;
  const major = b[3];
  const flags = b[5];
  if (major < 2 || major > 4 || b[4] === 0xff) return null;
  if ((b[6] | b[7] | b[8] | b[9]) & 0x80) return null;
  const size = syncsafe(b, 6);
  const footer = major === 4 && (flags & 0x10) ? 10 : 0;
  let body = b.subarray(10, Math.min(b.length, 10 + size));
  const totalSize = 10 + size + footer;

  if (major === 2) {
    if (flags & 0x40) return null;   // compresión v2.2: sin esquema definido
    if (flags & 0x80) body = deunsync(body);
    return { version: 3, sourceVersion: 2, offset: off, size: totalSize, frames: parseV22Frames(body) };
  }

  if (major === 3 && (flags & 0x80)) body = deunsync(body);   // v2.3: unsync de toda la etiqueta
  let p = 0;
  if (flags & 0x40) {   // cabecera extendida
    if (body.length < 4) return null;
    p = major === 4 ? syncsafe(body, 0) : 4 + u32be(body, 0);
    if (p > body.length) return null;
  }
  const frames = major === 4
    ? parseV24Frames(body, p, !!(flags & 0x80))
    : parseV23Frames(body, p);
  return { version: major, offset: off, size: totalSize, frames };
}

function parseV23Frames(b, p) {
  const frames = [];
  while (p + 10 <= b.length) {
    if (b[p] === 0) break;   // relleno
    const id = ascii(b, p, 4);
    if (!FRAME_ID_RE.test(id)) break;
    const size = u32be(b, p + 4);
    const fmt = b[p + 9];
    const start = p + 10;
    const end = start + size;
    if (end > b.length) break;
    p = end;
    if (fmt & 0x80 || fmt & 0x40) continue;   // comprimido o cifrado → se descarta
    let data = b.subarray(start, end);
    if (fmt & 0x20) data = data.subarray(1);  // id de grupo
    frames.push({ id, data: data.slice() });
  }
  return frames;
}

function looksLikeFrameStart(b, p) {
  if (p === b.length) return true;
  if (p > b.length) return false;
  if (b[p] === 0) return true;
  return p + 4 <= b.length && FRAME_ID_RE.test(ascii(b, p, 4));
}

function parseV24Frames(b, p, tagUnsync) {
  const frames = [];
  while (p + 10 <= b.length) {
    if (b[p] === 0) break;
    const id = ascii(b, p, 4);
    if (!FRAME_ID_RE.test(id)) break;
    // Algunos programas (iTunes antiguo) escribían tamaños v2.4 sin syncsafe
    let size = syncsafe(b, p + 4);
    const plain = u32be(b, p + 4);
    if ((b[p + 4] | b[p + 5] | b[p + 6] | b[p + 7]) & 0x80) size = plain;
    else if (plain !== size && !looksLikeFrameStart(b, p + 10 + size) && looksLikeFrameStart(b, p + 10 + plain)) size = plain;
    const fmt = b[p + 9];
    const start = p + 10;
    const end = start + size;
    if (end > b.length) break;
    p = end;
    if (fmt & 0x08 || fmt & 0x04) continue;   // comprimido o cifrado
    let data = b.subarray(start, end);
    if (fmt & 0x40) data = data.subarray(1);   // id de grupo
    if (fmt & 0x01) data = data.subarray(4);   // indicador de longitud
    if (fmt & 0x02 || tagUnsync) data = deunsync(data);
    frames.push({ id, data: data.slice() });
  }
  return frames;
}

const V22_TO_V23 = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4',
  TAL: 'TALB', TCO: 'TCON', TYE: 'TYER', TRK: 'TRCK', TPA: 'TPOS', TCM: 'TCOM', TBP: 'TBPM',
  TKE: 'TKEY', TCR: 'TCOP', TEN: 'TENC', TLA: 'TLAN', TPB: 'TPUB', TSS: 'TSSE', TOA: 'TOPE',
  TOT: 'TOAL', TOL: 'TOLY', TOR: 'TORY', TXT: 'TEXT', TMT: 'TMED', TDA: 'TDAT', TIM: 'TIME',
  TRD: 'TRDA', TXX: 'TXXX', TCP: 'TCMP', TLE: 'TLEN',
  COM: 'COMM', ULT: 'USLT', WXX: 'WXXX', WAR: 'WOAR', WAF: 'WOAF', WAS: 'WOAS', WCM: 'WCOM',
  WCP: 'WCOP', WPB: 'WPUB', POP: 'POPM', PIC: 'APIC',
};

function parseV22Frames(b) {
  const frames = [];
  let p = 0;
  while (p + 6 <= b.length) {
    if (b[p] === 0) break;
    const id = ascii(b, p, 3);
    if (!/^[A-Z0-9]{3}$/.test(id)) break;
    const size = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    const start = p + 6;
    const end = start + size;
    if (end > b.length) break;
    p = end;
    const id4 = V22_TO_V23[id];
    if (!id4) continue;
    let data = b.subarray(start, end);
    if (id === 'PIC') {
      if (data.length < 5) continue;
      const fmt = ascii(data, 1, 3).toUpperCase();
      const mime = fmt === 'PNG' ? 'image/png' : fmt === 'JPG' ? 'image/jpeg' : 'image/' + fmt.toLowerCase();
      const out = new Uint8Array(data.length - 3 + mime.length + 1);
      out[0] = data[0];
      for (let i = 0; i < mime.length; i++) out[1 + i] = mime.charCodeAt(i);
      out[1 + mime.length] = 0;
      out.set(data.subarray(4), 2 + mime.length);
      data = out;
    } else {
      data = data.slice();
    }
    frames.push({ id: id4, data });
  }
  return frames;
}

// ---------- etiquetas no ID3 (FLAC, M4A, RIFF INFO) → frames v2.3 ----------
// Así "Conservar etiquetas" también funciona con FLAC/M4A/WAV sin ID3: se sintetizan frames v2.3
// con texto UTF-16 (codificación 1, con BOM), que es lo que mejor leen reproductores y software DJ.

function utf16Text(s) {
  const out = new Uint8Array(3 + 2 * s.length);
  out[0] = 1;
  out[1] = 0xff;
  out[2] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[3 + 2 * i] = c & 0xff;
    out[4 + 2 * i] = c >> 8;
  }
  return out;
}

function textFrames(pairs) {
  const frames = [];
  const seen = new Set();
  for (const [id, value] of pairs) {
    const v = value == null ? '' : String(value).replace(/\u0000+$/, '').trim();
    if (!v || seen.has(id)) continue;
    seen.add(id);
    if (id === 'COMM') {
      const t = utf16Text(v);   // enc, BOM, texto
      const d = new Uint8Array(4 + 4 + t.length - 1);
      d.set([1, 0x65, 0x6e, 0x67, 0xff, 0xfe, 0, 0], 0);   // UTF-16, 'eng', descripción vacía (BOM + 00 00)
      d.set(t.subarray(1), 8);
      frames.push({ id, data: d });
    } else {
      frames.push({ id, data: utf16Text(v) });
    }
  }
  return frames;
}

function apicFrame(mime, pictureType, description, image) {
  const desc = utf16Text(description || '').subarray(1);
  const m = latin1Bytes(mime || 'image/jpeg');
  const d = new Uint8Array(1 + m.length + 1 + 1 + desc.length + 2 + image.length);
  let p = 0;
  d[p++] = 1;
  d.set(m, p); p += m.length;
  d[p++] = 0;
  d[p++] = pictureType & 0xff;
  d.set(desc, p); p += desc.length;
  p += 2;   // terminador UTF-16
  d.set(image, p);
  return { id: 'APIC', data: d };
}

function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function utf8OrLatin1(b) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return decodeLatin1(b);
  }
}

const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;

const VORBIS_TO_ID3 = {
  TITLE: 'TIT2', ARTIST: 'TPE1', ALBUM: 'TALB', ALBUMARTIST: 'TPE2', 'ALBUM ARTIST': 'TPE2', GENRE: 'TCON',
  DATE: 'TYER', YEAR: 'TYER', TRACKNUMBER: 'TRCK', DISCNUMBER: 'TPOS', COMPOSER: 'TCOM', BPM: 'TBPM',
  INITIALKEY: 'TKEY', KEY: 'TKEY', COMMENT: 'COMM', DESCRIPTION: 'COMM', ORGANIZATION: 'TPUB', LABEL: 'TPUB',
  ISRC: 'TSRC', COPYRIGHT: 'TCOP', REMIXER: 'TPE4', CONDUCTOR: 'TPE3', GROUPING: 'TIT1', SUBTITLE: 'TIT3',
  LYRICIST: 'TEXT', ENCODEDBY: 'TENC',
};

function normalizeYear(id, v) {
  if (id !== 'TYER') return v;
  const m = /\d{4}/.exec(v);
  return m ? m[0] : '';
}

// FLAC: bloques VORBIS_COMMENT (4) y PICTURE (6)
function readFlacTags(b) {
  if (ascii(b, 0, 4) !== 'fLaC') return null;
  const pairs = [];
  const pics = [];
  let totals = {};
  let p = 4;
  for (let guard = 0; guard < 1000 && p + 4 <= b.length; guard++) {
    const last = b[p] & 0x80;
    const type = b[p] & 0x7f;
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const body = p + 4;
    const end = body + len;
    if (end > b.length) break;
    if (type === 4) {
      let q = body + 4 + u32le(b, body);
      const count = u32le(b, q);
      q += 4;
      for (let i = 0; i < count && q + 4 <= end; i++) {
        const l = u32le(b, q);
        const entry = new TextDecoder('utf-8').decode(b.subarray(q + 4, Math.min(end, q + 4 + l)));
        q += 4 + l;
        const eq = entry.indexOf('=');
        if (eq <= 0) continue;
        const key = entry.slice(0, eq).toUpperCase();
        const value = entry.slice(eq + 1);
        if (key === 'TRACKTOTAL' || key === 'TOTALTRACKS') totals.track = value;
        else if (key === 'DISCTOTAL' || key === 'TOTALDISCS') totals.disc = value;
        else if (VORBIS_TO_ID3[key]) pairs.push([VORBIS_TO_ID3[key], normalizeYear(VORBIS_TO_ID3[key], value)]);
      }
    } else if (type === 6 && len >= 32) {
      const dv = new DataView(b.buffer, b.byteOffset + body, len);
      let q = 0;
      const picType = dv.getUint32(q); q += 4;
      const ml = dv.getUint32(q); q += 4;
      const mime = decodeLatin1(b.subarray(body + q, body + q + ml)); q += ml;
      const dl = dv.getUint32(q); q += 4;
      const desc = new TextDecoder('utf-8').decode(b.subarray(body + q, body + q + dl)); q += dl + 16;
      const il = dv.getUint32(q); q += 4;
      if (q + il <= len) pics.push(apicFrame(mime, picType, desc, b.slice(body + q, body + q + il)));
    }
    p = end;
    if (last) break;
  }
  const withTotals = pairs.map(([id, v]) => {
    if (id === 'TRCK' && totals.track && !v.includes('/')) return [id, `${v}/${totals.track}`];
    if (id === 'TPOS' && totals.disc && !v.includes('/')) return [id, `${v}/${totals.disc}`];
    return [id, v];
  });
  const frames = [...textFrames(withTotals), ...pics.slice(0, 1)];
  return frames.length ? { version: 3, source: 'flac', offset: 0, size: 0, frames } : null;
}

// MP4/M4A: moov/udta/meta/ilst (átomos de iTunes)
function mp4Children(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    let header = 8;
    if (size === 1) { size = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type: ascii(b, p + 4, 4), body: p + header, end: p + size });
    p += size;
  }
  return out;
}

const ILST_TO_ID3 = {
  '©nam': 'TIT2', '©ART': 'TPE1', '©alb': 'TALB', aART: 'TPE2', '©gen': 'TCON', '©day': 'TYER',
  '©wrt': 'TCOM', '©cmt': 'COMM', '©grp': 'TIT1', '©lyr': null, cprt: 'TCOP', '©too': 'TSSE',
};

function readMp4Tags(b) {
  if (ascii(b, 4, 4) !== 'ftyp') return null;
  const find = (list, type) => list.find((x) => x.type === type);
  const moov = find(mp4Children(b, 0, b.length), 'moov');
  const udta = moov && find(mp4Children(b, moov.body, moov.end), 'udta');
  const meta = udta && find(mp4Children(b, udta.body, udta.end), 'meta');
  if (!meta) return null;
  // 'meta' suele ser una "full box" (4 bytes de versión/flags antes de los hijos)
  const metaBody = u32be(b, meta.body) === 0 ? meta.body + 4 : meta.body;
  const ilst = find(mp4Children(b, metaBody, meta.end), 'ilst');
  if (!ilst) return null;
  const pairs = [];
  const pics = [];
  for (const item of mp4Children(b, ilst.body, ilst.end)) {
    const data = find(mp4Children(b, item.body, item.end), 'data');
    if (!data || data.end - data.body < 8) continue;
    const kind = u32be(b, data.body) & 0xffffff;
    const v = b.subarray(data.body + 8, data.end);
    const t = item.type;
    if (t === 'covr' && v.length) {
      const png = kind === 14 || (v[0] === 0x89 && v[1] === 0x50);
      pics.push(apicFrame(png ? 'image/png' : 'image/jpeg', 3, '', v.slice()));
    } else if ((t === 'trkn' || t === 'disk') && v.length >= 6) {
      const n = (v[2] << 8) | v[3];
      const total = (v[4] << 8) | v[5];
      if (n) pairs.push([t === 'trkn' ? 'TRCK' : 'TPOS', total ? `${n}/${total}` : String(n)]);
    } else if (t === 'tmpo' && v.length >= 2) {
      const bpm = (v[0] << 8) | v[1];
      if (bpm) pairs.push(['TBPM', String(bpm)]);
    } else if (ILST_TO_ID3[t] && kind === 1) {
      pairs.push([ILST_TO_ID3[t], normalizeYear(ILST_TO_ID3[t], new TextDecoder('utf-8').decode(v))]);
    }
  }
  const frames = [...textFrames(pairs), ...pics.slice(0, 1)];
  return frames.length ? { version: 3, source: 'mp4', offset: 0, size: 0, frames } : null;
}

// WAV: LIST/INFO (INAM, IART…)
const INFO_TO_ID3 = { INAM: 'TIT2', IART: 'TPE1', IPRD: 'TALB', IGNR: 'TCON', ICRD: 'TYER', ICMT: 'COMM', ITRK: 'TRCK',
  IPRT: 'TRCK', ICOP: 'TCOP', IENG: 'TENC', ICMS: 'TCOM' };

function readRiffInfo(b) {
  const head = ascii(b, 0, 4);
  if ((head !== 'RIFF' && head !== 'RF64') || ascii(b, 8, 4) !== 'WAVE') return null;
  let p = 12;
  const pairs = [];
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    if (size === 0xffffffff) break;
    if (id === 'LIST' && ascii(b, p + 8, 4) === 'INFO') {
      let q = p + 12;
      const end = Math.min(b.length, p + 8 + size);
      while (q + 8 <= end) {
        const sid = ascii(b, q, 4);
        const sl = u32le(b, q + 4);
        const key = INFO_TO_ID3[sid];
        if (key) pairs.push([key, normalizeYear(key, utf8OrLatin1(b.subarray(q + 8, Math.min(end, q + 8 + sl))))]);
        q += 8 + sl + (sl & 1);
      }
    }
    p += 8 + size + (size & 1);
  }
  const frames = textFrames(pairs);
  return frames.length ? { version: 3, source: 'riff-info', offset: 0, size: 0, frames } : null;
}

function readNativeTags(b) {
  try {
    return readFlacTags(b) || readMp4Tags(b) || readRiffInfo(b);
  } catch {
    return null;
  }
}

// ID3v1 (últimos 128 bytes) → frames v2.3 en ISO-8859-1
function readId3v1(b) {
  if (b.length < 128) return null;
  const p = b.length - 128;
  if (ascii(b, p, 3) !== 'TAG') return null;
  const field = (o, n) => {
    const s = b.subarray(p + o, p + o + n);
    let e = s.indexOf(0);
    if (e < 0) e = n;
    return decodeLatin1(s.subarray(0, e)).trim();
  };
  const frames = [];
  const text = (id, s) => {
    if (!s) return;
    const d = new Uint8Array(1 + s.length);
    for (let i = 0; i < s.length; i++) d[1 + i] = s.charCodeAt(i) & 0xff;
    frames.push({ id, data: d });
  };
  text('TIT2', field(3, 30));
  text('TPE1', field(33, 30));
  text('TALB', field(63, 30));
  text('TYER', field(93, 4));
  const v11 = b[p + 125] === 0 && b[p + 126] !== 0;
  const comment = field(97, v11 ? 28 : 30);
  if (comment) {
    const d = new Uint8Array(5 + comment.length);
    d.set([0, 0x65, 0x6e, 0x67, 0], 0);   // latin1, 'eng', descripción vacía
    for (let i = 0; i < comment.length; i++) d[5 + i] = comment.charCodeAt(i) & 0xff;
    frames.push({ id: 'COMM', data: d });
  }
  if (v11) text('TRCK', String(b[p + 126]));
  if (b[p + 127] !== 0xff) text('TCON', `(${b[p + 127]})`);
  if (!frames.length) return null;
  return { version: 3, sourceVersion: 1, offset: p, size: 128, frames };
}

// ---------- filtrado ----------

const ITUNES_TIMING = /^itun(smpb|norm|pgap)$/i;

// Sólo frames que siguen siendo válidos después de cortar el audio. Se descartan duración (TLEN, TSIZ),
// datos de análisis/cues de software DJ (GEOB, PRIV), sincronías (ETCO, MLLT, SYLT, SEEK, ASPI…) y los
// COMM/TXXX de iTunes con información de gapless/volumen (iTunSMPB, iTunNORM, iTunPGAP).
export function keepPortableFrames(frames) {
  return Array.from(frames || []).filter((f) => {
    if (!f || typeof f.id !== 'string' || !f.data) return false;
    const { id } = f;
    if (id === 'TLEN' || id === 'TSIZ') return false;
    if (id === 'TXXX' || id === 'COMM') return !ITUNES_TIMING.test(frameDescription(f));
    if (id[0] === 'T' || id[0] === 'W') return true;
    return id === 'APIC' || id === 'USLT' || id === 'POPM';
  });
}

// ---------- escritura ----------

const PADDING_BYTES = 256;

function writeSyncsafe(out, off, n) {
  out[off] = (n >>> 21) & 0x7f;
  out[off + 1] = (n >>> 14) & 0x7f;
  out[off + 2] = (n >>> 7) & 0x7f;
  out[off + 3] = n & 0x7f;
}

// Escribe una etiqueta v2.3 (tamaños de frame normales) o v2.4 (syncsafe), sin unsync ni flags, con algo de relleno.
// Devuelve un Uint8Array vacío si no queda ningún frame válido.
export function buildId3v2(frames, { version = 3 } = {}) {
  const v = Number(version) === 4 ? 4 : 3;
  const list = [];
  for (const f of frames || []) {
    if (!f || !FRAME_ID_RE.test(f.id)) continue;
    const data = toBytes(f.data);
    if (!data || !data.length) continue;
    list.push({ id: f.id, data });
  }
  if (!list.length) return new Uint8Array(0);
  let size = PADDING_BYTES;
  for (const f of list) size += 10 + f.data.length;
  if (size > 0x0fffffff) throw new Error('Las etiquetas son demasiado grandes.');
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, v, 0, 0], 0);
  writeSyncsafe(out, 6, size);
  let p = 10;
  for (const f of list) {
    for (let i = 0; i < 4; i++) out[p + i] = f.id.charCodeAt(i);
    const n = f.data.length;
    if (v === 4) writeSyncsafe(out, p + 4, n);
    else {
      out[p + 4] = (n >>> 24) & 0xff;
      out[p + 5] = (n >>> 16) & 0xff;
      out[p + 6] = (n >>> 8) & 0xff;
      out[p + 7] = n & 0xff;
    }
    out.set(f.data, p + 10);
    p += 10 + n;
  }
  return out;
}
