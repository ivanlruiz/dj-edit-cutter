# DJ Edit Cutter — plugin VST3 (desarrollo)

Plugin de efecto para el Mixer de FL Studio (VST3, Windows x64) hecho con JUCE 8.0.15 y CMake.
La app web (`js/**`) es la implementación de referencia: el core en C++ (`plugin/core`) es un port y
se compara contra ella con datos *golden* generados con Node.

## Requisitos

- CMake ≥ 3.22 y un compilador C++17 (MSVC 2022 o más nuevo en Windows; GCC 11+ o Clang 14+ en Linux).
- Ninja (recomendado en Linux).
- Node ≥ 18 (opcional: sin Node los tests de paridad se saltan).
- Linux: `libasound2-dev libfreetype-dev libfontconfig1-dev libx11-dev libxcomposite-dev libxcursor-dev
  libxext-dev libxinerama-dev libxrandr-dev libxrender-dev libgl1-mesa-dev` (y `xvfb` para pluginval).

## Compilar y probar

Desde la raíz del repo:

```sh
cmake -S plugin -B plugin/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build plugin/build -j4
ctest --test-dir plugin/build --output-on-failure
```

En Windows (Visual Studio): `cmake -S plugin -B plugin/build -A x64`, luego
`cmake --build plugin/build --config Release` y `ctest --test-dir plugin/build -C Release`.

JUCE se descarga solo (FetchContent, tag 8.0.15). Para no descargarlo otra vez, apunta a un clon local:
`-DFETCHCONTENT_SOURCE_DIR_JUCE=/ruta/a/JUCE`.

El VST3 queda en `plugin/build/DJEditCutter_artefacts/Release/VST3/DJ Edit Cutter.vst3`
(y la versión Standalone, para probar a mano, en `.../Release/Standalone/`).

`plugin/build/` está en `.gitignore`: nunca subas builds ni datos golden.

## Opciones de CMake

| Opción | Por defecto | Para qué |
| --- | --- | --- |
| `DJEC_BUILD_PLUGIN` | `ON` | `OFF` compila solo el core y sus tests, sin JUCE (rápido). |
| `DJEC_BUILD_TESTS` | `ON` | Tests con doctest registrados en CTest. |
| `DJEC_BUILD_STANDALONE` | `ON` | Añade la app Standalone además del VST3. |
| `DJEC_GOLDEN` | `ON` | Genera los datos golden con Node antes de los tests. |
| `DJEC_VERSION` | `0.1.0` | Versión `x.y.z` (el CI la toma del tag `plugin-vX.Y.Z`). |

## Targets

- `djec_core`: librería estática en C++17 puro (sin JUCE). Entra solo cualquier `.cpp` de
  `plugin/core/src/` (y subcarpetas); los headers públicos van en `plugin/core/include/djec/`.
- `djec_core_tests`: doctest con `plugin/tests/core/*_test.cpp`.
- `golden`: ejecuta cada `plugin/tools/golden-*.mjs` con Node así:
  `node plugin/tools/golden-xxx.mjs <build>/golden` (desde la raíz del repo). Solo se vuelve a ejecutar
  si cambia el script, `js/**`, `tests/synth/**` o `plugin/tools/**`.
- `DJEditCutter`: código del plugin (`plugin/source/*.cpp`, `plugin/source/ui/*.cpp`); los formatos son
  `DJEditCutter_VST3` y `DJEditCutter_Standalone`.
- `djec_host_tests`: doctest que enlaza el código del plugin y simula un host
  (`plugin/tests/host/*.cpp`).

Los archivos nuevos entran solos: el build vuelve a configurar CMake cuando cambia la lista.

En los tests están definidas `DJEC_GOLDEN_DIR` (`<build>/golden`), `DJEC_GOLDEN_ENABLED` (1 si hay
Node), `DJEC_PLUGIN_SOURCE_DIR` y `DJEC_REPO_ROOT`. Si falta un archivo golden, el test se salta
(con un `MESSAGE`) en vez de fallar.

## Cómo está hecho

Guía de uso para el usuario: [README.md](README.md). Diseño: `docs/diseno/` (la sección «USER DECISION v2» de
`SPEC-PLUGIN.md` manda sobre el resto).

- `core/` (`namespace djec`, sin JUCE): análisis rítmico, compases, plan de edición, render de los empalmes,
  cuadrícula desde las posiciones del host (`grid.h`) y ubicación de un archivo en el audio del canal (`align.h`).
  Port de la app web; los tests de paridad lo comparan con ella.
- `source/` (`namespace djec::plugin`):
  - `TakeEngine`: el hilo de audio (toma automática al darle Play, reproducción de lo editado alineada con la línea
    de tiempo, detección de cambios en el canal y del tempo, escucha para ubicar un archivo). Sin reservar memoria,
    sin bloqueos y sin E/S: habla con el resto por las colas del `Hub` (`Take.h`, `ChunkPool.h`).
  - `Worker`: el hilo de fondo; dueño de la toma, la cuadrícula, el plan y el render. Publica una
    `PlaybackSnapshot` al audio (puntero atómico) y una `SessionView` inmutable a la interfaz (`PluginState.h`).
  - `TakeFiles` y `Paths`: carpeta de las tomas (`%LOCALAPPDATA%\DJ Edit Cutter\Tomas` en Windows), registro de los
    WAV en uso (de todo el proceso) y la limpieza (3 GB / 60 días, nunca un archivo en uso), que corre en el worker.
  - `PluginProcessor`: el `AudioProcessor` de JUCE, el estado del proyecto y la API que usa la interfaz.
  - `PluginEditor` y `ui/`: la interfaz (todos los textos en `ui/Strings.h`).
- `tests/host/`: simulan a FL (cabezal falso, bloques de cualquier tamaño) contra el procesador; `alloc_test.cpp`
  comprueba que `processBlock` no reserva memoria.
- `tests/ui/snapshot.cpp` (`djec_ui_snapshot`): abre el editor en cada estado y guarda capturas PNG:
  `plugin/build/tests-ui/djec_ui_snapshot <carpeta> [--font "Nombre"] [--focus]`. En CTest (`djec_ui_layout`) solo
  comprueba el diseño, sin PNG.

## Validar con pluginval

```sh
xvfb-run -a pluginval --strictness-level 10 \
  --validate "$PWD/plugin/build/DJEditCutter_artefacts/Release/VST3/DJ Edit Cutter.vst3"
```

(Añade `--skip-gui-tests` si no hay pantalla.) Descarga: https://github.com/Tracktion/pluginval/releases (v1.0.4).

## CI

`.github/workflows/plugin.yml` compila en Linux (GCC + Ninja) y Windows (MSVC), pasa los tests y
pluginval (strictness 10) y deja el artefacto **DJ-Edit-Cutter-VST3-Windows** (la carpeta
`DJ Edit Cutter.vst3` + `LEEME.txt`). Un tag `plugin-vX.Y.Z` publica además una release con el `.zip`.
