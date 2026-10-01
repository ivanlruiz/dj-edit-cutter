# DJ Edit Cutter

App web para editar canciones compás a compás. Carga una canción, la app encuentra los beats y los compases, y te
deja hacer dos cosas, por separado o juntas:

1. **Recortar cada compás** (cambiar el compás). Quita un trozo del final de *cada* compás de la canción, o lo repite:
   de 4/4 a 7/8, 3/4, 2/4, 15/16, 5/4 o el compás que quieras. No estira el tiempo: corta trozos de audio y los
   empalma con crossfades cortos, como los edits de «canción X pero en 7/8».
2. **Quitar compases del final**. Corta la canción unos compases antes de su final, con un fade out ajustable.

**Úsala aquí: <https://ivanlruiz.github.io/dj-edit-cutter/>**

No hay que instalar nada. Funciona en el navegador del ordenador o del móvil.

## Plugin para FL Studio

¿Editas en FL Studio? También hay un plugin VST3 para Windows que hace lo mismo dentro del **Mixer**: lo pones en el
canal donde suena tu audio, le das Play una vez para que tome el audio y, desde el siguiente Play, el canal suena
recortado y alineado con la línea de tiempo. Después lo arrastras al Playlist o lo exportas como WAV. Instalación y
uso, paso a paso: **[plugin/README.md](plugin/README.md)**. (Todavía no se ha probado dentro de FL Studio.)

## Tu música no sale de tu dispositivo

Todo se procesa en tu navegador. La página es estática: no hay ningún servidor que reciba tu música y la canción
nunca se sube. Lo único que se guarda, en ese mismo navegador, son tus preferencias (formato, fade, suavizado, cuánto
recortar de cada compás…).

## Formatos

- **Para abrir:** MP3, WAV, FLAC, M4A/AAC y OGG/Opus. En general, cualquier archivo de audio que tu navegador sepa
  reproducir. La canción se abre a su frecuencia de muestreo original, sin convertirla.
- **Para guardar:** WAV (16 o 24 bits) o MP3 (320, 256 o 192 kbps). El MP3 se guarda a 44,1 o 48 kHz (o a 32 kHz si
  el original lo es): una canción a 96 kHz sale en MP3 a 48 kHz; en WAV conserva su frecuencia.
- **Etiquetas:** si el original tiene etiquetas ID3 (lo normal en un MP3), marca «Conservar etiquetas» para copiar
  título, artista, álbum y carátula al archivo nuevo (MP3 o WAV). Los datos de análisis de otros programas (por
  ejemplo, los cue points) se descartan, porque ya no coincidirían con el audio editado.

## Cómo se usa

### 1. Cargar la canción

Arrastra el archivo a la página o toca el recuadro para elegirlo. El análisis se hace en tu dispositivo: en un
ordenador, una canción de 4:30 tarda poco más de un segundo; en un móvil, algo más. Cuando termina, verás la forma
de onda con la cuadrícula: líneas finas en cada beat, líneas gruesas y números en cada «1» (inicio de compás).

Arriba de los paneles aparecen el tempo (por ejemplo «≈ 120 BPM (118–122)»: el rango indica cuánto varía), el
compás, el número de compases y un aviso de confianza: **Detección fiable**, **Detección aceptable** o **Revisa la
cuadrícula**.

### 2. Revisar la cuadrícula con el metrónomo

Activa **Clic de metrónomo** y pulsa **Reproducir**. El clic agudo tiene que caer en el «1» de cada compás y los
demás clics en los beats. Si no es así, corrígelo antes de editar (panel **1 · Revisa los compases**):

| Problema | Qué hacer |
| --- | --- |
| El clic va el doble de rápido o a la mitad | **Tempo ×2** o **Tempo ÷2** |
| El clic va a otro ritmo (por ejemplo, 3/2 del real) | Escribe el tempo en **Tempo manual**, o márcalo tocando **Marcar tempo** (o la tecla T) al ritmo de la canción, y pulsa **Aplicar** |
| La canción es de 3 (vals) o de otro compás | **Tiempos por compás**: Auto, 2, 3, 4, 5, 6 o 7 |
| El acento cae en otro beat, no en el «1» | **Mover el 1** ◀ ▶ desplaza el «1» un beat antes o después, o pon el cabezal sobre un «1» de verdad y pulsa **Este beat es el 1** |
| Quieres volver a empezar | **Restablecer** |

Cuando fijas el «1» a mano, el aviso cambia a «Cuadrícula ajustada a mano».

### 3. Recortar cada compás (activado por defecto)

Panel **2 · Recortar cada compás**. Elige cuánto quitar de cada compás; el botón te dice el compás que resulta
(los ejemplos son para una canción en 4/4):

- **½ tiempo (corchea) → 7/8** (la opción por defecto)
- **1 tiempo → 3/4**
- **2 tiempos → 2/4**
- **¼ tiempo (semicorchea) → 15/16**
- **Alargar: repetir el último tiempo → 5/4**
- **Otro compás…**: escribe el compás (numerador de 1 a 32; denominador 2, 4, 8 o 16)

Los botones se adaptan al compás de la canción (en una de 3/4, «½ tiempo» da 5/8). Siempre se quita o se repite el
**final** de cada compás: el «1» queda entero. Los compases de entrada antes del primer «1» y el último compás (el
del golpe final) no se tocan.

En la onda, lo que se quita se ve en **rojo** y lo que se repite en **verde** («×2»). Pulsa **Escuchar con el nuevo
compás** (o la tecla P) para oír el resultado desde el cabezal.

**Suavizado de empalmes** (5–40 ms, por defecto 10 ms) es la duración del crossfade en cada empalme: más corto suena
más nítido y más largo, más suave. Si oyes clics o cortes bruscos, súbelo un poco.

¿Solo quieres acortar el final? Apaga el interruptor de este panel.

### 4. Quitar compases del final (desactivado por defecto)

Enciende el interruptor del panel **3 · Quitar compases del final**. Elige cuántos compases quitar con − / + o con
los botones 1, 2, 4, 8, 16 y 32. Se cuentan desde el último compás, el del golpe final. Verás dónde queda el corte
y cuánto dura la canción antes y después.

Para ajustar el corte a mano:

- arrastra el marcador naranja en la onda (con Alt o Mayús se mueve libre, sin imán);
- usa los botones para moverlo un beat, un compás o 10 ms;
- **Imán a los beats** hace que el marcador se pegue a los beats.

Si usas los dos modos a la vez, primero se recorta cada compás y la canción termina donde está el corte.

### 5. El fade

En el mismo panel, **Fade out** va en beats: 0 (corte seco, con una rampa mínima para que no haga clic), ½, 1, 2,
4, 8 o 16 beats; al lado ves cuántos segundos son. **Curva del fade**: Lineal, Suave o Exponencial.

### 6. Escuchar

- **Reproducir** suena la canción original, con el clic si está activado.
- **Escuchar con el nuevo compás** suena el resultado desde el cabezal; si tocas la onda mientras suena, sigue desde
  ahí.
- **Escuchar el final** reproduce los últimos 8 segundos con el corte y el fade.

### 7. Guardar

En **4 · Guardar**, elige el formato y pulsa **Descargar**. Antes del botón verás un resumen (por ejemplo «Compás 7/8
· −2 compases del final · dura 3:52 → 3:14») y el nombre del archivo, por ejemplo `Mi canción (7-8, edit -2
compases).mp3`. Si no se puede guardar (por ejemplo, con los dos modos apagados), el botón queda desactivado y
debajo aparece el motivo.

### Atajos de teclado

| Tecla | Acción |
| --- | --- |
| Espacio | Reproducir / pausa |
| ← → | Mover el corte un beat (con «Quitar compases del final») |
| Mayús + ← → | Mover el corte un compás |
| + − | Acercar / alejar la onda |
| M | Clic de metrónomo |
| P | Escuchar el resultado (o el final) |
| T | Marcar tempo |

En la onda: toca para ir a ese punto, arrastra para desplazarte y pellizca (o usa la rueda) para el zoom.

## Si la detección falla

- **Escucha siempre con el clic** antes de guardar, sobre todo si ves «Revisa la cuadrícula».
- **Tempo al doble o a la mitad:** es el error más común. Pulsa **Tempo ×2** o **Tempo ÷2** y vuelve a escuchar.
- **Tempo raro (ni doble ni mitad):** escribe el tempo que tú oyes en **Tempo manual** o márcalo con **Marcar tempo**
  y pulsa **Aplicar**. Si la app no encuentra un pulso cerca de ese tempo, te lo dice; prueba con el doble o la mitad
  de lo que escribiste, o pulsa **Restablecer**.
- **El «1» está corrido:** **Mover el 1** ◀ ▶, o pon el cabezal justo en un «1» y pulsa **Este beat es el 1**. Toda
  la cuadrícula se mueve con él.
- **El final no está donde debería** (aplausos, un fade out largo, un ritardando muy fuerte): con «Quitar compases
  del final», arrastra el marcador al punto exacto y escucha con **Escuchar el final**.

## Limitaciones conocidas

- **«Recortar cada compás» no estira el tiempo.** Quita o repite trozos de audio, así que las voces y las notas
  largas se cortan en cada empalme: una palabra puede quedar a medias o repetirse. Es el sonido típico de estos
  edits; un suavizado más largo lo disimula, pero no lo evita.
- **Música sin ataques claros** (pads, voz sola, cuerdas muy ligadas): la cuadrícula puede salir mal. La app suele
  avisar con «Revisa la cuadrícula»; corrígela con el tempo manual.
- **Otros casos difíciles:** ritardandos muy fuertes al final (el tempo baja a la mitad o menos), punk muy rápido y
  muy comprimido (puede salir a la mitad del tempo) y cambios de compás dentro de la canción. El tempo automático se
  busca entre 50 y 220 BPM.
- **El compás original se interpreta siempre como M/4** (el beat es una negra). En una canción en 6/8 o 12/8,
  «½ tiempo» corta a mitad del beat y la app ajusta cada empalme al ataque más cercano (hasta 25 ms).
- **Probada solo en Chromium** (el motor de Chrome y Edge), en escritorio y con emulación de móvil. No se ha probado
  en Safari, Firefox ni en iPhone o Android reales. En iPhone, si no oyes nada, quita el modo silencio.
- **Canciones muy largas:** la canción entera se decodifica en memoria y exportar necesita más todavía. En un móvil
  con poca memoria, una canción de 10 minutos o más puede fallar.

## Para desarrolladores

Sitio estático: HTML, CSS y módulos ES sin compilar, sin dependencias de npm en tiempo de ejecución. El único código
de terceros es [lamejs](https://github.com/zhuker/lamejs) (codificador MP3, LGPL) en `vendor/`. Todo usa URLs
relativas, así que funciona servido desde `/dj-edit-cutter/` en GitHub Pages.

### Probar en local

Hace falta Node 22 (sirve ≥ 20). La app tiene que servirse por HTTP (los módulos ES y los workers no funcionan con
`file://`):

```sh
npm run serve                  # http://localhost:8080 (usa npx http-server)
python3 -m http.server 8080    # alternativa sin npm
```

### Tests

```sh
npm test                       # tests unitarios (node --test, sin dependencias)
npm run e2e                    # la app completa en Chromium
npm run e2e:all                # app + worker de análisis + audio en el navegador
```

Los tests de navegador usan Playwright (no está en `package.json`). Instálalo aparte:

```sh
npm install --no-save playwright@1.56.1
npx playwright install chromium          # en Linux: --with-deps para las librerías del sistema
```

Los scripts cargan `playwright` del proyecto o, si defines `PLAYWRIGHT_MODULE`, esa ruta (útil con una instalación
global: `PLAYWRIGHT_MODULE=$(npm root -g)/playwright/index.js`). GitHub Actions ejecuta `npm test` y los tres tests
de navegador en cada push y pull request (`.github/workflows/test.yml`).

### Benchmark del análisis

```sh
npm run bench -- --analyze                                   # suite sintética con verdad de referencia
node tools/bench.js --analyze --sets suite,stress,extra,limits \
  --variants none,limit12,clip4,clip8,applause               # conjuntos y variantes (masterización, aplausos)
REAL_AUDIO_DIR=ruta/a/clips node tools/bench.js --analyze --real   # añade clips reales
```

Las canciones de prueba se generan por síntesis con su verdad (beats, compases, último compás). Los clips reales no
están en el repositorio: cada `<nombre>.wav` necesita al lado un `<nombre>.madmom.beats.json` con los beats de
referencia. Por defecto se buscan en `tmp/real-audio/` (ignorada por git). Los detalles y las cifras medidas están en
[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

### Estructura

```
index.html            página única (importmap con ?v=N para la caché)
css/app.css           estilos (claro/oscuro, móvil primero)
js/main.js            controlador de la interfaz
js/ui/                forma de onda (canvas), plan de edición y textos/formatos (puros)
js/audio/             decodificar, reproducir, cortar/empalmar, WAV, ID3, MP3 (workers), exportar
js/core/              modelo de compases (bars.js) y cambio de compás (meter.js), puros
js/analysis/          análisis rítmico (puro) + worker y cliente
vendor/               lamejs (LGPL)
tests/                tests unitarios (*.test.js) y de navegador (*.e2e.mjs)
tests/synth/          generador de canciones sintéticas con verdad de referencia
tools/bench.js        benchmark del análisis
docs/ARQUITECTURA.md  cómo funciona por dentro
plugin/               plugin VST3 para FL Studio (C++/JUCE): ver plugin/README-dev.md
```

### Publicar

Configura GitHub Pages para servir la rama `main` desde la raíz (ya incluye `.nojekyll`). **En cada publicación,
sube la versión `?v=N` de `index.html`**: en todas las entradas del importmap, en `css/app.css?v=N` y en
`js/main.js?v=N`, todas con el mismo número. GitHub Pages deja los archivos 10 minutos en la caché del navegador y,
sin ese cambio, al recargar se mezclarían módulos viejos y nuevos. `tests/deploy-version.test.js` comprueba que el
importmap está completo y que todas las versiones coinciden, pero no que la hayas subido.
