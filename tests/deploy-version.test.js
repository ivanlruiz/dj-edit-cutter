// Publicación en GitHub Pages: los archivos quedan 10 min en la caché del navegador. index.html versiona (?v=) la hoja
// de estilos, main.js y, con un import map, TODOS los módulos que carga el hilo principal. Si falta uno, tras publicar
// se mezclarían módulos viejos y nuevos (p. ej. un splice.js nuevo con un edit.js viejo: la app no arranca).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Imports estáticos y dinámicos relativos de un módulo (rutas relativas a ROOT, sin query)
function importsOf(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = [];
  const re = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|^\s*import\s*['"](\.[^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    const spec = (m[1] || m[2] || m[3]).split('?')[0];
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
  }
  return out;
}

function moduleGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...importsOf(f));
  }
  return seen;
}

test('index.html: import map con TODO el grafo de módulos del hilo principal y la misma versión en todo', () => {
  const main = html.match(/<script type="module" src="js\/main\.js\?v=([^"]+)"><\/script>/);
  assert.ok(main, 'main.js con ?v=');
  const css = html.match(/<link rel="stylesheet" href="css\/app\.css\?v=([^"]+)">/);
  assert.ok(css, 'app.css con ?v=');
  const v = main[1];
  assert.equal(css[1], v, 'app.css y main.js con la misma versión');
  const mapText = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(mapText, 'hay import map');
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'), 'el import map va antes del primer módulo');
  const map = JSON.parse(mapText[1]).imports;
  const graph = moduleGraph('js/main.js');
  graph.delete('js/main.js');
  assert.ok(graph.size >= 10, `grafo de ${graph.size} módulos`);
  for (const f of graph) {
    assert.equal(map[`./${f}`], `./${f}?v=${v}`, `${f} versionado en el import map`);
  }
  for (const [k, val] of Object.entries(map)) {
    const f = k.replace(/^\.\//, '');
    assert.ok(graph.has(f), `${k}: el import map solo lista módulos del grafo`);
    assert.equal(val, `${k}?v=${v}`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} existe`);
  }
});

test('el worker MP3 y lamejs heredan la versión del módulo que los crea', () => {
  const exp = fs.readFileSync(path.join(ROOT, 'js/audio/export.js'), 'utf8');
  assert.match(exp, /new URL\(`\.\/mp3-worker\.js\$\{new URL\(import\.meta\.url\)\.search\}`, import\.meta\.url\)/);
  const w = fs.readFileSync(path.join(ROOT, 'js/audio/mp3-worker.js'), 'utf8');
  assert.match(w, /importScripts\('\.\.\/\.\.\/vendor\/lame\.min\.js' \+ \(\(self\.location && self\.location\.search\) \|\| ''\)\)/);
});
