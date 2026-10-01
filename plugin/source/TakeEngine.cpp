#include "TakeEngine.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace djec::plugin
{

namespace
{
constexpr double kTempoPpqTol = 0.01;    // negras (5 ms a 120 BPM)
constexpr double kTempoBpmTol = 0.05;    // BPM
constexpr int kTempoMismatchBlocks = 3;  // bloques seguidos que no coinciden

/** Posición del host en la muestra h de un bloque que empieza en blockStart. */
HostBlockInfo infoAt(const BlockPosition& bp, std::int64_t h, std::int64_t blockStart, double sr) noexcept
{
    HostBlockInfo i = bp.info;
    i.hostSample = h;
    if (h != blockStart && i.ppqValid && i.bpm > 0 && sr > 0)
        i.ppq += static_cast<double>(h - blockStart) * i.bpm / (60.0 * sr);
    return i;
}

/** ¿Hay que anotar otra posición del host? (primer bloque, cambios de tempo/compás/fase, deriva, 1 por segundo) */
bool needAnchor(const AnchorEntry* last, int numAnchors, int capacity, std::int64_t offset, const HostBlockInfo& i,
                double sr) noexcept
{
    if (numAnchors <= 0 || last == nullptr)
        return true;
    if (numAnchors >= capacity)
        return false;
    const HostBlockInfo& l = last->info;
    if (i.tsNum != l.tsNum || i.tsDen != l.tsDen || i.ppqValid != l.ppqValid || i.barValid != l.barValid)
        return true;
    if (i.barValid && l.barValid && i.tsNum > 0 && i.tsDen > 0)
    {
        const double barLen = i.tsNum * 4.0 / i.tsDen;
        const double d = std::fmod(i.lastBarStartPpq - l.lastBarStartPpq, barLen);
        if (std::fabs(d) > 1e-6 && std::fabs(std::fabs(d) - barLen) > 1e-6)
            return true;
    }
    const double dt = static_cast<double>(offset - last->offset);
    if (dt >= sr)
        return true;
    const double minSpacing = numAnchors < capacity / 2 ? 0.0 : 0.05 * sr;
    if (dt < minSpacing)
        return false;
    if (std::fabs(i.bpm - l.bpm) > 1e-9)
        return true;
    if (i.ppqValid && l.ppqValid && l.bpm > 0 && sr > 0)
    {
        const double predicted = l.ppq + dt * l.bpm / (60.0 * sr);
        if (std::fabs(predicted - i.ppq) > 1e-6)
            return true;
    }
    return false;
}

/** ppq y bpm esperados en la muestra p según el mapa de tempo de la toma. */
bool expectedTempoAt(const PlaybackSnapshot& s, std::int64_t p, double& ppq, double& bpm) noexcept
{
    const auto& t = s.tempo;
    if (t.empty())
        return false;
    // último punto con hostSample <= p
    std::size_t lo = 0, hi = t.size();
    while (hi - lo > 1)
    {
        const std::size_t mid = (lo + hi) / 2;
        if (t[mid].hostSample <= p)
            lo = mid;
        else
            hi = mid;
    }
    const TempoPoint& a = t[lo];
    if (!(a.samplesPerQuarter > 0))
        return false;
    ppq = a.ppq + static_cast<double>(p - a.hostSample) / a.samplesPerQuarter;
    bpm = a.bpm;
    if (lo + 1 < t.size() && p > a.hostSample)
    {
        const TempoPoint& b = t[lo + 1];
        const double f = static_cast<double>(p - a.hostSample) / static_cast<double>(b.hostSample - a.hostSample);
        bpm = a.bpm + (b.bpm - a.bpm) * std::min(1.0, std::max(0.0, f));
    }
    return true;
}
} // namespace

TakeEngine::TakeEngine(Hub& hub) : hub_(hub) {}

void TakeEngine::prepare(double sampleRate, int /*maxBlockSize*/)
{
    if (inPass_)
        endPass(PassEnd::Stopped);
    sr_ = sampleRate > 0 ? sampleRate : 44100;
    maxTakeSamples_ = static_cast<std::int64_t>(std::floor(kMaxTakeSeconds * sr_));
    minTakeSamples_ = static_cast<std::int64_t>(std::ceil(kMinTakeSeconds * sr_));
    windowLen_ = std::max<std::int64_t>(64, static_cast<std::int64_t>(std::llround(tuning.windowSec * sr_)));
    contiguityTol_ = contiguityToleranceSamples(sr_);
    resetChangeWindow();
    cdDiffWindows_ = 0;
    tempoMismatch_ = 0;
}

void TakeEngine::release()
{
    if (inPass_)
        endPass(PassEnd::Stopped);
    flushRetired();
}

void TakeEngine::destroySnapshots()
{
    // sin audio corriendo: se puede liberar aquí
    PlaybackSnapshot* all[] = {waiting_, latest_, passSnap_};
    for (int i = 0; i < 3; ++i)
    {
        PlaybackSnapshot* s = all[i];
        if (s == nullptr)
            continue;
        for (int k = i + 1; k < 3; ++k)
            if (all[k] == s)
                all[k] = nullptr;
        delete s;
    }
    waiting_ = latest_ = passSnap_ = nullptr;
    for (int i = 0; i < numOverflow_; ++i)
        delete overflow_[i];
    numOverflow_ = 0;
}

// ---- colas ---------------------------------------------------------------------------------------------------

void TakeEngine::emit(const AudioEvent& e) noexcept
{
    AudioEvent ev = e;
    ev.epoch = epoch_;
    hub_.events.push(ev);   // 4096 lugares: si se llena el worker está muerto; no hay nada mejor que hacer
}

void TakeEngine::warn(WarningKind w, std::int64_t hostSample) noexcept
{
    const int k = static_cast<int>(w);
    if (k >= 0 && k < 8)
    {
        if (warnedThisPass_[k])
            return;
        warnedThisPass_[k] = true;
    }
    AudioEvent e;
    e.type = EventType::Warning;
    e.warning = w;
    e.hostSample = hostSample;
    emit(e);
}

void TakeEngine::retire(PlaybackSnapshot* s) noexcept
{
    if (s == nullptr)
        return;
    if (hub_.retired.push(s))
        return;
    if (numOverflow_ < 16)
        overflow_[numOverflow_++] = s;
    // si no, se pierde (nunca pasa: el worker vacía la cola cada pocos ms)
}

void TakeEngine::flushRetired() noexcept
{
    int kept = 0;
    for (int i = 0; i < numOverflow_; ++i)
        if (!hub_.retired.push(overflow_[i]))
            overflow_[kept++] = overflow_[i];
    numOverflow_ = kept;
}

void TakeEngine::dropSnapshots() noexcept
{
    if (passSnap_ != nullptr && passSnap_ != latest_)
        retire(passSnap_);
    retire(latest_);
    passSnap_ = latest_ = nullptr;
}

void TakeEngine::discardRecording() noexcept
{
    if (rec_ == nullptr)
        return;
    AudioEvent e;
    e.type = EventType::RecordingDiscarded;
    e.recorder = recIdx_;
    e.takeId = rec_->takeId;
    e.kind = rec_->kind;
    emit(e);
    rec_ = nullptr;
    recIdx_ = -1;
    hub_.live.recKind.store(-1, std::memory_order_relaxed);
}

void TakeEngine::applyCommands() noexcept
{
    AudioCommand c;
    while (hub_.commands.pop(c))
    {
        epoch_ = c.epoch;
        discardRecording();
        hub_.align.listening.store(false, std::memory_order_release);
        // la pasada en curso sigue, pero sin lo que tenía fijado; las instantáneas de épocas anteriores ya no valen
        if (passSnap_ != nullptr && passSnap_ != latest_)
            retire(passSnap_);
        passSnap_ = nullptr;
        if (latest_ != nullptr && latest_->epoch < c.epoch)
        {
            retire(latest_);
            latest_ = nullptr;
        }
        pendingInvalidate_ = false;
        resetChangeWindow();
        cdDiffWindows_ = 0;
        tempoMismatch_ = 0;
        switch (c.type)
        {
            case CommandType::Reset:
                R_ = Range{};
                alignPending_ = false;
                break;
            case CommandType::ExpectAlignment:
                R_ = Range{};
                alignPending_ = true;
                break;
            case CommandType::SetRange:
                R_.valid = true;
                R_.id = c.takeId;
                R_.A = c.A;
                R_.E = c.E;
                R_.extendable = c.extendable;
                alignPending_ = false;
                break;
        }
        AudioEvent e;
        e.type = EventType::CommandApplied;
        emit(e);
    }
}

void TakeEngine::adoptPending() noexcept
{
    if (waiting_ == nullptr)
        waiting_ = hub_.pending.exchange(nullptr, std::memory_order_acq_rel);
    if (waiting_ == nullptr)
        return;
    if (waiting_->epoch > epoch_)
        applyCommands();
    if (waiting_->epoch > epoch_)
        return;   // sus órdenes todavía no llegaron
    if (waiting_->epoch < epoch_)
    {
        retire(waiting_);
        waiting_ = nullptr;
        return;
    }
    if (latest_ != nullptr && latest_ != passSnap_)
        retire(latest_);
    latest_ = waiting_;
    waiting_ = nullptr;
}

// ---- bloque --------------------------------------------------------------------------------------------------

void TakeEngine::processBypassed(int numSamples, const BlockPosition& pos) noexcept
{
    flushRetired();
    applyCommands();
    adoptPending();
    if (inPass_)
        endPass(PassEnd::Bypass);
    hub_.live.playing.store(pos.playing, std::memory_order_relaxed);
    hub_.live.outputEdited.store(false, std::memory_order_relaxed);
    publishRange();
    if (pos.hasTime)
        hub_.live.hostSample.store(pos.timeInSamples + numSamples, std::memory_order_relaxed);
}

void TakeEngine::process(float* const* ch, int numIn, int numOut, int n, const BlockPosition& bp,
                         bool nonRealtime) noexcept
{
    flushRetired();
    applyCommands();
    adoptPending();

    // lo que dijo el host, para el worker y la interfaz
    {
        HostInfoBox::Value v;
        v.valid = bp.hasInfo;
        v.playing = bp.playing;
        v.hasTime = bp.hasTime;
        v.timeInSamples = bp.timeInSamples;
        v.info = bp.info;
        hub_.hostInfo.write(v);
        LiveAtomics& L = hub_.live;
        L.playing.store(bp.playing && bp.hasTime, std::memory_order_relaxed);
        L.positionKnown.store(bp.hasTime, std::memory_order_relaxed);
        if (bp.hasTime)
            L.hostSample.store(bp.timeInSamples, std::memory_order_relaxed);
        L.ppq.store(bp.info.ppq, std::memory_order_relaxed);
        L.bpm.store(bp.info.bpm, std::memory_order_relaxed);
        L.tsNum.store(bp.info.tsNum, std::memory_order_relaxed);
        L.tsDen.store(bp.info.tsDen, std::memory_order_relaxed);
        L.lastBarPpq.store(bp.info.lastBarStartPpq, std::memory_order_relaxed);
        L.processedBlocks.fetch_add(1, std::memory_order_relaxed);
    }

    if (!bp.playing || !bp.hasTime || n <= 0)
    {
        if (inPass_ && (!bp.playing || !bp.hasTime))
            endPass(PassEnd::Stopped);
        if (!bp.playing)
            checkTempo(bp);   // cambio de tempo con el transporte parado
        hub_.live.outputEdited.store(false, std::memory_order_relaxed);
        hub_.live.outsideNotTaken.store(false, std::memory_order_relaxed);
        publishRange();
        return;   // la entrada pasa tal cual
    }

    // FL puede redondear la posición: una diferencia de hasta contiguityTol_ con lo esperado (posición anterior + largo
    // del bloque anterior) sigue siendo de corrido, y se usa la posición esperada (el audio llega de corrido aunque el
    // número informado tiemble); más que eso es un salto.
    std::int64_t p = bp.timeInSamples;
    if (inPass_)
    {
        const std::int64_t d = p - expectedNext_;
        if (d >= -contiguityTol_ && d <= contiguityTol_)
            p = expectedNext_;
        else
            endPass(PassEnd::Jump);
    }
    if (!inPass_)
    {
        // Play justo donde terminó la toma (FL puede informar unas muestras de más o de menos): sigue de corrido
        // con ella, así se agrega lo de detrás sin huecos
        if (R_.valid && R_.extendable && !alignPending_ && p != R_.E && p - R_.E >= -contiguityTol_
            && p - R_.E <= contiguityTol_)
            p = R_.E;
        startPass(p);
    }

    editedNow_ = false;
    outsideNow_ = false;
    checkTempo(bp);

    int j = 0;
    int guard = 0;
    while (j < n)
    {
        const int run = step(ch, numIn, numOut, j, p + j, n - j, bp, p, nonRealtime);
        j += run;
        if (pendingInvalidate_)
        {
            pendingInvalidate_ = false;
            invalidate(pendingReason_, pendingInvalidateAt_);
        }
        if (run == 0 && ++guard > 8)
            break;   // nunca debería pasar: cada vuelta sin avanzar cambia el estado
    }
    expectedNext_ = p + n;

    LiveAtomics& L = hub_.live;
    L.outputEdited.store(editedNow_, std::memory_order_relaxed);
    L.outsideNotTaken.store(outsideNow_, std::memory_order_relaxed);
    publishRange();
    L.playingSnapshotTakeId.store(passSnap_ != nullptr ? passSnap_->takeId : 0u, std::memory_order_relaxed);
    L.playingSnapshotA.store(passSnap_ != nullptr ? passSnap_->A : 0, std::memory_order_relaxed);
    if (rec_ != nullptr)
        L.recFrames.store(rec_->frames, std::memory_order_relaxed);
    else if (hub_.align.listening.load(std::memory_order_relaxed))
        L.recFrames.store(hub_.align.count.load(std::memory_order_relaxed), std::memory_order_relaxed);
}

void TakeEngine::publishRange() noexcept
{
    LiveAtomics& L = hub_.live;
    L.rangeValid.store(R_.valid, std::memory_order_relaxed);
    L.rangeTakeId.store(R_.id, std::memory_order_relaxed);
    L.rangeA.store(R_.A, std::memory_order_relaxed);
    L.rangeE.store(R_.E, std::memory_order_relaxed);
}

void TakeEngine::startPass(std::int64_t p) noexcept
{
    inPass_ = true;
    appendBlocked_ = false;
    for (bool& w : warnedThisPass_)
        w = false;
    resetChangeWindow();
    cdDiffWindows_ = 0;
    passSnap_ = (R_.valid && latest_ != nullptr && latest_->takeId == R_.id) ? latest_ : nullptr;
    if (alignPending_)
        startAlignListen(p);
    else if (R_.valid && R_.extendable && p < R_.A && R_.E - p <= maxTakeSamples_)
        startRecording(RecKind::Prepend, p);
}

void TakeEngine::endPass(PassEnd why) noexcept
{
    if (rec_ != nullptr)
    {
        if (rec_->kind == RecKind::Prepend)
            discardRecording();   // no llegó al principio de la toma: no se puede unir
        else
            finishRecording(why == PassEnd::Jump);
    }
    hub_.align.listening.store(false, std::memory_order_release);
    if (passSnap_ != nullptr && passSnap_ != latest_)
        retire(passSnap_);
    passSnap_ = nullptr;
    inPass_ = false;
    resetChangeWindow();
    cdDiffWindows_ = 0;
    hub_.live.recKind.store(-1, std::memory_order_relaxed);
}

int TakeEngine::step(float* const* ch, int numIn, int numOut, int j, std::int64_t h, int len,
                     const BlockPosition& bp, std::int64_t blockStart, bool nonRealtime) noexcept
{
    // sin toma: se toma (o se escucha para ubicar el archivo)
    if (rec_ == nullptr && !R_.valid)
    {
        if (alignPending_)
        {
            if (!hub_.align.listening.load(std::memory_order_relaxed))
                startAlignListen(h);
            alignRun(ch, numIn, j, h, len, bp, blockStart);
            return len;
        }
        if (numIn > 0 && !startRecording(RecKind::NewTake, h))
            return len;   // sin grabadora o sin memoria: suena el original (se reintenta en el próximo bloque)
    }

    if (rec_ != nullptr)
    {
        std::int64_t room = 0;
        switch (rec_->kind)
        {
            case RecKind::NewTake: room = maxTakeSamples_ - rec_->frames; break;
            case RecKind::Prepend: room = R_.A - h; break;
            case RecKind::Append: room = maxTakeSamples_ - (R_.E - R_.A) - rec_->frames; break;
        }
        const int run = static_cast<int>(std::max<std::int64_t>(0, std::min<std::int64_t>(len, room)));
        const bool recorded = run <= 0 || recordRun(ch, numIn, j, h, run, bp, blockStart, nonRealtime);
        // detrás de la toma puede seguir sonando lo editado («Alargar»); la entrada ya quedó grabada
        if (run > 0)
            editedBeyondTake(ch, numOut, j, h, run);
        if (!recorded)
            return run;   // se cortó (sin memoria): lo tomado ya se entregó
        if (rec_ != nullptr)
        {
            if (rec_->kind == RecKind::Prepend)
            {
                if (h + run >= R_.A)
                    finishRecording(false);   // llegó a la toma: se une
            }
            else if (run == static_cast<int>(room))
            {
                warn(WarningKind::MaxLength, h + run);
                appendBlocked_ = true;
                finishRecording(false);
            }
        }
        return run;
    }

    if (R_.valid)
    {
        if (h >= R_.A && h < R_.E)
        {
            const int run = static_cast<int>(std::min<std::int64_t>(len, R_.E - h));
            insideRun(ch, numIn, numOut, j, h, run);
            return run;
        }
        if (h == R_.E && R_.extendable && !appendBlocked_ && numIn > 0 && R_.E - R_.A < maxTakeSamples_)
        {
            if (startRecording(RecKind::Append, h))
                return 0;   // la próxima vuelta graba
            appendBlocked_ = true;
        }
        if (h < R_.A)
        {
            outsideNow_ = true;
            return static_cast<int>(std::min<std::int64_t>(len, R_.A - h));
        }
        if (editedBeyondTake(ch, numOut, j, h, len) < len)
            outsideNow_ = true;
        return len;
    }
    return len;
}

// ---- grabación -----------------------------------------------------------------------------------------------

Chunk* TakeEngine::acquireChunk(bool nonRealtime) noexcept
{
    Chunk* c = nullptr;
    if (hub_.pool.freeQueue().pop(c))
        return c;
    if (nonRealtime)
    {
        // render offline (exportar en FL): aquí sí se puede reservar memoria, no hay tiempo real que cumplir
        try
        {
            return new Chunk();
        }
        catch (...)
        {
            return nullptr;
        }
    }
    return nullptr;
}

bool TakeEngine::startRecording(RecKind kind, std::int64_t h) noexcept
{
    int idx = -1;
    if (!hub_.freeRecorders.pop(idx) || idx < 0 || idx >= kNumRecorders)
    {
        warn(WarningKind::NoRecorder, h);
        return false;
    }
    Recorder& r = hub_.recorders[idx];
    std::uint32_t id = R_.id;
    if (kind == RecKind::NewTake)
        id = hub_.nextTakeId.fetch_add(1, std::memory_order_relaxed);
    r.resetForUse(kind, id, h, 0);   // numChannels se fija en el primer tramo
    rec_ = &r;
    recIdx_ = idx;
    LiveAtomics& L = hub_.live;
    L.recKind.store(kind == RecKind::NewTake ? 0 : kind == RecKind::Prepend ? 1 : 2, std::memory_order_relaxed);
    L.recStart.store(h, std::memory_order_relaxed);
    L.recFrames.store(0, std::memory_order_relaxed);
    return true;
}

bool TakeEngine::recordRun(float* const* ch, int numIn, int j, std::int64_t h, int run, const BlockPosition& bp,
                           std::int64_t blockStart, bool nonRealtime) noexcept
{
    Recorder& r = *rec_;
    if (numIn <= 0)
        return true;   // sin entrada no hay nada que tomar (disposición rara): suena lo que haya
    if (r.numChannels == 0)
        r.numChannels = std::max(1, std::min(numIn, kMaxTakeChannels));
    // posición del host
    {
        const std::int64_t off = h - r.start;
        const HostBlockInfo info = infoAt(bp, h, blockStart, sr_);
        const AnchorEntry* last = r.numAnchors > 0 ? &r.anchors[static_cast<std::size_t>(r.numAnchors - 1)] : nullptr;
        if (bp.hasInfo && needAnchor(last, r.numAnchors, kMaxAnchors, off, info, sr_))
        {
            AnchorEntry& a = r.anchors[static_cast<std::size_t>(r.numAnchors++)];
            a.offset = off;
            a.info = info;
        }
        if (r.frames == 0)
        {
            hub_.live.recPpqStart.store(info.ppq, std::memory_order_relaxed);
            hub_.live.recPpqValid.store(info.ppqValid, std::memory_order_relaxed);
        }
    }
    int done = 0;
    while (done < run)
    {
        const std::size_t idx = static_cast<std::size_t>(r.frames / kChunkFrames);
        const int within = static_cast<int>(r.frames % kChunkFrames);
        if (idx >= r.chunks.size())
            break;
        Chunk* c = r.chunks[idx];
        if (c == nullptr)
        {
            c = acquireChunk(nonRealtime);
            if (c == nullptr)
            {
                warn(WarningKind::PoolDry, h + done);
                appendBlocked_ = true;
                finishRecording(false);
                return false;
            }
            r.chunks[idx] = c;
        }
        const int m = std::min(run - done, kChunkFrames - within);
        for (int k = 0; k < r.numChannels; ++k)
        {
            const float* src = ch[std::min(k, numIn - 1)] + j + done;
            std::memcpy(c->data[k] + within, src, sizeof(float) * static_cast<std::size_t>(m));
        }
        r.frames += m;
        done += m;
    }
    return true;
}

void TakeEngine::finishRecording(bool jumped) noexcept
{
    if (rec_ == nullptr)
        return;
    Recorder& r = *rec_;
    const std::int64_t endSample = r.start + r.frames;
    bool keep = false;
    switch (r.kind)
    {
        case RecKind::NewTake:
            if (r.frames >= minTakeSamples_)
            {
                R_.valid = true;
                R_.id = r.takeId;
                R_.A = r.start;
                R_.E = endSample;
                R_.extendable = true;
                keep = true;
            }
            else if (r.frames > 0)
                warn(WarningKind::TooShort, endSample);
            break;
        case RecKind::Prepend:
            if (R_.valid && r.takeId == R_.id && endSample == R_.A && r.frames > 0)
            {
                R_.A = r.start;
                keep = true;
            }
            break;
        case RecKind::Append:
            if (R_.valid && r.takeId == R_.id && r.start == R_.E && r.frames > 0)
            {
                R_.E = endSample;
                keep = true;
            }
            break;
    }
    if (!keep)
    {
        discardRecording();
        return;
    }
    if (jumped)
        warn(WarningKind::JumpDuringTake, endSample);
    AudioEvent e;
    e.type = EventType::RecordingFinished;
    e.recorder = recIdx_;
    e.takeId = r.takeId;
    e.kind = r.kind;
    e.hostSample = r.start;
    emit(e);
    rec_ = nullptr;
    recIdx_ = -1;
    hub_.live.recKind.store(-1, std::memory_order_relaxed);
}

// ---- escucha para ubicar un archivo --------------------------------------------------------------------------

void TakeEngine::startAlignListen(std::int64_t h) noexcept
{
    AlignBuffer& a = hub_.align;
    a.gen.fetch_add(1, std::memory_order_acq_rel);   // impar: reiniciando
    a.count.store(0, std::memory_order_relaxed);
    a.numAnchors.store(0, std::memory_order_relaxed);
    a.startHost.store(h, std::memory_order_relaxed);
    a.gen.fetch_add(1, std::memory_order_release);   // par
    a.listening.store(true, std::memory_order_release);
    hub_.live.recKind.store(3, std::memory_order_relaxed);
    hub_.live.recStart.store(h, std::memory_order_relaxed);
}

void TakeEngine::alignRun(float* const* ch, int numIn, int j, std::int64_t h, int run, const BlockPosition& bp,
                          std::int64_t blockStart) noexcept
{
    AlignBuffer& a = hub_.align;
    const std::int64_t cap = static_cast<std::int64_t>(a.mono.size());
    if (cap <= 0 || numIn <= 0)
        return;
    std::int64_t c = a.count.load(std::memory_order_relaxed);
    if (c + run > cap)
    {
        startAlignListen(h);   // lleno: se empieza otra vez desde aquí (ventana deslizante)
        c = 0;
        if (run > cap)
            return;
    }
    // posición del host
    {
        const std::int64_t start = a.startHost.load(std::memory_order_relaxed);
        const int na = a.numAnchors.load(std::memory_order_relaxed);
        const int capA = static_cast<int>(a.anchors.size());
        const HostBlockInfo info = infoAt(bp, h, blockStart, sr_);
        const AnchorEntry* last = na > 0 ? &a.anchors[static_cast<std::size_t>(na - 1)] : nullptr;
        if (bp.hasInfo && needAnchor(last, na, capA, h - start, info, sr_))
        {
            AnchorEntry& e = a.anchors[static_cast<std::size_t>(na)];
            e.offset = h - start;
            e.info = info;
            a.numAnchors.store(na + 1, std::memory_order_release);
        }
    }
    float* dst = a.mono.data() + c;
    if (numIn == 1)
        std::memcpy(dst, ch[0] + j, sizeof(float) * static_cast<std::size_t>(run));
    else
    {
        const float* l = ch[0] + j;
        const float* r = ch[1] + j;
        for (int k = 0; k < run; ++k)
            dst[k] = 0.5f * (l[k] + r[k]);
    }
    a.count.store(c + run, std::memory_order_release);
}

// ---- dentro de la toma ---------------------------------------------------------------------------------------

void TakeEngine::insideRun(float* const* ch, int numIn, int numOut, int j, std::int64_t h, int run) noexcept
{
    const PlaybackSnapshot* s = passSnap_;
    if (s != nullptr && s->changeDetect && s->takeNumCh > 0 && numIn > 0)
        detectChanges(ch, numIn, j, h, run, *s);
    else
        resetChangeWindow();

    const bool edited = s != nullptr && s->edLen > 0 && s->edNumCh > 0 &&
                        hub_.listenOriginal.load(std::memory_order_relaxed) == 0;
    if (!edited)
        return;   // suena el original

    int k = 0;
    while (k < run)
    {
        const std::int64_t hh = h + k;
        if (hh < s->A)
        {
            k += static_cast<int>(std::min<std::int64_t>(run - k, s->A - hh));
            continue;
        }
        if (hh >= s->E)
        {
            // más allá de lo que cubre la instantánea (lo agregado todavía sin render): original, salvo lo editado
            // que dura más que la toma
            editedBeyondTake(ch, numOut, j + k, hh, run - k);
            break;
        }
        const std::int64_t edEnd = s->A + s->edLen;
        if (hh < edEnd)
        {
            const int m = static_cast<int>(std::min<std::int64_t>({static_cast<std::int64_t>(run - k), edEnd - hh,
                                                                   s->E - hh}));
            writeEdited(ch, numOut, j + k, *s, hh - s->A, m);
            editedNow_ = true;
            k += m;
            continue;
        }
        const int m = static_cast<int>(std::min<std::int64_t>(run - k, s->E - hh));
        for (int oc = 0; oc < numOut; ++oc)
            std::memset(ch[oc] + j + k, 0, sizeof(float) * static_cast<std::size_t>(m));
        editedNow_ = true;
        k += m;
    }
}

void TakeEngine::writeEdited(float* const* ch, int numOut, int j, const PlaybackSnapshot& s, std::int64_t src,
                             int m) noexcept
{
    if (s.edNumCh == 1 || numOut == 1)
    {
        if (s.edNumCh == 1)
        {
            for (int oc = 0; oc < numOut; ++oc)
                std::memcpy(ch[oc] + j, s.edCh[0] + src, sizeof(float) * static_cast<std::size_t>(m));
        }
        else
        {
            const float* l = s.edCh[0] + src;
            const float* r = s.edCh[1] + src;
            float* o = ch[0] + j;
            for (int i = 0; i < m; ++i)
                o[i] = 0.5f * (l[i] + r[i]);
        }
    }
    else
    {
        for (int oc = 0; oc < numOut; ++oc)
            std::memcpy(ch[oc] + j, s.edCh[std::min(oc, s.edNumCh - 1)] + src,
                        sizeof(float) * static_cast<std::size_t>(m));
    }
}

int TakeEngine::editedBeyondTake(float* const* ch, int numOut, int j, std::int64_t h, int run) noexcept
{
    const PlaybackSnapshot* s = passSnap_;
    if (s == nullptr || s->edLen <= 0 || s->edNumCh <= 0 || numOut <= 0 || run <= 0
        || hub_.listenOriginal.load(std::memory_order_relaxed) != 0)
        return 0;
    const std::int64_t from = std::max(h, s->E);
    const std::int64_t to = std::min(h + run, s->A + s->edLen);
    if (from >= to)
        return 0;
    const int m = static_cast<int>(to - from);
    writeEdited(ch, numOut, j + static_cast<int>(from - h), *s, from - s->A, m);
    editedNow_ = true;
    return m;
}

void TakeEngine::resetChangeWindow() noexcept
{
    cdXX_ = cdYY_ = cdDD_ = cdXY_ = 0;
    cdCount_ = 0;
    cdNext_ = -1;
}

void TakeEngine::detectChanges(float* const* ch, int numIn, int j, std::int64_t h, int run,
                               const PlaybackSnapshot& s) noexcept
{
    const int nc = std::max(1, std::min(numIn, s.takeNumCh));
    int k = 0;
    while (k < run)
    {
        const std::int64_t hh = h + k;
        if (pendingInvalidate_)
            break;
        if (hh < s.A)
        {
            resetChangeWindow();
            k += static_cast<int>(std::min<std::int64_t>(run - k, s.A - hh));
            continue;
        }
        if (hh >= s.E)
        {
            resetChangeWindow();
            break;
        }
        if (cdNext_ != hh || cdChannels_ != nc)
        {
            resetChangeWindow();
            cdChannels_ = nc;
        }
        const std::int64_t remainWin = windowLen_ - cdCount_;
        const int m = static_cast<int>(std::min<std::int64_t>({static_cast<std::int64_t>(run - k), remainWin,
                                                               s.E - hh}));
        const std::int64_t t = hh - s.A;
        for (int c = 0; c < nc; ++c)
        {
            const float* x = ch[c] + j + k;
            const float* y = s.takeCh[c] + t;
            double xx = 0, yy = 0, dd = 0, xy = 0;
            for (int i = 0; i < m; ++i)
            {
                const double a = x[i], b = y[i], d = a - b;
                xx += a * a;
                yy += b * b;
                dd += d * d;
                xy += a * b;
            }
            cdXX_ += xx;
            cdYY_ += yy;
            cdDD_ += dd;
            cdXY_ += xy;
        }
        cdCount_ += m;
        cdNext_ = hh + m;
        k += m;
        if (cdCount_ >= windowLen_)
        {
            const double nVals = static_cast<double>(cdCount_) * nc;
            const double rmsX = std::sqrt(cdXX_ / nVals), rmsY = std::sqrt(cdYY_ / nVals);
            // entrada (casi) en silencio: no cuenta (canal silenciado, FL mandando ceros…): nunca se pierde la toma
            // por eso. Entrada con señal donde lo tomado era silencio: sí es un cambio.
            if (rmsX >= tuning.silence)
            {
                bool differ;
                if (rmsY < tuning.silence)
                    differ = true;
                else if (!s.correlationMode)
                    differ = std::sqrt(cdDD_) > tuning.diffRatio * std::sqrt(std::max(cdXX_, cdYY_));
                else
                    differ = cdXY_ / std::sqrt(cdXX_ * cdYY_) < tuning.minCorrelation;
                if (differ)
                {
                    if (++cdDiffWindows_ >= tuning.windowsToTrigger)
                    {
                        pendingInvalidate_ = true;
                        pendingReason_ = InvalidReason::AudioChanged;
                        pendingInvalidateAt_ = cdNext_;
                    }
                }
                else
                    cdDiffWindows_ = 0;
            }
            const std::int64_t next = cdNext_;
            resetChangeWindow();
            cdNext_ = next;
        }
    }
}

void TakeEngine::checkTempo(const BlockPosition& bp) noexcept
{
    if (!R_.valid || !bp.hasInfo || !(bp.info.bpm > 0) || !bp.hasTime)
    {
        tempoMismatch_ = 0;
        return;
    }
    const PlaybackSnapshot* s = (latest_ != nullptr && latest_->takeId == R_.id) ? latest_ : passSnap_;
    if (s == nullptr || s->takeId != R_.id)
        return;
    const std::int64_t p = bp.timeInSamples;
    if (p < s->tempoFrom || p >= s->tempoTo)
        return;
    double ppq = 0, bpm = 0;
    if (!expectedTempoAt(*s, p, ppq, bpm))
        return;
    bool mismatch = std::fabs(bp.info.bpm - bpm) > kTempoBpmTol;
    if (bp.info.ppqValid && std::fabs(bp.info.ppq - ppq) > kTempoPpqTol)
        mismatch = true;
    if (!mismatch)
    {
        tempoMismatch_ = 0;
        return;
    }
    if (++tempoMismatch_ >= kTempoMismatchBlocks)
    {
        tempoMismatch_ = 0;
        invalidate(InvalidReason::TempoChanged, p);
    }
}

void TakeEngine::invalidate(InvalidReason why, std::int64_t hostSample) noexcept
{
    if (!R_.valid)
        return;
    const bool wasFile = !R_.extendable;
    AudioEvent e;
    e.type = EventType::TakeInvalidated;
    e.takeId = R_.id;
    e.reason = why;
    e.hostSample = hostSample;
    if (rec_ != nullptr)
        discardRecording();
    emit(e);
    R_ = Range{};
    dropSnapshots();
    resetChangeWindow();
    cdDiffWindows_ = 0;
    // archivo + cambio de tempo: se vuelve a ubicar el archivo; si no, se vuelve a tomar desde aquí
    alignPending_ = wasFile && why == InvalidReason::TempoChanged;
}

} // namespace djec::plugin
