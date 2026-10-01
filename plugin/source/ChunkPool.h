// Piezas de tiempo real de la toma del audio: cola SPSC sin bloqueos, trozos de memoria fijos (Chunk) que el hilo de
// audio llena sin reservar memoria, grabadoras preasignadas (Recorder) y el hilo que repone los trozos (PoolFeeder).
//
// Reglas: el hilo de audio nunca reserva ni libera memoria, nunca bloquea y nunca hace E/S. Todo lo que necesita lo
// reserva otro hilo de antemano (constructor, prepareToPlay, PoolFeeder) y se lo pasa por colas SPSC.
#pragma once

#include "djec/capture_info.h"

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

namespace djec::plugin
{

// ---- límites ----
constexpr int kChunkFrames = 1 << 15;          // 32768 muestras por canal (0,68 s a 48 kHz; 256 KB en estéreo)
constexpr int kMaxTakeChannels = 2;            // la toma guarda 1 o 2 canales
constexpr double kMaxTakeSeconds = 15 * 60;    // toma máxima: 15 minutos
constexpr double kMaxSupportedRate = 384000;   // tablas de trozos dimensionadas para esto
constexpr int kNumRecorders = 4;               // grabaciones en vuelo (toma + agregar delante/detrás + una en espera)
constexpr int kMaxAnchors = 16384;             // posiciones del host anotadas por grabación
constexpr double kMinTakeSeconds = 1.0;        // una toma más corta se descarta
constexpr double kDefaultPoolSeconds = 30;     // margen de trozos libres que se mantiene listo

inline std::size_t maxChunksPerTake()
{
    return static_cast<std::size_t>(kMaxTakeSeconds * kMaxSupportedRate / kChunkFrames) + 2;
}

/**
 * Cola sin bloqueos de un productor y un consumidor (anillo con capacidad potencia de 2). T copiable trivialmente.
 * push/pop no reservan memoria y nunca esperan; devuelven false si la cola está llena/vacía.
 */
template <typename T>
class SpscQueue
{
public:
    explicit SpscQueue(std::size_t minCapacity)
    {
        std::size_t cap = 2;
        while (cap < minCapacity)
            cap <<= 1;
        buf_.resize(cap);
        mask_ = cap - 1;
    }

    bool push(const T& v) noexcept
    {
        const std::size_t h = head_.load(std::memory_order_relaxed);
        const std::size_t t = tail_.load(std::memory_order_acquire);
        if (h - t > mask_)
            return false;
        buf_[h & mask_] = v;
        head_.store(h + 1, std::memory_order_release);
        return true;
    }

    bool pop(T& out) noexcept
    {
        const std::size_t t = tail_.load(std::memory_order_relaxed);
        const std::size_t h = head_.load(std::memory_order_acquire);
        if (t == h)
            return false;
        out = buf_[t & mask_];
        tail_.store(t + 1, std::memory_order_release);
        return true;
    }

    std::size_t sizeApprox() const noexcept
    {
        return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
    }
    std::size_t capacity() const noexcept { return mask_ + 1; }

private:
    std::vector<T> buf_;
    std::size_t mask_ = 0;
    std::atomic<std::size_t> head_{0};   // (sin alignas: MSVC avisa C4324 y con este tráfico no importa)
    std::atomic<std::size_t> tail_{0};
};

/** Trozo fijo de audio (hasta 2 canales). Se crea con ceros (páginas ya tocadas: sin fallos de página en audio). */
struct Chunk
{
    float data[kMaxTakeChannels][kChunkFrames];
};

/** Qué está grabando una Recorder. */
enum class RecKind : std::uint8_t
{
    NewTake,   // toma nueva (no había toma válida)
    Prepend,   // lo que suena antes del principio de la toma, hasta llegar a ella
    Append     // lo que suena después del final de la toma
};

/** Posición del host anotada en la grabación (offset = muestra de la grabación). */
struct AnchorEntry
{
    std::int64_t offset = 0;
    HostBlockInfo info;
};

/**
 * Grabación preasignada (tabla de trozos para 15 min a 384 kHz + anclas). La usa el hilo de audio mientras graba y
 * pasa a ser del worker cuando la entrega (evento RecordingFinished); el worker la vacía y la devuelve libre.
 */
struct Recorder
{
    Recorder();

    std::vector<Chunk*> chunks;           // tamaño fijo; nullptr = sin trozo todavía
    std::vector<AnchorEntry> anchors;     // tamaño fijo kMaxAnchors; válidas [0, numAnchors)
    int numAnchors = 0;
    int numChannels = 0;
    std::int64_t start = 0;               // muestra del host de la primera muestra grabada
    std::int64_t frames = 0;
    RecKind kind = RecKind::NewTake;
    std::uint32_t takeId = 0;
    // para decidir cuándo anotar otra ancla (solo hilo de audio)
    std::int64_t lastAnchorOffset = 0;
    HostBlockInfo lastInfo;
    double lastSamplesPerQuarter = 0;

    void resetForUse(RecKind k, std::uint32_t id, std::int64_t hostStart, int numCh) noexcept;
    /** Muestra i del canal c (solo fuera del audio, cuando la grabación ya se entregó). */
    std::size_t numChunksUsed() const noexcept;
};

/**
 * Repone los trozos libres desde un hilo propio (así un análisis o una escritura largos del worker no dejan sin
 * memoria a una toma en curso). Mantiene `target` trozos en la cola libre; recicla los que devuelve el worker.
 */
class PoolFeeder
{
public:
    PoolFeeder();
    ~PoolFeeder();

    SpscQueue<Chunk*>& freeQueue() noexcept { return free_; }

    /** Trozos que se mantienen listos (se llama al cambiar la frecuencia o el margen). Fuera del audio. */
    void setTarget(std::size_t chunks);
    std::size_t target() const noexcept { return target_.load(std::memory_order_relaxed); }
    /** Devuelve trozos usados (los recicla o los libera). Fuera del audio. */
    void recycle(Chunk* c);
    /** Llena la cola ya mismo (prepareToPlay, tests). */
    void fillNow();
    /** Trozos reservados en total (diagnóstico). */
    long long allocatedApprox() const noexcept { return allocated_.load(std::memory_order_relaxed); }

    void start();
    void stop();

private:
    void run();
    void refill();

    SpscQueue<Chunk*> free_;
    std::atomic<std::size_t> target_{0};
    std::atomic<long long> allocated_{0};
    std::mutex recycleMutex_;
    std::vector<Chunk*> recycled_;
    std::mutex refillMutex_;   // refill() puede llamarse desde el hilo propio o desde fillNow()
    std::mutex cvMutex_;
    std::condition_variable cv_;
    bool stop_ = false;
    std::thread thread_;
};

} // namespace djec::plugin
