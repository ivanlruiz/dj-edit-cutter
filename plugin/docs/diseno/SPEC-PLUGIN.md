# >>> USER DECISION v2 — READ THIS FIRST. It OVERRIDES every "Capturar button" instruction below AND in your task prompt. <<<

The user does NOT want a manual "Capturar" step. Their mental model: "pones el audio en un canal del Mixer, pones el plugin y
el plugin te toma el audio". They chose: **automatic take on Play + optional file drop**. Implement this instead:

## A. Automatic take ("tomar el audio") — default, no button needed
- A Mixer plugin only receives audio while FL plays it, so the FIRST pass is a listening pass. The wording everywhere is
  "tomar el audio" (not "capturar"): status texts like "Dale Play en FL: el plugin toma el audio del canal",
  "Tomando el audio… 0:42 · 21 compases (escuchas el original)", "Procesando…", "Listo: desde el próximo Play suena
  recortado".
- Rule set (one contiguous taken range [A, E) in host samples, host sample rate):
  1. Transport starts playing and there is no valid take → start taking at the current host position (A = position),
     passing the input through. Keep taking while the transport keeps advancing contiguously.
  2. Transport stops (or jumps) → finalise what was taken; the worker builds grid/plan/render.
  3. Later passes inside [A, E): output the edited audio (as in the original spec: edited sample i at host A + i; silence
     between A + editedLength and E). A pass that runs contiguously past E continues taking (append; pass-through for the
     new part) and re-renders when it stops. A pass that starts before A and reaches A contiguously is prepended the same way
     (buffer [start, A) while passing through, then merge). Positions outside and not contiguous → pass-through, UI says
     "Esta parte todavía no fue tomada: dale Play desde el principio" (or similar clear Spanish).
  4. **Change detection:** during edited playback the plugin still receives the dry input; compare it with the taken audio
     at the same host position (RMS of the difference vs RMS of the signal over ~200 ms windows, ignoring near-silence). If it
     differs clearly for > ~1 s (the user changed the clip, the fader before the slot, an earlier effect…), invalidate the
     take, show "El audio del canal cambió: lo vuelvo a tomar" and restart taking from the current position (pass-through
     for this pass). Tune thresholds so dither/denormals/tiny automation do NOT trigger it; test both directions.
  5. Tempo or sample-rate change → invalidate the take automatically and re-take on the next Play (message as in the spec).
  6. A small secondary button "Volver a tomar el audio" clears the take manually. A/B "Original / Editado" stays.
- Real-time rules from the spec still apply (no allocation/locks/I/O on the audio thread; chunk pool; 15 min max).

## B. Optional file drop ("Suelta aquí el archivo")
- The editor accepts a dropped audio file (juce::FileDragAndDropTarget; from Windows Explorer or FL's Browser): WAV, AIFF,
  FLAC, OGG, MP3 (JUCE_USE_MP3AUDIOFORMAT=1) and on Windows M4A/AAC/WMA via JUCE_USE_WINDOWS_MEDIA_FORMAT=1 (the processor
  engineer may add these compile definitions to plugin/CMakeLists.txt). Decode + resample to the host rate off the audio
  thread (juce::WindowedSincInterpolator or equivalent quality), then the plugin has the whole audio instantly.
- **Alignment with FL's timeline:** on the next Play, automatically find where the file sits: cross-correlate a few
  seconds of the incoming input with the file (downsampled mono, normalised cross-correlation of envelopes and/or waveform,
  robust to gain changes from earlier effects/fader), off the audio thread, with a confidence threshold. When found:
  A = hostSample − fileOffset and the whole file is the take ("Ubicado: el archivo empieza en el compás 5"). Pass-through
  until aligned. If no match after ~8 s of playback: "No encuentro este audio en el canal. ¿Pusiste el plugin en el canal
  correcto?" plus a fallback button "El archivo empieza en el compás 1" (A = host sample of bar 1 / time 0).
- A dropped file replaces any previous take. It is saved in the plugin state by path (+ size/mtime); if missing on
  reload, fall back to automatic take.

## C. Tests to add (host simulation)
- Auto take on first Play (no button), edited on the second Play; append past E; prepend before A; jump outside.
- Change detection triggers on a changed input (different clip, +6 dB gain change on part of it) and does NOT trigger on
  identical input, on −90 dB noise differences, or on silence.
- File drop: file identical to the channel audio but starting at host bar 5 → aligned within 1 sample (or within the
  correlation resolution, then refined) after a few seconds of Play; gain-changed input (−6 dB, EQ'd) still aligns; wrong
  file → no alignment + message; fallback button works. Resampling from 44.1 kHz file to 48 kHz host.

---
# DJ Edit Cutter — FL Studio mixer plugin (VST3, Windows) — build spec

Read first: SPEC.md, SPEC-METER.md (including "Decisions" and "User decisions v2") and the WEB APP CODE in
/home/user/dj-edit-cutter (js/**). The web app is the reference implementation: its algorithms, constants and Spanish
texts are ported, not reinvented. Where the web code and the older specs differ, the CODE wins.

## Product (decided with the user)

- An audio EFFECT that the user inserts in an FL Studio **Mixer slot** (a track like a guitar/piano recording, or the
  Master with a whole song). Format **VST3, Windows x64** (FL Studio 20+). Name "DJ Edit Cutter", vendor "ivanlruiz".
- Works **like FL's Edison**: because trimming each bar makes the result run AHEAD of the original, a real-time effect cannot
  do it on the live stream. So:
  1. The user presses **"Capturar"** and plays the song/section in FL once. The plugin records its input together with the
     host position (sample position, ppq, tempo, time signature, last bar start). Input passes through unchanged meanwhile.
  2. When the transport stops, the capture is finalised. A background thread builds the bar grid, the edit plan and renders
     the edited audio.
  3. On every later Play, inside the captured range the plugin **replaces its input with the edited audio**, aligned to the
     host timeline sample-accurately (edited output sample i plays at host sample captureStartHostSample + i). After the
     edited audio ends (it is shorter), it outputs silence until the end of the captured range; outside the captured range
     it passes the input through. An "Original / Editado" A/B switch lets the user compare.
  4. The result can be **dragged from the plugin into the FL Playlist** (a WAV written to disk, then an external file drag)
     or **exported as WAV** (16/24-bit) with a file chooser. FL's own "Export song" also contains the edited audio because the
     plugin plays it during offline render too (isNonRealtime) — must work.
- **Where bars come from** (user choice "De FL, o detectar"):
  - Default **"Cuadrícula de FL"**: beats/bars from the host grid recorded during capture (ppq + time signature + bar
    start). No detection needed for material recorded in time with the project.
  - Button **"Detectar del audio"**: run the ported web analysis on the captured audio (for songs that do not follow FL's
    grid: live recordings, imported songs at another tempo). Corrections as in the web: Tempo ×2 / ÷2, Tempo manual,
    Marcar tempo (tap), Mover el 1 ◀ ▶, Este beat es el 1, Restablecer. In FL-grid mode only "Mover el 1 ◀ ▶" applies
    (offset of the bar start in beats, for pickups).
- **Tempo change after capture** (user choice): the plugin shows "Cambió el tempo del proyecto: vuelve a capturar" and passes
  the input through (no time-stretching). Same for a sample-rate change.
- **Functions = the web's**: "Recortar cada compás" (ON by default; amount chips ½ tiempo (corchea) → default, 1 tiempo,
  2 tiempos, ¼ tiempo (semicorchea), Alargar: repetir el último tiempo, Otro compás…; "Suavizado de empalmes" 5–40 ms, default
  10) and "Quitar compases del final" (OFF by default; N bars, fade 0–16 beats, curve Lineal/Suave/Exponencial). The plugin
  tells the user which time signature to set in FL so the grid matches ("Pon el compás del proyecto de FL en 7/8").
- UI in **Spanish**, same tone and wording as the web (tú-form imperatives, as in the web app); dark theme close to the web app (cyan waveform, orange/red cut colours,
  purple for Mode 2, red hatched removed slices, green repeated slices). Resizable editor (min ~900×560).

## Repository layout (monorepo: /home/user/dj-edit-cutter/plugin)

```
plugin/
  CMakeLists.txt                 JUCE 8.0.15 via FetchContent (GIT_TAG 8.0.15); honour FETCHCONTENT_SOURCE_DIR_JUCE for
                                 offline local builds. Targets: djec_core (static lib, NO JUCE), djec_core_tests (doctest),
                                 DJEditCutter (juce_add_plugin, FORMATS VST3 [+ Standalone only if trivial]),
                                 djec_host_tests (console app linking the plugin's shared code, simulates a host).
  core/include/djec/*.h          pure C++17, namespace djec, no JUCE, no allocation-free requirement (runs off the audio thread)
  core/src/*.cpp                 (analysis/*, bars, meter, splice, fade, capture, session …)
  source/                        JUCE plugin code (processor, editor, UI components, strings)
  tests/core/*_test.cpp          doctest unit + parity tests for the core
  tests/host/*.cpp               host-simulation tests of the AudioProcessor (fake playhead)
  tests/third_party/doctest.h    vendored (MIT)
  tools/golden-*.mjs             Node scripts that run the WEB JS implementation on synthetic cases and write golden
                                 JSON/WAV into a build dir (NOT committed) for C++ parity tests
.github/workflows/plugin.yml     Windows (MSVC) + Linux builds, tests, pluginval, artifact upload
```

Build dirs, golden outputs and downloaded deps are never committed (add to .gitignore). Local JUCE clone:
/tmp/claude-0/-home-user-showbies-privacidad/7332b3b8-b3f8-53fd-8064-8a834ec05999/scratchpad/deps/juce (pass
-DFETCHCONTENT_SOURCE_DIR_JUCE=<that path>). pluginval Linux binary: …/scratchpad/deps/pluginval.

## Core interfaces (contract between engineers — keep names; add fields if needed and document)

```cpp
namespace djec {

// ---- analysis (port of js/analysis/*) ----
struct AnalysisResult {                 // mirrors the JS AnalysisResult (seconds)
  double duration = 0, musicStart = 0, musicEnd = 0, lastOnset = 0, bpm = 0, bpmLo = 0, bpmHi = 0;
  std::vector<double> beats, beatStrength;
  int beatsPerBar = 4; bool meterAuto = true;
  std::vector<int> positions, downbeats, forcedDownbeats;
  double confBeats = 0, confBars = 0; int tailBeatsFrom = -1;
};
struct AnalyzeOptions { double minBpm = 50, maxBpm = 220; int beatsPerBar = 0; /* 0 = auto */ };
using ProgressFn = std::function<void(const char* stage, double fraction)>;  // may be empty
class Analyzer {                        // keeps features/samples cached for retrack/relabel (like the JS worker)
 public:
  AnalysisResult analyze(const float* mono, size_t n, double sampleRate /*22050*/, const AnalyzeOptions&, ProgressFn = {});
  AnalysisResult retrack(double bpmHint /*0 = default search*/, bool strict);
  AnalysisResult relabel(int beatsPerBar /*0 = auto*/, const std::vector<int>& forcedDownbeats);
};
std::vector<float> toAnalysisMono(const float* const* channels, int numChannels, size_t n, double sampleRate,
                                  double targetRate = 22050);   // port of the web's sinc resampler + downmix

// ---- bar model (port of js/core/bars.js) ----
struct Bar { int index; int beatIndex; double start, end; int beatCount; };
std::vector<Bar> getBars(const AnalysisResult&);
int findLastBarIndex(const AnalysisResult&);
// + cutForBarsRemoved, barsRemovedAt, nearestBeatIndex, stepBeat, stepBar as in bars.js

// ---- host grid → AnalysisResult-shaped grid ----
struct HostBlockInfo { int64_t hostSample; double ppq, bpm; int tsNum, tsDen; double lastBarStartPpq; bool ppqValid, barValid; };
struct CaptureInfo {                    // produced by the capture, consumed by the grid builder
  double sampleRate; int64_t hostStartSample; size_t numSamples;
  std::vector<std::pair<int64_t /*capture sample offset*/, HostBlockInfo>> blocks;   // one per processed block
};
AnalysisResult gridFromHost(const CaptureInfo&, int barOffsetBeats = 0);
  // beats at every host beat (1/tsDen note) inside the capture, positions from the host bar start + offset,
  // beatsPerBar = tsNum, duration = numSamples/sampleRate, musicEnd = duration, lastOnset = duration (so every complete bar
  // is transformed), confBeats = confBars = 1. Handles tempo automation piecewise (ppq→sample from the block table).

// ---- edit plan (port of js/core/meter.js + js/ui/edit-plan.js) ----
struct Segment { double start, end; };            // source seconds, output order
struct MeterChoice { int targetNum, targetDen; };  // from amount chips or "Otro"
struct MeterDescription { int unitsPerBeat, sourceUnits, targetUnits, delta; std::string unitName, text, error; };
MeterDescription describeMeterChange(int beatsPerBar, int targetNum, int targetDen, int sourceDen = 4);
struct MeterPlan { std::vector<Segment> segments, removed, repeated; int barsChanged = 0, delta = 0;
                   double outputDuration = 0; std::string error, info; };
MeterPlan planMeterChange(const AnalysisResult&, int targetNum, int targetDen, int sourceDen, double limitTime /*<0 = none*/,
                          double preroll, const std::function<double(double)>& snap = {});
struct EditSettings {                              // everything the user sets (mirrors the web UI state)
  bool trimEachBar = true; std::string amount = "eighth"; int otherNum = 7, otherDen = 8; double crossfadeSec = 0.010;
  bool removeEnd = false; int barsToRemove = 1; double fadeBeats = 0; std::string curve = "smooth";
};
struct EditPlan { std::vector<Segment> segments; double crossfadeSec, fadeOutSec; std::string curve; MeterPlan meter;
                  double cutTime; std::string blocker; /* Spanish reason why nothing can be rendered, or empty */ };
EditPlan buildEditPlan(const AnalysisResult& grid, int sourceDen, const EditSettings&);   // port of buildEditPlan
std::vector<std::pair<std::string,std::string>> meterAmountChips(int beatsPerBar);       // (amount id, label) like the web

// ---- render (port of js/audio/splice.js + edit.js fades) ----
float fadeGain(double x, const std::string& curve);
void renderSegments(const float* const* in, int numChannels, size_t inLength, double sampleRate,
                    const std::vector<Segment>&, double crossfadeSec, double fadeOutSec, const std::string& curve,
                    std::vector<std::vector<float>>& out);   // same sample math as the JS (lengths, adaptive crossfade)
}
```

## Plugin (JUCE) behaviour requirements

- Audio thread (processBlock): NO allocation, NO locks that can block, NO file I/O, NO logging. Capture writes into memory
  obtained off the audio thread (e.g. a pool of fixed-size chunks refilled by a background thread, lock-free handoff; if the
  pool runs dry, stop capturing and flag it — never allocate). Rendered output is published to the audio thread with an
  atomic pointer swap; the old buffer is freed off the audio thread. Max capture length 15 min (show it).
- Capture state machine: Vacío → Armado ("Pulsa Play en FL") → Capturando (elapsed time, bars) → Procesando → Listo;
  errors/warnings: salto de posición durante la captura (capture stops at the jump and keeps what it has), cambio de tempo o de
  frecuencia de muestreo (vuelve a capturar), captura demasiado larga. Cancel/Borrar captura.
- Playback mapping by host sample position; handle any block size (incl. 1 and odd sizes), mono and stereo buses, bypass,
  transport jumps/loops (each block independently maps host position → rendered index), isNonRealtime export.
- State (getStateInformation/setStateInformation): all settings + capture metadata + the captured audio stored as a WAV
  file in %APPDATA%/DJ Edit Cutter/Capturas/<uuid>.wav (path+hash in the state); on load, if the file exists re-run the
  pipeline, otherwise status "Vuelve a capturar". Write the capture file off the audio thread right after capture.
- Drag to Playlist: button/handle "Arrastrar a FL" → write the rendered audio to Documents/DJ Edit Cutter/<name> (7-8).wav
  (name from the track name if the host gives it, else "Captura") and start an external file drag. "Exportar WAV…" uses an
  async FileChooser.
- Editor: status bar; waveform of the captured audio with beats/downbeats/bar numbers, red hatched removed slices, green
  repeated slices, Mode-1 tail, host playhead; zoom (wheel/ctrl) and scroll; the panels listed in "Product". All strings
  Spanish. Timer-driven refresh (~30 Hz) reading lock-free/atomic state from the processor.
- VST3 metadata: manufacturer code "Ivlr", plugin code "Djec", category Fx, stereo in/out (accept mono). No latency.
