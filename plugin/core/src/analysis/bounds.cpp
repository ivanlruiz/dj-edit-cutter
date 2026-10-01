// Port de js/analysis/bounds.js.
#include "djec/analysis/bounds.h"

#include "djec/analysis/js_math.h"

#include <algorithm>
#include <cmath>
#include <unordered_map>

namespace djec
{
namespace analysis
{
namespace
{

struct WindowRms
{
    std::vector<float> rms;
    long long win = 1, hop = 1;
};

/** RMS sin componente continua en ventanas de windowSec (salto hopSec). */
WindowRms windowRms(const float* samples, std::size_t nSamples, double sampleRate, double windowSec, double hopSec)
{
    WindowRms r;
    r.win = std::max<long long>(1, js::roundi(windowSec * sampleRate));
    r.hop = std::max<long long>(1, js::roundi(hopSec * sampleRate));
    const long long n = static_cast<long long>(nSamples);
    const long long nW = std::max<long long>(1, std::max<long long>(0, n - r.win) / r.hop + 1);
    r.rms.assign(static_cast<std::size_t>(nW), 0.0f);
    for (long long w = 0; w < nW; ++w)
    {
        const long long o = w * r.hop;
        const long long end = std::min(n, o + r.win);
        double s = 0;
        double s2 = 0;
        for (long long i = o; i < end; ++i)
        {
            const double v = samples[i];
            s += v;
            s2 += v * v;
        }
        const long long cnt = end - o;
        r.rms[static_cast<std::size_t>(w)] =
            cnt > 0 ? static_cast<float>(js::sqrt(js::jmax(0, s2 - (s * s) / double(cnt)) / double(r.win))) : 0.0f;
    }
    return r;
}

/** Mediana "alta" de un tramo de floats (Float32Array.from(arr).sort()[len >> 1]); 0 si está vacío. */
float upperMedianF(const float* a, std::size_t n)
{
    if (!n)
        return 0;
    std::vector<float> s(a, a + n);
    std::sort(s.begin(), s.end());
    return s[n >> 1];
}

/** medianOf de findNoiseTail: orden numérico, elemento len >> 1; 0 si está vacío. */
double upperMedianD(std::vector<double> a)
{
    if (a.empty())
        return 0;
    std::sort(a.begin(), a.end());
    return a[a.size() >> 1];
}

/** Máximo de la ACF normalizada (sin media) de env alrededor de c para retardos de lagLo a lagHi s. */
double periodicityAt(const std::vector<float>& env, double fps, long long c, double win, double lagLo = 0.25, double lagHi = 1.5)
{
    const long long len = static_cast<long long>(env.size());
    const long long a = std::max<long long>(0, js::roundi(double(c) - (win * fps) / 2));
    const long long b = std::min<long long>(len, js::roundi(double(c) + (win * fps) / 2));
    const long long n = b - a;
    if (n < 20)
        return 0;
    double m = 0;
    for (long long i = a; i < b; ++i)
        m += env[static_cast<std::size_t>(i)];
    m /= double(n);
    double r0 = 0;
    for (long long i = a; i < b; ++i)
        r0 += (double(env[static_cast<std::size_t>(i)]) - m) * (double(env[static_cast<std::size_t>(i)]) - m);
    if (!(r0 > 0))
        return 0;
    double best = 0;
    const long long Lhi = std::min<long long>(n - 10, js::roundi(lagHi * fps));
    for (long long L = js::roundi(lagLo * fps); L <= Lhi; ++L)
    {
        double s = 0;
        for (long long i = a; i + L < b; ++i)
            s += (double(env[static_cast<std::size_t>(i)]) - m) * (double(env[static_cast<std::size_t>(i + L)]) - m);
        const double v = ((s / r0) * double(n)) / double(n - L);
        if (v > best)
            best = v;
    }
    return best;
}

} // namespace

MusicBounds findMusicBounds(const float* samples, std::size_t nSamples, double sampleRate, const BoundsOptions& o)
{
    const WindowRms wr = windowRms(samples, nSamples, sampleRate, o.windowSec, o.hopSec);
    const auto& rms = wr.rms;
    const long long nW = static_cast<long long>(rms.size());
    double peak = 0;
    for (float v : rms)
        if (v > peak)
            peak = v;
    MusicBounds out;
    out.thresholdDb = o.thresholdDb;
    if (peak <= 1e-9)
    {
        out.noiseFloorDb = -js::kInf;
        return out;
    }
    const long long edge = std::max<long long>(1, js::roundi(0.3 / o.hopSec));
    const double head = upperMedianF(rms.data(), static_cast<std::size_t>(std::min(nW, edge)));
    const long long tailFrom = std::max<long long>(0, nW - edge);
    const double tail = upperMedianF(rms.data() + tailFrom, static_cast<std::size_t>(nW - tailFrom));
    const double floor = js::jmin(head, tail);
    const double floorDb = floor > 0 ? 20 * js::log10(floor / peak) : -js::kInf;
    const double thDb = js::jmin(o.maxThresholdDb, js::jmax(o.thresholdDb, floorDb + o.noiseMarginDb));
    const double th = peak * js::pow(10, thDb / 20);
    const long long need = std::max<long long>(1, js::roundi(o.minActiveSec / o.hopSec));
    const long long span = need + 2;
    auto active = [&](long long w, int dir) {
        long long c = 0;
        for (long long k = 0; k < span; ++k)
        {
            const long long j = w + dir * k;
            if (j < 0 || j >= nW)
                break;
            if (rms[static_cast<std::size_t>(j)] >= th)
                ++c;
        }
        return c >= std::min(need, nW);
    };
    out.thresholdDb = thDb;
    out.noiseFloorDb = floorDb;
    out.peakRms = peak;
    long long a = -1;
    for (long long w = 0; w < nW; ++w)
        if (rms[static_cast<std::size_t>(w)] >= th && active(w, 1))
        {
            a = w;
            break;
        }
    if (a < 0)
        return out;
    long long b = a;
    for (long long w = nW - 1; w >= a; --w)
        if (rms[static_cast<std::size_t>(w)] >= th && active(w, -1))
        {
            b = w;
            break;
        }
    out.musicStart = double(a * wr.hop) / sampleRate;
    out.musicEnd = double(std::min<long long>(static_cast<long long>(nSamples), b * wr.hop + wr.win)) / sampleRate;
    return out;
}

std::optional<NoiseTail> findNoiseTail(const Features& features, double musicEnd, const NoiseTailOptions& o,
                                       const std::vector<int>* peaks)
{
    const auto& onset = features.onset;
    const auto& onsetLow = features.onsetLow;
    const auto& flatness = features.flatness;
    const auto& rms = features.rms;
    const double fps = features.fps;
    const int numFrames = features.numFrames;
    if (flatness.empty() || onset.empty() || !(fps > 0))
        return std::nullopt;
    const long long endFrame = std::min<long long>(numFrames - 1, js::floori((musicEnd + 0.02) * fps));
    std::vector<int> own;
    if (!peaks)
    {
        for (int i : pickPeaks(onset, fps, LastOnsetOptions::lastOnsetPick()))
            if (i <= endFrame)
                own.push_back(i);
        peaks = &own;
    }
    const std::vector<int>& pk = *peaks;
    if (pk.size() < 8)
        return std::nullopt;
    std::vector<float> env(static_cast<std::size_t>(numFrames));
    for (int i = 0; i < numFrames; ++i)
        env[static_cast<std::size_t>(i)] = static_cast<float>(
            double(onset[static_cast<std::size_t>(i)]) + 0.5 * (onsetLow.empty() ? 0.0 : double(onsetLow[static_cast<std::size_t>(i)])));
    // primer índice de pk con trama >= f
    auto lower = [&pk](double f) -> long long {
        std::size_t lo = 0;
        std::size_t hi = pk.size();
        while (lo < hi)
        {
            const std::size_t mid = (lo + hi) >> 1;
            if (pk[mid] < f)
                lo = mid + 1;
            else
                hi = mid;
        }
        return static_cast<long long>(lo);
    };
    const long long fh = js::roundi(o.flatHalf * fps);
    const double dh = o.densHalf * fps;
    constexpr int DENSE = 1;
    constexpr int FLAT = 2;
    constexpr int SOFT = 4;
    std::unordered_map<long long, int> memo;
    auto markAt = [&](long long c) -> int {
        const bool dense = double(lower(double(c) + dh + 1e-9) - lower(double(c) - dh)) / (2 * o.densHalf) >= o.minDensity;
        double s = 0;
        long long n = 0;
        for (long long i = std::max<long long>(0, c - fh); i <= std::min<long long>(numFrames - 1, c + fh); ++i)
        {
            s += flatness[static_cast<std::size_t>(i)];
            ++n;
        }
        const double fm = n > 0 ? s / double(n) : 0;
        const bool flat = fm >= o.minFlatness;
        const bool soft = fm >= js::jmin(o.minFlatness, o.extendFlatness);
        if (!dense && !soft)
            return 0;
        if (periodicityAt(env, fps, c, o.periodWin) >= o.maxPeriodicity)
            return 0;
        return (dense ? DENSE : 0) | (flat ? FLAT : 0) | (soft ? SOFT : 0);
    };
    auto mark = [&](double t) -> int {
        const long long c = js::roundi(t * fps);
        auto it = memo.find(c);
        if (it != memo.end())
            return it->second;
        const int m = markAt(c);
        memo.emplace(c, m);
        return m;
    };
    auto noise = [&](double t) { return (mark(t) & (DENSE | FLAT)) == (DENSE | FLAT); };
    const double lastPeak = pk.back() / fps;
    double end = -1;
    for (double t = lastPeak; t >= js::jmax(0, lastPeak - o.tailSlack); t -= o.step)
        if (noise(t))
        {
            end = t;
            break;
        }
    if (end < 0)
        return std::nullopt;
    double core = end;
    for (double t = end - o.step; t >= 0; t -= o.step)
    {
        if (noise(t))
            core = t;
        else if (core - t > o.maxGap)
            break;
    }
    double dense = core;
    while (dense - o.step >= 0 && (mark(dense - o.step) & DENSE))
        dense -= o.step;
    if (end - core < o.minRun && end - dense < o.minTotal)
        return std::nullopt;
    double coreLevel = 0;
    if (!rms.empty())
    {
        const long long a = js::roundi(core * fps);
        const long long b = std::min<long long>(numFrames, js::roundi(end * fps) + 1);
        std::vector<double> part;
        for (long long i = std::max<long long>(0, a); i < b; ++i)
            part.push_back(rms[static_cast<std::size_t>(i)]);
        coreLevel = upperMedianD(std::move(part));
    }
    if (std::isfinite(o.maxLevelDb) && !rms.empty())
    {
        double mx = 0;
        for (int i = 0; i < numFrames; ++i)
            if (rms[static_cast<std::size_t>(i)] > mx)
                mx = rms[static_cast<std::size_t>(i)];
        std::vector<double> before;
        const long long lim = std::min<long long>(numFrames, js::roundi(core * fps));
        for (long long i = 0; i < lim; ++i)
            if (rms[static_cast<std::size_t>(i)] > mx * 1e-3)
                before.push_back(rms[static_cast<std::size_t>(i)]);
        if (!before.empty() && coreLevel > 0 && 20 * js::log10(coreLevel / upperMedianD(before)) > o.maxLevelDb)
            return std::nullopt;
    }
    const double minLevel = coreLevel * js::pow(10, -o.extendDropDb / 20);
    auto loud = [&](double t) {
        if (rms.empty())
            return true;
        const long long c = js::roundi(t * fps);
        double m = 0;
        for (long long i = std::max<long long>(0, c - fh); i <= std::min<long long>(numFrames - 1, c + fh); ++i)
            m = js::jmax(m, rms[static_cast<std::size_t>(i)]);
        return m >= minLevel;
    };
    double start = core;
    if (o.weakExtend)
    {
        for (double t = core - o.step; t >= js::jmax(0, core - o.maxExtend); t -= o.step)
        {
            if (!loud(t))
                break;
            if (mark(t))
                start = t;
            else if (start - t > o.maxGap)
                break;
        }
    }
    std::vector<double> h;
    for (long long k = lower(double(js::roundi(js::jmin(core, dense) * fps))); k < static_cast<long long>(pk.size()); ++k)
        h.push_back(onset[static_cast<std::size_t>(pk[static_cast<std::size_t>(k)])]);
    if (h.size() < 4)
        return std::nullopt;
    std::sort(h.begin(), h.end());
    const double peakRef = h[static_cast<std::size_t>(js::floori(0.75 * double(h.size() - 1)))];
    return NoiseTail{js::jmax(0, start - o.margin), core, end, peakRef, o.outstanding * peakRef};
}

double findLastOnset(const Features& features, double musicEnd, const LastOnsetOptions& o)
{
    const auto& onset = features.onset;
    const auto& rms = features.rms;
    const double fps = features.fps;
    const int numFrames = features.numFrames;
    const std::vector<float>* high = features.rmsHigh.empty() ? nullptr : &features.rmsHigh;
    const long long endFrame = std::min<long long>(numFrames - 1, js::floori((musicEnd + 0.02) * fps));
    std::vector<int> peaks;
    for (int i : pickPeaks(onset, fps, o.pick))
        if (i <= endFrame)
            peaks.push_back(i);
    if (peaks.empty())
        return js::jmax(0, musicEnd);
    std::optional<NoiseTail> zone;
    if (o.useNoise)
        zone = findNoiseTail(features, musicEnd, o.noise, &peaks);
    const double zoneFrom = zone ? std::ceil(zone->start * fps) : js::kInf;
    const double zoneMin = zone ? zone->minHeight : 0;
    std::vector<double> heights;
    heights.reserve(peaks.size());
    for (int i : peaks)
        heights.push_back(onset[static_cast<std::size_t>(i)]);
    std::sort(heights.begin(), heights.end());
    const double p75 = heights[static_cast<std::size_t>(js::floori(0.75 * double(heights.size() - 1)))];
    double maxRms = 0;
    for (int i = 0; i < numFrames; ++i)
        if (rms[static_cast<std::size_t>(i)] > maxRms)
            maxRms = rms[static_cast<std::size_t>(i)];
    const double levelTh = maxRms * js::pow(10, o.minLevelDb / 20);
    const double strongLevelTh = maxRms * js::pow(10, o.strongLevelDb / 20);
    const long long after = std::max<long long>(1, js::roundi(0.08 * fps));
    const long long before = std::max<long long>(1, js::roundi(0.04 * fps));
    const double riseFactor = js::pow(10, o.minRiseDb / 20);
    const double highRiseFactor = js::pow(10, o.minHighRiseDb / 20);
    const long long ctxFrames = js::roundi(o.contrastSec * fps);
    const long long gapFrames = std::max<long long>(1, js::roundi(0.05 * fps));
    const long long contextFrames = js::roundi(o.contextSec * fps);
    auto postMax = [&](const std::vector<float>& env, long long i) {
        double m = 0;
        for (long long j = i; j <= std::min<long long>(numFrames - 1, i + after); ++j)
            if (env[static_cast<std::size_t>(j)] > m)
                m = env[static_cast<std::size_t>(j)];
        return m;
    };
    for (long long k = static_cast<long long>(peaks.size()) - 1; k >= 0; --k)
    {
        const long long i = peaks[static_cast<std::size_t>(k)];
        const double oi = onset[static_cast<std::size_t>(i)];
        if (double(i) >= zoneFrom && oi < zoneMin)
            continue;
        if (oi < o.relHeight * p75)
            continue;
        const double post = postMax(rms, i);
        if (post < levelTh)
            continue;
        const long long c0 = std::max<long long>(0, i - ctxFrames);
        const long long c1 = std::max<long long>(c0 + 1, i - gapFrames);
        double m = 0;
        for (long long j = c0; j < c1; ++j)
            m += onset[static_cast<std::size_t>(j)];
        m /= double(c1 - c0);
        const double contrast = m > 0 ? oi / m : js::kInf;
        if (contrast < o.minContrast)
            continue;
        double ctxMax = 0;
        for (long long j = std::max<long long>(0, i - contextFrames); j < i - gapFrames; ++j)
            if (onset[static_cast<std::size_t>(j)] > ctxMax)
                ctxMax = onset[static_cast<std::size_t>(j)];
        if (oi < o.minContextRel * ctxMax)
            continue;
        const double pre = rms[static_cast<std::size_t>(std::max<long long>(0, i - before))];
        bool attack = post >= pre * riseFactor;
        if (!attack && high && contrast >= o.highRiseContrast)
            attack = postMax(*high, i) >= double((*high)[static_cast<std::size_t>(std::max<long long>(0, i - before))]) * highRiseFactor;
        if (!attack && contrast >= o.strongContrast && post >= strongLevelTh)
            attack = oi >= o.strongRel * ctxMax;
        if (attack)
            return double(i) / fps;
    }
    return js::jmax(0, musicEnd);
}

std::vector<double> refineToTransients(const float* samples, std::size_t nSamples, double sampleRate,
                                       const std::vector<double>& times, const RefineOptions& o)
{
    const long long B = std::max<long long>(1, js::roundi(o.blockSec * sampleRate));
    const long long n = static_cast<long long>(nSamples);
    std::vector<double> out(times);
    const int preBlocks = o.preBlocks;
    const int postBlocks = o.postBlocks;
    const double pe = o.preEmphasis;
    std::vector<double> L, S;
    struct Cand
    {
        double time, rise;
    };
    std::vector<Cand> cands;
    for (std::size_t q = 0; q < times.size(); ++q)
    {
        const double t = times[q];
        if (!std::isfinite(t))
            continue;
        const long long s0 = std::max<long long>(1, js::floori((t - o.window) * sampleRate) - (preBlocks + 2) * B);
        const long long s1 = std::min<long long>(n, js::ceili((t + o.window) * sampleRate) + (postBlocks + 2) * B);
        const long long nb = js::floori(double(s1 - s0) / double(B));
        if (nb < preBlocks + postBlocks + 2)
            continue;
        L.assign(static_cast<std::size_t>(nb), 0.0);
        double maxE = 0;
        for (long long b = 0; b < nb; ++b)
        {
            double e = 0;
            const long long o0 = s0 + b * B;
            for (long long i = o0; i < o0 + B; ++i)
            {
                const double d = double(samples[i]) - pe * double(samples[i - 1]);
                e += d * d;
            }
            L[static_cast<std::size_t>(b)] = e;
            if (e > maxE)
                maxE = e;
        }
        if (maxE <= 0)
            continue;
        const double floor = maxE * 1e-9;
        if (o.smoothBlocks > 1)
        {
            S.assign(static_cast<std::size_t>(nb), 0.0);
            const long long h = o.smoothBlocks;
            for (long long b = 0; b < nb; ++b)
            {
                double acc = 0;
                long long c = 0;
                for (long long k = b; k < std::min(nb, b + h); ++k)
                {
                    acc += L[static_cast<std::size_t>(k)];
                    ++c;
                }
                S[static_cast<std::size_t>(b)] = acc / double(c);
            }
            L = S;
            maxE = 0;
            for (long long b = 0; b < nb; ++b)
                if (L[static_cast<std::size_t>(b)] > maxE)
                    maxE = L[static_cast<std::size_t>(b)];
        }
        for (long long b = 0; b < nb; ++b)
            L[static_cast<std::size_t>(b)] = 10 * js::log10(L[static_cast<std::size_t>(b)] + floor);
        const double Lmax = 10 * js::log10(maxE + floor);
        cands.clear();
        double bestRise = 0;
        const long long bLo = preBlocks;
        const long long bHi = nb - postBlocks - 1;
        for (long long b = bLo; b <= bHi; ++b)
        {
            double mn = js::kInf;
            for (long long k = b - preBlocks; k < b; ++k)
                if (L[static_cast<std::size_t>(k)] < mn)
                    mn = L[static_cast<std::size_t>(k)];
            double mx = -js::kInf;
            for (long long k = b; k <= b + postBlocks; ++k)
                if (L[static_cast<std::size_t>(k)] > mx)
                    mx = L[static_cast<std::size_t>(k)];
            const double rise = mx - mn;
            if (rise < o.minRiseDb || mx < Lmax - o.maxBelowPeakDb)
                continue;
            long long m = b;
            for (long long k = b; k <= b + postBlocks; ++k)
                if (L[static_cast<std::size_t>(k)] > L[static_cast<std::size_t>(m)])
                    m = k;
            long long st = m;
            while (st - 1 >= b - preBlocks && L[static_cast<std::size_t>(st - 1)] >= mn + 3)
                --st;
            const double time = double(s0 + st * B) / sampleRate;
            if (std::fabs(time - t) > o.window)
                continue;
            cands.push_back({time, rise});
            if (rise > bestRise)
                bestRise = rise;
        }
        if (cands.empty())
            continue;
        const Cand* best = nullptr;
        for (const auto& c : cands)
        {
            if (c.rise < o.relRise * bestRise)
                continue;
            if (!best || std::fabs(c.time - t) < std::fabs(best->time - t))
                best = &c;
        }
        if (best)
            out[q] = best->time;
    }
    return out;
}

} // namespace analysis
} // namespace djec
