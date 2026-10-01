#include "Worker.h"

#include "FileDrop.h"
#include "Paths.h"
#include "WavIO.h"

#include "djec/align.h"
#include "djec/bars.h"
#include "djec/edit_plan.h"
#include "djec/grid.h"
#include "djec/resample.h"
#include "djec/splice.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>

namespace djec::plugin
{

namespace
{
constexpr double kAlignFirstTrySec = 2.5;   // primer intento con 2,5 s escuchados
constexpr double kAlignRetrySec = 1.0;      // después, cada segundo más
constexpr double kAlignGiveUpSec = 8.0;     // a los ~8 s sin encontrarlo: aviso + «El archivo empieza en el compás 1»
constexpr std::size_t kMaxNotices = 8;
constexpr double kTempoMatchLo = 0.92, kTempoMatchHi = 1.08;   // TEMPO_MATCH de main.js
constexpr int kActiveWaitMs = 5;     // con el transporte en marcha (o trabajo reciente): mira la cola del audio cada 5 ms
constexpr int kIdleWaitMs = 25;      // en reposo, cada 25 ms (las órdenes de la interfaz lo despiertan al instante)
constexpr juce::int64 kActiveHoldMs = 1000;   // sigue mirando seguido un rato después de la última actividad

juce::String u8(const char* s)
{
    return juce::String::fromUTF8(s);
}
juce::String u8(const std::string& s)
{
    return juce::String::fromUTF8(s.c_str());
}

juce::String formatNumber1(double x)
{
    const double r = std::floor(x * 10 + 0.5) / 10;
    if (std::fabs(r - std::round(r)) < 1e-9)
        return juce::String(static_cast<long long>(std::llround(r)));
    return juce::String(r, 1).replaceCharacter('.', ',');
}

std::shared_ptr<const WaveformPeaks> computePeaks(const std::vector<std::vector<float>>& ch, double sr)
{
    auto p = std::make_shared<WaveformPeaks>();
    p->sampleRate = sr;
    const std::size_t n = ch.empty() ? 0 : ch[0].size();
    p->numSamples = static_cast<std::int64_t>(n);
    WaveformPeaks::Level l0;
    l0.samplesPerPeak = WaveformPeaks::kBasePeak;
    const std::size_t B = static_cast<std::size_t>(WaveformPeaks::kBasePeak);
    const std::size_t nb = (n + B - 1) / B;
    l0.mins.assign(nb, 0.0f);
    l0.maxs.assign(nb, 0.0f);
    for (std::size_t b = 0; b < nb; ++b)
    {
        float lo = std::numeric_limits<float>::max(), hi = -std::numeric_limits<float>::max();
        const std::size_t i0 = b * B, i1 = std::min(n, i0 + B);
        for (const auto& c : ch)
            for (std::size_t i = i0; i < i1; ++i)
            {
                lo = std::min(lo, c[i]);
                hi = std::max(hi, c[i]);
            }
        l0.mins[b] = lo;
        l0.maxs[b] = hi;
    }
    p->levels.push_back(std::move(l0));
    while (p->levels.back().mins.size() > 256)
    {
        const WaveformPeaks::Level& prev = p->levels.back();
        WaveformPeaks::Level next;
        next.samplesPerPeak = prev.samplesPerPeak * 4;
        const std::size_t m = (prev.mins.size() + 3) / 4;
        next.mins.resize(m);
        next.maxs.resize(m);
        for (std::size_t b = 0; b < m; ++b)
        {
            float lo = prev.mins[4 * b], hi = prev.maxs[4 * b];
            for (std::size_t k = 4 * b + 1; k < std::min(prev.mins.size(), 4 * b + 4); ++k)
            {
                lo = std::min(lo, prev.mins[k]);
                hi = std::max(hi, prev.maxs[k]);
            }
            next.mins[b] = lo;
            next.maxs[b] = hi;
        }
        p->levels.push_back(std::move(next));
    }
    return p;
}

/** ppq en la muestra del host h según un ancla. */
double ppqAt(const HostBlockInfo& i, std::int64_t h, double sr)
{
    const double bpm = i.bpm > 0 ? i.bpm : 120;
    const double base = i.ppqValid ? i.ppq : static_cast<double>(i.hostSample) / sr * bpm / 60;
    return base + static_cast<double>(h - i.hostSample) * bpm / (60 * sr);
}

/** Compás de FL (1 = el primero) en la muestra del host h. */
int barNumberAt(const std::vector<AnchorEntry>& anchors, std::int64_t h, double sr)
{
    if (anchors.empty() || !(sr > 0))
        return 1;
    const HostBlockInfo& i = anchors.front().info;
    const int num = i.tsNum >= 1 ? i.tsNum : 4;
    const int den = (i.tsDen == 2 || i.tsDen == 4 || i.tsDen == 8 || i.tsDen == 16) ? i.tsDen : 4;
    const double barLen = num * 4.0 / den;
    const double p = ppqAt(i, h, sr);
    double barNum;
    if (i.barValid)
    {
        const double k = std::floor((p - i.lastBarStartPpq) / barLen + 1e-6);
        barNum = std::round(i.lastBarStartPpq / barLen) + 1 + k;
    }
    else
        barNum = std::floor(p / barLen + 1e-6) + 1;
    return static_cast<int>(std::max(1.0, barNum));
}

// ---- compás de las anclas (cuadrícula de FL) ----
int meterNum(int n)
{
    return n >= 1 && n <= 64 ? n : 4;   // como gridFromHost
}
int meterDen(int d)
{
    return (d == 2 || d == 4 || d == 8 || d == 16) ? d : 4;
}

/** ppq de un ancla (NaN si no hay ppq ni tempo), como gridFromHost. */
double anchorPpq(const HostBlockInfo& i, double sr)
{
    if (i.ppqValid && std::isfinite(i.ppq))
        return i.ppq;
    if (i.bpm > 0 && sr > 0)
        return static_cast<double>(i.hostSample) / sr * i.bpm / 60;
    return std::numeric_limits<double>::quiet_NaN();
}

/** ppq de un "1" del compás del ancla (el inicio de compás de FL o, sin él, compases desde ppq 0). */
double anchorBarStart(const HostBlockInfo& i, double sr)
{
    const double barLen = meterNum(i.tsNum) * 4.0 / meterDen(i.tsDen);
    if (i.barValid && std::isfinite(i.lastBarStartPpq))
        return i.lastBarStartPpq;
    const double ppq = anchorPpq(i, sr);
    return std::isfinite(ppq) ? std::floor(ppq / barLen + 1e-9) * barLen : 0.0;
}

/** Fase del compás: ppq de un "1" módulo el largo del compás, en [0, largo). */
double barPhase(double barStartPpq, int num, int den)
{
    const double barLen = num * 4.0 / den;
    double ph = std::fmod(barStartPpq, barLen);
    if (ph < 0)
        ph += barLen;
    if (ph >= barLen - 1e-9)
        ph = 0;
    return ph;
}

/** El ancla pasa a decir num/den con los "1" en phase + k · largo del compás. */
void setAnchorMeter(HostBlockInfo& i, int num, int den, double phase, double sr)
{
    const double barLen = num * 4.0 / den;
    const double ppq = anchorPpq(i, sr);
    i.tsNum = num;
    i.tsDen = den;
    if (std::isfinite(ppq))
    {
        i.lastBarStartPpq = phase + std::floor((ppq - phase) / barLen + 1e-9) * barLen;
        i.barValid = true;
    }
    else
        i.barValid = false;
}

std::vector<TempoPoint> tempoMap(const std::vector<AnchorEntry>& anchors, std::int64_t A, double sr)
{
    std::vector<TempoPoint> pts;
    for (const AnchorEntry& a : anchors)
    {
        if (!(a.info.bpm > 0))
            continue;
        TempoPoint t;
        t.hostSample = A + a.offset;
        t.bpm = a.info.bpm;
        t.ppq = a.info.ppqValid ? a.info.ppq : static_cast<double>(a.info.hostSample) / sr * a.info.bpm / 60;
        if (!pts.empty() && pts.back().hostSample == t.hostSample)
            pts.back() = t;
        else
            pts.push_back(t);
    }
    std::sort(pts.begin(), pts.end(), [](const TempoPoint& a, const TempoPoint& b) { return a.hostSample < b.hostSample; });
    for (std::size_t i = 0; i < pts.size(); ++i)
    {
        const double nominal = 60 * sr / pts[i].bpm;
        pts[i].samplesPerQuarter = nominal;
        if (i + 1 < pts.size())
        {
            const double dOff = static_cast<double>(pts[i + 1].hostSample - pts[i].hostSample);
            const double dPpq = pts[i + 1].ppq - pts[i].ppq;
            if (dPpq > 0 && std::fabs(dOff / dPpq - nominal) <= 0.05 * nominal)
                pts[i].samplesPerQuarter = dOff / dPpq;
        }
    }
    return pts;
}
} // namespace

// ---------------------------------------------------------------------------------------------------------------

struct Worker::Model
{
    // toma
    std::shared_ptr<TakeAudio> take;
    TakeSource source = TakeSource::None;
    bool placed = false;
    std::int64_t A = 0;
    std::vector<AnchorEntry> anchors;   // offset = muestra de la toma
    // archivo soltado
    juce::File file;
    juce::int64 fileSize = 0, fileModified = 0;
    AlignState align = AlignState::None;
    int fileStartBar = 0;
    double alignConfidence = 0;
    bool loadingFile = false;
    djec::Aligner aligner;
    bool alignerReady = false;
    std::int64_t alignerMaxOffset = std::numeric_limits<std::int64_t>::min();
    std::uint32_t alignGen = 0xffffffffu;
    std::int64_t alignTried = 0;
    // toma guardada en disco
    juce::File wav;
    std::uint64_t hash = 0;
    // compás de la cuadrícula de FL
    bool meterFromMemory = false;       // las anclas dicen el compás recordado (FL estaba en el compás nuevo)
    int takeHostNum = 0, takeHostDen = 0;   // lo que dijo FL durante la toma
    // límites de la música (analyzeBounds o los de la detección): para la cuadrícula de FL
    bool boundsValid = false;
    djec::MusicBoundsResult bounds;
    // análisis
    djec::Analyzer analyzer;
    bool analyzed = false;
    djec::AnalysisResult detect;
    std::vector<double> forcedTimes;   // "1" forzados (s de la toma) a recolocar tras unir audio delante/detrás
    // derivados
    djec::AnalysisResult grid;
    djec::HostGridMeta meta;
    int sourceDen = 4;
    bool gridValid = false;
    bool hasPlan = false;
    djec::EditPlan plan;
    juce::String blockerText;
    std::shared_ptr<const RenderedAudio> render;
    std::uint64_t renderCounter = 0;
    std::shared_ptr<const WaveformPeaks> peaks, editedPeaks;
    bool busy = false;
    juce::String busyText;
    std::vector<Notice> notices;
    // pendientes hasta conocer la frecuencia del host
    bool hasPendingRestore = false;
    PersistedState pendingRestore;
    juce::File pendingLoad;
    double preparedRate = 0;
};

Worker::Worker(Hub& hub) : hub_(hub), m_(std::make_unique<Model>())
{
    view_ = std::make_shared<SessionView>();
}

Worker::~Worker()
{
    stop();
    // (sin hilo: ya se puede tocar el modelo) el WAV deja de estar en uso por esta instancia
    takefiles::release(m_->wav);
    const std::lock_guard<std::mutex> lock(stateMutex_);
    takefiles::release(pendingRestoreFile_);
    pendingRestoreFile_ = juce::File();
}

void Worker::start()
{
    if (thread_.joinable())
        return;
    {
        const std::lock_guard<std::mutex> lock(jobsMutex_);
        stop_ = false;
    }
    startedMs_ = juce::Time::currentTimeMillis();
    lastActiveMs_ = startedMs_;
    thread_ = std::thread([this] { run(); });
}

void Worker::stop()
{
    {
        const std::lock_guard<std::mutex> lock(jobsMutex_);
        stop_ = true;
    }
    jobsCv_.notify_all();
    if (thread_.joinable())
        thread_.join();
    deleteRetired();
}

void Worker::post(std::function<void()> job)
{
    {
        const std::lock_guard<std::mutex> lock(jobsMutex_);
        jobs_.push_back(std::move(job));
    }
    jobsCv_.notify_one();
}

bool Worker::activeNow()
{
    const juce::int64 now = juce::Time::currentTimeMillis();
    const LiveAtomics& L = hub_.live;
    if (L.playing.load(std::memory_order_relaxed) || L.recKind.load(std::memory_order_relaxed) >= 0
        || hub_.events.sizeApprox() > 0 || rebuildPending_.load() || hub_.align.listening.load(std::memory_order_relaxed)
        || !pendingCommands_.empty())
        lastActiveMs_ = now;
    return now - lastActiveMs_ < kActiveHoldMs;
}

void Worker::run()
{
    for (;;)
    {
        std::function<void()> job;
        {
            const int waitMs = activeNow() ? kActiveWaitMs : kIdleWaitMs;
            std::unique_lock<std::mutex> lock(jobsMutex_);
            // (rebuildPending_: los ajustes lo marcan y avisan sin encolar un trabajo)
            jobsCv_.wait_for(lock, std::chrono::milliseconds(waitMs),
                             [this] { return stop_ || !jobs_.empty() || rebuildPending_.load(); });
            if (stop_)
                return;
            if (!jobs_.empty())
            {
                job = std::move(jobs_.front());
                jobs_.pop_front();
            }
            // ocupado mientras haya algo que hacer en esta vuelta (lo mira waitIdle)
            busyJob_.store(job != nullptr || hub_.events.sizeApprox() > 0 || rebuildPending_.load());
        }
        wakeups_.fetch_add(1, std::memory_order_relaxed);
        deleteRetired();
        flushCommands();
        drainAudioEvents();
        hub_.pool.wake();   // si el audio gastó trozos (o se devolvieron), que el repositorio los reponga ya
        if (job)
        {
            lastActiveMs_ = juce::Time::currentTimeMillis();
            try
            {
                job();
            }
            catch (const std::exception& e)
            {
                addNotice("internal", NoticeKind::Error, u8("Algo salió mal: ") + u8(e.what()));
                publishView();
            }
        }
        if (rebuildPending_.exchange(false))
            rebuild();
        tryAlign();
        maintainTakeFiles();
        deleteRetired();
        flushCommands();
        busyJob_.store(false);
    }
}

bool Worker::waitIdle(int timeoutMs)
{
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    int calm = 0;
    while (std::chrono::steady_clock::now() < deadline)
    {
        bool idle;
        {
            const std::lock_guard<std::mutex> lock(jobsMutex_);
            idle = jobs_.empty() && !busyJob_.load() && !rebuildPending_.load() && hub_.events.sizeApprox() == 0;
        }
        calm = idle ? calm + 1 : 0;
        if (calm >= 4)   // cuatro miradas seguidas (≥ 2 vueltas del worker) sin trabajo
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
    return false;
}

// ---- audio ↔ worker -------------------------------------------------------------------------------------------

void Worker::deleteRetired()
{
    PlaybackSnapshot* s = nullptr;
    while (hub_.retired.pop(s))
        delete s;
}

void Worker::sendCommand(AudioCommand c)
{
    c.epoch = epoch_;
    if (!pendingCommands_.empty() || !hub_.commands.push(c))
        pendingCommands_.push_back(c);
}

void Worker::flushCommands()
{
    while (!pendingCommands_.empty() && hub_.commands.push(pendingCommands_.front()))
        pendingCommands_.pop_front();
}

void Worker::drainAudioEvents()
{
    AudioEvent e;
    while (hub_.events.pop(e))
    {
        busyJob_.store(true);   // (waitIdle) hay trabajo aunque la cola ya esté vacía
        handleEvent(e);
    }
}

void Worker::recycleRecorder(int index)
{
    if (index < 0 || index >= kNumRecorders)
        return;
    Recorder& r = hub_.recorders[index];
    for (Chunk*& c : r.chunks)
        if (c != nullptr)
        {
            hub_.pool.recycle(c);
            c = nullptr;
        }
    r.frames = 0;
    r.numAnchors = 0;
    hub_.freeRecorders.push(index);
}

void Worker::handleEvent(const AudioEvent& e)
{
    Model& m = *m_;
    switch (e.type)
    {
        case EventType::RecordingFinished:
            consumeRecording(e);
            break;
        case EventType::RecordingDiscarded:
            recycleRecorder(e.recorder);
            break;
        case EventType::CommandApplied:
            break;
        case EventType::Warning:
            switch (e.warning)
            {
                case WarningKind::JumpDuringTake:
                    addNotice("take-jump", NoticeKind::Info,
                              u8("Saltaste a otra parte mientras tomaba el audio: me quedo con lo tomado hasta ahí."));
                    break;
                case WarningKind::MaxLength:
                    addNotice("take-max", NoticeKind::Warning,
                              u8("La toma llegó al máximo de 15 minutos: me quedo con lo tomado."));
                    break;
                case WarningKind::PoolDry:
                    addNotice("take-memory", NoticeKind::Warning,
                              u8("Se acabó la memoria reservada para tomar el audio: me quedo con lo tomado hasta ahí."));
                    break;
                case WarningKind::TooShort:
                    addNotice("take-short", NoticeKind::Info,
                              u8("Eso fue muy corto: deja que suene al menos un segundo para tomar el audio."));
                    break;
                case WarningKind::NoRecorder:
                    addNotice("take-busy", NoticeKind::Info,
                              u8("Todavía estoy procesando la toma anterior: esta parte suena sin tomar."));
                    break;
            }
            publishView();
            break;
        case EventType::TakeInvalidated:
        {
            if (e.epoch < epoch_ || !m.take || m.take->id != e.takeId)
                break;
            const bool file = m.source == TakeSource::File;
            if (e.reason == InvalidReason::TempoChanged && file)
            {
                // el archivo sigue valiendo: se vuelve a ubicar (el audio ya está escuchando)
                m.placed = false;
                m.align = AlignState::WaitingForPlay;
                m.anchors.clear();
                m.alignGen = 0xffffffffu;
                {
                    const std::lock_guard<std::mutex> lock(stateMutex_);
                    persist_.align = AlignState::WaitingForPlay;
                    persist_.anchors.clear();
                }
                clearNotice("file-found");
                addNotice("tempo-changed", NoticeKind::Warning,
                          u8("Cambió el tempo del proyecto: vuelvo a ubicar el archivo en el próximo Play."));
                rebuildPending_ = true;
            }
            else
            {
                clearModel(false);
                if (e.reason == InvalidReason::TempoChanged)
                    addNotice("tempo-changed", NoticeKind::Warning,
                              u8("Cambió el tempo del proyecto: vuelvo a tomar el audio. Dale Play desde el "
                                 "principio."));
                else
                    addNotice("audio-changed", NoticeKind::Warning, u8("El audio del canal cambió: lo vuelvo a tomar."));
                publishView();
            }
            break;
        }
    }
}

void Worker::consumeRecording(const AudioEvent& e)
{
    if (e.recorder < 0 || e.recorder >= kNumRecorders)
        return;
    Recorder& r = hub_.recorders[e.recorder];
    Model& m = *m_;
    if (e.epoch < epoch_ || r.frames <= 0)
    {
        recycleRecorder(e.recorder);
        return;
    }
    // trozos → audio contiguo (cada trozo vuelve al repositorio en cuanto se copia)
    const int nCh = std::max(1, r.numChannels);
    const std::int64_t frames = r.frames;
    std::vector<std::vector<float>> ch(static_cast<std::size_t>(nCh), std::vector<float>(static_cast<std::size_t>(frames)));
    for (std::size_t idx = 0; idx < r.chunks.size(); ++idx)
    {
        Chunk* c = r.chunks[idx];
        const std::int64_t off = static_cast<std::int64_t>(idx) * kChunkFrames;
        if (c == nullptr || off >= frames)
            break;
        const std::size_t len = static_cast<std::size_t>(std::min<std::int64_t>(kChunkFrames, frames - off));
        for (int k = 0; k < nCh; ++k)
            std::memcpy(ch[static_cast<std::size_t>(k)].data() + off, c->data[k], len * sizeof(float));
        hub_.pool.recycle(c);
        r.chunks[idx] = nullptr;
    }
    std::vector<AnchorEntry> anchors(r.anchors.begin(), r.anchors.begin() + r.numAnchors);
    const std::int64_t start = r.start;
    const RecKind kind = r.kind;
    const std::uint32_t id = r.takeId;
    recycleRecorder(e.recorder);

    if (kind == RecKind::NewTake)
    {
        newTakeFromAudio(std::move(ch), id, start, std::move(anchors));
        return;
    }
    if (!m.take || m.source != TakeSource::Playback || !m.placed || m.take->id != id)
        return;
    // lo agregado puede venir con FL ya en el compás nuevo (el que pide el plugin): mismo compás que la toma
    normalizeAnchors(anchors, m.take->sampleRate, false);
    const auto& old = m.take->channels;
    const int outCh = std::max(nCh, m.take->numChannels());
    auto chan = [](const std::vector<std::vector<float>>& v, int k) -> const std::vector<float>& {
        return v[static_cast<std::size_t>(std::min<int>(k, static_cast<int>(v.size()) - 1))];
    };
    std::vector<std::vector<float>> merged(static_cast<std::size_t>(outCh));
    std::vector<AnchorEntry> mergedAnchors;
    std::int64_t newA = m.A;
    if (kind == RecKind::Prepend)
    {
        if (start + frames != m.A)
            return;
        for (int k = 0; k < outCh; ++k)
        {
            auto& dst = merged[static_cast<std::size_t>(k)];
            const auto& a = chan(ch, k);
            const auto& b = chan(old, k);
            dst.reserve(a.size() + b.size());
            dst.insert(dst.end(), a.begin(), a.end());
            dst.insert(dst.end(), b.begin(), b.end());
        }
        mergedAnchors = anchors;
        for (AnchorEntry a : m.anchors)
        {
            a.offset += frames;
            mergedAnchors.push_back(a);
        }
        newA = start;
    }
    else
    {
        if (m.A + m.take->numSamples != start)
            return;
        const std::int64_t oldLen = m.take->numSamples;
        for (int k = 0; k < outCh; ++k)
        {
            auto& dst = merged[static_cast<std::size_t>(k)];
            const auto& a = chan(old, k);
            const auto& b = chan(ch, k);
            dst.reserve(a.size() + b.size());
            dst.insert(dst.end(), a.begin(), a.end());
            dst.insert(dst.end(), b.begin(), b.end());
        }
        mergedAnchors = m.anchors;
        for (AnchorEntry a : anchors)
        {
            a.offset += oldLen;
            mergedAnchors.push_back(a);
        }
    }
    ch.clear();
    // "1" forzados de la detección: por tiempo (los índices de beat cambian al reanalizar)
    m.forcedTimes.clear();
    if (m.analyzed)
        for (int i : m.detect.forcedDownbeats)
            if (i >= 0 && static_cast<std::size_t>(i) < m.detect.beats.size())
                m.forcedTimes.push_back(m.detect.beats[static_cast<std::size_t>(i)] +
                                        (kind == RecKind::Prepend ? static_cast<double>(frames) / m.take->sampleRate : 0.0));
    // misma toma (mismo id), más larga
    auto t = std::make_shared<TakeAudio>();
    t->id = id;
    t->sampleRate = m.take->sampleRate;
    t->numSamples = static_cast<std::int64_t>(merged[0].size());
    t->channels = std::move(merged);
    m.take = std::move(t);
    m.A = newA;
    m.anchors = std::move(mergedAnchors);
    m.analyzed = false;
    m.analyzer.reset();
    m.boundsValid = false;
    m.peaks = computePeaks(m.take->channels, m.take->sampleRate);
    rebuild();
    saveTakeWav();
}

void Worker::newTakeFromAudio(std::vector<std::vector<float>> channels, std::uint32_t id, std::int64_t hostStart,
                              std::vector<AnchorEntry> anchors)
{
    Model& m = *m_;
    clearModel(false);
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.detect = DetectState{};   // audio nuevo: las correcciones de la detección ya no valen
    }
    auto t = std::make_shared<TakeAudio>();
    t->id = id;
    t->sampleRate = hub_.sampleRate.load();
    t->numSamples = channels.empty() ? 0 : static_cast<std::int64_t>(channels[0].size());
    t->channels = std::move(channels);
    m.take = std::move(t);
    m.source = TakeSource::Playback;
    m.A = hostStart;
    m.placed = true;
    normalizeAnchors(anchors, m.take->sampleRate, true);
    m.anchors = std::move(anchors);
    // (los avisos de "lo vuelvo a tomar" se quedan: explican por qué hay una toma nueva)
    for (const char* k : {"take-missing", "take-short", "file-found", "file-loaded", "file-not-found", "file-silent",
                          "file-error"})
        clearNotice(k);
    m.peaks = computePeaks(m.take->channels, m.take->sampleRate);
    rebuild();
    saveTakeWav();
}

void Worker::clearModel(bool keepFile)
{
    Model& m = *m_;
    forgetTakeFile();
    m.take.reset();
    m.source = TakeSource::None;
    m.placed = false;
    m.A = 0;
    m.anchors.clear();
    if (!keepFile)
    {
        m.file = juce::File();
        m.fileSize = m.fileModified = 0;
        m.align = AlignState::None;
        m.fileStartBar = 0;
        m.alignConfidence = 0;
    }
    m.aligner = djec::Aligner();
    m.alignerReady = false;
    m.alignerMaxOffset = std::numeric_limits<std::int64_t>::min();
    m.alignGen = 0xffffffffu;
    m.alignTried = 0;
    m.analyzer.reset();
    m.analyzed = false;
    m.detect = djec::AnalysisResult{};
    m.boundsValid = false;
    m.bounds = djec::MusicBoundsResult{};
    m.meterFromMemory = false;
    m.takeHostNum = m.takeHostDen = 0;
    m.forcedTimes.clear();
    m.grid = djec::AnalysisResult{};
    m.meta = djec::HostGridMeta{};
    m.sourceDen = 4;
    m.gridValid = false;
    m.hasPlan = false;
    m.plan = djec::EditPlan{};
    m.blockerText = {};
    m.render.reset();
    m.peaks.reset();
    m.editedPeaks.reset();
    m.busy = false;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.source = TakeSource::None;
        persist_.takeFile = juce::File();
        persist_.fileSize = persist_.fileModified = 0;
        persist_.hash = 0;
        persist_.sampleRate = 0;
        persist_.hostStart = persist_.numSamples = 0;
        persist_.numChannels = 0;
        persist_.anchors.clear();
        persist_.align = AlignState::None;
        persist_.fileStartBar = 0;
        persist_.meterFromMemory = false;
        persist_.takeHostNum = persist_.takeHostDen = 0;
        export_ = ExportData{};
    }
}

void Worker::setTakeWav(const juce::File& file)
{
    Model& m = *m_;
    if (m.wav == file)
        return;
    takefiles::acquire(file);
    takefiles::release(m.wav);
    m.wav = file;
}

void Worker::forgetTakeFile()
{
    Model& m = *m_;
    bool referenced;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        referenced = takeFileReferenced_;
        takeFileReferenced_ = false;
    }
    const juce::File old = m.wav;
    setTakeWav(juce::File());
    // un WAV de toma que nunca se guardó en un proyecto no sirve para nada más: se borra (si nadie más lo usa)
    if (old != juce::File() && !referenced && !takefiles::isInUse(old) && old.existsAsFile())
        old.deleteFile();
    m.hash = 0;
}

void Worker::persistTakeMeter()
{
    const Model& m = *m_;
    const std::lock_guard<std::mutex> lock(stateMutex_);
    persist_.meterFromMemory = m.meterFromMemory;
    persist_.takeHostNum = m.takeHostNum;
    persist_.takeHostDen = m.takeHostDen;
}

void Worker::setCleanupPolicy(const takefiles::Policy& policy)
{
    const std::lock_guard<std::mutex> lock(stateMutex_);
    cleanupPolicy_ = policy;
}

void Worker::runCleanup()
{
    takefiles::Policy policy;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        policy = cleanupPolicy_;
    }
    const juce::File keep = m_->wav;
    const juce::Time now = juce::Time::getCurrentTime();
    takefiles::cleanup(paths::takesDir(), policy, now, keep);
    const juce::File legacy = paths::legacyTakesDir();
    if (legacy != juce::File() && legacy.isDirectory())
        takefiles::cleanup(legacy, policy, now, keep);
}

void Worker::maintainTakeFiles()
{
    takefiles::Policy policy;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        policy = cleanupPolicy_;
    }
    const juce::int64 now = juce::Time::currentTimeMillis();
    // otro proceso de FL que limpie la carpeta ve que este WAV está en uso (modificado hace poco)
    const Model& m = *m_;
    if (m.wav != juce::File()
        && static_cast<double>(now - lastTouchMs_) >= policy.touchIntervalMinutes * 60.0 * 1000.0)
    {
        takefiles::touch(m.wav);
        lastTouchMs_ = now;
    }
    // al arrancar, pero cuando FL ya abrió el proyecto (todas las instancias cargaron su toma y la marcaron en uso)
    if (!startupCleanupDone_ && now - startedMs_ >= policy.startupDelayMs)
    {
        startupCleanupDone_ = true;
        runCleanup();
    }
}

void Worker::saveTakeWav()
{
    Model& m = *m_;
    if (!m.take || m.source != TakeSource::Playback)
        return;
    const juce::File file = paths::takesDir().getChildFile(juce::Uuid().toDashedString() + ".wav");
    const std::vector<const float*> ptrs = m.take->pointers();
    const juce::Result r = wav::write(file, ptrs.data(), m.take->numChannels(), m.take->numSamples,
                                      m.take->sampleRate, wav::Format::Float32);
    if (r.failed())
    {
        addNotice("take-save", NoticeKind::Warning,
                  u8("No pude guardar la toma en el disco (") + r.getErrorMessage() +
                      u8("): funciona igual, pero al abrir el proyecto habrá que volver a tomar el audio."));
        publishView();
        return;
    }
    const std::uint64_t hash = wav::hashAudio(ptrs.data(), m.take->numChannels(), m.take->numSamples);
    const juce::File old = m.wav;
    setTakeWav(file);
    lastTouchMs_ = juce::Time::currentTimeMillis();
    bool oldReferenced;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        oldReferenced = takeFileReferenced_;
        takeFileReferenced_ = false;
        persist_.source = TakeSource::Playback;
        persist_.takeFile = file;
        persist_.fileSize = file.getSize();
        persist_.fileModified = 0;
        persist_.hash = hash;
        persist_.sampleRate = m.take->sampleRate;
        persist_.hostStart = m.A;
        persist_.numSamples = m.take->numSamples;
        persist_.numChannels = m.take->numChannels();
        persist_.anchors = m.anchors;
        persist_.align = AlignState::None;
        persist_.fileStartBar = 0;
        persist_.meterFromMemory = m.meterFromMemory;
        persist_.takeHostNum = m.takeHostNum;
        persist_.takeHostDen = m.takeHostDen;
    }
    m.hash = hash;
    if (old != juce::File() && old != file && !oldReferenced && !takefiles::isInUse(old) && old.existsAsFile())
        old.deleteFile();
    publishView();
    // cada toma nueva ocupa disco: se aplica la política de limpieza (nunca toca este archivo ni los que estén en uso)
    runCleanup();
}

// ---- compás original y límites de la música (cuadrícula de FL) ---------------------------------------------------

// El plugin pide poner el compás de FL en el compás NUEVO (p. ej. 7/8). Una toma posterior (cambio en el canal, cambio
// de tempo, «Volver a tomar el audio», agregar delante/detrás) leería ese compás de FL y armaría una cuadrícula de 7/8
// sobre un audio que sigue en 4/4. Regla (con «Compás original» en Auto): se recuerda el compás de la primera toma; en
// las siguientes, las anclas en las que FL dice el compás destino de «Recortar cada compás» (calculado con el compás
// recordado) y no el recordado pasan al recordado (con su fase: los "1" donde estaban). Si FL dice otro compás, ese pasa
// a ser el recordado (otra canción, o el usuario cambió el compás del proyecto a propósito). Con un compás elegido a
// mano no se recuerda ni se cambia nada aquí: lo aplica rebuild().
void Worker::normalizeAnchors(std::vector<AnchorEntry>& anchors, double sr, bool newTake)
{
    Model& m = *m_;
    if (anchors.empty())
        return;
    const HostBlockInfo& first = anchors.front().info;
    const int hNum = meterNum(first.tsNum), hDen = meterDen(first.tsDen);
    if (newTake)
    {
        m.takeHostNum = hNum;
        m.takeHostDen = hDen;
        m.meterFromMemory = false;
    }
    djec::EditSettings settings;
    int remNum, remDen, manualNum;
    double remPhase;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        settings = persist_.settings;
        remNum = persist_.rememberedNum;
        remDen = persist_.rememberedDen;
        remPhase = persist_.rememberedPhasePpq;
        manualNum = persist_.sourceMeterNum;
    }
    if (manualNum > 0)
        return;
    auto remember = [&](int num, int den, const HostBlockInfo& i) {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.rememberedNum = num;
        persist_.rememberedDen = den;
        persist_.rememberedPhasePpq = barPhase(anchorBarStart(i, sr), num, den);
    };
    if (remNum <= 0 || remDen <= 0)
    {
        if (newTake)
            remember(hNum, hDen, first);
        return;
    }
    const djec::TargetMeter target = djec::targetMeter(settings.amount, settings.otherNum, settings.otherDen, remNum, remDen);
    bool remapped = false;
    if (target.num > 0 && target.den > 0 && !(target.num == remNum && target.den == remDen))
        for (AnchorEntry& a : anchors)
            if (meterNum(a.info.tsNum) == target.num && meterDen(a.info.tsDen) == target.den)
            {
                setAnchorMeter(a.info, remNum, remDen, remPhase, sr);
                remapped = true;
            }
    if (remapped)
        m.meterFromMemory = true;
    else if (newTake && (hNum != remNum || hDen != remDen))
        remember(hNum, hDen, first);
}

void Worker::ensureBounds()
{
    Model& m = *m_;
    if (m.boundsValid || !m.take)
        return;
    if (m.analyzed)
    {
        // «Detectar del audio» ya los calculó (mismo audio, mismas funciones)
        m.bounds.duration = m.detect.duration;
        m.bounds.musicStart = m.detect.musicStart;
        m.bounds.musicEnd = m.detect.musicEnd;
        m.bounds.lastOnset = m.detect.lastOnset;
        m.boundsValid = true;
        return;
    }
    try
    {
        const std::vector<const float*> ptrs = m.take->pointers();
        const std::vector<float> mono = djec::toAnalysisMono(ptrs.data(), m.take->numChannels(),
                                                             static_cast<std::size_t>(m.take->numSamples),
                                                             m.take->sampleRate);
        m.bounds = djec::analyzeBounds(mono.data(), mono.size(), djec::kAnalysisSampleRate);
        m.boundsValid = true;
    }
    catch (const std::exception&)
    {
        m.boundsValid = false;   // sin límites: cuentan todos los compases (como antes)
    }
}

// ---- cuadrícula, plan, render ---------------------------------------------------------------------------------

bool Worker::runAnalysis()
{
    Model& m = *m_;
    if (!m.take)
        return false;
    m.busy = true;
    m.busyText = u8("Detectando el ritmo…");
    publishView();
    auto progress = [this](const char* stage, double f) {
        const std::lock_guard<std::mutex> lock(progressMutex_);
        progressStage_ = stage != nullptr ? juce::String(stage) : juce::String();
        progressFraction_ = f;
    };
    DetectState d;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        d = persist_.detect;
    }
    bool ok = false;
    try
    {
        const std::vector<const float*> ptrs = m.take->pointers();
        std::vector<float> mono = djec::toAnalysisMono(ptrs.data(), m.take->numChannels(),
                                                       static_cast<std::size_t>(m.take->numSamples),
                                                       m.take->sampleRate);
        djec::AnalysisResult r = m.analyzer.analyze(mono.data(), mono.size(), djec::kAnalysisSampleRate, {}, progress);
        std::vector<float>().swap(mono);
        // los límites de la música son los mismos que usa la cuadrícula de FL (analyzeBounds): no se recalculan
        m.bounds.duration = r.duration;
        m.bounds.musicStart = r.musicStart;
        m.bounds.musicEnd = r.musicEnd;
        m.bounds.lastOnset = r.lastOnset;
        m.boundsValid = true;
        // correcciones guardadas (al cargar un proyecto)
        if (d.bpmHint > 0)
            r = m.analyzer.retrack(d.bpmHint, d.strict, progress);
        if (!m.forcedTimes.empty())
        {
            // la toma creció: los "1" forzados se buscan por tiempo en los beats nuevos
            std::vector<int> forced;
            for (double t : m.forcedTimes)
            {
                const int i = djec::nearestBeatIndex(r, t);
                if (i >= 0)
                    forced.push_back(i);
            }
            r = m.analyzer.relabel(d.meterChoice, forced, progress);
        }
        else if (d.meterChoice != 0 || !d.forced.empty())
            r = m.analyzer.relabel(d.meterChoice, d.forced, progress);
        m.forcedTimes.clear();
        m.detect = std::move(r);
        m.analyzed = true;
        ok = true;
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.detect.analyzed = true;
        persist_.detect.forced = m.detect.forcedDownbeats;
    }
    catch (const std::exception& e)
    {
        addNotice("detect-error", NoticeKind::Error, u8("No pude analizar el audio: ") + u8(e.what()));
    }
    {
        const std::lock_guard<std::mutex> lock(progressMutex_);
        progressStage_ = {};
        progressFraction_ = 0;
    }
    return ok;
}

void Worker::rebuild()
{
    busyJob_.store(true);
    Model& m = *m_;
    if (!m.take)
    {
        publishView();
        return;
    }
    djec::EditSettings settings;
    GridMode mode;
    int barOffset, manualNum, manualDen;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        settings = persist_.settings;
        mode = persist_.gridMode;
        barOffset = persist_.barOffsetBeats;
        manualNum = persist_.sourceMeterNum;
        manualDen = persist_.sourceMeterDen;
    }
    const TakeAudio& t = *m.take;
    const double sr = t.sampleRate;
    const double dur = static_cast<double>(t.numSamples) / sr;
    const std::vector<const float*> ptrs = t.pointers();
    m.busy = true;
    m.busyText = u8("Procesando…");
    publishView();

    std::function<double(double)> snap;
    m.meta = djec::HostGridMeta{};
    m.sourceDen = 4;
    if (mode == GridMode::Detect)
    {
        if (!m.analyzed)
            runAnalysis();
        m.grid = m.analyzed ? m.detect : djec::AnalysisResult{};
        m.grid.duration = dur;
        if (!m.analyzed)
            m.grid.musicEnd = m.grid.lastOnset = dur;
        // la web siempre lleva los límites internos al ataque real (los compases detectados no son exactos)
        snap = djec::makeTransientSnap(ptrs.data(), t.numChannels(), static_cast<std::size_t>(t.numSamples), sr);
    }
    else if (m.placed)
    {
        djec::CaptureInfo cap;
        cap.sampleRate = sr;
        cap.hostStartSample = m.A;
        cap.numSamples = static_cast<std::size_t>(t.numSamples);
        // «Compás original» elegido a mano: ese compás, con un "1" donde empezaba el compás de la primera ancla
        const bool manual = manualNum > 0 && manualDen > 0 && !m.anchors.empty();
        const double ref = manual ? anchorBarStart(m.anchors.front().info, sr) : 0.0;
        for (const AnchorEntry& a : m.anchors)
        {
            HostBlockInfo info = a.info;
            if (manual)
                setAnchorMeter(info, manualNum, manualDen, barPhase(ref, manualNum, manualDen), sr);
            cap.blocks.emplace_back(a.offset, info);
        }
        m.grid = djec::gridFromHost(cap, barOffset, &m.meta);
        m.sourceDen = m.meta.tsDen;
        // el silencio o la resonancia del final no cuentan como compases (como la web; ver applyMusicBounds)
        ensureBounds();
        if (m.boundsValid)
            djec::applyMusicBounds(m.grid, m.bounds.musicStart, m.bounds.musicEnd, m.bounds.lastOnset);
        // la cuadrícula de FL es exacta: sin imán (el resultado es el mismo en cada pasada)
    }
    else
    {
        m.grid = djec::AnalysisResult{};
        m.grid.duration = m.grid.musicEnd = m.grid.lastOnset = dur;
    }
    m.gridValid = m.grid.beats.size() > 1 && !djec::validDownbeats(m.grid).empty();

    m.plan = djec::buildEditPlan(m.grid, m.sourceDen, settings, snap);
    m.hasPlan = true;
    // motivo, con palabras del plugin
    {
        const std::string& id = m.plan.blockerId;
        if (id.empty())
            m.blockerText = {};
        else if (id == "no-mode")
            m.blockerText = u8("Activa «Recortar cada compás» o «Quitar compases del final»: mientras tanto suena el "
                               "original.");
        else if (id == "no-grid")
        {
            if (mode == GridMode::Host && m.source == TakeSource::File && !m.placed)
                m.blockerText = u8("Falta ubicar el archivo en la línea de tiempo: dale Play en FL.");
            else if (mode == GridMode::Host)
                m.blockerText = u8("FL no informó el tempo ni la posición: prueba «Detectar del audio».");
            else
                m.blockerText = u8("No se detectaron beats ni compases: prueba «Tempo manual» o «Marcar tempo», o "
                                   "desactiva «Recortar cada compás».");
        }
        else if (id == "bad-meter")
            m.blockerText = u8("Elige un compás válido o desactiva «Recortar cada compás».");
        else if (id == "no-change")
            m.blockerText = u8("Con ese compás la canción no cambia: elige otro compás.");
        else if (id == "empty")
            m.blockerText = u8("No queda audio: revisa los ajustes.");
        else
            m.blockerText = u8(m.plan.blocker);
    }

    if (m.plan.blocker.empty())
    {
        auto r = std::make_shared<RenderedAudio>();
        djec::renderSegments(ptrs.data(), t.numChannels(), static_cast<std::size_t>(t.numSamples), sr,
                             m.plan.segments, m.plan.crossfadeSec, m.plan.fadeOutSec, m.plan.curve, r->channels);
        r->sampleRate = sr;
        r->length = r->channels.empty() ? 0 : static_cast<std::int64_t>(r->channels[0].size());
        r->renderId = ++m.renderCounter;
        m.editedPeaks = computePeaks(r->channels, sr);
        m.render = std::move(r);
    }
    else
    {
        m.render.reset();
        m.editedPeaks.reset();
    }
    m.busy = false;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        export_.render = m.render;
        export_.plan = m.plan;
        export_.meterChanges = m.plan.meterApplies;
        if (m.source == TakeSource::File)
            export_.baseName = m.file.getFileNameWithoutExtension();
        else
            export_.baseName = persist_.trackName.isNotEmpty() ? persist_.trackName : juce::String("Toma");
    }
    publishSnapshot();
    publishView();
}

void Worker::publishSnapshot()
{
    Model& m = *m_;
    if (!m.take || !m.placed)
        return;
    const TakeAudio& t = *m.take;
    auto* s = new PlaybackSnapshot();
    s->epoch = epoch_;
    s->takeId = t.id;
    s->A = m.A;
    s->E = m.A + t.numSamples;
    s->take = m.take;
    s->takeNumCh = std::min(t.numChannels(), kMaxTakeChannels);
    for (int k = 0; k < s->takeNumCh; ++k)
        s->takeCh[k] = t.channels[static_cast<std::size_t>(k)].data();
    s->render = m.render;
    if (m.render && m.render->length > 0)
    {
        s->edNumCh = std::min(static_cast<int>(m.render->channels.size()), kMaxTakeChannels);
        for (int k = 0; k < s->edNumCh; ++k)
            s->edCh[k] = m.render->channels[static_cast<std::size_t>(k)].data();
        s->edLen = m.render->length;
    }
    const bool file = m.source == TakeSource::File;
    s->changeDetect = !file || m.align == AlignState::Found;
    s->correlationMode = file;
    s->tempo = tempoMap(m.anchors, m.A, t.sampleRate);
    if (!file)
    {
        s->tempoFrom = s->A;
        s->tempoTo = s->E;
    }
    else if (!s->tempo.empty())
    {
        // archivo: solo donde se vio la posición del host (al ubicarlo)
        s->tempoFrom = std::max(s->A, s->tempo.front().hostSample);
        s->tempoTo = std::min(s->E, s->tempo.back().hostSample + static_cast<std::int64_t>(2 * t.sampleRate));
    }
    PlaybackSnapshot* old = hub_.pending.exchange(s, std::memory_order_acq_rel);
    delete old;   // el audio nunca la vio
}

void Worker::publishView()
{
    const Model& m = *m_;
    auto v = std::make_shared<SessionView>();
    v->version = ++viewVersion_;
    PersistedState ps;
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        ps.settings = persist_.settings;
        ps.gridMode = persist_.gridMode;
        ps.barOffsetBeats = persist_.barOffsetBeats;
        ps.detect = persist_.detect;
        ps.trackName = persist_.trackName;
        ps.sourceMeterNum = persist_.sourceMeterNum;
        ps.sourceMeterDen = persist_.sourceMeterDen;
        ps.rememberedNum = persist_.rememberedNum;
        ps.rememberedDen = persist_.rememberedDen;
    }
    if (m.take)
    {
        const TakeAudio& t = *m.take;
        v->hasTake = true;
        v->source = m.source;
        v->takeId = t.id;
        v->sampleRate = t.sampleRate;
        v->numChannels = t.numChannels();
        v->hostStart = m.A;
        v->numSamples = t.numSamples;
        v->durationSec = static_cast<double>(t.numSamples) / t.sampleRate;
        v->placed = m.placed;
        v->takeFile = m.source == TakeSource::File ? m.file : m.wav;
    }
    v->displayName = m.source == TakeSource::File ? m.file.getFileNameWithoutExtension()
                                                  : (ps.trackName.isNotEmpty() ? ps.trackName : juce::String("Toma"));
    v->align = m.align;
    v->fileStartBar = m.fileStartBar;
    v->alignConfidence = m.alignConfidence;
    // siempre que haya un archivo (también si el canal está vacío y nunca se va a encontrar); la interfaz lo
    // destaca con align == NotFound
    v->canUseBarOneFallback = m.source == TakeSource::File && m.take != nullptr && !m.loadingFile &&
                              m.align != AlignState::Manual;
    v->loadingFile = m.loadingFile;

    v->gridMode = ps.gridMode;
    v->gridValid = m.gridValid;
    v->grid = m.grid;
    v->hostMeta = m.meta;
    v->sourceDen = m.sourceDen;
    if (m.take)
    {
        v->bars = djec::getBars(m.grid);
        v->lastBarIndex = djec::findLastBarIndex(m.grid);
    }
    v->barOffsetBeats = ps.barOffsetBeats;
    v->sourceMeterNum = ps.sourceMeterNum;
    v->sourceMeterDen = ps.sourceMeterDen;
    v->rememberedNum = ps.rememberedNum;
    v->rememberedDen = ps.rememberedDen;
    v->takeHostNum = m.takeHostNum;
    v->takeHostDen = m.takeHostDen;
    v->meterOrigin = ps.sourceMeterNum > 0 ? MeterOrigin::Manual
                     : m.meterFromMemory   ? MeterOrigin::FirstTake
                                           : MeterOrigin::Host;
    v->detect = ps.detect;
    if (ps.gridMode == GridMode::Host)
    {
        v->gridSourceText = u8("Cuadrícula de FL");
        v->displayBpm = m.meta.valid ? m.meta.hostBpm : 0;
    }
    else
    {
        v->gridSourceText = "Detectado del audio";
        v->displayBpm = m.grid.bpm;
        if (m.analyzed && m.gridValid)
        {
            // confidenceInfo de la web (sin la comprobación del golpe final)
            if (!m.grid.forcedDownbeats.empty())
                v->confidenceLabel = u8("Cuadrícula ajustada a mano");
            else
            {
                const double c = std::min(m.grid.confBeats, m.grid.confBars);
                if (c >= 0.75)
                    v->confidenceLabel = u8("Detección fiable");
                else if (c >= 0.5)
                    v->confidenceLabel = u8("Detección aceptable");
                else
                {
                    v->confidenceLabel = u8("Revisa la cuadrícula");
                    v->lowConfidence = true;
                }
            }
        }
    }

    v->settings = ps.settings;
    v->hasPlan = m.hasPlan;
    v->plan = m.plan;
    v->blockerText = m.blockerText;
    {
        const int bpb = m.gridValid ? m.grid.beatsPerBar : 4;
        v->chips = djec::meterAmountChips(bpb, m.sourceDen);
    }
    if (m.hasPlan && m.plan.meterApplies && m.plan.target.num > 0 && m.plan.target.den > 0)
        v->meterHint = u8("Pon el compás del proyecto de FL en ") + juce::String(m.plan.target.num) + "/" +
                       juce::String(m.plan.target.den);
    v->hasRender = m.render != nullptr;
    v->renderId = m.render ? m.render->renderId : 0;
    v->editedLength = m.render ? m.render->length : 0;
    v->editedDurationSec = m.render ? static_cast<double>(m.render->length) / m.render->sampleRate : 0;
    v->peaks = m.peaks;
    v->editedPeaks = m.editedPeaks;
    v->busy = m.busy || m.loadingFile;
    v->busyText = m.loadingFile ? u8("Leyendo el archivo…") : m.busyText;
    v->notices = m.notices;
    const std::lock_guard<std::mutex> lock(stateMutex_);
    view_ = std::move(v);
}

// ---- archivo soltado -------------------------------------------------------------------------------------------

void Worker::doLoadFile(const juce::File& file, bool restoring, const PersistedState* rs)
{
    Model& m = *m_;
    const double sr = hostRate_.load();
    if (!(sr > 0))
    {
        m.pendingLoad = file;   // al conocer la frecuencia del host (prepareToPlay)
        return;
    }
    m.loadingFile = true;
    m.busy = true;
    publishView();
    filedrop::Decoded d = filedrop::decode(file, sr, kMaxTakeSeconds);
    m.loadingFile = false;
    m.busy = false;
    if (d.error.isNotEmpty())
    {
        addNotice("file-error", NoticeKind::Error, d.error);
        if (restoring)
        {
            clearModel(false);
            ++epoch_;
            sendCommand(AudioCommand{CommandType::Reset});
        }
        publishView();
        return;
    }
    // reemplaza a cualquier toma anterior
    clearModel(false);
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        if (!restoring)
            persist_.detect = DetectState{};
    }
    auto t = std::make_shared<TakeAudio>();
    t->id = hub_.nextTakeId.fetch_add(1);
    t->sampleRate = sr;
    t->numSamples = d.length;
    t->channels = std::move(d.channels);
    m.take = std::move(t);
    m.source = TakeSource::File;
    m.file = file;
    m.fileSize = file.getSize();
    m.fileModified = file.getLastModificationTime().toMilliseconds();
    m.placed = false;
    m.align = AlignState::WaitingForPlay;
    m.peaks = computePeaks(m.take->channels, sr);
    for (const char* k : {"audio-changed", "tempo-changed", "rate-changed", "take-missing", "file-found",
                          "file-loaded", "file-not-found", "file-silent", "file-error", "take-short"})
        clearNotice(k);
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.source = TakeSource::File;
        persist_.takeFile = file;
        persist_.fileSize = m.fileSize;
        persist_.fileModified = m.fileModified;
        persist_.hash = 0;
        persist_.sampleRate = sr;
        persist_.hostStart = 0;
        persist_.numSamples = m.take->numSamples;
        persist_.numChannels = m.take->numChannels();
        persist_.anchors.clear();
        persist_.align = AlignState::WaitingForPlay;
        persist_.fileStartBar = 0;
    }

    const bool keepPlace = restoring && rs != nullptr &&
                           (rs->align == AlignState::Found || rs->align == AlignState::Manual) &&
                           rs->fileSize == m.fileSize && rs->fileModified == m.fileModified &&
                           std::llround(rs->sampleRate) == std::llround(sr) && rs->numSamples == m.take->numSamples;
    if (keepPlace)
    {
        placeFile(rs->hostStart, rs->anchors, rs->align, 1.0, rs);
        clearNotice("file-found");   // al abrir el proyecto no hace falta avisar
        publishView();
        return;
    }
    ++epoch_;
    sendCommand(AudioCommand{CommandType::ExpectAlignment});
    addNotice("file-loaded", NoticeKind::Info,
              u8("Archivo listo: dale Play en FL y lo ubico solo en la línea de tiempo (escuchas el original "
                 "mientras tanto)."));
    rebuildPending_ = true;
    publishView();
}

void Worker::tryAlign()
{
    Model& m = *m_;
    if (!m.take || m.source != TakeSource::File || m.placed || m.loadingFile)
        return;
    AlignBuffer& a = hub_.align;
    const bool listening = a.listening.load(std::memory_order_acquire);
    const double sr = m.take->sampleRate;
    const std::uint32_t g1 = a.gen.load(std::memory_order_acquire);
    if (g1 & 1u)
        return;
    const std::int64_t c = a.count.load(std::memory_order_acquire);
    if (g1 != m.alignGen)
    {
        m.alignGen = g1;
        m.alignTried = 0;
    }
    const double need = m.alignTried == 0 ? kAlignFirstTrySec : kAlignRetrySec;
    const bool enough = static_cast<double>(c - m.alignTried) >= need * sr;
    // se paró antes del próximo intento: un último intento con todo lo escuchado
    const bool lastTry = !listening && c > m.alignTried && static_cast<double>(c) >= djec::AlignOptions{}.minOverlapSec * sr;
    if (!listening && !lastTry)
    {
        if (m.align == AlignState::Searching)
        {
            m.align = AlignState::WaitingForPlay;
            publishView();
        }
        return;
    }
    if (listening && m.align == AlignState::WaitingForPlay)
    {
        m.align = AlignState::Searching;
        publishView();
    }
    if (!enough && !lastTry)
        return;
    busyJob_.store(true);

    std::vector<float> mono;
    std::vector<AnchorEntry> anchors;
    std::int64_t start;
    {
        const std::lock_guard<std::mutex> lock(hub_.alignResize);
        if (static_cast<std::size_t>(c) > a.mono.size())
            return;
        start = a.startHost.load(std::memory_order_acquire);
        const int na = std::min(a.numAnchors.load(std::memory_order_acquire), static_cast<int>(a.anchors.size()));
        mono.assign(a.mono.begin(), a.mono.begin() + c);
        anchors.assign(a.anchors.begin(), a.anchors.begin() + na);
    }
    std::atomic_thread_fence(std::memory_order_acquire);
    if (a.gen.load(std::memory_order_relaxed) != g1)
        return;   // el audio reinició la escucha durante la copia
    m.alignTried = c;

    djec::AlignOptions o;
    o.maxFileOffset = start;   // el archivo no puede empezar antes del principio del proyecto
    if (!m.alignerReady || m.alignerMaxOffset != start)
    {
        const std::vector<const float*> ptrs = m.take->pointers();
        m.aligner.prepare(ptrs.data(), m.take->numChannels(), static_cast<std::size_t>(m.take->numSamples), sr, o);
        m.alignerReady = true;
        m.alignerMaxOffset = start;
    }
    const djec::AlignResult r = m.aligner.find(mono.data(), mono.size());
    if (r.found)
    {
        const std::int64_t A = start - r.fileOffsetOfInputStart;
        for (AnchorEntry& e : anchors)
            e.offset = start + e.offset - A;
        placeFile(A, anchors, AlignState::Found, r.confidence);
        return;
    }
    if (r.tooQuiet && static_cast<double>(c) >= kAlignGiveUpSec * sr)
    {
        bool shown = false;
        for (const Notice& x : m.notices)
            shown = shown || x.key == "file-silent";
        if (!shown)
        {
            addNotice("file-silent", NoticeKind::Info,
                      u8("No suena nada en el canal: pon el archivo en el canal de FL, o usa «El archivo empieza en "
                         "el compás 1»."));
            publishView();
        }
    }
    if (!r.tooQuiet && static_cast<double>(c) >= kAlignGiveUpSec * sr && m.align != AlignState::NotFound)
    {
        m.align = AlignState::NotFound;
        addNotice("file-not-found", NoticeKind::Warning,
                  u8("No encuentro este audio en el canal. ¿Pusiste el plugin en el canal correcto?"));
        publishView();
    }
}

void Worker::placeFile(std::int64_t A, const std::vector<AnchorEntry>& anchorsRel, AlignState how, double confidence,
                       const PersistedState* restored)
{
    Model& m = *m_;
    if (!m.take)
        return;
    const double sr = m.take->sampleRate;
    m.A = A;
    m.placed = true;
    m.anchors = anchorsRel;
    std::sort(m.anchors.begin(), m.anchors.end(),
              [](const AnchorEntry& x, const AnchorEntry& y) { return x.offset < y.offset; });
    m.align = how;
    m.alignConfidence = confidence;
    if (restored != nullptr)
    {
        // estado guardado: las anclas ya tienen el compás que se usó y el compás de inicio ya se calculó
        m.fileStartBar = restored->fileStartBar > 0 ? restored->fileStartBar : barNumberAt(m.anchors, A, sr);
        m.meterFromMemory = restored->meterFromMemory;
        m.takeHostNum = restored->takeHostNum;
        m.takeHostDen = restored->takeHostDen;
    }
    else
    {
        // compás de FL donde empieza (con lo que informó FL: es el número que se ve en su línea de tiempo)
        m.fileStartBar = barNumberAt(m.anchors, A, sr);
        normalizeAnchors(m.anchors, sr, true);
    }
    persistTakeMeter();
    clearNotice("file-not-found");
    clearNotice("file-loaded");
    clearNotice("file-silent");
    clearNotice("tempo-changed");
    if (how == AlignState::Found)
        addNotice("file-found", NoticeKind::Info,
                  u8("Ubicado: el archivo empieza en el compás ") + juce::String(m.fileStartBar) +
                      u8(". Desde el próximo Play suena recortado."));
    else if (how == AlignState::Manual)
        addNotice("file-found", NoticeKind::Info, u8("Listo: el archivo empieza en el compás 1."));
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.hostStart = A;
        persist_.anchors = m.anchors;
        persist_.align = how;
        persist_.fileStartBar = m.fileStartBar;
    }
    ++epoch_;
    AudioCommand c;
    c.type = CommandType::SetRange;
    c.takeId = m.take->id;
    c.A = A;
    c.E = A + m.take->numSamples;
    c.extendable = false;
    sendCommand(c);
    rebuild();
}

// ---- estado guardado --------------------------------------------------------------------------------------------

void Worker::doRestore(const PersistedState& ps)
{
    Model& m = *m_;
    const double sr = hostRate_.load();
    if (!(sr > 0))
    {
        m.hasPendingRestore = true;
        m.pendingRestore = ps;
        return;
    }
    m.hasPendingRestore = false;
    // el WAV del estado estuvo marcado en uso desde restore() hasta ahora (que se carga o se descarta)
    struct ReleasePending
    {
        Worker* w;
        ~ReleasePending()
        {
            const std::lock_guard<std::mutex> lock(w->stateMutex_);
            takefiles::release(w->pendingRestoreFile_);
            w->pendingRestoreFile_ = juce::File();
        }
    } releasePending{this};
    clearModel(false);
    if (ps.source == TakeSource::None)
    {
        ++epoch_;
        sendCommand(AudioCommand{CommandType::Reset});
        publishView();
        return;
    }
    if (ps.source == TakeSource::File)
    {
        if (!ps.takeFile.existsAsFile())
        {
            addNotice("take-missing", NoticeKind::Warning,
                      u8("No encontré «") + ps.takeFile.getFileName() +
                          u8("»: dale Play para tomar el audio del canal."));
            ++epoch_;
            sendCommand(AudioCommand{CommandType::Reset});
            publishView();
            return;
        }
        doLoadFile(ps.takeFile, true, &ps);
        return;
    }
    // toma del canal
    auto fail = [&](const juce::String& text) {
        addNotice("take-missing", NoticeKind::Warning, text);
        ++epoch_;
        sendCommand(AudioCommand{CommandType::Reset});
        publishView();
    };
    if (std::llround(ps.sampleRate) != std::llround(sr))
    {
        fail(u8("Cambió la frecuencia de muestreo del proyecto: vuelvo a tomar el audio en el próximo Play."));
        return;
    }
    // la ruta guardada; si no está, el mismo archivo en Tomas (otra instancia ya lo migró) o en la carpeta de antes
    juce::File takeFile = ps.takeFile;
    if (!takeFile.existsAsFile())
        for (const juce::File& dir : {paths::takesDir(), paths::legacyTakesDir()})
            if (dir != juce::File() && dir.getChildFile(ps.takeFile.getFileName()).existsAsFile())
            {
                takeFile = dir.getChildFile(ps.takeFile.getFileName());
                break;
            }
    wav::Audio audio;
    const juce::Result r = wav::read(takeFile, audio);
    bool ok = r.wasOk() && audio.frames() == ps.numSamples && !audio.channels.empty();
    if (ok && ps.hash != 0)
    {
        std::vector<const float*> ptrs;
        for (const auto& c : audio.channels)
            ptrs.push_back(c.data());
        ok = wav::hashAudio(ptrs.data(), static_cast<int>(ptrs.size()), audio.frames()) == ps.hash;
    }
    if (!ok)
    {
        fail(u8("No encontré el audio tomado de esta sesión: dale Play para volver a tomarlo."));
        return;
    }
    // migración: una toma de la carpeta de antes (%APPDATA%, móvil) pasa a Tomas (%LOCALAPPDATA%); si no se puede
    // mover (otro proceso la tiene abierta…), se sigue usando donde está
    {
        const juce::File legacy = paths::legacyTakesDir();
        if (legacy != juce::File() && takeFile.getParentDirectory() == legacy)
        {
            const juce::File dir = paths::takesDir();
            const juce::File dest = dir.getChildFile(takeFile.getFileName());
            if (!dest.exists() && dir.createDirectory().wasOk() && takeFile.moveFileTo(dest))
                takeFile = dest;
        }
    }
    // se usa ahora: la fecha de modificación cuenta para la limpieza (las tomas sin usar en 60 días se borran)
    takefiles::touch(takeFile);
    lastTouchMs_ = juce::Time::currentTimeMillis();
    auto t = std::make_shared<TakeAudio>();
    t->id = hub_.nextTakeId.fetch_add(1);
    t->sampleRate = sr;
    t->numSamples = audio.frames();
    t->channels = std::move(audio.channels);
    m.take = std::move(t);
    m.source = TakeSource::Playback;
    m.A = ps.hostStart;
    m.placed = true;
    m.anchors = ps.anchors;
    m.meterFromMemory = ps.meterFromMemory;
    m.takeHostNum = ps.takeHostNum;
    m.takeHostDen = ps.takeHostDen;
    setTakeWav(takeFile);
    m.hash = ps.hash;
    m.peaks = computePeaks(m.take->channels, sr);
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        takeFileReferenced_ = true;   // viene de un proyecto guardado: no se borra al cambiar de toma
        persist_.source = TakeSource::Playback;
        persist_.takeFile = takeFile;
        persist_.fileSize = ps.fileSize;
        persist_.hash = ps.hash;
        persist_.sampleRate = sr;
        persist_.hostStart = ps.hostStart;
        persist_.numSamples = m.take->numSamples;
        persist_.numChannels = m.take->numChannels();
        persist_.anchors = ps.anchors;
        persist_.meterFromMemory = ps.meterFromMemory;
        persist_.takeHostNum = ps.takeHostNum;
        persist_.takeHostDen = ps.takeHostDen;
        // estados de antes de recordar el compás original: el de la toma (FL todavía no estaba en el compás nuevo)
        if (persist_.rememberedNum <= 0 && !ps.anchors.empty())
        {
            const HostBlockInfo& i = ps.anchors.front().info;
            persist_.rememberedNum = meterNum(i.tsNum);
            persist_.rememberedDen = meterDen(i.tsDen);
            persist_.rememberedPhasePpq = barPhase(anchorBarStart(i, sr), persist_.rememberedNum, persist_.rememberedDen);
        }
    }
    ++epoch_;
    AudioCommand c;
    c.type = CommandType::SetRange;
    c.takeId = m.take->id;
    c.A = m.A;
    c.E = m.A + m.take->numSamples;
    c.extendable = true;
    sendCommand(c);
    rebuild();
}

// ---- avisos -----------------------------------------------------------------------------------------------------

void Worker::addNotice(const juce::String& key, NoticeKind kind, const juce::String& text)
{
    auto& n = m_->notices;
    n.erase(std::remove_if(n.begin(), n.end(), [&](const Notice& x) { return x.key == key; }), n.end());
    Notice x;
    x.id = ++noticeCounter_;
    x.kind = kind;
    x.key = key;
    x.text = text;
    x.createdMs = juce::Time::currentTimeMillis();
    n.push_back(x);
    while (n.size() > kMaxNotices)
        n.erase(n.begin());
}

void Worker::clearNotice(const juce::String& key)
{
    auto& n = m_->notices;
    n.erase(std::remove_if(n.begin(), n.end(), [&](const Notice& x) { return x.key == key; }), n.end());
}

// ---- órdenes públicas -------------------------------------------------------------------------------------------

void Worker::hostPrepared(double sampleRate)
{
    hostRate_.store(sampleRate);
    post([this, sampleRate] {
        Model& m = *m_;
        const double before = m.preparedRate;
        m.preparedRate = sampleRate;
        if (m.hasPendingRestore)
        {
            const PersistedState ps = m.pendingRestore;
            doRestore(ps);
            return;
        }
        if (m.pendingLoad != juce::File())
        {
            const juce::File f = m.pendingLoad;
            m.pendingLoad = juce::File();
            doLoadFile(f, false, nullptr);
            return;
        }
        juce::ignoreUnused(before);
        if (m.take && std::llround(m.take->sampleRate) != std::llround(sampleRate))
        {
            if (m.source == TakeSource::Playback)
            {
                clearModel(false);
                ++epoch_;
                sendCommand(AudioCommand{CommandType::Reset});
                addNotice("rate-changed", NoticeKind::Warning,
                          u8("Cambió la frecuencia de muestreo del proyecto: vuelvo a tomar el audio en el próximo "
                             "Play."));
                publishView();
            }
            else
            {
                const juce::File f = m.file;
                addNotice("rate-changed", NoticeKind::Info,
                          u8("Cambió la frecuencia de muestreo del proyecto: vuelvo a preparar el archivo."));
                doLoadFile(f, false, nullptr);
            }
        }
    });
}

void Worker::clearTake()
{
    post([this] {
        clearModel(false);
        for (const char* k : {"audio-changed", "tempo-changed", "rate-changed", "take-missing", "file-found",
                              "file-loaded", "file-not-found", "file-silent", "file-error", "take-jump", "take-max",
                              "take-memory", "take-short", "take-busy", "take-save"})
            clearNotice(k);
        {
            const std::lock_guard<std::mutex> lock(stateMutex_);
            persist_.detect = DetectState{};
        }
        ++epoch_;
        sendCommand(AudioCommand{CommandType::Reset});
        publishView();
    });
}

void Worker::loadFile(const juce::File& file)
{
    post([this, file] { doLoadFile(file, false, nullptr); });
}

void Worker::fileStartsAtBarOne()
{
    post([this] {
        Model& m = *m_;
        if (!m.take || m.source != TakeSource::File)
            return;
        // posiciones del host: lo escuchado hasta ahora o, si no, lo último que informó el host (aunque esté parado)
        std::vector<AnchorEntry> anchors;
        {
            AlignBuffer& a = hub_.align;
            const std::lock_guard<std::mutex> lock(hub_.alignResize);
            const std::uint32_t g = a.gen.load(std::memory_order_acquire);
            const std::int64_t start = a.startHost.load(std::memory_order_acquire);
            const int na = std::min(a.numAnchors.load(std::memory_order_acquire), static_cast<int>(a.anchors.size()));
            if (!(g & 1u))
                for (int i = 0; i < na; ++i)
                {
                    AnchorEntry e = a.anchors[static_cast<std::size_t>(i)];
                    e.offset = start + e.offset;   // A = 0
                    anchors.push_back(e);
                }
        }
        if (anchors.empty())
        {
            const HostInfoBox::Value v = hub_.hostInfo.read();
            if (v.valid && v.info.bpm > 0)
            {
                AnchorEntry e;
                e.offset = v.hasTime ? v.timeInSamples : 0;
                e.info = v.info;
                e.info.hostSample = e.offset;
                anchors.push_back(e);
            }
        }
        placeFile(0, anchors, AlignState::Manual, 0);
    });
}

void Worker::setGridMode(GridMode mode)
{
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.gridMode = mode;
    }
    rebuildPending_ = true;
    jobsCv_.notify_one();
}

void Worker::setBarOffset(int beats)
{
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.barOffsetBeats = beats;
    }
    rebuildPending_ = true;
    jobsCv_.notify_one();
}

void Worker::setSettings(const djec::EditSettings& s)
{
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.settings = s;
    }
    rebuildPending_ = true;
    jobsCv_.notify_one();
}

void Worker::setListenOriginal(bool original)
{
    hub_.listenOriginal.store(original ? 1 : 0);
    const std::lock_guard<std::mutex> lock(stateMutex_);
    persist_.listenOriginal = original;
}

void Worker::setTrackName(const juce::String& name)
{
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        if (persist_.trackName == name)
            return;
        persist_.trackName = name;
    }
    rebuildPending_ = true;
    jobsCv_.notify_one();
}

void Worker::setSourceMeter(int num, int den)
{
    const bool valid = num >= 1 && num <= 32 && (den == 2 || den == 4 || den == 8 || den == 16);
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.sourceMeterNum = valid ? num : 0;
        persist_.sourceMeterDen = valid ? den : 0;
    }
    rebuildPending_ = true;
    jobsCv_.notify_one();
}

void Worker::retrack(double bpmHint, bool strict)
{
    post([this, bpmHint, strict] {
        Model& m = *m_;
        if (!m.take)
            return;
        if (!m.analyzed && !runAnalysis())
        {
            publishView();
            return;
        }
        auto progress = [this](const char* stage, double f) {
            const std::lock_guard<std::mutex> lock(progressMutex_);
            progressStage_ = stage != nullptr ? juce::String(stage) : juce::String();
            progressFraction_ = f;
        };
        try
        {
            m.busy = true;
            m.busyText = bpmHint > 0 ? u8("Recalculando a ≈ ") + formatNumber1(bpmHint) + u8(" BPM…")
                                     : u8("Restableciendo la detección…");
            publishView();
            djec::AnalysisResult r = m.analyzer.retrack(bpmHint, strict, progress);
            m.detect = r;
            {
                const std::lock_guard<std::mutex> lock(stateMutex_);
                persist_.detect.bpmHint = bpmHint;
                persist_.detect.strict = bpmHint > 0 && strict;
                if (bpmHint > 0)
                    persist_.detect.tempoChanged = true;
                persist_.detect.forced = r.forcedDownbeats;
            }
            clearNotice("tempo-result");
            if (bpmHint > 0)
            {
                // tempoResultNotice de main.js
                const juce::String asked = formatNumber1(bpmHint) + " BPM";
                if (!(r.beats.size() > 1))
                    addNotice("tempo-result", NoticeKind::Error,
                              u8("No se encontró un pulso cerca de ") + asked +
                                  u8(": este audio no tiene ataques claros."));
                else
                {
                    const double ratio = r.bpm / bpmHint;
                    if (!(ratio >= kTempoMatchLo && ratio <= kTempoMatchHi))
                        addNotice("tempo-result", NoticeKind::Error,
                                  u8("No se encontró un pulso cerca de ") + asked + u8(": la cuadrícula quedó en ") +
                                      formatBpm(r.bpm) + u8(". Escúchalo con el metrónomo de FL o pulsa «Restablecer»."));
                }
            }
        }
        catch (const std::exception& e)
        {
            addNotice("tempo-result", NoticeKind::Error, u8(e.what()));
        }
        {
            const std::lock_guard<std::mutex> lock(progressMutex_);
            progressStage_ = {};
        }
        m.busy = false;
        rebuild();
    });
}

void Worker::relabelNow(int beatsPerBar, const std::vector<int>& forced)
{
    Model& m = *m_;
    if (!m.take)
        return;
    if (!m.analyzed && !runAnalysis())
    {
        publishView();
        return;
    }
    try
    {
        djec::AnalysisResult r = m.analyzer.relabel(beatsPerBar, forced);
        m.detect = r;
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.detect.meterChoice = beatsPerBar;
        persist_.detect.forced = r.forcedDownbeats;
    }
    catch (const std::exception& e)
    {
        addNotice("detect-error", NoticeKind::Error, u8(e.what()));
    }
    rebuild();
}

void Worker::relabel(int beatsPerBar, std::vector<int> forced)
{
    post([this, beatsPerBar, forced] { relabelNow(beatsPerBar, forced); });
}

void Worker::moveDownbeat(int delta, double refTimeSec)
{
    post([this, delta, refTimeSec] {
        GridMode mode;
        int meter;
        {
            const std::lock_guard<std::mutex> lock(stateMutex_);
            mode = persist_.gridMode;
            meter = persist_.detect.meterChoice;
            if (mode == GridMode::Host)
                persist_.barOffsetBeats += delta;
        }
        if (mode == GridMode::Host)
        {
            rebuildPending_ = true;
            return;
        }
        Model& m = *m_;
        if (!m.take || (!m.analyzed && !runAnalysis()))
            return;
        // shiftedDownbeatIndex de js/ui/format.js: el "1" más cercano a refTime, corrido delta beats
        const djec::AnalysisResult& r = m.detect;
        if (r.beats.empty())
            return;
        int base = -1;
        if (!r.downbeats.empty())
        {
            std::vector<double> times;
            for (int i : r.downbeats)
                times.push_back(r.beats[static_cast<std::size_t>(i)]);
            const auto it = std::lower_bound(times.begin(), times.end(), refTimeSec);
            std::size_t k = static_cast<std::size_t>(it - times.begin());
            if (k >= times.size())
                k = times.size() - 1;
            else if (k > 0 && refTimeSec - times[k - 1] <= times[k] - refTimeSec)
                --k;
            base = r.downbeats[k];
        }
        else
            base = djec::nearestBeatIndex(r, refTimeSec);
        const int idx = std::max(0, std::min(static_cast<int>(r.beats.size()) - 1, base + delta));
        relabelNow(meter, {idx});
    });
}

void Worker::beatIsOne(double timeSec)
{
    post([this, timeSec] {
        Model& m = *m_;
        if (!m.take || (!m.analyzed && !runAnalysis()))
            return;
        const int idx = djec::nearestBeatIndex(m.detect, timeSec);
        if (idx < 0)
            return;
        int meter;
        {
            const std::lock_guard<std::mutex> lock(stateMutex_);
            meter = persist_.detect.meterChoice;
        }
        relabelNow(meter, {idx});
    });
}

void Worker::resetDetection()
{
    post([this] {
        Model& m = *m_;
        if (!m.take)
            return;
        if (!m.analyzed && !runAnalysis())
        {
            publishView();
            return;
        }
        bool tempoChanged;
        {
            const std::lock_guard<std::mutex> lock(stateMutex_);
            tempoChanged = persist_.detect.tempoChanged;
        }
        try
        {
            if (tempoChanged)
                m.analyzer.retrack(0, false);
            m.detect = m.analyzer.relabel(0, {});
        }
        catch (const std::exception& e)
        {
            addNotice("detect-error", NoticeKind::Error, u8(e.what()));
        }
        {
            const std::lock_guard<std::mutex> lock(stateMutex_);
            persist_.detect = DetectState{};
            persist_.detect.analyzed = true;
        }
        clearNotice("tempo-result");
        rebuild();
    });
}

void Worker::restore(const PersistedState& state)
{
    {
        const std::lock_guard<std::mutex> lock(stateMutex_);
        persist_.settings = state.settings;
        persist_.gridMode = state.gridMode;
        persist_.barOffsetBeats = state.barOffsetBeats;
        persist_.detect = state.detect;
        persist_.listenOriginal = state.listenOriginal;
        if (state.trackName.isNotEmpty())
            persist_.trackName = state.trackName;
        persist_.sourceMeterNum = state.sourceMeterNum;
        persist_.sourceMeterDen = state.sourceMeterDen;
        persist_.rememberedNum = state.rememberedNum;
        persist_.rememberedDen = state.rememberedDen;
        persist_.rememberedPhasePpq = state.rememberedPhasePpq;
        // hasta que se cargue, el WAV de la toma está en uso (la limpieza no lo toca)
        const juce::File f = state.source == TakeSource::Playback ? state.takeFile : juce::File();
        if (f != pendingRestoreFile_)
        {
            takefiles::acquire(f);
            takefiles::release(pendingRestoreFile_);
            pendingRestoreFile_ = f;
        }
    }
    hub_.listenOriginal.store(state.listenOriginal ? 1 : 0);
    post([this, state] { doRestore(state); });
}

void Worker::dismissNotice(std::uint64_t id)
{
    post([this, id] {
        auto& n = m_->notices;
        n.erase(std::remove_if(n.begin(), n.end(), [&](const Notice& x) { return x.id == id; }), n.end());
        publishView();
    });
}

// ---- lectura ----------------------------------------------------------------------------------------------------

std::shared_ptr<const SessionView> Worker::view() const
{
    const std::lock_guard<std::mutex> lock(stateMutex_);
    return view_;
}

PersistedState Worker::persisted()
{
    const std::lock_guard<std::mutex> lock(stateMutex_);
    if (persist_.source == TakeSource::Playback && persist_.takeFile != juce::File())
        takeFileReferenced_ = true;
    return persist_;
}

djec::EditSettings Worker::settings() const
{
    const std::lock_guard<std::mutex> lock(stateMutex_);
    return persist_.settings;
}

ExportData Worker::exportData() const
{
    const std::lock_guard<std::mutex> lock(stateMutex_);
    return export_;
}

void Worker::analysisProgress(juce::String& stage, double& fraction) const
{
    const std::lock_guard<std::mutex> lock(progressMutex_);
    stage = progressStage_;
    fraction = progressFraction_;
}

} // namespace djec::plugin
