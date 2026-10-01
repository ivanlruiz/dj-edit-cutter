// API del procesador para la interfaz (el editor). Todo lo que hay aquí se puede leer desde el hilo de mensajes (o
// cualquier hilo que no sea el de audio) sin bloquear el audio.
//
// Lectura: DjecAudioProcessor::getViewState() devuelve un ViewState:
//   - session: instantánea inmutable (shared_ptr<const SessionView>) que publica el worker cada vez que algo cambia
//     (toma, cuadrícula, plan, render, picos, avisos). Cambia pocas veces: compara session->version para redibujar.
//   - live: lo que cambia en cada bloque de audio (transporte, posición, toma en curso, qué suena), leído de atómicos.
//   - phase + statusText: la línea de estado en español, ya armada.
// Órdenes: métodos de DjecAudioProcessor (ver PluginProcessor.h); son asíncronas (las ejecuta el worker) salvo las
// de exportar/arrastrar, que escriben el archivo en el hilo que llama.
//
// Tiempos: los de la cuadrícula y el plan (grid.beats, plan.segments, plan.meter.removed…) son SEGUNDOS DESDE EL
// PRINCIPIO DE LA TOMA (muestra 0 de la toma = muestra hostStart del host). El editado suena alineado: la muestra i
// de lo editado suena en hostStart + i.
#pragma once

#include "djec/analysis_result.h"
#include "djec/bars.h"
#include "djec/edit_plan.h"
#include "djec/grid.h"

#include <juce_core/juce_core.h>

#include <cstdint>
#include <memory>
#include <vector>

namespace djec::plugin
{

/** De dónde salen los compases. */
enum class GridMode
{
    Host,    // «Cuadrícula de FL» (por defecto): posición del host anotada durante la toma
    Detect   // «Detectar del audio»: análisis portado de la web
};

/**
 * De dónde sale el compás original de la cuadrícula de FL (el que se recorta: el plugin pide poner FL en el compás
 * NUEVO, y una toma posterior leería ese compás de FL sobre un audio que sigue en el original).
 */
enum class MeterOrigin
{
    Host,        // el que informó FL durante la toma
    FirstTake,   // FL estaba en el compás nuevo que pide el plugin: se usa el de la primera toma (recordado)
    Manual       // «Compás original» elegido a mano
};

/** De dónde salió el audio de la toma. */
enum class TakeSource
{
    None,
    Playback,   // tomado del canal mientras sonaba
    File        // archivo soltado en el plugin
};

/** Ubicación de un archivo soltado en la línea de tiempo de FL. */
enum class AlignState
{
    None,            // no hay archivo
    WaitingForPlay,  // archivo listo: falta darle Play para ubicarlo
    Searching,       // escuchando el canal y buscando
    Found,           // ubicado automáticamente
    NotFound,        // ~8 s escuchando sin encontrarlo (se ofrece «El archivo empieza en el compás 1»)
    Manual           // el usuario dijo «El archivo empieza en el compás 1»
};

/** Estado principal para la línea de estado. */
enum class Phase
{
    WaitingForPlay,      // "Dale Play en FL: el plugin toma el audio del canal"
    Taking,              // "Tomando el audio… 0:42 · 21 compases (escuchas el original)"
    TakingMore,          // tomando lo que faltaba delante o detrás de la toma
    LoadingFile,         // "Leyendo el archivo…"
    WaitingForFilePlay,  // archivo listo, falta Play para ubicarlo
    SearchingFile,       // buscando el archivo en el canal
    FileNotFound,        // "No encuentro este audio en el canal…"
    Processing,          // "Procesando…" / etapa del análisis
    Ready,               // "Listo: desde el próximo Play suena recortado"
    PlayingEdited,       // suena lo editado
    PlayingOriginal,     // A/B en «Original» dentro de la toma
    OutsideTake,         // suena una parte que no se tomó
    NothingToEdit        // hay toma pero el plan no recorta nada (motivo en blockerText)
};

enum class NoticeKind
{
    Info,
    Warning,
    Error
};

/**
 * Aviso para el usuario (los más nuevos al final; como mucho 8). key identifica el tipo ("audio-changed",
 * "file-found"…; ver la lista en Worker.cpp). Un aviso nuevo con la misma key reemplaza al anterior. La interfaz puede
 * ocultarlos pasado un rato (createdMs) o cerrarlos con DjecAudioProcessor::dismissNotice(id).
 */
struct Notice
{
    std::uint64_t id = 0;
    NoticeKind kind = NoticeKind::Info;
    juce::String key;
    juce::String text;
    juce::int64 createdMs = 0;   // juce::Time::currentTimeMillis() al crearlo
};

/**
 * Picos min/max para dibujar la forma de onda (todos los canales juntos), calculados fuera del hilo de audio.
 * levels[0]: kBasePeak muestras por pico; cada nivel siguiente agrupa 4 del anterior. Elegir con levelFor().
 */
struct WaveformPeaks
{
    static constexpr int kBasePeak = 64;
    struct Level
    {
        int samplesPerPeak = kBasePeak;
        std::vector<float> mins, maxs;
    };
    double sampleRate = 0;
    std::int64_t numSamples = 0;
    std::vector<Level> levels;

    /** El nivel más grueso que todavía tiene al menos un pico por píxel (samplesPerPixel = muestras por píxel). */
    const Level* levelFor(double samplesPerPixel) const noexcept;
};

/** Correcciones del modo «Detectar del audio» (las mismas de la web). */
struct DetectState
{
    bool analyzed = false;
    double bpmHint = 0;          // último tempo pedido (0 = automático)
    bool strict = false;
    int meterChoice = 0;         // 0 = automático, 2..7 = tiempos por compás elegidos
    std::vector<int> forced;     // "1" forzados (índices de beat)
    bool tempoChanged = false;   // se pidió un tempo (Restablecer tiene que volver a detectar)
};

/** Instantánea completa para la interfaz (inmutable; la publica el worker). */
struct SessionView
{
    std::uint64_t version = 0;

    // ---- toma ----
    bool hasTake = false;                 // hay audio (tomado o archivo), aunque el archivo no esté ubicado
    TakeSource source = TakeSource::None;
    std::uint32_t takeId = 0;
    double sampleRate = 0;
    int numChannels = 0;
    std::int64_t hostStart = 0;           // A: muestra del host donde empieza la toma (archivo: cuando está ubicado)
    std::int64_t numSamples = 0;          // E − A
    double durationSec = 0;
    juce::String displayName;             // nombre del archivo o de la pista ("Toma" si no hay)
    juce::File takeFile;                  // WAV de la toma en …/DJ Edit Cutter/Tomas (o el archivo soltado)
    bool placed = false;                  // la toma está en la línea de tiempo (siempre, salvo archivo sin ubicar)

    // ---- archivo soltado ----
    AlignState align = AlignState::None;
    int fileStartBar = 0;                 // compás de FL donde empieza el archivo (ubicado)
    double alignConfidence = 0;
    bool canUseBarOneFallback = false;    // mostrar «El archivo empieza en el compás 1»
    bool loadingFile = false;

    // ---- cuadrícula ----
    GridMode gridMode = GridMode::Host;
    bool gridValid = false;               // hay beats y compases
    djec::AnalysisResult grid;            // segundos desde el principio de la toma
    djec::HostGridMeta hostMeta;          // solo cuadrícula de FL
    int sourceDen = 4;                    // denominador del compás original (FL: el del proyecto; detectado: 4)
    std::vector<djec::Bar> bars;
    int lastBarIndex = -1;                // compás del golpe final (findLastBarIndex)
    int barOffsetBeats = 0;               // «Mover el 1» en la cuadrícula de FL
    MeterOrigin meterOrigin = MeterOrigin::Host;   // de dónde sale el compás de la cuadrícula de FL (hostMeta)
    int sourceMeterNum = 0, sourceMeterDen = 0;    // «Compás original» elegido (0 = Auto, de FL)
    int takeHostNum = 0, takeHostDen = 0;          // compás que informó FL durante la toma (0 = no se sabe)
    int rememberedNum = 0, rememberedDen = 0;      // compás de la primera toma, recordado (0 = ninguno)
    double displayBpm = 0;                // FL: tempo del proyecto; detectado: grid.bpm
    juce::String gridSourceText;          // "Cuadrícula de FL" | "Detectado del audio"
    juce::String confidenceLabel;         // "Detección fiable" | "Detección aceptable" | "Revisa la cuadrícula" | ""
    bool lowConfidence = false;
    DetectState detect;

    // ---- plan y render ----
    djec::EditSettings settings;
    bool hasPlan = false;
    djec::EditPlan plan;                  // segments, meter.removed/repeated, cutTime, outputDuration, blocker…
    juce::String blockerText;             // motivo (redactado para el plugin) por el que no se recorta; "" = se recorta
    std::vector<djec::MeterAmountChip> chips;
    juce::String meterHint;               // "Pon el compás del proyecto de FL en 7/8" ("" si no hay cambio de compás)
    bool hasRender = false;
    std::uint64_t renderId = 0;
    std::int64_t editedLength = 0;        // muestras de lo editado
    double editedDurationSec = 0;
    std::shared_ptr<const WaveformPeaks> peaks;         // de la toma
    std::shared_ptr<const WaveformPeaks> editedPeaks;   // de lo editado

    // ---- trabajo en segundo plano ----
    bool busy = false;
    juce::String busyText;                // "Procesando…", "Detectando notas…"

    std::vector<Notice> notices;
};

/** Lo que cambia en cada bloque (atómicos del hilo de audio). */
struct LiveView
{
    bool playing = false;
    bool positionKnown = false;
    std::int64_t hostSample = 0;
    double ppq = 0, hostBpm = 0;
    int tsNum = 4, tsDen = 4;
    int recKind = -1;                     // -1 nada, 0 toma nueva, 1 delante, 2 detrás, 3 buscando el archivo
    double recSeconds = 0;                // tomado en esta pasada
    int recBars = 0;                      // compases de FL que pasaron tomando
    bool insideTake = false;              // la posición está dentro de la toma
    double takeSec = 0;                   // posición del host en segundos de la toma (válido si insideTake)
    double sourceSec = 0;                 // instante de la toma que está sonando (si suena lo editado)
    bool outputEdited = false;            // está sonando lo editado
    bool outsideNotTaken = false;         // suena una parte que no se tomó
    bool listenOriginal = false;          // A/B en «Original»
    juce::String analysisStage;           // "" o etapa del análisis en curso ("Detectando notas"…)
    double analysisFraction = 0;          // 0..1
};

struct ViewState
{
    std::shared_ptr<const SessionView> session;   // nunca nullptr
    LiveView live;
    Phase phase = Phase::WaitingForPlay;
    juce::String statusText;
    bool statusIsWarning = false;
};

// ---- textos y formatos (español, mismo tono que la web) ----
/** "0:42", "3:52", "1:03:41" (truncando, como formatDuration de la web). */
juce::String formatClock(double sec);
/** "≈ 124 BPM" / "≈ 124,5 BPM" (formatBpm de la web, sin rango). */
juce::String formatBpm(double bpm);
/** Etapa del análisis → texto (STAGE_LABELS de la web). */
juce::String stageLabel(const juce::String& stage);
/** "1 compás" / "4 compases". */
juce::String formatBars(int n);
/** Nombre para el archivo editado: "<base> (7-8, edit -2 compases).wav" (suggestFileName de la web). */
juce::String suggestFileName(const juce::String& baseName, const djec::EditPlan& plan, bool meterChanges);

} // namespace djec::plugin
