// Port de js/analysis/beats-dp.js (trackBeats y piezas) y de refineBeats (js/analysis/beats.js).
#include "djec/analysis/beats_dp.h"

#include "djec/analysis/bounds.h"
#include "djec/analysis/js_math.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>

namespace djec
{
namespace analysis
{
namespace
{

std::vector<float> movingMean(const std::vector<float>& x, long long half)
{
    const long long n = static_cast<long long>(x.size());
    std::vector<double> cs(static_cast<std::size_t>(n) + 1, 0.0);
    for (long long i = 0; i < n; ++i)
        cs[static_cast<std::size_t>(i) + 1] = cs[static_cast<std::size_t>(i)] + x[static_cast<std::size_t>(i)];
    std::vector<float> out(static_cast<std::size_t>(n));
    for (long long i = 0; i < n; ++i)
    {
        const long long a = std::max<long long>(0, i - half);
        const long long b = std::min<long long>(n - 1, i + half);
        out[static_cast<std::size_t>(i)] =
            static_cast<float>((cs[static_cast<std::size_t>(b) + 1] - cs[static_cast<std::size_t>(a)]) / double(b - a + 1));
    }
    return out;
}

std::vector<float> gaussianSmooth(const std::vector<float>& x, double sigma)
{
    if (!(sigma > 0))
        return x;
    const long long r = std::max<long long>(1, js::ceili(3 * sigma));
    std::vector<double> k(static_cast<std::size_t>(2 * r + 1));
    double s = 0;
    for (long long j = -r; j <= r; ++j)
    {
        k[static_cast<std::size_t>(j + r)] = js::exp((-0.5 * double(j) * double(j)) / (sigma * sigma));
        s += k[static_cast<std::size_t>(j + r)];
    }
    for (double& v : k)
        v /= s;
    const long long n = static_cast<long long>(x.size());
    std::vector<float> out(static_cast<std::size_t>(n));
    for (long long i = 0; i < n; ++i)
    {
        double acc = 0;
        for (long long j = -r; j <= r; ++j)
        {
            const long long q = i + j;
            if (q >= 0 && q < n)
                acc += k[static_cast<std::size_t>(j + r)] * double(x[static_cast<std::size_t>(q)]);
        }
        out[static_cast<std::size_t>(i)] = static_cast<float>(acc);
    }
    return out;
}

/** median de beats-dp.js: Float64Array ordenado, media de los dos centrales si la longitud es par. */
double median(std::vector<double> a)
{
    if (a.empty())
        return 0;
    std::sort(a.begin(), a.end());
    const std::size_t m = a.size() >> 1;
    return (a.size() % 2) ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

double medianInts(const std::vector<int>& v, std::size_t a, std::size_t b) // [a, b)
{
    std::vector<double> d;
    d.reserve(b - a);
    for (std::size_t i = a; i < b; ++i)
        d.push_back(v[i]);
    return median(std::move(d));
}

struct Bounds2
{
    double musicStart, musicEnd;
};

Bounds2 boundsFromRms(const Features& f)
{
    const auto& rms = f.rms;
    const int numFrames = f.numFrames;
    double mx = 0;
    for (int i = 0; i < numFrames; ++i)
        if (rms[static_cast<std::size_t>(i)] > mx)
            mx = rms[static_cast<std::size_t>(i)];
    if (!(mx > 0))
        return {0, 0};
    const double th = mx * js::pow(10, -50.0 / 20);
    int a = 0;
    while (a < numFrames && rms[static_cast<std::size_t>(a)] < th)
        ++a;
    int b = numFrames - 1;
    while (b > a && rms[static_cast<std::size_t>(b)] < th)
        --b;
    return {a / f.fps, js::jmin(f.duration, (b + 1) / f.fps)};
}

double acfAtRow(const std::vector<float>& row, double lag)
{
    const double fi = std::floor(lag);
    if (fi < 0 || fi + 1 >= double(row.size()))
        return 0;
    const std::size_t i = static_cast<std::size_t>(fi);
    const double f = lag - fi;
    return double(row[i]) * (1 - f) + double(row[i + 1]) * f;
}

std::vector<int> backtrace(const std::vector<int>& back, int end)
{
    std::vector<int> out;
    for (int i = end; i >= 0; i = back[static_cast<std::size_t>(i)])
        out.push_back(i);
    std::reverse(out.begin(), out.end());
    return out;
}

/** Periodo por trama a partir de beats (tramas): mediana de IBI en ±k beats, interpolada. */
std::vector<double> periodFromBeats(const std::vector<int>& beats, int n, int k, double fallback)
{
    std::vector<double> out(static_cast<std::size_t>(n), fallback);
    if (beats.size() < 3)
        return out;
    std::vector<int> ibi;
    for (std::size_t i = 1; i < beats.size(); ++i)
        ibi.push_back(beats[i] - beats[i - 1]);
    std::vector<double> mids, vals;
    const long long L = static_cast<long long>(ibi.size());
    for (long long i = 0; i < L; ++i)
    {
        const long long a = std::max<long long>(0, i - k);
        const long long b = std::min<long long>(L - 1, i + k);
        vals.push_back(medianInts(ibi, static_cast<std::size_t>(a), static_cast<std::size_t>(b + 1)));
        mids.push_back(0.5 * double(beats[static_cast<std::size_t>(i)] + beats[static_cast<std::size_t>(i) + 1]));
    }
    std::size_t w = 0;
    for (int i = 0; i < n; ++i)
    {
        while (w + 1 < mids.size() && mids[w + 1] <= i)
            ++w;
        if (i <= mids[0])
            out[static_cast<std::size_t>(i)] = vals[0];
        else if (w + 1 >= mids.size())
            out[static_cast<std::size_t>(i)] = vals.back();
        else
        {
            const double f = (i - mids[w]) / (mids[w + 1] - mids[w]);
            out[static_cast<std::size_t>(i)] = vals[w] * (1 - f) + vals[w + 1] * f;
        }
    }
    return out;
}

double logPrior(double bpm, double center, double sigma)
{
    const double z = js::log2(bpm / center) / sigma;
    return -0.5 * z * z;
}

using SalFn = std::function<double(long long)>;

OctaveEvidence octaveEvidence(const std::vector<int>& beatsF, const SalFn& salAt)
{
    const int n = static_cast<int>(beatsF.size());
    if (n < 8)
        return {js::kNaN, js::kNaN, n};
    double e = 0, od = 0, b = 0, m = 0;
    int ne = 0, no = 0;
    for (int i = 0; i < n; ++i)
    {
        const double v = salAt(beatsF[static_cast<std::size_t>(i)]);
        b += v;
        if (i % 2 == 0)
        {
            e += v;
            ++ne;
        }
        else
        {
            od += v;
            ++no;
        }
        if (i > 0)
            m += salAt(js::roundi(0.5 * double(beatsF[static_cast<std::size_t>(i)] + beatsF[static_cast<std::size_t>(i) - 1])));
    }
    e /= ne;
    od /= no;
    b /= n;
    m /= n - 1;
    const double mx = js::jmax(e, od);
    return {mx > 0 ? js::jmin(e, od) / mx : js::kNaN, b > 0 ? js::jmin(1, m / b) : js::kNaN, n};
}

double beatContrast(const std::vector<int>& beatsF, std::size_t count, const SalFn& salAt)
{
    if (count < 2)
        return 0;
    double bs = 0;
    for (std::size_t i = 0; i < count; ++i)
        bs += salAt(beatsF[i]);
    double as = 0;
    long long an = 0;
    for (long long f = beatsF[0]; f <= beatsF[count - 1]; ++f)
    {
        as += salAt(f);
        ++an;
    }
    return as > 0 ? bs / double(count) / (as / double(an)) : 0;
}

} // namespace

BeatEnvelope beatEnvelope(const Features& features, int f0, int f1, const DpOptions& o)
{
    const auto& onset = features.onset;
    const auto& onsetLow = features.onsetLow;
    const int n = f1 - f0 + 1;
    std::vector<float> raw(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
        raw[static_cast<std::size_t>(i)] = static_cast<float>(
            double(onset[static_cast<std::size_t>(f0 + i)]) +
            o.lowWeight * (onsetLow.empty() ? 0.0 : double(onsetLow[static_cast<std::size_t>(f0 + i)])));
    double tot = 0;
    for (int i = 0; i < n; ++i)
        tot += raw[static_cast<std::size_t>(i)];
    const double gMean = tot / std::max(1, n);
    const std::vector<float> mean = movingMean(raw, std::max<long long>(1, js::roundi(o.normSec * features.fps)));
    const double floor = js::jmax(1e-6, o.normFloor * gMean);
    BeatEnvelope be;
    be.env.resize(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
        be.env[static_cast<std::size_t>(i)] =
            static_cast<float>(double(raw[static_cast<std::size_t>(i)]) / js::jmax(mean[static_cast<std::size_t>(i)], floor));
    be.score = gaussianSmooth(be.env, o.smoothSigma);
    return be;
}

std::vector<double> tempoPath(const std::vector<float>& env, double fps, double bpm0, const DpOptions& o, const PathOverrides& p)
{
    const long long n = static_cast<long long>(env.size());
    const double lo = p.lo ? *p.lo : o.pathLo;
    const double hi = p.hi ? *p.hi : o.pathHi;
    const double tau0 = (60 * fps) / bpm0;
    std::vector<double> out(static_cast<std::size_t>(n), tau0);
    const long long nS = std::max<long long>(1, js::roundi((hi - lo) / o.pathStep) + 1);
    std::vector<double> lags(static_cast<std::size_t>(nS));
    for (long long s = 0; s < nS; ++s)
        lags[static_cast<std::size_t>(s)] = tau0 * js::pow(2, -(lo + double(s) * o.pathStep));
    const double maxLagState = lags[0];
    const std::vector<float> m = movingMean(env, std::max<long long>(1, js::roundi(0.25 * fps)));
    std::vector<float> pe(static_cast<std::size_t>(n));
    for (long long i = 0; i < n; ++i)
        pe[static_cast<std::size_t>(i)] =
            static_cast<float>(js::jmax(0, double(env[static_cast<std::size_t>(i)]) - double(m[static_cast<std::size_t>(i)])));
    const double winS = js::jmin(o.tempoWindowMax,
                                js::jmax(js::jmax(o.tempoWindowMin, (o.tempoWindowBeats * 60) / bpm0), (2.5 * maxLagState) / fps));
    const double winL = js::jmax(winS, js::jmin(o.combWindowMax, (o.combWindowBeats * 60) / bpm0));
    if (double(n) < 3 * maxLagState)
        return out;
    const Tempogram tgS = tempogram(pe, fps, winS, o.tempoHopSec, static_cast<int>(js::ceili(maxLagState) + 2));
    const bool useLong = o.combBar > 0 || o.combDouble > 0;
    Tempogram tgL;
    if (useLong)
        tgL = tempogram(pe, fps, winL, o.tempoHopSec, static_cast<int>(js::ceili(4 * maxLagState) + 2));
    const auto& rows = tgS.rows;
    const long long nW = static_cast<long long>(rows.size());
    if (!nW)
        return out;
    const double hopSec = double(std::max<long long>(1, js::roundi(o.tempoHopSec * fps))) / fps;
    const double endF = std::isfinite(p.endFrame) ? p.endFrame : js::kInf;
    const double endSpan = (o.endBeats * 60 * fps) / bpm0;
    auto endRamp = [&](long long w) {
        return js::jmin(1, js::jmax(0, (tgS.centers[static_cast<std::size_t>(w)] - (endF - endSpan)) / (0.5 * endSpan)));
    };
    const double sigmaMax = o.pathSigma * js::jmax(1, o.endSigmaMult);
    const long long maxJump = std::max<long long>(1, js::ceili((4 * sigmaMax * js::sqrt(hopSec)) / o.pathStep));
    std::vector<double> prior(static_cast<std::size_t>(nS));
    for (long long s = 0; s < nS; ++s)
    {
        const double d = lo + double(s) * o.pathStep;
        prior[static_cast<std::size_t>(s)] = -o.pathPrior * hopSec * 0.5 * (d / 0.5) * (d / 0.5);
    }
    double barMult = 4;
    if (useLong)
    {
        double a3 = 0;
        double a4 = 0;
        for (const auto& rl : tgL.rows)
        {
            if (rl[0] <= 0)
                continue;
            a3 += acfAtRow(rl, 3 * tau0);
            a4 += acfAtRow(rl, 4 * tau0);
        }
        barMult = a3 > a4 * o.barThreeBias ? 3 : 4;
    }
    // fila de la ventana larga con el centro más cercano a cada ventana corta
    std::vector<const std::vector<float>*> longRows;
    if (useLong)
    {
        std::size_t k = 0;
        for (long long w = 0; w < nW; ++w)
        {
            const double c = tgS.centers[static_cast<std::size_t>(w)];
            while (k + 1 < tgL.centers.size() && std::fabs(tgL.centers[k + 1] - c) <= std::fabs(tgL.centers[k] - c))
                ++k;
            longRows.push_back(&tgL.rows[k]);
        }
    }
    auto obs = [&](long long w, long long s) -> double {
        const auto& row = rows[static_cast<std::size_t>(w)];
        if (row[0] <= 0)
            return 0;
        const double L = lags[static_cast<std::size_t>(s)];
        double v = acfAtRow(row, L) + o.combSub * js::jmax(acfAtRow(row, L / 2), acfAtRow(row, L / 3));
        if (useLong)
        {
            const auto& rl = *longRows[static_cast<std::size_t>(w)];
            if (rl[0] > 0)
                v += o.combDouble * acfAtRow(rl, 2 * L) + o.combBar * acfAtRow(rl, barMult * L);
        }
        return js::jmax(0, v);
    };
    std::vector<double> prev(static_cast<std::size_t>(nS), 0.0), cur(static_cast<std::size_t>(nS), 0.0);
    std::vector<std::vector<int16_t>> back(static_cast<std::size_t>(nW));
    const bool useCore = std::isfinite(p.coreLo) && std::isfinite(p.coreHi);
    auto outside = [&](long long w, long long s) {
        if (!useCore)
            return false;
        const double r = endRamp(w);
        const double d = lo + double(s) * o.pathStep;
        return d < p.coreLo + (lo - p.coreLo) * r - 1e-9 || d > p.coreHi + (hi - p.coreHi) * r + 1e-9;
    };
    const double BANNED = -1e12;
    for (long long s = 0; s < nS; ++s)
        prev[static_cast<std::size_t>(s)] = outside(0, s) ? BANNED : o.pathWeight * obs(0, s) + prior[static_cast<std::size_t>(s)];
    for (long long w = 1; w < nW; ++w)
    {
        std::vector<int16_t> bk(static_cast<std::size_t>(nS));
        const double r = endRamp(w);
        const double sig = o.pathSigma * (1 + (o.endSigmaMult - 1) * r);
        const double inv2var = 1 / (2 * sig * sig * hopSec);
        const double pw = 1 - r;
        for (long long s = 0; s < nS; ++s)
        {
            double best = -js::kInf;
            long long bi = s;
            const long long a = std::max<long long>(0, s - maxJump);
            const long long b = std::min<long long>(nS - 1, s + maxJump);
            for (long long k = a; k <= b; ++k)
            {
                const double d = double(k - s) * o.pathStep;
                const double v = prev[static_cast<std::size_t>(k)] - d * d * inv2var;
                if (v > best)
                {
                    best = v;
                    bi = k;
                }
            }
            cur[static_cast<std::size_t>(s)] =
                outside(w, s) ? BANNED : best + o.pathWeight * obs(w, s) + pw * prior[static_cast<std::size_t>(s)];
            bk[static_cast<std::size_t>(s)] = static_cast<int16_t>(bi);
        }
        back[static_cast<std::size_t>(w)] = std::move(bk);
        std::swap(prev, cur);
    }
    long long s = 0;
    for (long long k = 1; k < nS; ++k)
        if (prev[static_cast<std::size_t>(k)] > prev[static_cast<std::size_t>(s)])
            s = k;
    std::vector<double> pathLag(static_cast<std::size_t>(nW));
    for (long long w = nW - 1; w >= 0; --w)
    {
        pathLag[static_cast<std::size_t>(w)] = lags[static_cast<std::size_t>(s)];
        if (w > 0)
            s = back[static_cast<std::size_t>(w)][static_cast<std::size_t>(s)];
    }
    const auto& centers = tgS.centers;
    long long w = 0;
    for (long long i = 0; i < n; ++i)
    {
        while (w + 1 < nW && centers[static_cast<std::size_t>(w + 1)] <= double(i))
            ++w;
        if (double(i) <= centers[0])
            out[static_cast<std::size_t>(i)] = pathLag[0];
        else if (w + 1 >= nW)
            out[static_cast<std::size_t>(i)] = pathLag[static_cast<std::size_t>(nW - 1)];
        else
        {
            const double f = (double(i) - centers[static_cast<std::size_t>(w)]) /
                             (centers[static_cast<std::size_t>(w + 1)] - centers[static_cast<std::size_t>(w)]);
            out[static_cast<std::size_t>(i)] = pathLag[static_cast<std::size_t>(w)] * (1 - f) + pathLag[static_cast<std::size_t>(w + 1)] * f;
        }
    }
    return out;
}

DpForward dpForward(const std::vector<float>& score, const std::vector<double>& period, double tightness, bool alwaysLink)
{
    const long long n = static_cast<long long>(score.size());
    DpForward r;
    r.cum.assign(static_cast<std::size_t>(n), 0.0);
    r.back.assign(static_cast<std::size_t>(n), -1);
    double* cum = r.cum.data();
    int* back = r.back.data();
    for (long long i = 0; i < n; ++i)
    {
        const double tau = period[static_cast<std::size_t>(i)];
        const long long jLo = std::max<long long>(0, i - js::roundi(2 * tau));
        const long long jHi = i - std::max<long long>(1, js::roundi(tau / 2));
        double best = -js::kInf;
        long long bj = -1;
        for (long long j = jHi; j >= jLo; --j)
        {
            const double rr = js::log(double(i - j) / tau);
            const double v = cum[j] - tightness * rr * rr;
            if (v > best)
            {
                best = v;
                bj = j;
            }
        }
        if (bj >= 0 && (best > 0 || alwaysLink))
        {
            cum[i] = double(score[static_cast<std::size_t>(i)]) + best;
            back[i] = static_cast<int>(bj);
        }
        else
            cum[i] = score[static_cast<std::size_t>(i)];
    }
    return r;
}

double offCoreFraction(const std::vector<int>& beatsF, double bpm0, double fps, double endF, double lo, double hi)
{
    int n = 0;
    int off = 0;
    const std::size_t len = beatsF.size();
    for (std::size_t i = 1; i < len; ++i)
    {
        if (beatsF[i] > endF)
            break;
        std::vector<double> ibis;
        for (std::size_t k = std::max<std::size_t>(1, i >= 2 ? i - 2 : 1); k <= std::min(len - 1, i + 1); ++k)
            ibis.push_back(beatsF[k] - beatsF[k - 1]);
        const double d = js::log2((60 * fps) / median(ibis) / bpm0);
        ++n;
        if (d < lo || d > hi)
            ++off;
    }
    return n ? double(off) / n : 0;
}

std::optional<BeatRun> slowRun(const std::vector<int>& beatsF, double bpm0, double fps, double endF, double lo)
{
    std::optional<BeatRun> best;
    long long from = -1;
    const std::size_t len = beatsF.size();
    for (std::size_t i = 1; i < len && beatsF[i] <= endF; ++i)
    {
        std::vector<double> ibis;
        for (std::size_t k = std::max<std::size_t>(1, i >= 2 ? i - 2 : 1); k <= std::min(len - 1, i + 1); ++k)
            ibis.push_back(beatsF[k] - beatsF[k - 1]);
        const bool slow = js::log2((60 * fps) / median(ibis) / bpm0) < lo;
        if (slow && from < 0)
            from = static_cast<long long>(i);
        if ((!slow || i + 1 >= len || beatsF[i + 1] > endF) && from >= 0)
        {
            const long long to = slow ? static_cast<long long>(i) : static_cast<long long>(i) - 1;
            if (!best || to - from > best->to - best->from)
                best = BeatRun{static_cast<int>(from), static_cast<int>(to)};
            from = -1;
        }
    }
    return best;
}

TrackResult trackBeats(const Features& features, const TrackOptions& opts)
{
    const DpOptions& o = opts.dp;
    auto empty = [](double bpm = 0) {
        TrackResult r;
        r.bpm = bpm;
        return r;
    };
    if (!(features.numFrames > 0) || !(features.fps > 0) || features.onset.empty())
        return empty();
    const double fps = features.fps;
    const double hint = (std::isfinite(opts.bpmHint) && opts.bpmHint > 0) ? opts.bpmHint : 0;
    const bool strict = hint > 0 && opts.strict;
    const double minBpmIn = (opts.dp.minBpm != 0 && !std::isnan(opts.dp.minBpm)) ? opts.dp.minBpm : 50;
    const double minBpm = js::jmax(20, minBpmIn);
    const double maxBpmIn = (opts.dp.maxBpm != 0 && !std::isnan(opts.dp.maxBpm)) ? opts.dp.maxBpm : 220;
    const double maxBpm = js::jmax(minBpm * 1.1, maxBpmIn);

    double musicStart = opts.musicStart;
    double musicEnd = opts.musicEnd;
    if (!(std::isfinite(musicStart) && std::isfinite(musicEnd)))
    {
        if (opts.samples && opts.numSamples)
        {
            const MusicBounds b = findMusicBounds(opts.samples, opts.numSamples, opts.sampleRate > 0 ? opts.sampleRate : features.sampleRate);
            musicStart = b.musicStart;
            musicEnd = b.musicEnd;
        }
        else
        {
            const Bounds2 b = boundsFromRms(features);
            musicStart = b.musicStart;
            musicEnd = b.musicEnd;
        }
    }
    musicStart = js::jmax(0, musicStart);
    musicEnd = js::jmin(features.duration, musicEnd);
    if (!(musicEnd > musicStart))
        return empty();
    const double half = (features.frameSize ? features.frameSize : 1024) / 2;
    const double hop = features.hop ? features.hop : 256;
    const long long firstValid = js::ceili(half / hop);
    const long long lastValid = js::floori((features.duration * features.sampleRate - half) / hop);
    const long long f0l = std::max<long long>(firstValid, js::floori(musicStart * fps));
    const long long f1l = std::min<long long>(std::min<long long>(features.numFrames - 1, lastValid), js::ceili(musicEnd * fps));
    if (f1l - f0l < js::roundi(0.5 * fps))
        return empty();
    const int f0 = static_cast<int>(f0l);
    const int f1 = static_cast<int>(f1l);

    // tempo global
    TempoEstimate own;
    const TempoEstimate* tempo = opts.tempo;
    if (hint > 0 || !tempo || !(tempo->bpm > 0))
    {
        TempoOptions to;
        to.minBpm = minBpm;
        to.maxBpm = maxBpm;
        to.bpmHint = hint;
        to.strict = strict;
        own = estimateTempo(features, to);
        tempo = &own;
    }
    double bpm0 = tempo->bpm > 0 ? tempo->bpm : (hint > 0 ? hint : 115);
    if (strict)
        bpm0 = js::jmin(hint * 1.25, js::jmax(hint * 0.8, bpm0));

    const BeatEnvelope be = beatEnvelope(features, f0, f1, o);
    const std::vector<float>& env = be.env;
    const std::vector<float>& score = be.score;
    const int n = static_cast<int>(env.size());
    double envMax = 0;
    for (int i = 0; i < n; ++i)
        if (env[static_cast<std::size_t>(i)] > envMax)
            envMax = env[static_cast<std::size_t>(i)];
    if (!(envMax > 0))
        return empty(bpm0);

    // fin de la evidencia: último onset significativo
    const double endSearch = js::jmin(musicEnd, double(f1 - 2) / fps);
    double lastOnset = findLastOnset(features, endSearch);
    if (lastOnset >= endSearch - 1e-6)
    {
        std::vector<int> peaks;
        for (int i : pickPeaks(features.onset, fps, LastOnsetOptions::lastOnsetPick()))
            if (i >= f0 && i <= f1 - 2)
                peaks.push_back(i);
        if (!peaks.empty())
        {
            std::vector<double> h;
            for (int i : peaks)
                h.push_back(features.onset[static_cast<std::size_t>(i)]);
            std::sort(h.begin(), h.end());
            const double th = 0.2 * h[static_cast<std::size_t>(js::floori(0.75 * double(h.size() - 1)))];
            for (long long q = static_cast<long long>(peaks.size()) - 1; q >= 0; --q)
                if (features.onset[static_cast<std::size_t>(peaks[static_cast<std::size_t>(q)])] >= th)
                {
                    lastOnset = peaks[static_cast<std::size_t>(q)] / fps;
                    break;
                }
        }
    }
    const int fLast = static_cast<int>(std::min<long long>(n - 1, std::max<long long>(0, js::roundi(lastOnset * fps) - f0)));
    const int R = o.refineFrames;
    const SalFn salAt = [&env, n, R](long long f) -> double {
        double m = 0;
        for (long long k = std::max<long long>(0, f - R); k <= std::min<long long>(n - 1, f + R); ++k)
            if (env[static_cast<std::size_t>(k)] > m)
                m = env[static_cast<std::size_t>(k)];
        return m;
    };

    bool useCore = hint <= 0 && o.pathCore == DpOptions::PathCore::Always;
    PathOverrides strictCore;
    if (strict)
    {
        strictCore.coreLo = js::log2((o.strictLo * hint) / bpm0);
        strictCore.coreHi = js::log2((o.strictHi * hint) / bpm0);
    }
    std::optional<PathOverrides> coreOverride;
    auto decode = [&](double bpmC, bool steady) -> std::vector<int> {
        PathOverrides po;
        if (hint > 0)
        {
            po = strictCore;
            po.lo = o.hintLo;
            po.hi = o.hintHi;
        }
        else if (coreOverride)
            po = *coreOverride;
        else if (useCore)
        {
            po.coreLo = o.pathCoreLo;
            po.coreHi = o.pathCoreHi;
        }
        po.endFrame = fLast;
        std::vector<double> period = steady ? std::vector<double>(static_cast<std::size_t>(n), (60 * fps) / bpmC)
                                            : tempoPath(env, fps, bpmC, o, po);
        std::vector<int> beatsF;
        const int passes = std::max(1, o.passes);
        for (int pass = 0; pass < passes; ++pass)
        {
            const DpForward dp = dpForward(score, period, steady ? o.tightness * o.steadyTightnessMult : o.tightness, steady);
            const double tauE = period[static_cast<std::size_t>(fLast)];
            const long long a = std::max<long long>(0, js::roundi(double(fLast) - 0.9 * tauE));
            const long long b = std::min<long long>(n - 1, fLast + o.refineFrames + 1);
            long long e = a;
            for (long long i = a; i <= b; ++i)
                if (dp.cum[static_cast<std::size_t>(i)] > dp.cum[static_cast<std::size_t>(e)])
                    e = i;
            beatsF = backtrace(dp.back, static_cast<int>(e));
            if (!steady && pass + 1 < o.passes && beatsF.size() >= 4)
                period = periodFromBeats(beatsF, n, o.ibiSmoothBeats, (60 * fps) / bpmC);
        }
        return beatsF;
    };

    TrackResult res;
    std::vector<int> beatsF = decode(bpm0, false);
    const double endZone = double(fLast) - (o.endBeats * 60 * fps) / bpm0;
    if (hint <= 0 && o.pathCore == DpOptions::PathCore::Auto && beatsF.size() >= 8)
    {
        const double off = offCoreFraction(beatsF, bpm0, fps, endZone, o.pathCoreLo, o.pathCoreHi);
        if (off > o.pathCoreMaxOff)
        {
            useCore = true;
            std::vector<int> alt = decode(bpm0, false);
            if (alt.size() >= 4)
            {
                res.metricLevelApplied = true;
                beatsF = std::move(alt);
            }
            else
                useCore = false;
        }
    }
    if (hint <= 0 && o.sectionCheck && !useCore && beatsF.size() >= 16)
    {
        const auto run = slowRun(beatsF, bpm0, fps, endZone, o.sectionLo);
        if (run && run->to - run->from + 1 >= o.sectionMinBeats)
        {
            const std::vector<int> seg(beatsF.begin() + run->from, beatsF.begin() + run->to + 1);
            const OctaveEvidence ev = octaveEvidence(seg, salAt);
            const double bpmRun = (60 * fps * double(seg.size() - 1)) / double(seg.back() - seg.front());
            auto lp = [&](double b) { return logPrior(b, o.octavePriorCenter, o.octavePriorSigma); };
            const double dbl = o.octaveEvidenceWeight * js::log(js::jmax(1e-3, ev.mid) / o.octaveDoubleThreshold) + lp(2 * bpmRun) - lp(bpmRun);
            if (dbl > 0)
            {
                PathOverrides co;
                co.coreLo = o.sectionCoreLo;
                co.coreHi = o.pathHi;
                coreOverride = co;
                std::vector<int> alt = decode(bpm0, false);
                coreOverride.reset();
                if (alt.size() > beatsF.size())
                {
                    res.sectionApplied = true;
                    beatsF = std::move(alt);
                }
            }
        }
    }
    const bool lowEvidence = beatContrast(beatsF, beatsF.size(), salAt) < o.steadyBelowContrast;
    if (lowEvidence)
    {
        if (hint > 0)
            bpm0 = hint;
        beatsF = decode(bpm0, true);
    }

    // octava: ¿mitad o doble?
    if (hint <= 0 && o.octaveCheck)
    {
        const OctaveEvidence ev = octaveEvidence(beatsF, salAt);
        const double bpmNow = beatsF.size() > 1
                                  ? (60 * fps * double(beatsF.size() - 1)) / double(beatsF.back() - beatsF.front())
                                  : bpm0;
        if (ev.n >= o.octaveMinBeats && beatContrast(beatsF, beatsF.size(), salAt) >= o.octaveMinContrast)
        {
            auto lp = [&](double b) { return logPrior(b, o.octavePriorCenter, o.octavePriorSigma); };
            const double k = o.octaveEvidenceWeight;
            const double halfS = bpmNow / 2 >= minBpm
                                     ? k * js::log(o.octaveHalfThreshold / js::jmax(1e-3, ev.parity)) + lp(bpmNow / 2) - lp(bpmNow)
                                     : -js::kInf;
            const double dblS = bpmNow * 2 <= maxBpm
                                    ? k * js::log(js::jmax(1e-3, ev.mid) / o.octaveDoubleThreshold) + lp(bpmNow * 2) - lp(bpmNow)
                                    : -js::kInf;
            const double mult = (halfS > 0 && halfS >= dblS) ? 0.5 : (dblS > 0 ? 2 : 1);
            if (mult != 1)
            {
                std::vector<int> alt = decode(bpm0 * mult, lowEvidence);
                if (alt.size() >= 4)
                {
                    res.octaveApplied = true;
                    beatsF = std::move(alt);
                    bpm0 *= mult;
                }
            }
        }
    }

    // recorte de beats débiles al principio
    std::vector<double> sal;
    sal.reserve(beatsF.size() + static_cast<std::size_t>(o.maxTailBeats));
    for (int f : beatsF)
        sal.push_back(salAt(f));
    const double medSal = median(sal);
    std::size_t s0 = 0;
    while (s0 + 1 < beatsF.size() && sal[s0] < o.edgeRatio * medSal)
        ++s0;
    beatsF.erase(beatsF.begin(), beatsF.begin() + static_cast<std::ptrdiff_t>(s0));
    sal.erase(sal.begin(), sal.begin() + static_cast<std::ptrdiff_t>(s0));

    // extrapolación por la cola (acorde que resuena)
    const auto noiseZone = findNoiseTail(features, endSearch);
    const double fEnd = std::floor(js::jmin(musicEnd, noiseZone ? noiseZone->coreStart : js::kInf) * fps) - f0;
    int extrapolated = 0;
    const auto& rmsV = features.rms;
    const int numFrames = features.numFrames;
    if (beatsF.size() >= 2)
    {
        auto rmsAfter = [&](long long g, double sec, double skip) {
            double m = 0;
            const long long a = g + js::roundi(skip * fps);
            for (long long k = std::max<long long>(0, a); k <= std::min<long long>(numFrames - 1, a + js::roundi(sec * fps)); ++k)
                m = js::jmax(m, rmsV[static_cast<std::size_t>(k)]);
            return m;
        };
        const double ref = rmsAfter(fLast + f0, 0.2, 0);
        const double minLevel = ref * js::pow(10, -o.tailDropDb / 20);
        const std::size_t k = std::min<std::size_t>(3, beatsF.size() - 1);
        std::vector<double> ibis;
        for (std::size_t i = beatsF.size() - k; i < beatsF.size(); ++i)
            ibis.push_back(beatsF[i] - beatsF[i - 1]);
        const double step = median(ibis);
        double t = beatsF.back() + step;
        const double cutFactor = js::pow(10, -o.tailCutDb / 20);
        auto sounding = [&](long long g) {
            const double post = rmsAfter(g, 0.1, 0.05);
            return post >= minLevel && post >= cutFactor * rmsAfter(g, 0.1, -0.15);
        };
        while (step > 0 && t + 0.5 * step <= fEnd && extrapolated < o.maxTailBeats && sounding(js::roundi(t) + f0))
        {
            beatsF.push_back(static_cast<int>(js::roundi(t)));
            sal.push_back(salAt(std::min<long long>(n - 1, js::roundi(t))));
            t += step;
            ++extrapolated;
        }
    }

    // posición fina: interpolación parabólica del pico de onset cercano
    const auto& onset = features.onset;
    auto onsetAt = [&](long long k) -> double {
        return (k >= 0 && k < static_cast<long long>(onset.size())) ? double(onset[static_cast<std::size_t>(k)]) : js::kNaN;
    };
    std::vector<double> beats;
    beats.reserve(beatsF.size());
    for (std::size_t q = 0; q < beatsF.size(); ++q)
    {
        const long long g = static_cast<long long>(beatsF[q]) + f0;
        long long p = g;
        for (long long k = std::max<long long>(0, g - R); k <= std::min<long long>(numFrames - 1, g + R); ++k)
            if (onsetAt(k) > onsetAt(p))
                p = k;
        double pos = double(g);
        if (!lowEvidence && sal[q] >= o.refineMinSal && p > 0 && p < numFrames - 1 && onsetAt(p) >= onsetAt(p - 1) &&
            onsetAt(p) >= onsetAt(p + 1))
        {
            const double y0 = onsetAt(p - 1);
            const double y1 = onsetAt(p);
            const double y2 = onsetAt(p + 1);
            const double d = y0 - 2 * y1 + y2;
            pos = double(p) + (d < 0 ? js::jmax(-0.5, js::jmin(0.5, (0.5 * (y0 - y2)) / d)) : 0.0);
        }
        beats.push_back(js::jmin(musicEnd, js::jmax(musicStart, pos / fps)));
    }
    for (std::size_t i = 1; i < beats.size(); ++i)
        if (beats[i] <= beats[i - 1])
            beats[i] = beats[i - 1] + 1e-3;
    std::vector<double> ibi;
    for (std::size_t i = 1; i < beats.size(); ++i)
        ibi.push_back(beats[i] - beats[i - 1]);
    const double bpm = !ibi.empty() ? 60 / median(ibi) : bpm0;
    if (beats.size() < 2)
        return empty(bpm0);
    res.beats = std::move(beats);
    res.bpm = bpm;
    res.strength.reserve(sal.size());
    for (double v : sal)
        res.strength.push_back(v / (v + o.strengthHalf));
    res.extrapolated = extrapolated;
    res.contrast = beatContrast(beatsF, beatsF.size() - static_cast<std::size_t>(extrapolated), salAt);
    res.confidence = js::jmin(1, js::jmax(0, js::log(res.contrast / o.confidenceLo) / js::log(o.confidenceHi / o.confidenceLo)));
    return res;
}

std::vector<double> refineBeats(const float* samples, std::size_t n, double sampleRate, const std::vector<double>& beats,
                                double musicStart, double musicEnd, double window, double maxLater)
{
    std::vector<double> src(beats);
    if (src.empty() || !samples || !n || !(sampleRate > 0))
        return src;
    const double lo = std::isfinite(musicStart) ? musicStart : 0;
    const double hi = std::isfinite(musicEnd) ? musicEnd : double(n) / sampleRate;
    RefineOptions ro;
    ro.window = window;
    const std::vector<double> ref = refineToTransients(samples, n, sampleRate, src, ro);
    std::vector<double> out(src.size());
    for (std::size_t i = 0; i < src.size(); ++i)
    {
        const double t = ref[i];
        const double v = (std::isfinite(t) && t - src[i] <= maxLater) ? t : src[i];
        out[i] = js::jmin(hi, js::jmax(lo, v));
    }
    const double MIN_GAP = 0.001;
    for (std::size_t i = 1; i < out.size(); ++i)
        if (out[i] <= out[i - 1] + MIN_GAP)
            out[i] = js::jmax(src[i], out[i - 1] + MIN_GAP);
    return out;
}

} // namespace analysis
} // namespace djec
