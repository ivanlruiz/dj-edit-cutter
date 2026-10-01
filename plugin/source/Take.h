// Datos que comparten el hilo de audio (TakeEngine) y el worker: el audio tomado, el render, la instantánea de
// reproducción que se publica al hilo de audio, las órdenes (worker → audio) y los avisos (audio → worker).
#pragma once

#include "ChunkPool.h"

#include "djec/capture_info.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace djec::plugin
{

/**
 * Audio tomado (o archivo soltado), contiguo, a la frecuencia del host. Inmutable una vez publicado. Dónde está en
 * la línea de tiempo (A) no va aquí: un archivo soltado tiene audio antes de saber dónde está.
 */
struct TakeAudio
{
    std::uint32_t id = 0;
    double sampleRate = 0;
    std::int64_t numSamples = 0;
    std::vector<std::vector<float>> channels;   // 1 o 2 canales

    int numChannels() const noexcept { return static_cast<int>(channels.size()); }
    std::vector<const float*> pointers() const
    {
        std::vector<const float*> p;
        for (const auto& c : channels)
            p.push_back(c.data());
        return p;
    }
};

/** Audio editado (renderSegments). Inmutable una vez publicado. */
struct RenderedAudio
{
    std::uint64_t renderId = 0;
    double sampleRate = 0;
    std::int64_t length = 0;
    std::vector<std::vector<float>> channels;
};

/** Mapa de tempo de la toma para notar si cambió el tempo del proyecto (muestra → ppq lineal por tramos). */
struct TempoPoint
{
    std::int64_t hostSample = 0;
    double ppq = 0;
    double samplesPerQuarter = 0;   // pendiente del tramo que empieza aquí
    double bpm = 0;
};

/**
 * Lo que el hilo de audio necesita para reproducir una toma. La crea el worker, la recibe el audio por un buzón
 * atómico y la devuelve por una cola para que el worker la libere (el audio nunca libera memoria).
 */
struct PlaybackSnapshot
{
    std::uint32_t epoch = 0;                    // época de las órdenes del worker a la que pertenece
    std::uint32_t takeId = 0;
    std::int64_t A = 0, E = 0;                  // tramo del host que cubre esta instantánea
    std::shared_ptr<const TakeAudio> take;      // para comparar la entrada con lo tomado
    std::shared_ptr<const RenderedAudio> render;// nullptr = no hay nada que recortar (suena el original)
    const float* takeCh[kMaxTakeChannels] = {nullptr, nullptr};
    int takeNumCh = 0;
    const float* edCh[kMaxTakeChannels] = {nullptr, nullptr};
    int edNumCh = 0;
    std::int64_t edLen = 0;
    // detección de cambios
    bool changeDetect = true;
    bool correlationMode = false;               // archivo: insensible a la ganancia (correlación)
    // detección de cambio de tempo (solo dentro de [tempoFrom, tempoTo))
    std::vector<TempoPoint> tempo;
    std::int64_t tempoFrom = 0, tempoTo = 0;
};

// ---- órdenes del worker al hilo de audio ----
enum class CommandType : std::uint8_t
{
    Reset,            // sin toma: descarta grabaciones e instantáneas (la próxima vez que suene se toma)
    ExpectAlignment,  // como Reset, pero en vez de tomar escucha para ubicar el archivo soltado
    SetRange,         // la toma es [A, E) con id takeId (archivo ubicado, estado cargado)
};

struct AudioCommand
{
    CommandType type = CommandType::Reset;
    std::uint32_t epoch = 0;
    std::uint32_t takeId = 0;
    std::int64_t A = 0, E = 0;
    bool extendable = true;       // se puede agregar delante/detrás (toma del canal)
};

// ---- avisos del hilo de audio al worker ----
enum class EventType : std::uint8_t
{
    RecordingFinished,   // recorder listo para consumir
    RecordingDiscarded,  // recorder para devolver sin usar
    TakeInvalidated,     // la toma dejó de valer (cambió el audio o el tempo)
    Warning,             // aviso para el usuario
    CommandApplied,      // el audio aplicó la orden de esta época
};

enum class InvalidReason : std::uint8_t
{
    AudioChanged,
    TempoChanged,
};

enum class WarningKind : std::uint8_t
{
    JumpDuringTake,   // salto de posición mientras se tomaba: se queda lo tomado
    MaxLength,        // llegó a 15 min
    PoolDry,          // se acabaron los trozos libres
    TooShort,         // toma de menos de 1 s: descartada
    NoRecorder,       // no hay grabadora libre (el worker va atrasado)
};

struct AudioEvent
{
    EventType type = EventType::Warning;
    std::uint32_t epoch = 0;
    int recorder = -1;
    std::uint32_t takeId = 0;
    RecKind kind = RecKind::NewTake;
    InvalidReason reason = InvalidReason::AudioChanged;
    WarningKind warning = WarningKind::JumpDuringTake;
    std::int64_t hostSample = 0;
    // para TempoChanged: lo que dijo el host
    double ppq = 0, bpm = 0;
};

/** Última posición informada por el host (escribe el audio, lee cualquiera). Seqlock con valores atómicos. */
class HostInfoBox
{
public:
    struct Value
    {
        bool valid = false;       // hubo un bloque con información
        bool playing = false;
        bool hasTime = false;
        std::int64_t timeInSamples = 0;
        HostBlockInfo info;
    };

    void write(const Value& v) noexcept
    {
        seq_.fetch_add(1, std::memory_order_acq_rel);
        valid_.store(v.valid, std::memory_order_relaxed);
        playing_.store(v.playing, std::memory_order_relaxed);
        hasTime_.store(v.hasTime, std::memory_order_relaxed);
        time_.store(v.timeInSamples, std::memory_order_relaxed);
        ppq_.store(v.info.ppq, std::memory_order_relaxed);
        bpm_.store(v.info.bpm, std::memory_order_relaxed);
        num_.store(v.info.tsNum, std::memory_order_relaxed);
        den_.store(v.info.tsDen, std::memory_order_relaxed);
        bar_.store(v.info.lastBarStartPpq, std::memory_order_relaxed);
        ppqValid_.store(v.info.ppqValid, std::memory_order_relaxed);
        barValid_.store(v.info.barValid, std::memory_order_relaxed);
        seq_.fetch_add(1, std::memory_order_release);
    }

    Value read() const noexcept
    {
        Value v;
        for (int tries = 0; tries < 64; ++tries)
        {
            const unsigned s1 = seq_.load(std::memory_order_acquire);
            if (s1 & 1u)
                continue;
            v.valid = valid_.load(std::memory_order_relaxed);
            v.playing = playing_.load(std::memory_order_relaxed);
            v.hasTime = hasTime_.load(std::memory_order_relaxed);
            v.timeInSamples = time_.load(std::memory_order_relaxed);
            v.info.hostSample = v.timeInSamples;
            v.info.ppq = ppq_.load(std::memory_order_relaxed);
            v.info.bpm = bpm_.load(std::memory_order_relaxed);
            v.info.tsNum = num_.load(std::memory_order_relaxed);
            v.info.tsDen = den_.load(std::memory_order_relaxed);
            v.info.lastBarStartPpq = bar_.load(std::memory_order_relaxed);
            v.info.ppqValid = ppqValid_.load(std::memory_order_relaxed);
            v.info.barValid = barValid_.load(std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_acquire);
            if (seq_.load(std::memory_order_relaxed) == s1)
                return v;
        }
        return v;
    }

private:
    std::atomic<unsigned> seq_{0};
    std::atomic<bool> valid_{false}, playing_{false}, hasTime_{false}, ppqValid_{false}, barValid_{false};
    std::atomic<std::int64_t> time_{0};
    std::atomic<double> ppq_{0}, bpm_{0}, bar_{0};
    std::atomic<int> num_{4}, den_{4};
};

/**
 * Lo que se escucha para ubicar un archivo soltado: mezcla mono de la entrada (a la frecuencia del host) desde
 * startHost, y las posiciones del host. Escribe el audio; el worker copia con una comprobación de generación (si el
 * audio reinició el búfer durante la copia, la copia se descarta).
 */
struct AlignBuffer
{
    std::vector<float> mono;                  // capacidad fija (prepareToPlay)
    std::vector<AnchorEntry> anchors;         // capacidad fija
    std::atomic<std::uint32_t> gen{0};        // impar = reiniciando
    std::atomic<std::int64_t> count{0};
    std::atomic<int> numAnchors{0};
    std::atomic<std::int64_t> startHost{0};
    std::atomic<bool> listening{false};
    // solo audio
    HostBlockInfo lastInfo;
};

/** Estado "en vivo" que el audio publica para la interfaz y el worker (todo atómico, sin bloqueos). */
struct LiveAtomics
{
    std::atomic<bool> playing{false};
    std::atomic<bool> positionKnown{false};
    std::atomic<std::int64_t> hostSample{0};
    std::atomic<double> ppq{0}, bpm{0}, lastBarPpq{0};
    std::atomic<int> tsNum{4}, tsDen{4};
    // grabación en curso: -1 ninguna, 0 toma nueva, 1 delante, 2 detrás, 3 escuchando para ubicar el archivo
    std::atomic<int> recKind{-1};
    std::atomic<std::int64_t> recFrames{0}, recStart{0};
    std::atomic<double> recPpqStart{0};
    std::atomic<bool> recPpqValid{false};
    // salida
    std::atomic<bool> outputEdited{false};     // el último bloque sonó (en parte) editado
    std::atomic<bool> outsideNotTaken{false};  // suena una parte que no se tomó (ni se puede agregar)
    // la toma según el hilo de audio
    std::atomic<bool> rangeValid{false};
    std::atomic<std::uint32_t> rangeTakeId{0};
    std::atomic<std::int64_t> rangeA{0}, rangeE{0};
    std::atomic<std::uint32_t> playingSnapshotTakeId{0};
    std::atomic<std::int64_t> playingSnapshotA{0};
    std::atomic<std::uint64_t> processedBlocks{0};
};

/**
 * Todo lo que conecta el hilo de audio con el worker (colas, buzón de instantáneas, grabadoras, trozos, estado en
 * vivo). Lo crea el procesador; ni el audio ni el worker lo poseen.
 */
struct Hub
{
    SpscQueue<AudioCommand> commands{256};          // worker → audio
    SpscQueue<AudioEvent> events{4096};             // audio → worker
    SpscQueue<int> freeRecorders{16};               // worker → audio (índices de recorders libres)
    SpscQueue<PlaybackSnapshot*> retired{1024};     // audio → worker (para liberar)
    std::atomic<PlaybackSnapshot*> pending{nullptr};// worker → audio (la más nueva; el worker libera la anterior)
    Recorder recorders[kNumRecorders];
    PoolFeeder pool;
    AlignBuffer align;
    LiveAtomics live;
    HostInfoBox hostInfo;
    std::atomic<int> listenOriginal{0};             // A/B: 1 = «Original»
    std::atomic<std::uint32_t> nextTakeId{1};
    std::atomic<double> sampleRate{0};
    std::mutex alignResize;                         // prepareToPlay (redimensiona) vs. worker (copia)

    Hub()
    {
        for (int i = 0; i < kNumRecorders; ++i)
            freeRecorders.push(i);
    }
};

} // namespace djec::plugin
