import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readId3v2, buildId3v2, keepPortableFrames, frameText } from '../js/audio/id3.js';

// ---------- utilidades para fabricar etiquetas a mano ----------

const cat = (...parts) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);
const utf16bom = (s) => {
  const out = [0xff, 0xfe];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c & 0xff, c >> 8); }
  return Uint8Array.from(out);
};
const utf16be = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c >> 8, c & 0xff); }
  return Uint8Array.from(out);
};
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ss32 = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const header = (ver, flags, size) => cat(latin1('ID3'), [ver, 0, flags], ss32(size));
const frame23 = (id, body, fmt = 0) => cat(latin1(id), be32(body.length), [0, fmt], body);
const frame24 = (id, body, fmt = 0, sizeOverride) => cat(latin1(id), ss32(sizeOverride ?? body.length), [0, fmt], body);

// "unsynchronisation": 00 después de cada FF seguido de ≥E0 o 00 (y de un FF final)
function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] >= 0xe0 || b[i + 1] === 0)) out.push(0);
  }
  return Uint8Array.from(out);
}

// Imagen falsa con falsas sincronías MPEG (FF Ex / FF 00) que obligan a usar unsync
const IMAGE = cat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], latin1('JFIF'), [0xff, 0xfb, 0x90, 0x00, 0xff, 0x00, 0x12], new Uint8Array(200).map((_, i) => (i * 37) & 0xff), [0xff]);
const apicBody = (enc = 0, desc = latin1('Portada')) => cat([enc], latin1('image/jpeg'), [0, 3], desc, enc === 1 || enc === 2 ? [0, 0] : [0], IMAGE);

const TITLE = 'Canción ñandú';
const ARTIST = 'Los Fulanos — en vivo';

function assertFrames(actual, expected) {
  assert.deepEqual(actual.map((f) => f.id), expected.map((f) => f.id));
  for (let i = 0; i < expected.length; i++) assert.deepEqual(Array.from(actual[i].data), Array.from(expected[i].data), expected[i].id);
}

// ---------- lectura ----------

test('ID3v2.3 con unsync de toda la etiqueta, cabecera extendida, UTF-16 y APIC', () => {
  const tit2 = cat([1], utf16bom(TITLE));
  const tpe1 = cat([0], latin1('Latin ñ'));
  const apic = apicBody(1, utf16bom('Tapa'));
  const comm = cat([1], latin1('spa'), utf16bom(''), [0, 0], utf16bom('Comentario'));
  const frames = cat(frame23('TIT2', tit2), frame23('TPE1', tpe1), frame23('APIC', apic), frame23('COMM', comm));
  const ext = cat(be32(6), [0, 0], be32(0));   // cabecera extendida v2.3 (tamaño sin contarse a sí mismo)
  const body = unsync(cat(ext, frames, new Uint8Array(20)));
  assert.ok(body.length > ext.length + frames.length + 20, 'el unsync insertó bytes');
  const file = cat(header(3, 0x80 | 0x40, body.length), body, [0xff, 0xfb, 0x90, 0x64]);
  const tag = readId3v2(file.buffer);
  assert.equal(tag.version, 3);
  assert.equal(tag.size, 10 + body.length);
  assertFrames(tag.frames, [{ id: 'TIT2', data: tit2 }, { id: 'TPE1', data: tpe1 }, { id: 'APIC', data: apic }, { id: 'COMM', data: comm }]);
  assert.equal(frameText(tag.frames[0]), TITLE);
  assert.equal(frameText(tag.frames[1]), 'Latin ñ');
  assert.equal(frameText(tag.frames[3]), 'Comentario');
});

test('ID3v2.4 con UTF-8, UTF-16BE, unsync por frame, indicador de longitud, agrupación, footer y cabecera extendida', () => {
  const tit2 = cat([3], utf8(TITLE + ' 🎧'));
  const tpe1 = cat([2], utf16be(ARTIST));
  const apic = apicBody(3, utf8('Carátula'));
  const apicOnDisk = unsync(apic);
  const tlen = cat([0], latin1('123456'));
  const frames = cat(
    frame24('TIT2', tit2),
    frame24('TPE1', tpe1),
    frame24('APIC', cat(ss32(apic.length), apicOnDisk), 0x02 | 0x01),        // unsync + longitud
    frame24('TCOM', cat([0x07], [3], utf8('Grupo')), 0x40),                // agrupación: 1 byte extra
    frame24('TXXX', cat(ss32(50), [0x78, 0x9c, 1, 2, 3]), 0x08 | 0x01),    // comprimido → se descarta
    frame24('PRIV', cat([1], latin1('cifrado')), 0x04),                    // cifrado → se descarta
    frame24('TLEN', tlen),
  );
  const ext = cat(ss32(6), [1, 0]);
  const body = cat(ext, frames, new Uint8Array(30));
  const file = cat(header(4, 0x40 | 0x10, body.length), body, latin1('3DI'), [4, 0, 0x10], ss32(body.length), [0xff, 0xfb]);
  const tag = readId3v2(file);
  assert.equal(tag.version, 4);
  assert.equal(tag.size, 10 + body.length + 10);
  assertFrames(tag.frames, [
    { id: 'TIT2', data: tit2 }, { id: 'TPE1', data: tpe1 }, { id: 'APIC', data: apic },
    { id: 'TCOM', data: cat([3], utf8('Grupo')) }, { id: 'TLEN', data: tlen },
  ]);
  assert.equal(frameText(tag.frames[0]), TITLE + ' 🎧');
  assert.equal(frameText(tag.frames[1]), ARTIST);
});

test('ID3v2.4 con el flag de unsync en la cabecera aplica a todos los frames', () => {
  const apic = apicBody();
  const body = cat(frame24('APIC', unsync(apic)), new Uint8Array(4));
  const tag = readId3v2(cat(header(4, 0x80, body.length), body));
  assertFrames(tag.frames, [{ id: 'APIC', data: apic }]);
});

test('ID3v2.4 con tamaños de frame sin syncsafe (iTunes antiguo) se lee igual', () => {
  const big = cat([0], latin1('x'.repeat(300)));   // 301 bytes: 00 00 01 2D normal ≠ syncsafe
  const t2 = cat([0], latin1('Título'));
  const body = cat(latin1('TIT3'), be32(big.length), [0, 0], big, frame24('TIT2', t2), new Uint8Array(8));
  const tag = readId3v2(cat(header(4, 0, body.length), body));
  assertFrames(tag.frames, [{ id: 'TIT3', data: big }, { id: 'TIT2', data: t2 }]);
});

test('ID3v2.2 se convierte a v2.3 (PIC → APIC)', () => {
  const f22 = (id, body) => cat(latin1(id), [(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body);
  const pic = cat([0], latin1('PNG'), [3], latin1('tapa'), [0], IMAGE);
  const body = cat(f22('TT2', cat([0], latin1('Hola'))), f22('TP1', cat([1], utf16bom('Artista'))), f22('XYZ', [1, 2, 3]),
    f22('PIC', pic), f22('COM', cat([0], latin1('eng'), [0], latin1('nota'))), new Uint8Array(10));
  const tag = readId3v2(cat(header(2, 0, body.length), body));
  assert.equal(tag.version, 3);
  assert.deepEqual(tag.frames.map((f) => f.id), ['TIT2', 'TPE1', 'APIC', 'COMM']);
  assert.equal(frameText(tag.frames[0]), 'Hola');
  assert.equal(frameText(tag.frames[1]), 'Artista');
  assert.deepEqual(Array.from(tag.frames[2].data), Array.from(cat([0], latin1('image/png'), [0, 3], latin1('tapa'), [0], IMAGE)));
  assert.equal(frameText(tag.frames[3]), 'nota');
  // se puede reescribir como v2.3 válida
  const rebuilt = readId3v2(buildId3v2(tag.frames, { version: tag.version }));
  assertFrames(rebuilt.frames, tag.frames);
});

test('ID3v1 al final se convierte a frames v2.3', () => {
  const v1 = new Uint8Array(128);
  const put = (o, s) => v1.set(latin1(s), o);
  put(0, 'TAG'); put(3, 'Tema viejo'); put(33, 'Grupo'); put(63, 'Disco'); put(93, '1999'); put(97, 'hola');
  v1[125] = 0; v1[126] = 5; v1[127] = 17;
  const file = cat([0xff, 0xfb, 0x90, 0x64], new Uint8Array(500), v1);
  const tag = readId3v2(file.buffer);
  assert.equal(tag.version, 3);
  const text = Object.fromEntries(tag.frames.map((f) => [f.id, frameText(f)]));
  assert.deepEqual(text, { TIT2: 'Tema viejo', TPE1: 'Grupo', TALB: 'Disco', TYER: '1999', COMM: 'hola', TRCK: '5', TCON: '(17)' });
});

test('readId3v2 devuelve null sin etiqueta o con cabecera inválida, y no revienta con etiquetas truncadas', () => {
  assert.equal(readId3v2(new ArrayBuffer(0)), null);
  assert.equal(readId3v2(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(readId3v2(cat(latin1('ID3'), [3, 0, 0, 0x80, 0, 0, 0])), null);   // tamaño no syncsafe
  assert.equal(readId3v2(cat(latin1('ID3'), [5, 0, 0], ss32(10), new Uint8Array(10))), null);   // versión desconocida
  assert.equal(readId3v2(null), null);
  const good = cat(frame23('TIT2', cat([0], latin1('abc'))), frame23('TPE1', cat([0], latin1('def'))));
  const truncated = cat(header(3, 0, good.length + 100), good.subarray(0, good.length - 2));
  const tag = readId3v2(truncated);
  assert.deepEqual(tag.frames.map((f) => f.id), ['TIT2']);
});

// ---------- filtrado ----------

test('keepPortableFrames conserva lo portátil y descarta GEOB/PRIV/TLEN y datos de tiempo', () => {
  const txxx = (desc) => ({ id: 'TXXX', data: cat([0], latin1(desc), [0], latin1('valor')) });
  const comm = (desc) => ({ id: 'COMM', data: cat([0], latin1('eng'), latin1(desc), [0], latin1('texto')) });
  const d = (id) => ({ id, data: latin1('\u0000x') });
  const frames = [d('TIT2'), d('TLEN'), d('TSIZ'), txxx('DJ'), txxx('iTunSMPB'), comm(''), comm('iTunNORM'), comm('iTunPGAP'),
    d('APIC'), d('GEOB'), d('PRIV'), d('USLT'), d('WOAR'), d('WXXX'), d('POPM'), d('ETCO'), d('MLLT'), d('SYLT'), d('SEEK'),
    d('ASPI'), d('UFID'), d('TBPM'), d('TKEY'), d('RVA2'), null, { id: 'TPE1' }];
  const before = frames.slice();
  const kept = keepPortableFrames(frames);
  assert.deepEqual(kept.map((f) => f.id), ['TIT2', 'TXXX', 'COMM', 'APIC', 'USLT', 'WOAR', 'WXXX', 'POPM', 'TBPM', 'TKEY']);
  assert.equal(frameText(kept[1]), 'valor');
  assert.deepEqual(frames, before, 'no muta la lista');
});

// ---------- escritura ----------

test('buildId3v2: ida y vuelta en v2.3 y v2.4 con tamaños correctos', () => {
  const big = cat([0], latin1('y'.repeat(300)));
  const frames = [
    { id: 'TIT2', data: cat([1], utf16bom(TITLE)) },
    { id: 'TIT3', data: big },
    { id: 'APIC', data: apicBody() },
    { id: 'USLT', data: cat([0], latin1('spa'), [0], latin1('letra')) },
  ];
  for (const version of [3, 4]) {
    const tag = buildId3v2(frames, { version });
    assert.deepEqual(Array.from(tag.subarray(0, 6)), [0x49, 0x44, 0x33, version, 0, 0]);
    const size = ((tag[6] & 0x7f) << 21) | ((tag[7] & 0x7f) << 14) | ((tag[8] & 0x7f) << 7) | (tag[9] & 0x7f);
    assert.equal(size, tag.length - 10);
    assert.ok(tag.subarray(6, 10).every((b) => b < 0x80));
    // tamaño del frame TIT3 (301 bytes): normal en 2.3, syncsafe en 2.4
    const p = 10 + 10 + frames[0].data.length;
    assert.equal(String.fromCharCode(...tag.subarray(p, p + 4)), 'TIT3');
    assert.deepEqual(Array.from(tag.subarray(p + 4, p + 8)), version === 4 ? ss32(301) : be32(301));
    // relleno al final
    assert.ok(tag.subarray(tag.length - 64).every((b) => b === 0));
    const back = readId3v2(tag.buffer);
    assert.equal(back.version, version);
    assertFrames(back.frames, frames);
  }
  // versión desconocida → 2.3
  assert.equal(buildId3v2(frames, { version: 2 })[3], 3);
  assert.equal(buildId3v2(frames)[3], 3);
});

test('buildId3v2 ignora frames inválidos y devuelve vacío si no queda nada', () => {
  assert.equal(buildId3v2([]).length, 0);
  assert.equal(buildId3v2([{ id: 'bad', data: latin1('x') }, { id: 'TIT2', data: new Uint8Array(0) }, null]).length, 0);
  const t = buildId3v2([{ id: 'TIT2', data: [0, 0x41] }, { id: 'tit2', data: latin1('x') }]);
  assert.deepEqual(readId3v2(t).frames.map((f) => f.id), ['TIT2']);
});

test('leer → filtrar → reescribir conserva los frames útiles de una etiqueta v2.4 real-ista', () => {
  const frames = [
    { id: 'TIT2', data: cat([3], utf8(TITLE)) },
    { id: 'TPE1', data: cat([3], utf8(ARTIST)) },
    { id: 'TLEN', data: cat([0], latin1('240000')) },
    { id: 'GEOB', data: cat([0], latin1('application/octet-stream'), [0, 0], latin1('Serato Markers2'), [0], IMAGE) },
    { id: 'APIC', data: apicBody(3, utf8('')) },
  ];
  const src = buildId3v2(frames, { version: 4 });
  const read = readId3v2(cat(src, [0xff, 0xfb, 0x90, 0x64]));
  const out = readId3v2(buildId3v2(keepPortableFrames(read.frames), { version: read.version }));
  assert.equal(out.version, 4);
  assert.deepEqual(out.frames.map((f) => f.id), ['TIT2', 'TPE1', 'APIC']);
  assert.equal(frameText(out.frames[1]), ARTIST);
});

// ---------- etiquetas no ID3 → frames v2.3 ----------

const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const texts = (tag) => Object.fromEntries(tag.frames.filter((f) => f.id !== 'APIC').map((f) => [f.id, frameText(f)]));
function apicParts(frame) {
  const d = frame.data;
  const mimeEnd = d.indexOf(0, 1);
  const mime = String.fromCharCode(...d.subarray(1, mimeEnd));
  const type = d[mimeEnd + 1];
  let p = mimeEnd + 2;
  while (!(d[p] === 0 && d[p + 1] === 0)) p += 2;   // descripción UTF-16
  return { enc: d[0], mime, type, image: d.subarray(p + 2) };
}

test('FLAC: comentarios Vorbis y PICTURE → frames v2.3', () => {
  const comments = ['TITLE=' + TITLE, 'ARTIST=' + ARTIST, 'ALBUM=Disco', 'TRACKNUMBER=3', 'TRACKTOTAL=12', 'DATE=2019-05-01',
    'BPM=124', 'COMMENT=Edit de prueba', 'REPLAYGAIN_TRACK_GAIN=-6 dB', 'sin_igual'];
  const vc = cat(le32(5), latin1('vendr'), le32(comments.length), ...comments.map((c) => { const u = utf8(c); return cat(le32(u.length), u); }));
  const img = cat([0x89, 0x50, 0x4e, 0x47], new Uint8Array(40).fill(0xab));
  const pic = cat(be32(3), be32(9), latin1('image/png'), be32(4), utf8('Tapa'), be32(0), be32(0), be32(0), be32(0), be32(img.length), img);
  const block = (type, body, last = false) => cat([(last ? 0x80 : 0) | type, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body);
  const flac = cat(latin1('fLaC'), block(0, new Uint8Array(34)), block(4, vc), block(6, pic, true), [0xff, 0xf8, 0x69]);
  const tag = readId3v2(flac.buffer);
  assert.equal(tag.version, 3);
  assert.equal(tag.source, 'flac');
  assert.deepEqual(texts(tag), { TIT2: TITLE, TPE1: ARTIST, TALB: 'Disco', TRCK: '3/12', TYER: '2019', TBPM: '124', COMM: 'Edit de prueba' });
  const apic = apicParts(tag.frames.find((f) => f.id === 'APIC'));
  assert.equal(apic.mime, 'image/png');
  assert.equal(apic.type, 3);
  assert.deepEqual(Array.from(apic.image), Array.from(img));
  // se reescribe como etiqueta v2.3 válida y sobrevive al filtro
  const back = readId3v2(buildId3v2(keepPortableFrames(tag.frames), { version: tag.version }));
  assert.deepEqual(texts(back), texts(tag));
});

test('M4A: átomos de iTunes (ilst) → frames v2.3', () => {
  const box = (type, ...kids) => { const body = cat(...kids); return cat(be32(8 + body.length), latin1(type), body); };
  const data = (kind, value) => box('data', be32(kind), be32(0), value);
  const jpeg = cat([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(30).fill(7));
  const ilst = box('ilst',
    box('©nam', data(1, utf8(TITLE))), box('©ART', data(1, utf8(ARTIST))), box('©day', data(1, utf8('2021-03-04T00:00:00Z'))),
    box('trkn', data(0, Uint8Array.from([0, 0, 0, 7, 0, 10, 0, 0]))), box('tmpo', data(21, Uint8Array.from([0, 128]))),
    box('covr', data(13, jpeg)), box('----', box('mean', latin1('com.apple.iTunes')), box('name', latin1('iTunSMPB')), data(1, utf8(' 00000000'))));
  const meta = box('meta', [0, 0, 0, 0], box('hdlr', new Uint8Array(25)), ilst);
  const m4a = cat(box('ftyp', latin1('M4A '), be32(0)), box('mdat', new Uint8Array(20)), box('moov', box('mvhd', new Uint8Array(100)), box('udta', meta)));
  const tag = readId3v2(m4a);
  assert.equal(tag.source, 'mp4');
  assert.deepEqual(texts(tag), { TIT2: TITLE, TPE1: ARTIST, TYER: '2021', TRCK: '7/10', TBPM: '128' });
  const apic = apicParts(tag.frames.find((f) => f.id === 'APIC'));
  assert.equal(apic.mime, 'image/jpeg');
  assert.deepEqual(Array.from(apic.image), Array.from(jpeg));
});

test('WAV: LIST/INFO → frames v2.3 (UTF-8 o Latin-1)', () => {
  const sub = (id, bytes) => cat(latin1(id), le32(bytes.length), bytes, bytes.length & 1 ? [0] : []);
  const info = cat(latin1('INFO'), sub('INAM', cat(utf8('Título ñ'), [0])), sub('IART', Uint8Array.from([0x4d, 0x61, 0xf1, 0x61, 0x6e, 0x61, 0])),
    sub('ISFT', cat(latin1('DAW'), [0])), sub('ICRD', cat(latin1('1998-01-01'), [0])));
  const chunk = (id, body) => cat(latin1(id), le32(body.length), body, body.length & 1 ? [0] : []);
  const body = cat(latin1('WAVE'), chunk('fmt ', new Uint8Array(16)), chunk('LIST', info), chunk('data', new Uint8Array(4)));
  const wav = cat(latin1('RIFF'), le32(body.length), body);
  const tag = readId3v2(wav.buffer);
  assert.equal(tag.source, 'riff-info');
  assert.deepEqual(texts(tag), { TIT2: 'Título ñ', TPE1: 'Mañana', TYER: '1998' });
});
