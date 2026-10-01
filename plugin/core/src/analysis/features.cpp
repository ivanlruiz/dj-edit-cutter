// Port de js/analysis/features.js (computeFeatures, pickPeaks). Mismos tipos: Float32Array → float, el resto double.
#include "djec/analysis/features.h"

#include "djec/analysis/fft.h"
#include "djec/analysis/js_math.h"

#include <algorithm>
#include <cmath>

namespace djec
{
namespace analysis
{
namespace
{

struct Filter
{
    int start = 0;
    std::vector<float> weights;
    double centerHz = 0;
};

/** Filtros triangulares log-frecuencia con bins únicos (estilo madmom), normalizados en área. */
std::vector<Filter> buildLogFilterbank(int fftSize, double sampleRate, int bandsPerOctave, double fmin, double fmax)
{
    const double binHz = sampleRate / fftSize;
    const int nBins = fftSize / 2 + 1;
    const double top = js::jmin(fmax, sampleRate / 2);
    std::vector<int> bins;
    for (int j = 0;; ++j)
    {
        const double f = fmin * js::pow(2, double(j) / bandsPerOctave);
        if (f > top)
            break;
        const long long b = js::roundi(f / binHz);
        if (b >= 1 && b < nBins && (bins.empty() || bins.back() != b))
            bins.push_back(static_cast<int>(b));
    }
    std::vector<Filter> filters;
    for (std::size_t k = 1; k + 1 < bins.size(); ++k)
    {
        const int lo = bins[k - 1];
        const int c = bins[k];
        const int hi = bins[k + 1];
        const int start = c - lo > 1 ? lo + 1 : c;
        const int stop = hi - c > 1 ? hi - 1 : c;
        Filter flt;
        flt.weights.assign(static_cast<std::size_t>(stop - start + 1), 0.0f);
        for (int b = start; b <= stop; ++b)
        {
            double v;
            if (b <= c)
                v = (c == lo) ? 1.0 : double(b - lo) / double(c - lo);
            else
                v = (hi == c) ? 1.0 : double(hi - b) / double(hi - c);
            flt.weights[static_cast<std::size_t>(b - start)] = static_cast<float>(v);
        }
        double s = 0;
        for (float w : flt.weights)
            s += w;
        for (float& w : flt.weights)
            w = static_cast<float>(w / s);
        flt.start = start;
        flt.centerHz = c * binHz;
        filters.push_back(std::move(flt));
    }
    return filters;
}

struct ChromaMap
{
    int b0 = 0, b1 = -1;
    std::vector<uint8_t> pc;
    std::vector<float> w;
};

ChromaMap buildChromaMap(int fftSize, double sampleRate, double fmin, double fmax)
{
    const double binHz = sampleRate / fftSize;
    ChromaMap m;
    m.b0 = static_cast<int>(std::max<long long>(1, js::ceili(fmin / binHz)));
    m.b1 = static_cast<int>(std::min<long long>(fftSize / 2, js::floori(fmax / binHz)));
    const int len = std::max(0, m.b1 - m.b0 + 1);
    m.pc.assign(static_cast<std::size_t>(len), 0);
    m.w.assign(static_cast<std::size_t>(len), 0.0f);
    for (int b = m.b0; b <= m.b1; ++b)
    {
        const double p = 69 + 12 * js::log2((b * binHz) / 440);
        const double r = js::round(p);
        const long long ri = static_cast<long long>(r);
        m.pc[static_cast<std::size_t>(b - m.b0)] = static_cast<uint8_t>(((ri % 12) + 12) % 12);
        m.w[static_cast<std::size_t>(b - m.b0)] = static_cast<float>(js::jmax(0, 1 - 2 * std::fabs(p - r)));
    }
    return m;
}

float quantileOf(const std::vector<float>& arr, double q)
{
    const std::size_t n = arr.size();
    if (!n)
        return 0;
    std::vector<float> s(arr);
    std::sort(s.begin(), s.end());
    long long idx = js::floori(q * double(n - 1));
    idx = std::max<long long>(0, std::min<long long>(static_cast<long long>(n) - 1, idx));
    return s[static_cast<std::size_t>(idx)];
}

/** Envuelve un callback de progreso: fracciones crecientes en [0, 1]. */
class Progress
{
public:
    explicit Progress(const std::function<void(double)>& cb) : cb_(cb) {}
    void operator()(double f)
    {
        if (!cb_)
            return;
        const double v = std::min(1.0, std::max(0.0, f));
        if (v <= last_)
            return;
        last_ = v;
        try
        {
            cb_(v);
        }
        catch (...)
        {
            // un fallo en la interfaz no debe parar el análisis
        }
    }

private:
    const std::function<void(double)>& cb_;
    double last_ = -1;
};

/** Interpola linealmente pares (x crecientes) a las tramas 0..n-1 (extremos constantes). */
std::vector<float> interpolateAt(const std::vector<double>& pairs, int n)
{
    std::vector<float> out(static_cast<std::size_t>(n), 0.0f);
    const std::size_t m = pairs.size() / 2;
    if (!m)
        return out;
    std::size_t j = 0;
    for (int i = 0; i < n; ++i)
    {
        while (j + 1 < m && pairs[2 * (j + 1)] <= i)
            ++j;
        const double x0 = pairs[2 * j];
        const double y0 = pairs[2 * j + 1];
        if (i <= x0 || j + 1 >= m)
            out[static_cast<std::size_t>(i)] = static_cast<float>(y0);
        else
        {
            const double x1 = pairs[2 * (j + 1)];
            out[static_cast<std::size_t>(i)] =
                static_cast<float>(y0 + ((pairs[2 * (j + 1) + 1] - y0) * (i - x0)) / (x1 - x0));
        }
    }
    return out;
}

/** Croma a salto hop*chromaHopFactor con ventana larga, interpolado linealmente a la rejilla de tramas. */
std::vector<float> computeChroma(const float* samples, std::size_t n, double sampleRate, double gain, int numFrames,
                                 const FeatureOptions& o, const std::function<void(double)>& progress)
{
    const int N = o.chromaFrameSize;
    const long long hopC = static_cast<long long>(o.hop) * o.chromaHopFactor;
    const long long nC = static_cast<long long>(n) / hopC + 1;
    RealFFT fft(static_cast<std::size_t>(N));
    const std::vector<float> win = hannWindow(static_cast<std::size_t>(N));
    std::vector<double> frame(static_cast<std::size_t>(N));
    const ChromaMap map = buildChromaMap(N, sampleRate, o.chromaFmin, o.chromaFmax);
    std::vector<float> cC(static_cast<std::size_t>(nC * 12), 0.0f);
    std::vector<float> energy(static_cast<std::size_t>(nC), 0.0f);
    double acc[12];
    const long long half = N / 2;
    const long long progStep = std::max<long long>(1, nC / 25);
    const long long nn = static_cast<long long>(n);
    double maxE = 0;
    for (long long j = 0; j < nC; ++j)
    {
        const long long s0 = j * hopC - half;
        if (s0 >= 0 && s0 + N <= nn)
        {
            for (int k = 0; k < N; ++k)
                frame[static_cast<std::size_t>(k)] = double(samples[s0 + k]) * gain * double(win[static_cast<std::size_t>(k)]);
        }
        else
        {
            for (int k = 0; k < N; ++k)
            {
                const long long idx = s0 + k;
                frame[static_cast<std::size_t>(k)] =
                    (idx >= 0 && idx < nn) ? double(samples[idx]) * gain * double(win[static_cast<std::size_t>(k)]) : 0.0;
            }
        }
        fft.forward(frame.data());
        const double* re = fft.re().data();
        const double* im = fft.im().data();
        for (double& a : acc)
            a = 0;
        double e = 0;
        for (int b = map.b0; b <= map.b1; ++b)
        {
            const double m = js::sqrt(re[b] * re[b] + im[b] * im[b]);
            const std::size_t i = static_cast<std::size_t>(b - map.b0);
            acc[map.pc[i]] += double(map.w[i]) * m;
            e += m;
        }
        energy[static_cast<std::size_t>(j)] = static_cast<float>(e);
        if (e > maxE)
            maxE = e;
        double mx = 0;
        for (int p = 0; p < 12; ++p)
            if (acc[p] > mx)
                mx = acc[p];
        if (mx > 0)
            for (int p = 0; p < 12; ++p)
                cC[static_cast<std::size_t>(j * 12 + p)] = static_cast<float>(acc[p] / mx);
        if (j % progStep == 0)
            progress(double(j) / double(nC));
    }
    const double th = maxE * 1e-3;
    for (long long j = 0; j < nC; ++j)
        if (energy[static_cast<std::size_t>(j)] < th)
            std::fill(cC.begin() + j * 12, cC.begin() + j * 12 + 12, 0.0f);
    std::vector<float> chroma(static_cast<std::size_t>(numFrames) * 12, 0.0f);
    const int r = o.chromaHopFactor;
    for (int i = 0; i < numFrames; ++i)
    {
        const long long j = i / r;
        const double f = double(i - j * r) / r;
        const long long j1 = std::min<long long>(nC - 1, j + 1);
        for (int p = 0; p < 12; ++p)
            chroma[static_cast<std::size_t>(i) * 12 + p] = static_cast<float>(
                (1 - f) * double(cC[static_cast<std::size_t>(j * 12 + p)]) + f * double(cC[static_cast<std::size_t>(j1 * 12 + p)]));
    }
    return chroma;
}

} // namespace

Features computeFeatures(const float* samples, std::size_t nSamples, double sampleRate, const FeatureOptions& o)
{
    const int frameSize = o.frameSize;
    const int hop = o.hop;
    const int lag = o.lag;
    const long long n = static_cast<long long>(nSamples);
    const int numFrames = static_cast<int>(n / hop + 1);
    const int half = frameSize / 2;
    Progress progress(o.onProgress);

    double peak = 0;
    for (long long i = 0; i < n; ++i)
    {
        const double a = samples[i] < 0 ? -double(samples[i]) : double(samples[i]);
        if (a > peak)
            peak = a;
    }
    const double gain = peak > 0 ? 1 / peak : 1;

    RealFFT fft(static_cast<std::size_t>(frameSize));
    const std::vector<float> win = hannWindow(static_cast<std::size_t>(frameSize));
    std::vector<double> frame(static_cast<std::size_t>(frameSize));
    std::vector<double> mag(static_cast<std::size_t>(frameSize / 2 + 1));
    const std::vector<Filter> filters = buildLogFilterbank(frameSize, sampleRate, o.bandsPerOctave, o.fmin, o.fmax);
    const int nb = static_cast<int>(filters.size());
    int nLow = 0;
    while (nLow < nb && filters[static_cast<std::size_t>(nLow)].centerHz < o.lowCutoff)
        ++nLow;

    const std::size_t NF = static_cast<std::size_t>(numFrames);
    std::vector<float> onset(NF, 0.0f), onsetLow(NF, 0.0f), rms(NF, 0.0f), rmsHigh(NF, 0.0f);
    const int refFrames = std::max(1, o.refFrames);
    const int R = lag + refFrames;
    std::vector<std::vector<float>> ring(static_cast<std::size_t>(R), std::vector<float>(static_cast<std::size_t>(nb), 0.0f));
    std::vector<float> refT(static_cast<std::size_t>(nb), 0.0f), refMax(static_cast<std::size_t>(nb), 0.0f);
    const int mfr = o.maxFilterBands / 2;
    const double logMul = o.logMul;
    const double wTau = o.whitenTau;
    const double wFloor = o.whitenFloor;
    const double wA = wTau > 0 ? js::exp(-double(hop) / sampleRate / wTau) : 0;
    std::vector<float> fluct(static_cast<std::size_t>(nb), 0.0f);
    const long long firstValid = js::ceili(double(half) / hop);
    const long long lastValid = js::floori(double(n - half) / hop);
    const long long fluxFrom = firstValid + lag;

    // banco de filtros aplanado
    std::vector<int> fbStart(static_cast<std::size_t>(nb)), fbLen(static_cast<std::size_t>(nb)), fbOff(static_cast<std::size_t>(nb));
    int totalW = 0;
    for (int f = 0; f < nb; ++f)
    {
        fbStart[static_cast<std::size_t>(f)] = filters[static_cast<std::size_t>(f)].start;
        fbLen[static_cast<std::size_t>(f)] = static_cast<int>(filters[static_cast<std::size_t>(f)].weights.size());
        fbOff[static_cast<std::size_t>(f)] = totalW;
        totalW += fbLen[static_cast<std::size_t>(f)];
    }
    std::vector<float> fbW(static_cast<std::size_t>(totalW));
    for (int f = 0; f < nb; ++f)
        std::copy(filters[static_cast<std::size_t>(f)].weights.begin(), filters[static_cast<std::size_t>(f)].weights.end(),
                  fbW.begin() + fbOff[static_cast<std::size_t>(f)]);
    const double* re = fft.re().data();
    const double* im = fft.im().data();
    const long long kHigh = std::min<long long>(half, std::max<long long>(1, js::ceili((o.highCutoff * frameSize) / sampleRate)));
    double winSq = 0;
    for (int k = 0; k < frameSize; ++k)
        winSq += double(win[static_cast<std::size_t>(k)]) * double(win[static_cast<std::size_t>(k)]);
    const double highScale = 2 / (frameSize * winSq * gain * gain);
    const int progStep = std::max(1, numFrames / 100);
    const int fb0 = static_cast<int>(std::max<long long>(1, js::roundi((o.flatnessFmin * frameSize) / sampleRate)));
    const int fb1 = static_cast<int>(
        std::min<long long>(half, std::max<long long>(fb0, js::roundi((o.flatnessFmax * frameSize) / sampleRate))));
    const int fnb = fb1 - fb0 + 1;
    const int fA = static_cast<int>(std::max<long long>(1, js::roundi((o.flatnessSec * sampleRate) / hop)));
    const int fStep = std::max(1, o.flatnessStep);
    std::vector<float> fRing(static_cast<std::size_t>(fA) * static_cast<std::size_t>(fnb), 0.0f);
    std::vector<double> fSum(static_cast<std::size_t>(fnb), 0.0);
    std::vector<double> flatAt;
    flatAt.reserve(static_cast<std::size_t>(2 * (numFrames / fStep + 2)));

    for (int i = 0; i < numFrames; ++i)
    {
        const long long c = static_cast<long long>(i) * hop;
        const long long s0 = c - half;
        double sq = 0;
        double sm = 0;
        int cnt = frameSize;
        if (s0 >= 0 && s0 + frameSize <= n)
        {
            const float* src = samples + s0;
            for (int k = 0; k < frameSize; ++k)
            {
                const double v = src[k];
                sq += v * v;
                sm += v;
                frame[static_cast<std::size_t>(k)] = v * gain * double(win[static_cast<std::size_t>(k)]);
            }
        }
        else
        {
            cnt = 0;
            for (int k = 0; k < frameSize; ++k)
            {
                const long long idx = s0 + k;
                const bool inside = idx >= 0 && idx < n;
                const double v = inside ? double(samples[idx]) : 0.0;
                if (inside)
                    ++cnt;
                sq += v * v;
                sm += v;
                frame[static_cast<std::size_t>(k)] = v * gain * double(win[static_cast<std::size_t>(k)]);
            }
        }
        rms[static_cast<std::size_t>(i)] =
            cnt > 0 ? static_cast<float>(js::sqrt(js::jmax(0, sq - (sm * sm) / cnt) / frameSize)) : 0.0f;
        fft.forward(frame.data());
        double hi = 0;
        for (int k = 0; k <= half; ++k)
        {
            const double p = re[k] * re[k] + im[k] * im[k];
            mag[static_cast<std::size_t>(k)] = js::sqrt(p);
            if (k >= kHigh)
                hi += k == half ? 0.5 * p : p;
        }
        rmsHigh[static_cast<std::size_t>(i)] = static_cast<float>(js::sqrt(hi * highScale));
        const std::size_t slot = static_cast<std::size_t>(i % fA) * static_cast<std::size_t>(fnb);
        for (int k = fb0; k <= fb1; ++k)
        {
            const double p = re[k] * re[k] + im[k] * im[k];
            const std::size_t q = slot + static_cast<std::size_t>(k - fb0);
            fSum[static_cast<std::size_t>(k - fb0)] += p - double(fRing[q]);
            fRing[q] = static_cast<float>(p);
        }
        if (i % fA == fA - 1)
        {
            std::fill(fSum.begin(), fSum.end(), 0.0);
            for (std::size_t q = 0; q < fRing.size(); q += static_cast<std::size_t>(fnb))
                for (int k = 0; k < fnb; ++k)
                    fSum[static_cast<std::size_t>(k)] += fRing[q + static_cast<std::size_t>(k)];
        }
        if (i % fStep == 0 || i == numFrames - 1)
        {
            const int cntF = std::min(i + 1, fA);
            double lg = 0;
            double ar = 0;
            for (int k = 0; k < fnb; ++k)
            {
                const double v = js::jmax(0, fSum[static_cast<std::size_t>(k)]) / cntF;
                ar += v;
                lg += js::log(v + 1e-30);
            }
            ar /= fnb;
            flatAt.push_back(i - double(cntF - 1) / 2);
            flatAt.push_back(ar > 1e-14 ? js::jmin(1, js::exp(lg / fnb) / ar) : 0.0);
        }
        std::vector<float>& cur = ring[static_cast<std::size_t>(i % R)];
        for (int f = 0; f < nb; ++f)
        {
            double s = 0;
            const float* w = fbW.data() + fbOff[static_cast<std::size_t>(f)];
            const double* mg = mag.data() + fbStart[static_cast<std::size_t>(f)];
            const int len = fbLen[static_cast<std::size_t>(f)];
            for (int k = 0; k < len; ++k)
                s += double(w[k]) * mg[k];
            cur[static_cast<std::size_t>(f)] = static_cast<float>(js::kLog10E * js::log(1 + logMul * s));
        }
        if (i >= lag)
        {
            const std::vector<float>* ref = &ring[static_cast<std::size_t>((i - lag) % R)];
            if (refFrames > 1)
            {
                refT = *ref;
                for (int q = 1; q < refFrames && i - lag - q >= 0; ++q)
                {
                    const std::vector<float>& r2 = ring[static_cast<std::size_t>((i - lag - q) % R)];
                    for (int f = 0; f < nb; ++f)
                        if (r2[static_cast<std::size_t>(f)] > refT[static_cast<std::size_t>(f)])
                            refT[static_cast<std::size_t>(f)] = r2[static_cast<std::size_t>(f)];
                }
                ref = &refT;
            }
            const std::vector<float>& rf = *ref;
            for (int f = 0; f < nb; ++f)
            {
                float m = rf[static_cast<std::size_t>(f)];
                for (int d = 1; d <= mfr; ++d)
                {
                    if (f - d >= 0 && rf[static_cast<std::size_t>(f - d)] > m)
                        m = rf[static_cast<std::size_t>(f - d)];
                    if (f + d < nb && rf[static_cast<std::size_t>(f + d)] > m)
                        m = rf[static_cast<std::size_t>(f + d)];
                }
                refMax[static_cast<std::size_t>(f)] = m;
            }
            double sum = 0;
            double sumLow = 0;
            for (int f = 0; f < nb; ++f)
            {
                const std::size_t fi = static_cast<std::size_t>(f);
                double d = double(cur[fi]) - double(refMax[fi]);
                if (wTau > 0)
                {
                    const double ad = std::fabs(double(cur[fi]) - double(rf[fi]));
                    const double sc = wFloor / (wFloor + double(fluct[fi]));
                    fluct[fi] = static_cast<float>(wA * double(fluct[fi]) + (1 - wA) * ad);
                    d *= sc;
                }
                if (d > 0)
                {
                    sum += d;
                    if (f < nLow)
                        sumLow += d;
                }
            }
            if (i >= fluxFrom && i <= lastValid)
            {
                onset[static_cast<std::size_t>(i)] = static_cast<float>(sum);
                onsetLow[static_cast<std::size_t>(i)] = static_cast<float>(sumLow);
            }
        }
        if (i % progStep == 0)
            progress((0.8 * i) / numFrames);
    }

    Features F;
    F.flatness = interpolateAt(flatAt, numFrames);
    const double onsetScale = js::jmax(1e-9, quantileOf(onset, o.normQuantile));
    const double onsetLowScale = js::jmax(1e-9, quantileOf(onsetLow, o.normQuantile));
    for (std::size_t i = 0; i < NF; ++i)
    {
        onset[i] = static_cast<float>(onset[i] / onsetScale);
        onsetLow[i] = static_cast<float>(onsetLow[i] / onsetLowScale);
    }

    std::function<void(double)> chromaProgress = [&progress](double f) { progress(0.8 + 0.2 * f); };
    F.chroma = computeChroma(samples, nSamples, sampleRate, gain, numFrames, o, chromaProgress);
    progress(1);

    F.sampleRate = sampleRate;
    F.hop = hop;
    F.frameSize = frameSize;
    F.fps = sampleRate / hop;
    F.numFrames = numFrames;
    F.duration = double(n) / sampleRate;
    F.peak = peak;
    F.onset = std::move(onset);
    F.onsetLow = std::move(onsetLow);
    F.onsetScale = onsetScale;
    F.onsetLowScale = onsetLowScale;
    F.numBands = nb;
    F.numLowBands = nLow;
    F.firstValidFrame = static_cast<int>(std::min<long long>(numFrames - 1, fluxFrom));
    F.lastValidFrame = static_cast<int>(std::max<long long>(0, lastValid));
    F.rms = std::move(rms);
    F.rmsHigh = std::move(rmsHigh);
    return F;
}

std::vector<int> pickPeaks(const std::vector<float>& env, double fps, const PeakOptions& o)
{
    const int n = static_cast<int>(env.size());
    const int pM = static_cast<int>(std::max<long long>(0, js::roundi(o.preMax * fps)));
    const int qM = static_cast<int>(std::max<long long>(0, js::roundi(o.postMax * fps)));
    const int pA = static_cast<int>(std::max<long long>(0, js::roundi(o.preAvg * fps)));
    const int qA = static_cast<int>(std::max<long long>(0, js::roundi(o.postAvg * fps)));
    const double comb = o.combine * fps;
    std::vector<double> cs(static_cast<std::size_t>(n) + 1, 0.0);
    for (int i = 0; i < n; ++i)
        cs[static_cast<std::size_t>(i) + 1] = cs[static_cast<std::size_t>(i)] + env[static_cast<std::size_t>(i)];
    std::vector<int> out;
    double last = -js::kInf;
    for (int i = 0; i < n; ++i)
    {
        const double v = env[static_cast<std::size_t>(i)];
        if (v <= o.minValue)
            continue;
        bool isMax = true;
        for (int k = std::max(0, i - pM); k <= std::min(n - 1, i + qM); ++k)
        {
            const double ek = env[static_cast<std::size_t>(k)];
            if (ek > v || (ek == v && k < i))
            {
                isMax = false;
                break;
            }
        }
        if (!isMax)
            continue;
        const int a = std::max(0, i - pA);
        const int b = std::min(n - 1, i + qA);
        const double mean = (cs[static_cast<std::size_t>(b) + 1] - cs[static_cast<std::size_t>(a)]) / (b - a + 1);
        if (v < mean * (1 + o.relThreshold) + o.threshold)
            continue;
        if (i - last <= comb)
            continue;
        out.push_back(i);
        last = i;
    }
    return out;
}

} // namespace analysis
} // namespace djec
