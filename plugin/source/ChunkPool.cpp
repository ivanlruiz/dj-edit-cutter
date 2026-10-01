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
    {
        const std::lock_guard<std::mutex> lock(cvMutex_);
        kick_ = true;
    }
    cv_.notify_one();
}

void PoolFeeder::recycle(Chunk* c)
{
    if (c == nullptr)
        return;
    {
        const std::lock_guard<std::mutex> lock(recycleMutex_);
        recycled_.push_back(c);
        numRecycled_.store(recycled_.size(), std::memory_order_relaxed);
    }
    // sin despertar al hilo por cada trozo: el worker devuelve una toma entera de golpe (wake() al terminar, o la
    // próxima vuelta del hilo dentro de kFeederWakeMs)
}

void PoolFeeder::wake()
{
    if (!needsWork())
        return;
    {
        const std::lock_guard<std::mutex> lock(cvMutex_);
        kick_ = true;
    }
    cv_.notify_one();
}

bool PoolFeeder::needsWork() const noexcept
{
    return free_.sizeApprox() < target_.load(std::memory_order_relaxed) ||
           numRecycled_.load(std::memory_order_relaxed) > 0;
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
        numRecycled_.store(0, std::memory_order_relaxed);
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
            // cada kFeederWakeMs (o antes si alguien avisa): hay `target` trozos listos (30 s de audio por defecto)
            // y en tiempo real el audio gasta como mucho uno cada 85 ms; en render offline, si se acaban, el hilo de
            // audio reserva los suyos (ahí sí puede)
            cv_.wait_for(lock, std::chrono::milliseconds(kFeederWakeMs), [this] { return stop_ || kick_; });
            if (stop_)
                return;
            kick_ = false;
        }
        wakeups_.fetch_add(1, std::memory_order_relaxed);
        if (needsWork())
            refill();
    }
}

// Nota: allocated_ no cuenta los trozos que el hilo de audio reserva por su cuenta en modo offline (al reciclarlos
// se descuentan igual): es solo un diagnóstico aproximado.

} // namespace djec::plugin
