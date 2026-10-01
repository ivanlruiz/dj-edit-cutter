// Port de js/analysis/tempo.js.
#include "djec/analysis/tempo.h"

#include "djec/analysis/fft.h"
#include "djec/analysis/js_math.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace djec
{
namespace analysis
{
namespace
{

double lagToBpm(double lag, double fps) { return (60 * fps) / lag; }

/** Interpolación parabólica del máximo alrededor de i: {posición, valor}. */
template <typename T>
std::pair<double, double> parabolic(const std::vector<T>& arr, long long i)
{
    const long long len = static_cast<long long>(arr.size());
    if (i <= 0 || i >= len - 1)
        return {double(i), double(arr[static_cast<std::size_t>(i)])};
    const double a = arr[static_cast<std::size_t>(i - 1)];
    const double b = arr[static_cast<std::size_t>(i)];
    const double c = arr[static_cast<std::size_t>(i + 1)];
    const double d = a - 2 * b + c;
    if (d >= 0)
        return {double(i), b};
    const double p = (0.5 * (a - c)) / d;
    return {double(i) + p, b - 0.25 * (a - c) * p};
}

double acfAt(const std::vector<float>& acf, double lag)
{
    const double fi = std::floor(lag);
    if (fi < 0 || fi + 1 >= double(acf.size()))
        return 0;
    const std::size_t i = static_cast<std::size_t>(fi);
    const double f = lag - fi;
    return double(acf[i]) * (1 - f) + double(acf[i + 1]) * f;
}

double salience(const std::vector<float>& acf, double lag, double w2, double w4)
{
    return acfAt(acf, lag) + w2 * acfAt(acf, 2 * lag) + w4 * acfAt(acf, 4 * lag);
}

double logPriorGauss(double bpm, double center, double sigma)
{
    const double x = js::log2(bpm / center) / sigma;
    return js::exp(-0.5 * x * x);
}

double round2(double x) { return js::round(x * 100) / 100; }

/** Afinado del periodo con los picos de la ACF en 1×, 2× y 4× el retardo. */
double refineLag(const std::vector<float>& acf, double lag)
{
    std::vector<std::pair<double, double>> est;
    const long long len = static_cast<long long>(acf.size());
    for (int m : {1, 2, 4})
    {
        const double target = lag * m;
        const long long i = js::roundi(target);
        if (i + 2 >= len)
            break;
        const long long r = std::max<long long>(1, js::roundi(target * 0.04));
        long long bi = i;
        for (long long k = std::max<long long>(1, i - r); k <= std::min<long long>(len - 2, i + r); ++k)
            if (acf[static_cast<std::size_t>(k)] > acf[static_cast<std::size_t>(bi)])
                bi = k;
        const auto pv = parabolic(acf, bi);
        if (pv.second > 0)
            est.emplace_back(pv.first / m, pv.second * m);
    }
    if (est.empty())
        return lag;
    double s = 0;
    double w = 0;
    for (const auto& e : est)
    {
        s += e.first * e.second;
        w += e.second;
    }
    return s / w;
}

/** Tempo local por ventana con Viterbi cerca del periodo global; interpolado a cada trama. */
std::vector<float> localTempo(const Tempogram& tg, double fps, double lagGlobal, int numFrames, const TempoOptions& o)
{
    const auto& rows = tg.rows;
    const int nW = static_cast<int>(rows.size());
    std::vector<float> out(static_cast<std::size_t>(numFrames), 0.0f);
    const long long lagMin = std::max<long long>(2, js::floori(lagGlobal * js::pow(2, -o.localRange)));
    const long long lagMax = std::min<long long>(tg.maxLag - 1, js::ceili(lagGlobal * js::pow(2, o.localRange)));
    if (nW == 0 || lagMax <= lagMin)
    {
        std::fill(out.begin(), out.end(), static_cast<float>(lagToBpm(lagGlobal, fps)));
        return out;
    }
    const int nS = static_cast<int>(lagMax - lagMin + 1);
    std::vector<double> logLag(static_cast<std::size_t>(nS));
    for (int s = 0; s < nS; ++s)
        logLag[static_cast<std::size_t>(s)] = js::log2(double(lagMin + s));
    std::vector<double> score(static_cast<std::size_t>(nS), 0.0), prev(static_cast<std::size_t>(nS), 0.0);
    std::vector<std::vector<int>> back(static_cast<std::size_t>(nW), std::vector<int>(static_cast<std::size_t>(nS), 0));
    auto obs = [&tg](const std::vector<float>& row, long long lag) -> double {
        if (row[0] <= 0)
            return 0;
        const double v = double(row[static_cast<std::size_t>(lag)]) +
                         0.5 * (2 * lag <= tg.maxLag ? double(row[static_cast<std::size_t>(2 * lag)]) : 0.0);
        return js::jmax(0, v);
    };
    const double lg0 = js::log2(lagGlobal);
    for (int s = 0; s < nS; ++s)
        prev[static_cast<std::size_t>(s)] = obs(rows[0], lagMin + s) - 2 * std::fabs(logLag[static_cast<std::size_t>(s)] - lg0);
    for (int w = 1; w < nW; ++w)
    {
        for (int s = 0; s < nS; ++s)
        {
            double bestV = -js::kInf;
            int bestK = s;
            const int kr = static_cast<int>(std::max<long long>(1, js::roundi(double(lagMin + s) * 0.08)));
            for (int k = std::max(0, s - kr); k <= std::min(nS - 1, s + kr); ++k)
            {
                const double v = prev[static_cast<std::size_t>(k)] -
                                 o.localPenalty * std::fabs(logLag[static_cast<std::size_t>(s)] - logLag[static_cast<std::size_t>(k)]);
                if (v > bestV)
                {
                    bestV = v;
                    bestK = k;
                }
            }
            score[static_cast<std::size_t>(s)] = bestV + obs(rows[static_cast<std::size_t>(w)], lagMin + s) -
                                                 0.3 * std::fabs(logLag[static_cast<std::size_t>(s)] - lg0);
            back[static_cast<std::size_t>(w)][static_cast<std::size_t>(s)] = bestK;
        }
        prev = score;
    }
    int s = 0;
    for (int k = 1; k < nS; ++k)
        if (prev[static_cast<std::size_t>(k)] > prev[static_cast<std::size_t>(s)])
            s = k;
    std::vector<double> path(static_cast<std::size_t>(nW));
    for (int w = nW - 1; w >= 0; --w)
    {
        path[static_cast<std::size_t>(w)] = double(lagMin + s);
        if (w > 0)
            s = back[static_cast<std::size_t>(w)][static_cast<std::size_t>(s)];
    }
    std::vector<double> bpmW(static_cast<std::size_t>(nW));
    for (int w = 0; w < nW; ++w)
    {
        const auto& row = rows[static_cast<std::size_t>(w)];
        const double l = path[static_cast<std::size_t>(w)];
        const double p = row[0] > 0 ? parabolic(row, static_cast<long long>(l)).first : l;
        bpmW[static_cast<std::size_t>(w)] = lagToBpm(std::fabs(p - l) <= 1 ? p : l, fps);
    }
    std::vector<double> sm(static_cast<std::size_t>(nW));
    for (int w = 0; w < nW; ++w)
    {
        const double a = bpmW[static_cast<std::size_t>(std::max(0, w - 1))];
        const double b = bpmW[static_cast<std::size_t>(w)];
        const double c = bpmW[static_cast<std::size_t>(std::min(nW - 1, w + 1))];
        sm[static_cast<std::size_t>(w)] = js::jmax(js::jmin(a, b), js::jmin(js::jmax(a, b), c));
    }
    const auto& centers = tg.centers;
    int w = 0;
    for (int i = 0; i < numFrames; ++i)
    {
        while (w + 1 < nW && centers[static_cast<std::size_t>(w + 1)] <= i)
            ++w;
        float v;
        if (i <= centers[0])
            v = static_cast<float>(sm[0]);
        else if (w + 1 >= nW)
            v = static_cast<float>(sm[static_cast<std::size_t>(nW - 1)]);
        else
        {
            const double f = (i - centers[static_cast<std::size_t>(w)]) /
                             (centers[static_cast<std::size_t>(w + 1)] - centers[static_cast<std::size_t>(w)]);
            v = static_cast<float>(sm[static_cast<std::size_t>(w)] * (1 - f) + sm[static_cast<std::size_t>(w + 1)] * f);
        }
        out[static_cast<std::size_t>(i)] = v;
    }
    return out;
}

} // namespace

std::vector<float> periodicityEnvelope(const Features& f, double smoothSec)
{
    const auto& onset = f.onset;
    const auto& onsetLow = f.onsetLow;
    const int n = static_cast<int>(onset.size());
    std::vector<float> e(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
        e[static_cast<std::size_t>(i)] = static_cast<float>(
            double(onset[static_cast<std::size_t>(i)]) + 0.5 * (onsetLow.empty() ? 0.0 : double(onsetLow[static_cast<std::size_t>(i)])));
    const int w = static_cast<int>(std::max<long long>(1, js::roundi((smoothSec * f.fps) / 2)));
    std::vector<double> cs(static_cast<std::size_t>(n) + 1, 0.0);
    for (int i = 0; i < n; ++i)
        cs[static_cast<std::size_t>(i) + 1] = cs[static_cast<std::size_t>(i)] + e[static_cast<std::size_t>(i)];
    std::vector<float> out(static_cast<std::size_t>(n), 0.0f);
    for (int i = 0; i < n; ++i)
    {
        const int a = std::max(0, i - w);
        const int b = std::min(n - 1, i + w);
        const double m = (cs[static_cast<std::size_t>(b) + 1] - cs[static_cast<std::size_t>(a)]) / (b - a + 1);
        const double v = e[static_cast<std::size_t>(i)] - m;
        out[static_cast<std::size_t>(i)] = v > 0 ? static_cast<float>(v) : 0.0f;
    }
    return out;
}

Tempogram tempogram(const std::vector<float>& env, double fps, double windowSec, double hopSec, int maxLag, double maxSpecHz)
{
    const long long n = static_cast<long long>(env.size());
    const long long W = std::min<long long>(n, std::max<long long>(16, js::roundi(windowSec * fps)));
    const long long H = std::max<long long>(1, js::roundi(hopSec * fps));
    const std::size_t size = nextPow2(static_cast<std::size_t>(2 * W));
    ComplexFFT fft(size);
    std::vector<double> re(size), im(size);
    const long long L = std::min<long long>(maxLag, W - 1);
    Tempogram tg;
    const long long nSpec = std::min<long long>(static_cast<long long>(size / 2), js::ceili((maxSpecHz * double(size)) / fps) + 2);
    double totalE = 0;
    for (long long i = 0; i < n; ++i)
        totalE += double(env[static_cast<std::size_t>(i)]) * double(env[static_cast<std::size_t>(i)]);
    const double meanE = totalE / double(std::max<long long>(1, n));
    for (long long s = 0;; s += H)
    {
        const long long start = std::min<long long>(s, std::max<long long>(0, n - W));
        std::fill(re.begin(), re.end(), 0.0);
        std::fill(im.begin(), im.end(), 0.0);
        double e0 = 0;
        for (long long i = 0; i < W && start + i < n; ++i)
        {
            const double v = env[static_cast<std::size_t>(start + i)];
            re[static_cast<std::size_t>(i)] = v;
            e0 += v * v;
        }
        std::vector<float> row(static_cast<std::size_t>(L + 1), 0.0f);
        std::vector<float> spec(static_cast<std::size_t>(std::max<long long>(0, nSpec)), 0.0f);
        if (e0 > 1e-3 * meanE * double(W) && e0 > 0)
        {
            fft.transform(re.data(), im.data(), false);
            for (std::size_t k = 0; k < size; ++k)
            {
                re[k] = re[k] * re[k] + im[k] * im[k];
                im[k] = 0;
            }
            for (long long k = 0; k < nSpec; ++k)
                spec[static_cast<std::size_t>(k)] = static_cast<float>(js::sqrt(re[static_cast<std::size_t>(k)] / e0));
            fft.transform(re.data(), im.data(), true);
            const double r0 = re[0];
            for (long long l = 0; l <= L; ++l)
                row[static_cast<std::size_t>(l)] =
                    static_cast<float>((re[static_cast<std::size_t>(l)] / r0) * (double(W) / double(W - l)));
        }
        tg.rows.push_back(std::move(row));
        tg.specs.push_back(std::move(spec));
        tg.centers.push_back(double(start) + double(W) / 2);
        if (start + W >= n)
            break;
    }
    tg.specSize = size;
    tg.maxLag = static_cast<int>(L);
    tg.window = static_cast<int>(W);
    return tg;
}

TempoEstimate estimateTempo(const Features& features, const TempoOptions& o)
{
    const double fps = features.fps;
    double minBpm = o.minBpm;
    double maxBpm = o.maxBpm;
    const double hint = o.bpmHint > 0 ? o.bpmHint : 0;
    if (hint > 0 && o.strict)
    {
        minBpm = js::jmax(20, hint * o.strictLo);
        maxBpm = js::jmin(400, hint * o.strictHi);
    }
    const std::vector<float> env = periodicityEnvelope(features);
    const long long minLag = std::max<long long>(2, js::floori((60 * fps) / maxBpm));
    const long long maxLagSearch = js::ceili((60 * fps) / minBpm);
    const long long acfMaxLag = js::ceili(double(maxLagSearch) * 4 + 2);
    const Tempogram tg = tempogram(env, fps, js::jmax(o.windowSec, (double(acfMaxLag) / fps) * 1.25), o.hopSec,
                                   static_cast<int>(acfMaxLag));
    const int L = tg.maxLag;
    TempoEstimate out;
    out.globalAcf.assign(static_cast<std::size_t>(L) + 1, 0.0f);
    int nRows = 0;
    for (const auto& row : tg.rows)
    {
        if (row[0] <= 0)
            continue;
        ++nRows;
        for (int l = 0; l <= L; ++l)
            out.globalAcf[static_cast<std::size_t>(l)] += row[static_cast<std::size_t>(l)];
    }
    if (nRows)
        for (int l = 0; l <= L; ++l)
            out.globalAcf[static_cast<std::size_t>(l)] = static_cast<float>(double(out.globalAcf[static_cast<std::size_t>(l)]) / nRows);
    const std::size_t nSpec = tg.specs.empty() ? 0 : tg.specs[0].size();
    out.globalDft.assign(nSpec, 0.0f);
    for (std::size_t w = 0; w < tg.rows.size(); ++w)
    {
        if (tg.rows[w][0] <= 0)
            continue;
        for (std::size_t k = 0; k < nSpec; ++k)
            out.globalDft[k] += tg.specs[w][k];
    }
    if (nRows)
        for (std::size_t k = 0; k < nSpec; ++k)
            out.globalDft[k] = static_cast<float>(double(out.globalDft[k]) / nRows);
    const auto& globalAcf = out.globalAcf;
    const auto& globalDft = out.globalDft;
    auto dftAt = [&](double lag) -> double {
        const double x = double(tg.specSize) / lag;
        const double fi = std::floor(x);
        if (fi + 1 >= double(nSpec))
            return 0;
        const std::size_t i = static_cast<std::size_t>(fi);
        const double f = x - fi;
        return double(globalDft[i]) * (1 - f) + double(globalDft[i + 1]) * f;
    };

    std::vector<float> sal(static_cast<std::size_t>(maxLagSearch + 2), 0.0f);
    for (long long lag = minLag; lag <= std::min<long long>(maxLagSearch + 1, L); ++lag)
    {
        const double bpm = lagToBpm(double(lag), fps);
        const double prior = (hint > 0 && !o.strict) ? logPriorGauss(bpm, hint, 0.5) : logPriorGauss(bpm, o.priorCenter, o.priorSigma);
        const double a = js::jmax(0, salience(globalAcf, double(lag), o.w2, o.w4));
        sal[static_cast<std::size_t>(lag)] = static_cast<float>((o.hybrid ? a * js::pow(dftAt(double(lag)), o.dftPower) : a) * prior);
    }
    struct Cand
    {
        double lag, bpm, score;
    };
    std::vector<Cand> cands;
    for (long long lag = std::max<long long>(minLag, 1); lag <= std::min<long long>(maxLagSearch, static_cast<long long>(sal.size()) - 2); ++lag)
    {
        const float sv = sal[static_cast<std::size_t>(lag)];
        if (sv > 0 && sv >= sal[static_cast<std::size_t>(lag - 1)] && sv >= sal[static_cast<std::size_t>(lag + 1)])
        {
            const auto pv = parabolic(sal, lag);
            const double bpm = lagToBpm(pv.first, fps);
            if (bpm >= minBpm * 0.98 && bpm <= maxBpm * 1.02)
                cands.push_back({pv.first, bpm, pv.second});
        }
    }
    out.lagMin = static_cast<int>(minLag);
    out.lagMax = static_cast<int>(maxLagSearch);
    if (cands.empty())
    {
        const double bpm = hint > 0 ? hint : o.priorCenter;
        out.bpm = bpm;
        out.candidates = {{bpm, 0}};
        out.localBpm.assign(static_cast<std::size_t>(features.numFrames), static_cast<float>(bpm));
        return out;
    }
    std::stable_sort(cands.begin(), cands.end(), [](const Cand& a, const Cand& b) { return a.score > b.score; });
    const double top = (cands[0].score != 0 && !std::isnan(cands[0].score)) ? cands[0].score : 1; // score || 1
    const double lagBest = refineLag(globalAcf, cands[0].lag);
    out.bpm = lagToBpm(lagBest, fps);
    for (const auto& c : cands)
    {
        const double b = round2(lagToBpm(refineLag(globalAcf, c.lag), fps));
        bool dup = false;
        for (const auto& x : out.candidates)
            if (std::fabs(x.bpm / b - 1) < 0.02)
            {
                dup = true;
                break;
            }
        if (dup)
            continue;
        out.candidates.push_back({b, c.score / top});
        if (out.candidates.size() >= 8)
            break;
    }
    if (o.computeLocal)
        out.localBpm = localTempo(tg, fps, lagBest, features.numFrames, o);
    return out;
}

} // namespace analysis
} // namespace djec
