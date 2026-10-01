// Port de js/analysis/analyze.js: orquestador (características → límites → tempo → beats → compases) y sesión
// con retrack / relabel.
#include "djec/analysis.h"

#include "djec/analysis/analyze_util.h"
#include "djec/analysis/beats_dp.h"
#include "djec/analysis/bounds.h"
#include "djec/analysis/downbeats.h"
#include "djec/analysis/features.h"
#include "djec/analysis/js_math.h"
#include "djec/analysis/tempo.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <set>
#include <stdexcept>
#include <string>

namespace djec
{
namespace analysis
{
namespace
{

constexpr double DC_CUTOFF_HZ = 10;
constexpr double FORCED_CONFIDENCE = 0.75;
constexpr double REMAP_MAX_SEC = 0.1;
constexpr double REMAP_MAX_IBI = 0.25;
constexpr double PROGRESS_MIN_MS = 50;
constexpr int MIN_LABELLED_BEATS = 4;

double roundTo(double x, int d)
{
    const double k = d == 1 ? 10.0 : (d == 3 ? 1000.0 : std::pow(10.0, d));
    return js::round(x * k) / k;
}

/** quantile de analyze.js sobre un vector ordenado (interpolación lineal). */
double quantileSorted(const std::vector<double>& s, double q)
{
    if (s.empty())
        return 0;
    const double pos = q * double(s.size() - 1);
    const double fi = std::floor(pos);
    const std::size_t i = static_cast<std::size_t>(fi);
    const double f = pos - fi;
    return i + 1 < s.size() ? s[i] * (1 - f) + s[i + 1] * f : s[i];
}

double medianA(std::vector<double> a)
{
    if (a.empty())
        return 0;
    std::sort(a.begin(), a.end());
    return quantileSorted(a, 0.5);
}

/** Remuestreo sencillo de respaldo (media móvil contra el aliasing al bajar + interpolación lineal). */
std::vector<float> resampleLinear(const float* x, std::size_t len, double from, double to)
{
    const double ratio = from / to;
    const long long n = std::max<long long>(0, js::floori(double(len) / ratio));
    std::vector<float> filtered;
    const float* src = x;
    if (ratio > 1.01)
    {
        const long long w = std::max<long long>(2, js::roundi(1.5 * ratio));
        std::vector<double> cs(len + 1, 0.0);
        for (std::size_t i = 0; i < len; ++i)
            cs[i + 1] = cs[i] + (std::isfinite(x[i]) ? double(x[i]) : 0.0);
        filtered.resize(len);
        const long long h = w >> 1;
        const long long L = static_cast<long long>(len);
        for (long long i = 0; i < L; ++i)
        {
            const long long a = std::max<long long>(0, i - h);
            const long long b = std::min<long long>(L, a + w);
            filtered[static_cast<std::size_t>(i)] =
                static_cast<float>((cs[static_cast<std::size_t>(b)] - cs[static_cast<std::size_t>(a)]) / double(b - a));
        }
        src = filtered.data();
    }
    std::vector<float> out(static_cast<std::size_t>(n));
    for (long long i = 0; i < n; ++i)
    {
        const double p = double(i) * ratio;
        const double k = std::floor(p);
        const double f = p - k;
        const std::size_t ki = static_cast<std::size_t>(k);
        const double a = src[ki];
        const double b = ki + 1 < len ? double(src[ki + 1]) : a;
        out[static_cast<std::size_t>(i)] = static_cast<float>(a + (b - a) * f);
    }
    return out;
}

/** progressReporter de analyze.js: 0 y 1 siempre; intermedias como mucho cada 50 ms y crecientes. */
class Reporter
{
public:
    explicit Reporter(ProgressFn fn) : fn_(std::move(fn)) {}
    void operator()(const char* stage, double fraction)
    {
        if (!fn_)
            return;
        const bool edge = fraction == 0 || fraction == 1;
        const double t = nowMs();
        if (!edge)
        {
            if (t - lastT_ < PROGRESS_MIN_MS || (lastStage_ == stage && lastFraction_ == fraction))
                return;
        }
        lastT_ = t;
        lastStage_ = stage;
        lastFraction_ = fraction;
        try
        {
            fn_(stage, fraction);
        }
        catch (...)
        {
            // un fallo en la interfaz no debe parar el análisis
        }
    }
    static double nowMs()
    {
        using namespace std::chrono;
        return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
    }

private:
    ProgressFn fn_;
    double lastT_ = -js::kInf;
    std::string lastStage_;
    double lastFraction_ = js::kNaN;
};

} // namespace

std::vector<float> prepareSamples(const float* samples, std::size_t len, double sampleRate)
{
    if (!samples && len > 0)
        throw std::invalid_argument("no hay muestras de audio");
    const double sr = sampleRate;
    if (!(sr >= 3000 && sr <= 384000))
        throw std::invalid_argument("frecuencia de muestreo no válida");
    std::vector<float> resampled;
    const float* x = samples;
    std::size_t n = len;
    if (std::fabs(sr - kAnalysisSampleRate) > 0.5)
    {
        resampled = resampleLinear(samples, len, sr, kAnalysisSampleRate);
        x = resampled.data();
        n = resampled.size();
    }
    std::vector<float> out(n);
    double sum = 0;
    for (std::size_t i = 0; i < n; ++i)
        if (std::isfinite(x[i]))
            sum += x[i];
    const double mean = n ? sum / double(n) : 0;
    const double r = js::exp((-2 * js::kPi * DC_CUTOFF_HZ) / kAnalysisSampleRate);
    double px = 0;
    double py = 0;
    for (std::size_t i = 0; i < n; ++i)
    {
        const double v = std::isfinite(x[i]) ? double(x[i]) - mean : 0.0;
        py = v - px + r * py;
        px = v;
        out[i] = static_cast<float>(py);
    }
    return out;
}

std::vector<int> sanitizeForced(const std::vector<int>& list, int n)
{
    std::vector<int> s(list);
    std::sort(s.begin(), s.end());
    std::vector<int> out;
    for (int v : s)
        if (v >= 0 && v < n && (out.empty() || out.back() != v))
            out.push_back(v);
    return out;
}

std::vector<int> remapForced(const std::vector<double>& oldTimes, const std::vector<double>& newBeats)
{
    std::vector<int> out;
    if (newBeats.empty())
        return out;
    std::vector<double> ibis;
    for (std::size_t i = 1; i < newBeats.size(); ++i)
        ibis.push_back(newBeats[i] - newBeats[i - 1]);
    const double tol = js::jmin(REMAP_MAX_SEC, !ibis.empty() ? REMAP_MAX_IBI * medianA(ibis) : REMAP_MAX_SEC);
    for (double t : oldTimes)
    {
        if (!std::isfinite(t))
            continue;
        std::size_t lo = 0;
        std::size_t hi = newBeats.size() - 1;
        while (lo < hi)
        {
            const std::size_t mid = (lo + hi) >> 1;
            if (newBeats[mid] < t)
                lo = mid + 1;
            else
                hi = mid;
        }
        std::size_t j = lo;
        if (j > 0 && std::fabs(newBeats[j - 1] - t) <= std::fabs(newBeats[j] - t))
            j -= 1;
        if (std::fabs(newBeats[j] - t) <= tol)
            out.push_back(static_cast<int>(j));
    }
    return sanitizeForced(out, static_cast<int>(newBeats.size()));
}

void extendPositions(std::vector<int>& positions, std::size_t n, int beatsPerBar, const std::vector<int>& forced)
{
    const std::set<int> f(forced.begin(), forced.end());
    for (std::size_t i = positions.size(); i < n; ++i)
    {
        const int prev = i > 0 ? positions[i - 1] : beatsPerBar - 1;
        positions.push_back((f.count(static_cast<int>(i)) || prev + 1 >= beatsPerBar) ? 0 : prev + 1);
    }
}

TempoSummary tempoSummary(const std::vector<double>& beats)
{
    TempoSummary ts;
    if (beats.size() < 2)
        return ts;
    std::vector<double> inst, ibi;
    for (std::size_t i = 1; i < beats.size(); ++i)
    {
        const double d = beats[i] - beats[i - 1];
        ibi.push_back(d);
        inst.push_back(60 / d);
    }
    std::vector<double> local;
    const long long nI = static_cast<long long>(ibi.size());
    for (long long i = 0; i < static_cast<long long>(beats.size()); ++i)
    {
        const long long a = std::max<long long>(0, i - 2);
        const long long b = std::min<long long>(nI - 1, i + 1);
        local.push_back(60 / medianA(std::vector<double>(ibi.begin() + a, ibi.begin() + b + 1)));
    }
    std::sort(local.begin(), local.end());
    ts.bpm = roundTo(medianA(inst), 1);
    ts.bpmLo = roundTo(quantileSorted(local, 0.1), 1);
    ts.bpmHi = roundTo(quantileSorted(local, 0.9), 1);
    return ts;
}

} // namespace analysis

// ------------------------------------------------------------------------------------------------ Analyzer

struct Analyzer::Impl
{
    // opciones normalizadas
    double minBpm = 50, maxBpm = 220;
    int optionsBeatsPerBar = 0;
    double duration = 0;
    std::vector<float> samples; // 22050 Hz, preparadas
    bool analyzed = false;
    analysis::Features features;
    analysis::MusicBounds bounds;
    analysis::TempoEstimate tempo;
    double lastOnset = 0;
    // pista de beats
    std::vector<double> beats, strength;
    double trackConfidence = 0;
    int tailFrom = -1;
    // compases
    int beatsPerBar = 0; // 0 = auto
    std::vector<int> forced;
    int barsBeatsPerBar = 4;
    bool barsMeterAuto = true;
    std::vector<int> positions, downbeats;
    double barsConfidence = 0;
    AnalysisTimings timings;

    void requireAnalysis() const
    {
        if (!analyzed)
            throw std::logic_error("primero hay que analizar una canción");
    }

    void track(double bpmHint, bool strict)
    {
        analysis::TrackOptions to;
        to.dp.minBpm = minBpm;
        to.dp.maxBpm = maxBpm;
        to.musicStart = bounds.musicStart;
        to.musicEnd = bounds.musicEnd;
        to.samples = samples.data();
        to.numSamples = samples.size();
        to.sampleRate = kAnalysisSampleRate;
        to.tempo = &tempo;
        to.bpmHint = bpmHint;
        to.strict = strict;
        const analysis::TrackResult tr = analysis::trackBeats(features, to);
        beats = analysis::refineBeats(samples.data(), samples.size(), kAnalysisSampleRate, tr.beats, bounds.musicStart,
                                      bounds.musicEnd);
        strength.assign(beats.size(), 0.0);
        for (std::size_t i = 0; i < beats.size(); ++i)
        {
            const double v = i < tr.strength.size() ? tr.strength[i] : 0.0;
            strength[i] = std::isfinite(v) ? std::min(1.0, std::max(0.0, v)) : 0.0;
        }
        const double conf = tr.confidence;
        trackConfidence = beats.size() >= 2 && std::isfinite(conf) ? std::min(1.0, std::max(0.0, conf)) : 0.0;
        const int tail = std::max(0, std::min(static_cast<int>(beats.size()), tr.extrapolated));
        tailFrom = tail > 0 ? static_cast<int>(beats.size()) - tail : -1;
    }

    void label()
    {
        const int len = static_cast<int>(beats.size());
        forced = analysis::sanitizeForced(forced, len);
        int nLab = tailFrom >= analysis::MIN_LABELLED_BEATS ? tailFrom : len;
        auto doLabel = [&](const std::vector<int>& fd) {
            if (nLab < len)
            {
                const std::vector<double> part(beats.begin(), beats.begin() + nLab);
                return analysis::labelBars(features, part, beatsPerBar, fd);
            }
            return analysis::labelBars(features, beats, beatsPerBar, fd);
        };
        std::vector<int> before, inTail;
        for (int i : forced)
            (i < nLab ? before : inTail).push_back(i);
        analysis::LabelResult lb = doLabel(before);
        if (!inTail.empty())
        {
            const int M = lb.beatsPerBar;
            std::vector<int> proj;
            bool allOk = true;
            for (int f : inTail)
            {
                const int p = f - static_cast<int>(std::ceil(double(f - nLab + 1) / M)) * M;
                proj.push_back(p);
                if (p < 0)
                    allOk = false;
            }
            if (allOk)
            {
                std::vector<int> all(before);
                all.insert(all.end(), proj.begin(), proj.end());
                lb = doLabel(analysis::sanitizeForced(all, nLab));
            }
            else
            {
                nLab = len;
                lb = doLabel(forced);
            }
        }
        positions = lb.positions;
        analysis::extendPositions(positions, beats.size(), lb.beatsPerBar, forced);
        downbeats.clear();
        for (std::size_t i = 0; i < positions.size(); ++i)
            if (positions[i] == 0)
                downbeats.push_back(static_cast<int>(i));
        double conf = lb.confidence;
        conf = len >= 2 && std::isfinite(conf) ? std::min(1.0, std::max(0.0, conf)) : 0.0;
        if (!forced.empty() && len >= 2)
            conf = std::max(conf, analysis::FORCED_CONFIDENCE);
        barsBeatsPerBar = lb.beatsPerBar;
        barsMeterAuto = lb.meterAuto;
        barsConfidence = conf;
    }

    AnalysisResult result() const
    {
        requireAnalysis();
        AnalysisResult r;
        const analysis::TempoSummary ts = analysis::tempoSummary(beats);
        r.duration = duration;
        r.musicStart = bounds.musicStart;
        r.musicEnd = bounds.musicEnd;
        r.lastOnset = lastOnset;
        r.bpm = ts.bpm;
        r.bpmLo = ts.bpmLo;
        r.bpmHi = ts.bpmHi;
        r.beats = beats;
        r.beatStrength = strength;
        r.beatsPerBar = barsBeatsPerBar;
        r.meterAuto = barsMeterAuto;
        r.positions = positions;
        r.downbeats = downbeats;
        r.forcedDownbeats = forced;
        r.confBeats = js::round(trackConfidence * 1000) / 1000;
        r.confBars = js::round(barsConfidence * 1000) / 1000;
        r.tailBeatsFrom = tailFrom;
        return r;
    }
};

namespace
{
int normalizeMeter(int v) { return (v >= 2 && v <= 7) ? v : 0; }
} // namespace

Analyzer::Analyzer() : impl_(std::make_unique<Impl>()) {}
Analyzer::~Analyzer() = default;
Analyzer::Analyzer(Analyzer&&) noexcept = default;
Analyzer& Analyzer::operator=(Analyzer&&) noexcept = default;

bool Analyzer::hasAnalysis() const { return impl_ && impl_->analyzed; }

void Analyzer::reset() { impl_ = std::make_unique<Impl>(); }

const AnalysisTimings& Analyzer::lastTimings() const
{
    static const AnalysisTimings none{};
    return impl_ ? impl_->timings : none;
}

AnalysisResult Analyzer::result() const
{
    if (!impl_)
        throw std::logic_error("primero hay que analizar una canción");
    return impl_->result();
}

AnalysisResult Analyzer::analyze(const float* mono, std::size_t n, double sampleRate, const AnalyzeOptions& options,
                                 ProgressFn progress)
{
    if (!mono && n > 0)
        throw std::invalid_argument("no hay muestras de audio");
    const double sr = sampleRate;
    if (!(sr >= 3000 && sr <= 384000))
        throw std::invalid_argument("frecuencia de muestreo no válida");
    auto im = std::make_unique<Impl>();
    // normalizeOptions
    double minBpm = options.minBpm;
    double maxBpm = options.maxBpm;
    if (!(minBpm >= 20 && minBpm <= 300))
        minBpm = 50;
    if (!(maxBpm >= 40 && maxBpm <= 400))
        maxBpm = 220;
    if (maxBpm < minBpm * 1.5)
    {
        minBpm = 50;
        maxBpm = 220;
    }
    im->minBpm = minBpm;
    im->maxBpm = maxBpm;
    im->optionsBeatsPerBar = normalizeMeter(options.beatsPerBar);
    im->duration = double(n) / sr;

    analysis::Reporter report(std::move(progress));
    const double tAll = analysis::Reporter::nowMs();
    double t = tAll;
    report("features", 0);
    im->samples = analysis::prepareSamples(mono, n, sr);
    im->beatsPerBar = im->optionsBeatsPerBar;
    im->forced.clear();
    report("features", 0.05);
    analysis::FeatureOptions fo;
    fo.onProgress = [&report](double f) { report("features", 0.05 + 0.9 * f); };
    im->features = analysis::computeFeatures(im->samples.data(), im->samples.size(), kAnalysisSampleRate, fo);
    im->features.sampleRate = kAnalysisSampleRate;
    im->bounds = analysis::findMusicBounds(im->samples.data(), im->samples.size(), kAnalysisSampleRate);
    im->lastOnset = analysis::findLastOnset(im->features, im->bounds.musicEnd);
    AnalysisTimings tm;
    tm.features = analysis::Reporter::nowMs() - t;
    report("features", 1);

    t = analysis::Reporter::nowMs();
    report("tempo", 0);
    analysis::TempoOptions to;
    to.minBpm = im->minBpm;
    to.maxBpm = im->maxBpm;
    im->tempo = analysis::estimateTempo(im->features, to);
    tm.tempo = analysis::Reporter::nowMs() - t;
    report("tempo", 1);

    t = analysis::Reporter::nowMs();
    report("beats", 0);
    im->track(0, false);
    tm.beats = analysis::Reporter::nowMs() - t;
    report("beats", 1);

    t = analysis::Reporter::nowMs();
    report("bars", 0);
    im->analyzed = true;
    im->label();
    tm.bars = analysis::Reporter::nowMs() - t;
    report("bars", 1);
    tm.total = analysis::Reporter::nowMs() - tAll;
    im->timings = tm;
    impl_ = std::move(im);
    return impl_->result();
}

AnalysisResult Analyzer::retrack(double bpmHint, bool strict, ProgressFn progress)
{
    if (!impl_)
        throw std::logic_error("primero hay que analizar una canción");
    impl_->requireAnalysis();
    double hint = 0;
    if (bpmHint != 0)
    {
        hint = bpmHint;
        if (!(hint >= 20 && hint <= 400))
            throw std::invalid_argument("tempo fuera de rango (20–400 BPM)");
    }
    analysis::Reporter report(std::move(progress));
    AnalysisTimings tm;
    const double tAll = analysis::Reporter::nowMs();
    std::vector<double> forcedTimes;
    for (int i : impl_->forced)
        forcedTimes.push_back(impl_->beats[static_cast<std::size_t>(i)]);
    double t = analysis::Reporter::nowMs();
    report("beats", 0);
    impl_->track(hint, hint > 0 && strict);
    tm.beats = analysis::Reporter::nowMs() - t;
    report("beats", 1);
    impl_->forced = analysis::remapForced(forcedTimes, impl_->beats);
    t = analysis::Reporter::nowMs();
    report("bars", 0);
    impl_->label();
    tm.bars = analysis::Reporter::nowMs() - t;
    report("bars", 1);
    tm.total = analysis::Reporter::nowMs() - tAll;
    impl_->timings = tm;
    return impl_->result();
}

AnalysisResult Analyzer::relabel(int beatsPerBar, const std::vector<int>& forcedDownbeats, ProgressFn progress)
{
    if (!impl_)
        throw std::logic_error("primero hay que analizar una canción");
    impl_->requireAnalysis();
    analysis::Reporter report(std::move(progress));
    const double tAll = analysis::Reporter::nowMs();
    impl_->beatsPerBar = normalizeMeter(beatsPerBar);
    impl_->forced = analysis::sanitizeForced(forcedDownbeats, static_cast<int>(impl_->beats.size()));
    report("bars", 0);
    impl_->label();
    report("bars", 1);
    AnalysisTimings tm;
    tm.bars = tm.total = analysis::Reporter::nowMs() - tAll;
    impl_->timings = tm;
    return impl_->result();
}

} // namespace djec
