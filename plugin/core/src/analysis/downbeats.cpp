// Port de js/analysis/downbeats.js.
#include "djec/analysis/downbeats.h"

#include "djec/analysis/js_math.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <map>

namespace djec
{
namespace analysis
{
namespace
{

constexpr int K = 5; // FEATURE_KEYS = ['low', 'ons', 'hc1', 'hc2', 'acc']
constexpr double NEG = -1e30;

double medianOf(const std::vector<double>& arr)
{
    std::vector<double> v;
    v.reserve(arr.size());
    for (double x : arr)
        if (std::isfinite(x))
            v.push_back(x);
    if (v.empty())
        return 0;
    std::sort(v.begin(), v.end());
    const std::size_t m = v.size() >> 1;
    return (v.size() % 2) ? v[m] : (v[m - 1] + v[m]) / 2;
}

struct BeatSync
{
    int n = 0;
    std::vector<double> low, ons, hc1, hc2, acc;
};

BeatSync beatSyncFeatures(const Features& f, const std::vector<double>& beats, const DownbeatOptions& o)
{
    const double fps = f.fps;
    const int numFrames = f.numFrames;
    const int n = static_cast<int>(beats.size());
    auto fr = [&](double t) -> long long {
        return std::max<long long>(0, std::min<long long>(numFrames - 1, js::roundi(t * fps)));
    };
    std::vector<double> ibis;
    for (int i = 1; i < n; ++i)
        ibis.push_back(beats[static_cast<std::size_t>(i)] - beats[static_cast<std::size_t>(i) - 1]);
    const double medIbi = !ibis.empty() ? medianOf(ibis) : 0.5;
    BeatSync bf;
    bf.n = n;
    const std::size_t N = static_cast<std::size_t>(n);
    bf.low.assign(N, 0.0);
    bf.ons.assign(N, 0.0);
    bf.acc.assign(N, 0.0);
    std::vector<double> C(N * 12, 0.0);
    for (int i = 0; i < n; ++i)
    {
        const std::size_t I = static_cast<std::size_t>(i);
        const double t = beats[I];
        const double dur = i + 1 < n ? js::jmax(1e-3, beats[I + 1] - t) : medIbi;
        const long long fi = fr(t);
        double ml = 0;
        double mo = 0;
        for (long long k = fi - o.onsetWin; k <= fi + o.onsetWin; ++k)
        {
            if (k < 0 || k >= numFrames)
                continue;
            if (f.onsetLow[static_cast<std::size_t>(k)] > ml)
                ml = f.onsetLow[static_cast<std::size_t>(k)];
            if (f.onset[static_cast<std::size_t>(k)] > mo)
                mo = f.onset[static_cast<std::size_t>(k)];
        }
        bf.low[I] = js::log(o.logFloor + ml);
        bf.ons[I] = js::log(o.logFloor + mo);
        const long long a = fr(t + js::jmin(o.chromaSkip, o.chromaSkipFrac * dur));
        const long long b = std::max<long long>(a, fr(t + dur - js::jmin(o.chromaTail, 0.1 * dur)));
        double norm = 0;
        for (long long k = a; k <= b; ++k)
            for (int p = 0; p < 12; ++p)
                C[I * 12 + static_cast<std::size_t>(p)] += f.chroma[static_cast<std::size_t>(k) * 12 + static_cast<std::size_t>(p)];
        for (int p = 0; p < 12; ++p)
            norm += C[I * 12 + static_cast<std::size_t>(p)] * C[I * 12 + static_cast<std::size_t>(p)];
        norm = js::sqrt(norm);
        if (norm > 0)
            for (int p = 0; p < 12; ++p)
                C[I * 12 + static_cast<std::size_t>(p)] /= norm;
        const double h = 0.5 * dur;
        const long long f1 = fr(t + h);
        const long long f0 = fr(t - h);
        double e1 = 0;
        double e0 = 0;
        for (long long k = fi; k <= f1; ++k)
            e1 += double(f.rms[static_cast<std::size_t>(k)]) * double(f.rms[static_cast<std::size_t>(k)]);
        for (long long k = f0; k < fi; ++k)
            e0 += double(f.rms[static_cast<std::size_t>(k)]) * double(f.rms[static_cast<std::size_t>(k)]);
        e1 /= double(std::max<long long>(1, f1 - fi + 1));
        e0 /= double(std::max<long long>(1, fi - f0));
        bf.acc[I] = 10 * js::log10((e1 + 1e-10) / (e0 + 1e-10));
    }
    auto cosine = [](const double* x, const double* y) {
        double s = 0, nx = 0, ny = 0;
        for (int p = 0; p < 12; ++p)
        {
            s += x[p] * y[p];
            nx += x[p] * x[p];
            ny += y[p] * y[p];
        }
        return (nx > 0 && ny > 0) ? s / js::sqrt(nx * ny) : js::kNaN;
    };
    bf.hc1.assign(N, js::kNaN);
    bf.hc2.assign(N, js::kNaN);
    for (int i = 1; i < n; ++i)
        bf.hc1[static_cast<std::size_t>(i)] = 1 - cosine(&C[static_cast<std::size_t>(i) * 12], &C[static_cast<std::size_t>(i - 1) * 12]);
    double r1[12], r2[12];
    for (int i = 2; i + 1 < n; ++i)
    {
        for (int p = 0; p < 12; ++p)
        {
            r1[p] = C[static_cast<std::size_t>(i) * 12 + p] + C[static_cast<std::size_t>(i + 1) * 12 + p];
            r2[p] = C[static_cast<std::size_t>(i - 1) * 12 + p] + C[static_cast<std::size_t>(i - 2) * 12 + p];
        }
        bf.hc2[static_cast<std::size_t>(i)] = 1 - cosine(r1, r2);
    }
    return bf;
}

std::vector<double> standardizedMatrix(const BeatSync& bf, const DownbeatOptions& o)
{
    const int n = bf.n;
    std::vector<double> Z(static_cast<std::size_t>(n) * K, 0.0);
    const std::vector<double>* keys[K] = {&bf.low, &bf.ons, &bf.hc1, &bf.hc2, &bf.acc};
    for (int k = 0; k < K; ++k)
    {
        const std::vector<double> z = localStandardize(*keys[k], o.normHalf, o.stdFloorRel);
        for (int i = 0; i < n; ++i)
            Z[static_cast<std::size_t>(i) * K + k] = js::jmax(-4, js::jmin(4, z[static_cast<std::size_t>(i)]));
    }
    return Z;
}

using Matrix = std::vector<std::vector<double>>;

Matrix buildTransitions(int M, const DownbeatOptions& o, double mul)
{
    const int S = M + 1;
    Matrix T(static_cast<std::size_t>(S), std::vector<double>(static_cast<std::size_t>(S), NEG));
    const double reset = o.resetLog * mul;
    for (int p = 0; p < M; ++p)
        T[static_cast<std::size_t>(p)][0] = reset;
    for (int p = 0; p + 1 < M; ++p)
        T[static_cast<std::size_t>(p)][static_cast<std::size_t>(p) + 1] = 0;
    if (M >= 2)
        T[static_cast<std::size_t>(M) - 2][0] = js::jmax(T[static_cast<std::size_t>(M) - 2][0], o.shortBarLog * mul);
    T[static_cast<std::size_t>(M) - 1][0] = 0;
    T[static_cast<std::size_t>(M) - 1][static_cast<std::size_t>(M)] = o.longBarLog * mul;
    T[static_cast<std::size_t>(M)][0] = 0;
    return T;
}

std::vector<int> viterbi(const std::vector<double>& E, int n, int S, const Matrix& T)
{
    std::vector<double> prev(static_cast<std::size_t>(S)), cur(static_cast<std::size_t>(S));
    std::vector<int8_t> back(static_cast<std::size_t>(n) * static_cast<std::size_t>(S), 0);
    for (int s = 0; s < S; ++s)
        prev[static_cast<std::size_t>(s)] = (s < S - 1 ? 0 : NEG) + E[static_cast<std::size_t>(s)];
    for (int i = 1; i < n; ++i)
    {
        for (int t = 0; t < S; ++t)
        {
            double best = NEG;
            int arg = 0;
            for (int s = 0; s < S; ++s)
            {
                const double v = prev[static_cast<std::size_t>(s)] + T[static_cast<std::size_t>(s)][static_cast<std::size_t>(t)];
                if (v > best)
                {
                    best = v;
                    arg = s;
                }
            }
            cur[static_cast<std::size_t>(t)] = best + E[static_cast<std::size_t>(i) * S + t];
            back[static_cast<std::size_t>(i) * S + t] = static_cast<int8_t>(arg);
        }
        std::swap(prev, cur);
    }
    double best = NEG;
    int arg = 0;
    for (int s = 0; s < S; ++s)
        if (prev[static_cast<std::size_t>(s)] > best)
        {
            best = prev[static_cast<std::size_t>(s)];
            arg = s;
        }
    std::vector<int> path(static_cast<std::size_t>(n));
    if (n == 0)
        return path;
    path[static_cast<std::size_t>(n) - 1] = arg;
    for (int i = n - 1; i > 0; --i)
        path[static_cast<std::size_t>(i) - 1] = back[static_cast<std::size_t>(i) * S + path[static_cast<std::size_t>(i)]];
    return path;
}

std::vector<double> priorEmissions(const std::vector<double>& d, int n, int S, double scale)
{
    std::vector<double> E(static_cast<std::size_t>(n) * S, 0.0);
    for (int i = 0; i < n; ++i)
        E[static_cast<std::size_t>(i) * S] = scale * d[static_cast<std::size_t>(i)];
    return E;
}

std::vector<double> templateEmissions(const std::vector<double>& Z, int n, int M, const std::vector<double>& tmpl, double scale)
{
    const int S = M + 1;
    std::vector<double> E(static_cast<std::size_t>(n) * S);
    std::vector<double> tn(static_cast<std::size_t>(S));
    for (int s = 0; s < S; ++s)
    {
        double q = 0;
        for (int k = 0; k < K; ++k)
            q += tmpl[static_cast<std::size_t>(s) * K + k] * tmpl[static_cast<std::size_t>(s) * K + k];
        tn[static_cast<std::size_t>(s)] = q / 2;
    }
    for (int i = 0; i < n; ++i)
        for (int s = 0; s < S; ++s)
        {
            double v = 0;
            for (int k = 0; k < K; ++k)
                v += Z[static_cast<std::size_t>(i) * K + k] * tmpl[static_cast<std::size_t>(s) * K + k];
            E[static_cast<std::size_t>(i) * S + s] = scale * (v - tn[static_cast<std::size_t>(s)]);
        }
    return E;
}

std::vector<double> learnTemplates(const std::vector<double>& Z, int n, int M, const std::vector<int>& path,
                                   const std::vector<double>& prior, double shrink)
{
    const int S = M + 1;
    std::vector<double> sum(static_cast<std::size_t>(S) * K, 0.0);
    std::vector<double> cnt(static_cast<std::size_t>(S), 0.0);
    for (int i = 0; i < n; ++i)
    {
        const int s = path[static_cast<std::size_t>(i)];
        cnt[static_cast<std::size_t>(s)]++;
        for (int k = 0; k < K; ++k)
            sum[static_cast<std::size_t>(s) * K + k] += Z[static_cast<std::size_t>(i) * K + k];
    }
    std::vector<double> tmpl(static_cast<std::size_t>(S) * K);
    for (int s = 0; s < S; ++s)
        for (int k = 0; k < K; ++k)
            tmpl[static_cast<std::size_t>(s) * K + k] =
                (sum[static_cast<std::size_t>(s) * K + k] + shrink * prior[static_cast<std::size_t>(s) * K + k]) /
                (cnt[static_cast<std::size_t>(s)] + shrink);
    return tmpl;
}

std::vector<int> sanitizeForcedDb(const std::vector<int>& forced, int n)
{
    std::vector<int> out;
    for (int v : forced)
        if (v >= 0 && v < n && std::find(out.begin(), out.end(), v) == out.end())
            out.push_back(v);
    std::sort(out.begin(), out.end());
    return out;
}

int bestClass(const std::vector<double>& d, const std::vector<int>& path, int M)
{
    std::vector<double> sum(static_cast<std::size_t>(M), 0.0), cnt(static_cast<std::size_t>(M), 0.0);
    for (std::size_t i = 0; i < path.size(); ++i)
    {
        if (path[i] >= M)
            continue;
        sum[static_cast<std::size_t>(path[i])] += d[i];
        cnt[static_cast<std::size_t>(path[i])]++;
    }
    int best = 0;
    for (int p = 1; p < M; ++p)
    {
        const std::size_t P = static_cast<std::size_t>(p), B = static_cast<std::size_t>(best);
        if (cnt[P] != 0 && (cnt[B] == 0 || sum[P] / cnt[P] > sum[B] / cnt[B]))
            best = p;
    }
    return best;
}

std::vector<double> rotateTemplates(const std::vector<double>& tmpl, int M, int r)
{
    const int S = M + 1;
    std::vector<double> rot(static_cast<std::size_t>(S) * K);
    for (int s = 0; s < M; ++s)
    {
        const int q = (s + r) % M;
        std::copy(tmpl.begin() + q * K, tmpl.begin() + q * K + K, rot.begin() + s * K);
    }
    std::copy(tmpl.begin() + M * K, tmpl.begin() + S * K, rot.begin() + M * K);
    return rot;
}

std::vector<int> decodeMeter(const std::vector<double>& Z, const std::vector<double>& d, int n, int M,
                             const std::vector<int>& forced, const DownbeatOptions& o)
{
    const int S = M + 1;
    const Matrix T = buildTransitions(M, o, 1);
    std::vector<int> path = viterbi(priorEmissions(d, n, S, o.emissionScale), n, S, T);
    const double w[K] = {o.wLow, o.wOns, o.wHc1, o.wHc2, o.wAcc};
    std::vector<double> prior(static_cast<std::size_t>(S) * K, 0.0);
    for (int k = 0; k < K; ++k)
    {
        prior[static_cast<std::size_t>(k)] = w[k];
        for (int s = 1; s < S; ++s)
            prior[static_cast<std::size_t>(s) * K + k] = -w[k] / std::max(1, M - 1);
    }
    std::vector<double> tmpl;
    bool haveTmpl = false;
    bool rotated = false;
    for (int it = 0; it < o.templateIters; ++it)
    {
        tmpl = learnTemplates(Z, n, M, path, prior, o.templateShrink);
        haveTmpl = true;
        path = viterbi(templateEmissions(Z, n, M, tmpl, o.templateScale), n, S, T);
        const int r = rotated ? 0 : bestClass(d, path, M);
        if (r != 0)
        {
            rotated = true;
            tmpl = rotateTemplates(tmpl, M, r);
            path = viterbi(templateEmissions(Z, n, M, tmpl, o.templateScale), n, S, T);
        }
    }
    if (forced.empty())
        return path;
    if (!haveTmpl)
        tmpl = learnTemplates(Z, n, M, path, prior, o.templateShrink);
    std::map<int, std::vector<double>> byRot;
    auto emissionsFor = [&](int r) -> const std::vector<double>& {
        auto it = byRot.find(r);
        if (it == byRot.end())
            it = byRot.emplace(r, templateEmissions(Z, n, M, rotateTemplates(tmpl, M, r), o.templateScale)).first;
        return it->second;
    };
    std::vector<double> E(static_cast<std::size_t>(n) * S);
    std::size_t f = 0;
    for (int i = 0; i < n; ++i)
    {
        while (f + 1 < forced.size() && std::abs(forced[f + 1] - i) <= std::abs(forced[f] - i))
            ++f;
        const int pf = path[static_cast<std::size_t>(forced[f])];
        const std::vector<double>& Er = emissionsFor(pf == M ? M - 1 : pf);
        for (int s = 0; s < S; ++s)
            E[static_cast<std::size_t>(i) * S + s] = Er[static_cast<std::size_t>(i) * S + s];
    }
    for (int i : forced)
        for (int s = 1; s < S; ++s)
            E[static_cast<std::size_t>(i) * S + s] = NEG;
    return viterbi(E, n, S, buildTransitions(M, o, o.forcedPenaltyMul));
}

struct Margin
{
    double effect;
    double bars;
};

Margin phaseMargin(const std::vector<double>& d, const std::vector<int>& positions, int M, int from, int to)
{
    std::vector<double> sum(static_cast<std::size_t>(M), 0.0), sq(static_cast<std::size_t>(M), 0.0),
        cnt(static_cast<std::size_t>(M), 0.0);
    for (int i = from; i < to; ++i)
    {
        const int p = positions[static_cast<std::size_t>(i)];
        if (p >= M)
            continue;
        sum[static_cast<std::size_t>(p)] += d[static_cast<std::size_t>(i)];
        sq[static_cast<std::size_t>(p)] += d[static_cast<std::size_t>(i)] * d[static_cast<std::size_t>(i)];
        cnt[static_cast<std::size_t>(p)]++;
    }
    double within = 0;
    double dof = 0;
    for (int p = 0; p < M; ++p)
    {
        const std::size_t P = static_cast<std::size_t>(p);
        if (cnt[P] == 0)
            continue;
        within += sq[P] - (sum[P] * sum[P]) / cnt[P];
        dof += cnt[P] - 1;
    }
    const double sw = js::sqrt(js::jmax(1e-9, within / js::jmax(1, dof)));
    if (cnt[0] == 0)
        return {0, 0};
    double alt = -js::kInf;
    for (int p = 1; p < M; ++p)
        if (cnt[static_cast<std::size_t>(p)] != 0)
            alt = js::jmax(alt, sum[static_cast<std::size_t>(p)] / cnt[static_cast<std::size_t>(p)]);
    const double effect = std::isfinite(alt) ? (sum[0] / cnt[0] - alt) / sw : 0;
    return {effect, cnt[0]};
}

double clamp01(double x) { return js::jmax(0, js::jmin(1, x)); }

} // namespace

std::vector<double> localStandardize(const std::vector<double>& x, int half, double stdFloorRel)
{
    const int n = static_cast<int>(x.size());
    std::vector<double> out(static_cast<std::size_t>(n)), stds(static_cast<std::size_t>(n)), means(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
    {
        double s = 0, s2 = 0;
        int c = 0;
        for (int j = std::max(0, i - half); j <= std::min(n - 1, i + half); ++j)
        {
            const double v = x[static_cast<std::size_t>(j)];
            if (!std::isfinite(v))
                continue;
            s += v;
            s2 += v * v;
            ++c;
        }
        const double m = c ? s / c : 0;
        means[static_cast<std::size_t>(i)] = m;
        stds[static_cast<std::size_t>(i)] = c > 1 ? js::sqrt(js::jmax(0, s2 / c - m * m)) : 0;
    }
    const double floor = js::jmax(1e-6, stdFloorRel * medianOf(stds));
    for (int i = 0; i < n; ++i)
    {
        const double v = x[static_cast<std::size_t>(i)];
        out[static_cast<std::size_t>(i)] =
            std::isfinite(v) ? (v - means[static_cast<std::size_t>(i)]) / js::jmax(stds[static_cast<std::size_t>(i)], floor) : 0;
    }
    return out;
}

double meterPeriodicity(const std::vector<double>& Z, int n, int Kk, int M, int W, int hop)
{
    if (n < 2 * M)
        return 0;
    const int win = std::min(W, n - (n % M));
    const double chance = double(M - 1) / double(win - 1);
    double total = 0;
    std::vector<double> sum(static_cast<std::size_t>(M)), num(static_cast<std::size_t>(M));
    for (int k = 0; k < Kk; ++k)
    {
        double acc = 0;
        int cnt = 0;
        for (int s = 0; s + win <= n; s += hop)
        {
            double mean = 0;
            for (int i = s; i < s + win; ++i)
                mean += Z[static_cast<std::size_t>(i) * Kk + k];
            mean /= win;
            double ss = 0;
            std::fill(sum.begin(), sum.end(), 0.0);
            std::fill(num.begin(), num.end(), 0.0);
            for (int i = s; i < s + win; ++i)
            {
                const double v = Z[static_cast<std::size_t>(i) * Kk + k] - mean;
                ss += v * v;
                sum[static_cast<std::size_t>(i % M)] += v;
                num[static_cast<std::size_t>(i % M)]++;
            }
            if (ss <= 1e-9)
                continue;
            double bs = 0;
            for (int p = 0; p < M; ++p)
                if (num[static_cast<std::size_t>(p)] != 0)
                    bs += (sum[static_cast<std::size_t>(p)] * sum[static_cast<std::size_t>(p)]) / num[static_cast<std::size_t>(p)];
            acc += (bs / ss - chance) / (1 - chance);
            ++cnt;
        }
        if (cnt)
            total += acc / cnt;
    }
    return total;
}

LabelResult labelBars(const Features& features, const std::vector<double>& beats, int beatsPerBar,
                      const std::vector<int>& forcedDownbeats, const DownbeatOptions& o)
{
    const int n = static_cast<int>(beats.size());
    const bool autoM = !(beatsPerBar >= 2 && beatsPerBar <= 7);
    const std::vector<int> forced = sanitizeForcedDb(forcedDownbeats, n);
    LabelResult res;
    res.meterAuto = autoM;
    if (n == 0)
    {
        res.beatsPerBar = autoM ? 4 : beatsPerBar;
        return res;
    }
    const BeatSync bf = beatSyncFeatures(features, beats, o);
    const std::vector<double> Z = standardizedMatrix(bf, o);
    const double w[K] = {o.wLow, o.wOns, o.wHc1, o.wHc2, o.wAcc};
    std::vector<double> d(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
    {
        double s = 0;
        for (int k = 0; k < K; ++k)
            s += w[k] * Z[static_cast<std::size_t>(i) * K + k];
        d[static_cast<std::size_t>(i)] = s;
    }
    res.meterScore3 = meterPeriodicity(Z, n, K, 3, o.meterWindow, o.meterHop);
    res.meterScore4 = meterPeriodicity(Z, n, K, 4, o.meterWindow, o.meterHop);
    int M = beatsPerBar;
    double meterConf = 1;
    if (autoM)
    {
        const double diff = res.meterScore3 - res.meterScore4;
        M = diff > o.meterBias ? 3 : 4;
        const double margin = M == 3 ? diff - o.meterBias : o.meterBias - diff;
        meterConf = js::jmin(1, js::jmax(0, margin / o.meterConfSpan));
    }
    res.positions = decodeMeter(Z, d, n, M, forced, o);
    for (int i = 0; i < n; ++i)
        if (res.positions[static_cast<std::size_t>(i)] == 0)
            res.downbeats.push_back(i);
    const Margin g = phaseMargin(d, res.positions, M, 0, n);
    const Margin tl = phaseMargin(d, res.positions, M, std::max(0, n - 12 * M), n);
    const double effect = 0.5 * (g.effect + tl.effect);
    const double tStat = effect * js::sqrt(g.bars / 2);
    int irregular = 0;
    for (int i = 1; i < n; ++i)
        if (res.positions[static_cast<std::size_t>(i)] == 0 && res.positions[static_cast<std::size_t>(i) - 1] < M - 1)
            ++irregular;
    for (int i = 0; i < n; ++i)
        if (res.positions[static_cast<std::size_t>(i)] == M)
            ++irregular;
    const double phaseConf = js::jmin(clamp01((effect - o.confEffectLow) / (o.confEffectHigh - o.confEffectLow)), clamp01((tStat - 1) / 2));
    double confidence = phaseConf * js::pow(o.confIrregularFactor, irregular);
    if (autoM)
        confidence *= 0.5 + 0.5 * meterConf;
    res.beatsPerBar = M;
    res.confidence = confidence;
    return res;
}

} // namespace analysis
} // namespace djec
