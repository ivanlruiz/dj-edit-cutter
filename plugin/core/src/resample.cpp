// Port del remuestreo de js/audio/decode.js (FIR sinc·Kaiser, fases precalculadas en float) y de toAnalysisMono.
#include "djec/resample.h"

#include "djec/analysis/js_math.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace djec
{
namespace
{

double besselI0(double x)
{
    double sum = 1;
    double term = 1;
    for (int k = 1; k < 40; ++k)
    {
        const double y = x / (2 * k);
        term *= y * y;
        sum += term;
        if (term < 1e-12 * sum)
            break;
    }
    return sum;
}

long long gcd(long long a, long long b)
{
    while (b)
    {
        const long long t = a % b;
        a = b;
        b = t;
    }
    return a;
}

/** mixInto de la web: dst[i] = Σ_c src_c[i0 + i] · w_c, acumulado en float canal a canal. */
void mixInto(const float* const* chans, int nCh, const std::vector<double>& weights, std::size_t i0, std::size_t i1, float* dst)
{
    const std::size_t len = i1 - i0;
    std::fill(dst, dst + len, 0.0f);
    for (int c = 0; c < nCh; ++c)
    {
        const double w = weights[static_cast<std::size_t>(c)];
        if (w == 0 || std::isnan(w))
            continue;
        const float* src = chans[c] + i0;
        for (std::size_t i = 0; i < len; ++i)
            dst[i] = static_cast<float>(double(dst[i]) + double(src[i]) * w);
    }
}

} // namespace

Resampler::Resampler(double fromRate, double toRate, ResamplerOptions o)
{
    const double from = js::round(fromRate);
    const double to = js::round(toRate);
    if (!(from > 0) || !(to > 0) || from > 1e9 || to > 1e9)
        throw std::invalid_argument("Frecuencia de muestreo no válida.");
    from_ = static_cast<int>(from);
    to_ = static_cast<int>(to);
    const double scale = std::min(1.0, to / from);
    cutoff_ = 0.5 * scale * o.rolloff;
    half_ = js::ceili(o.zeroCrossings / scale);
    taps_ = 2 * half_;
    i0b_ = besselI0(8.6);
    const long long g = gcd(from_, to_);
    P_ = from_ / g;
    Q_ = to_ / g;
    phases_ = Q_ <= 4096 ? Q_ : 0;
    if (phases_)
    {
        coef_.assign(static_cast<std::size_t>(phases_ * taps_), 0.0f);
        for (long long ph = 0; ph < phases_; ++ph)
        {
            double sum = 0;
            for (long long k = 0; k < taps_; ++k)
            {
                const double v = kernel(double(k - half_ + 1) - double(ph) / double(Q_));
                coef_[static_cast<std::size_t>(ph * taps_ + k)] = static_cast<float>(v);
                sum += v;
            }
            for (long long k = 0; k < taps_; ++k)
            {
                float& c = coef_[static_cast<std::size_t>(ph * taps_ + k)];
                c = static_cast<float>(double(c) / sum);
            }
        }
    }
    step_ = from / to;
}

double Resampler::kernel(double t) const
{
    const double a = std::fabs(t);
    if (a >= double(half_))
        return 0;
    const double r = a / double(half_);
    const double w = besselI0(8.6 * std::sqrt(1 - r * r)) / i0b_;
    const double s = a < 1e-9 ? 2 * cutoff_ : std::sin(2 * js::kPi * cutoff_ * a) / (js::kPi * a);
    return s * w;
}

std::size_t Resampler::outLength(std::size_t n) const
{
    return static_cast<std::size_t>(std::ceil((double(n) * to_) / from_));
}

std::pair<std::size_t, std::size_t> Resampler::inputRange(std::size_t j0, std::size_t j1, std::size_t total) const
{
    const long long lo = std::max<long long>(0, static_cast<long long>(std::floor((double(j0) * from_) / to_)) - half_ - 1);
    const long long hi = std::min<long long>(static_cast<long long>(total),
                                             static_cast<long long>(std::ceil((double(j1) * from_) / to_)) + half_ + 2);
    return {static_cast<std::size_t>(lo), static_cast<std::size_t>(std::max(lo, hi))};
}

void Resampler::process(const float* x, float* out, std::size_t j0, std::size_t j1, std::size_t xOffset, std::size_t total) const
{
    const long long n = static_cast<long long>(total);
    const long long xo = static_cast<long long>(xOffset);
    for (std::size_t j = j0; j < j1; ++j)
    {
        long long i0;
        long long ph = -1;
        double frac = 0;
        if (phases_)
        {
            const long long num = static_cast<long long>(j) * P_;
            i0 = num / Q_;
            ph = num - i0 * Q_;
        }
        else
        {
            const double t = double(j) * step_;
            i0 = static_cast<long long>(std::floor(t));
            frac = t - double(i0);
        }
        const long long base = i0 - half_ + 1;
        if (ph >= 0 && base >= 0 && base + taps_ <= n)
        {
            const float* c = coef_.data() + ph * taps_;
            const float* xs = x + (base - xo);
            double acc = 0;
            for (long long k = 0; k < taps_; ++k)
                acc += double(xs[k]) * double(c[k]);
            out[j] = static_cast<float>(acc);
            continue;
        }
        double acc = 0;
        double wsum = 0;
        const long long lo = std::max<long long>(0, base);
        const long long hi = std::min<long long>(n - 1, i0 + half_);
        for (long long i = lo; i <= hi; ++i)
        {
            const double h = ph >= 0 ? double(coef_[static_cast<std::size_t>(ph * taps_ + (i - base))])
                                     : kernel(double(i - i0) - frac);
            acc += double(x[i - xo]) * h;
            wsum += h;
        }
        out[j] = wsum > 1e-6 ? static_cast<float>(acc / wsum) : 0.0f;
    }
}

std::vector<float> resample(const float* x, std::size_t n, double fromRate, double toRate, ResamplerOptions options)
{
    if (js::round(fromRate) == js::round(toRate))
        return std::vector<float>(x, x + n);
    const Resampler r(fromRate, toRate, options);
    std::vector<float> out(r.outLength(n));
    r.process(x, out.data(), 0, out.size(), 0, n);
    return out;
}

std::vector<float> downmixMono(const float* const* channels, int numChannels, std::size_t n)
{
    if (numChannels <= 0)
        return {};
    if (numChannels == 1)
        return std::vector<float>(channels[0], channels[0] + n);
    std::vector<float> mono(n, 0.0f);
    const double k = 1.0 / numChannels;
    for (int c = 0; c < numChannels; ++c)
        for (std::size_t i = 0; i < n; ++i)
            mono[i] = static_cast<float>(double(mono[i]) + double(channels[c][i]) * k);
    return mono;
}

std::vector<double> analysisMixWeights(const float* const* channels, int numChannels, std::size_t n)
{
    if (numChannels < 2)
        return numChannels == 1 ? std::vector<double>{1.0} : std::vector<double>{};
    const double k = 1.0 / numChannels;
    std::vector<double> sq(static_cast<std::size_t>(numChannels), 0.0);
    double mix = 0;
    for (std::size_t i = 0; i < n; ++i)
    {
        double m = 0;
        for (int c = 0; c < numChannels; ++c)
        {
            const double v = channels[c][i];
            sq[static_cast<std::size_t>(c)] += v * v;
            m += v;
        }
        mix += (m * k) * (m * k);
    }
    double tot = 0;
    for (double s : sq)
        tot += s;
    const double mean = tot / numChannels;
    std::vector<double> avg(static_cast<std::size_t>(numChannels), k);
    if (!(mean > 0) || mix >= mean * 1e-3) // 10 ** (−30 / 10)
        return avg;
    if (numChannels == 2)
        return {0.5, -0.5};
    int best = 0;
    for (int c = 1; c < numChannels; ++c)
        if (sq[static_cast<std::size_t>(c)] > sq[static_cast<std::size_t>(best)])
            best = c;
    std::vector<double> w(static_cast<std::size_t>(numChannels), 0.0);
    w[static_cast<std::size_t>(best)] = 1;
    return w;
}

std::vector<float> toAnalysisMono(const float* const* channels, int numChannels, std::size_t n, double sampleRate, double targetRate)
{
    if (numChannels <= 0 || !channels)
        return {};
    const std::vector<double> weights = analysisMixWeights(channels, numChannels, n);
    bool plain = true;
    for (double w : weights)
        if (w != 1.0 / numChannels)
            plain = false;
    if (js::round(sampleRate) == js::round(targetRate))
    {
        if (plain)
            return downmixMono(channels, numChannels, n);
        std::vector<float> mono(n);
        mixInto(channels, numChannels, weights, 0, n, mono.data());
        return mono;
    }
    const Resampler r(sampleRate, targetRate, kAnalysisResampler);
    std::vector<float> out(r.outLength(n));
    const std::size_t block = std::size_t(1) << 16;
    std::vector<float> tmp;
    for (std::size_t j0 = 0; j0 < out.size(); j0 += block)
    {
        const std::size_t j1 = std::min(out.size(), j0 + block);
        const auto range = r.inputRange(j0, j1, n);
        if (tmp.size() < range.second - range.first)
            tmp.resize(range.second - range.first);
        mixInto(channels, numChannels, weights, range.first, range.second, tmp.data());
        r.process(tmp.data(), out.data(), j0, j1, range.first, n);
    }
    return out;
}

} // namespace djec
