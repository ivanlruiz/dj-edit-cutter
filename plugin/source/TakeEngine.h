// Hilo de audio: toma automática del audio al darle Play, reproducción del audio editado alineada a la línea de
// tiempo del host, detección de cambios en el audio del canal y del tempo, escucha para ubicar un archivo soltado.
//
// Todo lo de aquí corre en processBlock: sin reservar memoria, sin bloqueos, sin E/S. Habla con el worker solo por
// las colas del Hub (órdenes, avisos, grabadoras, trozos, instantáneas).
//
// Reglas (USER DECISION v2): una sola toma contigua [A, E) en muestras del host.
//  1. Suena el transporte y no hay toma → se toma desde la posición actual (la entrada pasa tal cual).
//  2. Se para o salta → se entrega lo tomado (si dura al menos kMinTakeSeconds); el worker arma cuadrícula/plan/render.
//  3. Pasadas siguientes: dentro de [A, E) suena lo editado (muestra i en A + i; silencio desde A + largo editado hasta
//     E). Si la pasada sigue de corrido más allá de E se toma lo nuevo (detrás); si empieza antes de A y llega a A de
//     corrido, se toma lo de delante. Fuera de la toma y sin continuidad: suena el original. Si lo editado dura más
//     que la toma («Alargar»), sigue sonando después de E hasta A + largo editado (aunque se esté tomando lo de detrás).
//  4. Dentro de la toma se compara la entrada con lo tomado (ventanas de 200 ms); si difiere claramente durante 1 s,
//     la toma deja de valer y se vuelve a tomar desde ahí.
//  5. Cambio de tempo (ppq/bpm distintos de los de la toma en la misma muestra) → la toma deja de valer.
// La instantánea que suena se fija al empezar cada pasada (Play o salto): un render nuevo suena desde la próxima
// pasada, nunca a mitad de una (salvo que la toma deje de valer, que corta a original al instante).
// «De corrido»: la posición de cada bloque es la del anterior + su largo, con una tolerancia de max(2 muestras,
// 0,5 ms) porque FL puede redondear las posiciones (contiguityToleranceSamples); dentro de la tolerancia manda la
// cuenta propia (la toma y lo editado siguen sin huecos ni repeticiones).
#pragma once

#include "Take.h"

#include <cstdint>

namespace djec::plugin
{

/** Lo que el host dijo de un bloque (juce::AudioPlayHead::PositionInfo traducido, sin JUCE). */
struct BlockPosition
{
    bool hasInfo = false;   // hubo PositionInfo
    bool playing = false;
    bool hasTime = false;
    std::int64_t timeInSamples = 0;
    HostBlockInfo info;     // ppq, bpm, compás, inicio de compás (con sus flags)
};

/** Umbrales de la detección de cambios (USER DECISION v2, regla 4). */
struct ChangeDetectionTuning
{
    double windowSec = 0.2;          // ventanas de ~200 ms
    double silence = 0.001;          // −60 dBFS: con la entrada por debajo, la ventana no cuenta
    double diffRatio = 0.3;          // toma del canal: rms(entrada − tomado) / rms(la más fuerte) > 0,3 (≈ ±3 dB)
    double minCorrelation = 0.5;     // archivo: correlación < 0,5 (insensible a ganancia y EQ suave)
    int windowsToTrigger = 5;        // 5 ventanas seguidas = 1 s
};

/**
 * Cuánto puede diferir la posición del host de la esperada (anterior + largo del bloque) sin que sea un salto:
 * max(2 muestras, 0,5 ms). FL puede redondear las posiciones; más que esto es un salto de verdad.
 */
inline std::int64_t contiguityToleranceSamples(double sampleRate) noexcept
{
    const auto halfMs = static_cast<std::int64_t>(0.0005 * (sampleRate > 0 ? sampleRate : 44100) + 1e-9);
    return halfMs > 2 ? halfMs : 2;
}

class TakeEngine
{
public:
    explicit TakeEngine(Hub& hub);

    /** No concurrente con process (prepareToPlay). Cierra la pasada en curso. */
    void prepare(double sampleRate, int maxBlockSize);
    /** No concurrente con process (releaseResources). Entrega lo que se estuviera tomando. */
    void release();

    /**
     * Un bloque. channels: punteros del buffer (los primeros numIn son la entrada; la salida se escribe en los primeros
     * numOut). Los canales de salida sin entrada ya vienen en cero.
     */
    void process(float* const* channels, int numIn, int numOut, int numSamples, const BlockPosition& pos,
                 bool nonRealtime) noexcept;
    /** Bypass: deja pasar la entrada y cierra la pasada (no se toma nada mientras está en bypass). */
    void processBypassed(int numSamples, const BlockPosition& pos) noexcept;

    /** Destructor del procesador (sin audio): libera las instantáneas que tenga. */
    void destroySnapshots();

    ChangeDetectionTuning tuning;

private:
    struct Range
    {
        bool valid = false;
        std::uint32_t id = 0;
        std::int64_t A = 0, E = 0;
        bool extendable = true;
    };

    enum class PassEnd
    {
        Stopped,
        Jump,
        Bypass
    };

    void applyCommands() noexcept;
    void adoptPending() noexcept;
    void retire(PlaybackSnapshot* s) noexcept;
    void flushRetired() noexcept;
    void dropSnapshots() noexcept;
    void discardRecording() noexcept;
    void emit(const AudioEvent& e) noexcept;
    void warn(WarningKind w, std::int64_t hostSample) noexcept;

    void publishRange() noexcept;
    void startPass(std::int64_t p) noexcept;
    void endPass(PassEnd why) noexcept;
    int step(float* const* ch, int numIn, int numOut, int j, std::int64_t h, int len, const BlockPosition& bp,
             std::int64_t blockStart, bool nonRealtime) noexcept;

    bool startRecording(RecKind kind, std::int64_t h) noexcept;
    /** false si se cortó la grabación (sin memoria). */
    bool recordRun(float* const* ch, int numIn, int j, std::int64_t h, int run, const BlockPosition& bp,
                   std::int64_t blockStart, bool nonRealtime) noexcept;
    void finishRecording(bool jumped) noexcept;
    Chunk* acquireChunk(bool nonRealtime) noexcept;

    void startAlignListen(std::int64_t h) noexcept;
    void alignRun(float* const* ch, int numIn, int j, std::int64_t h, int run, const BlockPosition& bp,
                  std::int64_t blockStart) noexcept;

    void insideRun(float* const* ch, int numIn, int numOut, int j, std::int64_t h, int run) noexcept;
    /** Copia m muestras de lo editado (desde la muestra src) a la salida, en ch[..] + j. */
    void writeEdited(float* const* ch, int numOut, int j, const PlaybackSnapshot& s, std::int64_t src,
                     int m) noexcept;
    /**
     * Lo editado que dura más que la toma («Alargar»: compases repetidos) sigue sonando después de E, hasta
     * A + largo editado. Escribe la parte de [h, h + run) que cae ahí (la entrada ya se grabó si se estaba tomando)
     * y devuelve cuántas muestras escribió.
     */
    int editedBeyondTake(float* const* ch, int numOut, int j, std::int64_t h, int run) noexcept;
    void detectChanges(float* const* ch, int numIn, int j, std::int64_t h, int run,
                       const PlaybackSnapshot& s) noexcept;
    void resetChangeWindow() noexcept;
    void checkTempo(const BlockPosition& bp) noexcept;
    void invalidate(InvalidReason why, std::int64_t hostSample) noexcept;

    Hub& hub_;
    double sr_ = 0;
    std::int64_t maxTakeSamples_ = 0, minTakeSamples_ = 0, windowLen_ = 1;
    std::int64_t contiguityTol_ = 2;      // contiguityToleranceSamples(sr_)
    std::uint32_t epoch_ = 0;
    Range R_;
    bool alignPending_ = false;

    // pasada
    bool inPass_ = false;
    std::int64_t expectedNext_ = 0;
    bool appendBlocked_ = false;          // en esta pasada ya no se agrega detrás (máximo, sin memoria…)
    bool warnedThisPass_[8] = {};
    bool outsideNow_ = false;
    bool editedNow_ = false;

    // instantáneas
    PlaybackSnapshot* waiting_ = nullptr;   // llegó antes que las órdenes de su época
    PlaybackSnapshot* latest_ = nullptr;
    PlaybackSnapshot* passSnap_ = nullptr;  // la que suena en esta pasada
    PlaybackSnapshot* overflow_[16] = {};
    int numOverflow_ = 0;

    // grabación
    Recorder* rec_ = nullptr;
    int recIdx_ = -1;

    // invalidación pendiente (se aplica al terminar el tramo en curso)
    bool pendingInvalidate_ = false;
    InvalidReason pendingReason_ = InvalidReason::AudioChanged;
    std::int64_t pendingInvalidateAt_ = 0;

    // detección de cambios
    double cdXX_ = 0, cdYY_ = 0, cdDD_ = 0, cdXY_ = 0;
    std::int64_t cdCount_ = 0;
    std::int64_t cdNext_ = -1;    // muestra del host que se espera comparar a continuación
    int cdDiffWindows_ = 0;
    int cdChannels_ = 1;

    // cambio de tempo
    int tempoMismatch_ = 0;
};

} // namespace djec::plugin
