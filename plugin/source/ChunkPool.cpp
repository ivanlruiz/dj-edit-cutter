#include "ChunkPool.h"

#include <chrono>

namespace djec::plugin
{

Recorder::Recorder()
    : chunks(maxChunksPerTake(), nullptr),
      anchors(static_cast<std::size_t>(kMaxAnchors))
{
}

void Recorder::resetForUse(RecKind k, std::uint32_t id, std::int64_t hostStart, int numCh) noexcept
{
    kind = k;
    takeId = id;
    start = hostStart;
    frames = 0;
    numChannels = numCh;
    numAnchors = 0;
    lastAnchorOffset = 0;
    lastInfo = HostBlockInfo{};
    lastSamplesPerQuarter = 0;
}

std::size_t Recorder::numChunksUsed() const noexcept
{
    return static_cast<std::size_t>((frames + kChunkFrames - 1) / kChunkFrames);
}

// ---------------------------------------------------------------------------------------------------------------

PoolFeeder::PoolFeeder() : free_(4096) {}

PoolFeeder::~PoolFeeder()
{
    stop();
    Chunk* c = nullptr;
    while (free_.pop(c))
        delete c;
    for (Chunk* r : recycled_)
        delete r;
    recycled_.clear();
}

void PoolFeeder::setTarget(std::size_t chunks)
{
    const std::size_t cap = free_.capacity() - 1;
    target_.store(chunks < cap ? chunks : cap, std::memory_order_relaxed);
    cv_.notify_one();
}

void PoolFeeder::recycle(Chunk* c)
{
    if (c == nullptr)
        return;
    {
        const std::lock_guard<std::mutex> lock(recycleMutex_);
        recycled_.push_back(c);
    }
    cv_.notify_one();
}

void PoolFeeder::fillNow()
{
    refill();
}

void PoolFeeder::refill()
{
    const std::lock_guard<std::mutex> producer(refillMutex_);
    const std::size_t want = target_.load(std::memory_order_relaxed);
    // primero los reciclados
    std::vector<Chunk*> recycled;
    {
        const std::lock_guard<std::mutex> lock(recycleMutex_);
        recycled.swap(recycled_);
    }
    for (Chunk* c : recycled)
    {
        if (free_.sizeApprox() < want && free_.push(c))
            continue;
        delete c;
        allocated_.fetch_sub(1, std::memory_order_relaxed);
    }
    while (free_.sizeApprox() < want)
    {
        Chunk* c = new Chunk();   // con ceros: las páginas quedan tocadas aquí y no en el hilo de audio
        if (!free_.push(c))
        {
            delete c;
            break;
        }
        allocated_.fetch_add(1, std::memory_order_relaxed);
    }
}

void PoolFeeder::start()
{
    if (thread_.joinable())
        return;
    {
        const std::lock_guard<std::mutex> lock(cvMutex_);
        stop_ = false;
    }
    thread_ = std::thread([this] { run(); });
}

void PoolFeeder::stop()
{
    {
        const std::lock_guard<std::mutex> lock(cvMutex_);
        stop_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable())
        thread_.join();
}

void PoolFeeder::run()
{
    for (;;)
    {
        {
            std::unique_lock<std::mutex> lock(cvMutex_);
            // cada 4 ms: a 48 kHz un trozo dura 680 ms; aun a 100× de velocidad (render offline) da tiempo
            cv_.wait_for(lock, std::chrono::milliseconds(4), [this] { return stop_; });
            if (stop_)
                return;
        }
        refill();
    }
}

// Nota: allocated_ no cuenta los trozos que el hilo de audio reserva por su cuenta en modo offline (al reciclarlos
// se descuentan igual): es solo un diagnóstico aproximado.

} // namespace djec::plugin
