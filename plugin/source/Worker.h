// Worker: el hilo en segundo plano del plugin. Es el dueño del "modelo" (la toma, el análisis, la cuadrícula, el plan,
// el render) y hace todo lo lento: arma la toma con lo que grabó el hilo de audio (o la une con lo agregado delante o
// detrás), cuadrícula (gridFromHost o Analyzer), plan (buildEditPlan), render (renderSegments), picos, guardar la toma
// en disco, decodificar y ubicar un archivo soltado, cargar el estado guardado. Publica:
//   - al hilo de audio: PlaybackSnapshot (buzón atómico) y órdenes (cola SPSC);
//   - a la interfaz: SessionView (shared_ptr bajo un mutex; nunca lo toca el hilo de audio).
// Las órdenes de la interfaz llegan por una cola de trabajos (mutex + condition_variable, nunca desde el audio).
#pragma once

#include "PluginState.h"
#include "Take.h"
#include "TakeFiles.h"

#include "djec/analysis.h"
#include "djec/capture_info.h"

#include <juce_core/juce_core.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace djec::plugin
{

/** Todo lo que se guarda en el proyecto de FL (getStateInformation). */
struct PersistedState
{
    // ajustes
    djec::EditSettings settings;
    GridMode gridMode = GridMode::Host;
    int barOffsetBeats = 0;
    DetectState detect;
    bool listenOriginal = false;
    juce::String trackName;
    // compás original de la cuadrícula de FL
    int sourceMeterNum = 0, sourceMeterDen = 0;     // «Compás original» elegido a mano (0 = Auto, de FL)
    int rememberedNum = 0, rememberedDen = 0;       // el de la primera toma (0 = todavía ninguno)
    double rememberedPhasePpq = 0;                  // ppq de un "1" de ese compás (módulo el largo del compás)
    // toma
    TakeSource source = TakeSource::None;
    juce::File takeFile;                 // WAV en Tomas/ o el archivo soltado
    juce::int64 fileSize = 0;
    juce::int64 fileModified = 0;        // ms desde 1970 (archivo soltado)
    std::uint64_t hash = 0;              // huella del audio de la toma (WAV de Tomas)
    double sampleRate = 0;
    std::int64_t hostStart = 0;
    std::int64_t numSamples = 0;
    int numChannels = 0;
    std::vector<AnchorEntry> anchors;    // posición del host durante la toma (offset = muestra de la toma)
    AlignState align = AlignState::None; // archivo: Found / Manual = ubicado
    int fileStartBar = 0;
    bool meterFromMemory = false;        // FL estaba en el compás nuevo: las anclas usan el compás recordado
    int takeHostNum = 0, takeHostDen = 0;// compás que informó FL durante la toma
};

/** Lo necesario para exportar lo editado (una copia barata: el audio va por shared_ptr). */
struct ExportData
{
    std::shared_ptr<const RenderedAudio> render;
    djec::EditPlan plan;
    juce::String baseName;
    bool meterChanges = false;
};

class Worker
{
public:
    explicit Worker(Hub& hub);
    ~Worker();

    void start();
    void stop();

    // ---- órdenes (cualquier hilo menos el de audio) ----
    void hostPrepared(double sampleRate);
    void clearTake();
    void loadFile(const juce::File& file);
    void fileStartsAtBarOne();
    void setGridMode(GridMode mode);
    void retrack(double bpmHint, bool strict);
    void relabel(int beatsPerBar, std::vector<int> forced);
    void resetDetection();
    /** «Mover el 1 ◀ ▶»: FL → barOffset += delta; detectado → "1" forzado (shiftedDownbeatIndex de la web). */
    void moveDownbeat(int delta, double refTimeSec);
    /** «Este beat es el 1» (solo detectado): el beat más cercano a timeSec pasa a ser "1". */
    void beatIsOne(double timeSec);
    void setBarOffset(int beats);
    void setSettings(const djec::EditSettings& s);
    void setListenOriginal(bool original);
    void setTrackName(const juce::String& name);
    /**
     * «Compás original» de la cuadrícula de FL: num = 0 → Auto (el que informa FL; si FL ya está en el compás nuevo que
     * pide el plugin, el de la primera toma). Si no, ese compás para la toma actual y las siguientes.
     */
    void setSourceMeter(int num, int den);
    /** Carga un estado guardado (los ajustes se aplican ya; la toma, en el worker). */
    void restore(const PersistedState& state);
    /** Avisos que la interfaz ya mostró y el usuario cerró. */
    void dismissNotice(std::uint64_t id);

    // ---- lectura (cualquier hilo menos el de audio) ----
    std::shared_ptr<const SessionView> view() const;
    PersistedState persisted();          // marca la toma como guardada en un proyecto (ya no se borra sola)
    djec::EditSettings settings() const;
    ExportData exportData() const;
    /** Etapa y avance del análisis en curso ("" si no hay). */
    void analysisProgress(juce::String& stage, double& fraction) const;

    /** Tests: espera a que no quede trabajo pendiente (cola, avisos del audio, reconstrucción). */
    bool waitIdle(int timeoutMs);
    /** Tests: política para borrar tomas viejas (por defecto la de takefiles::Policy). */
    void setCleanupPolicy(const takefiles::Policy& policy);
    /** Veces que se despertó el hilo (diagnóstico y tests). */
    long long wakeups() const noexcept { return wakeups_.load(std::memory_order_relaxed); }

private:
    struct Model;

    void run();
    void post(std::function<void()> job);
    void drainAudioEvents();
    void handleEvent(const AudioEvent& e);
    void consumeRecording(const AudioEvent& e);
    void recycleRecorder(int index);
    void deleteRetired();
    void sendCommand(AudioCommand c);
    void flushCommands();

    void clearModel(bool keepFile);
    void newTakeFromAudio(std::vector<std::vector<float>> channels, std::uint32_t id, std::int64_t hostStart,
                          std::vector<AnchorEntry> anchors);
    void rebuild();
    bool runAnalysis();
    void publishSnapshot();
    void publishView();
    void saveTakeWav();
    void forgetTakeFile();
    /** Cambia el WAV de la toma (registro de archivos en uso). */
    void setTakeWav(const juce::File& file);
    /** Limpieza de tomas viejas (takefiles::cleanup en Tomas y en la carpeta de antes). */
    void runCleanup();
    /** En cada vuelta: «toca» el WAV en uso cada tanto y la limpieza de arranque. */
    void maintainTakeFiles();
    /** ¿Hay algo en marcha? (el hilo mira más seguido) */
    bool activeNow();

    /**
     * Compás de las anclas de una toma nueva (o de lo agregado delante/detrás) con «Compás original» en Auto: si FL
     * informa el compás nuevo que pide el plugin (el destino de «Recortar cada compás») y no el recordado, se usa el
     * recordado (con su fase); si no, el de FL pasa a ser el recordado. Ver normalizeAnchors en Worker.cpp.
     */
    void normalizeAnchors(std::vector<AnchorEntry>& anchors, double sampleRate, bool newTake);
    void persistTakeMeter();
    /** Límites de la música de la toma (analyzeBounds o, si ya se analizó, los de la detección). */
    void ensureBounds();

    void relabelNow(int beatsPerBar, const std::vector<int>& forced);
    void doLoadFile(const juce::File& file, bool restoring, const PersistedState* restoreState);
    void tryAlign();
    /** restored: estado guardado (anclas ya normalizadas, compás de inicio guardado). */
    void placeFile(std::int64_t A, const std::vector<AnchorEntry>& anchorsRelToTake, AlignState how,
                   double confidence, const PersistedState* restored = nullptr);
    void doRestore(const PersistedState& ps);

    void addNotice(const juce::String& key, NoticeKind kind, const juce::String& text);
    void clearNotice(const juce::String& key);

    Hub& hub_;
    std::unique_ptr<Model> m_;

    // cola de trabajos
    mutable std::mutex jobsMutex_;
    std::condition_variable jobsCv_;
    std::deque<std::function<void()>> jobs_;
    bool stop_ = false;
    std::atomic<bool> busyJob_{false};
    std::thread thread_;

    // órdenes al audio que no entraron en la cola
    std::deque<AudioCommand> pendingCommands_;
    std::uint32_t epoch_ = 0;

    // estado compartido con otros hilos
    mutable std::mutex stateMutex_;
    PersistedState persist_;                 // ajustes + datos de la toma para guardar
    std::shared_ptr<const SessionView> view_;
    ExportData export_;
    bool takeFileReferenced_ = false;        // la toma ya se guardó en un proyecto: no se borra su WAV
    takefiles::Policy cleanupPolicy_;
    juce::File pendingRestoreFile_;          // WAV de un estado por cargar (en uso hasta que se carga)

    std::atomic<double> hostRate_{0};
    std::atomic<bool> rebuildPending_{false};
    std::atomic<std::uint64_t> viewVersion_{0};
    std::atomic<std::uint64_t> noticeCounter_{0};
    std::atomic<long long> wakeups_{0};

    // solo el hilo del worker
    juce::int64 startedMs_ = 0;
    bool startupCleanupDone_ = false;
    juce::int64 lastTouchMs_ = 0;
    juce::int64 lastActiveMs_ = 0;

    mutable std::mutex progressMutex_;
    juce::String progressStage_;
    double progressFraction_ = 0;
};

} // namespace djec::plugin
