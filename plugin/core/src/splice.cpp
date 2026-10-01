// Port de js/audio/splice.js (renderSegments con la ventana completa, mixCrossfade, renderedLength).
#include "djec/splice.h"

#include "djec/fade.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace djec
{

const double kSpliceCeiling = std::pow(10.0, -1.0 / 20);

namespace
{
constexpr double kHalfPi = 3.141592653589793 / 2;   // Math.PI / 2
// Mezclas de las ganancias adaptadas con las de igual ganancia (cos²/sin², nunca superan el pico de A o B)
constexpr double kGuardBlends[5] = {0, 0.25, 0.5, 0.75, 1};

// Math.round (los .5 hacia +∞)
double jsRound(double x)
{
    if (!std::isfinite(x))
        return x;
    const double f = std::floor(x);
    return (x - f >= 0.5) ? f + 1.0 : f;
}

struct Seg
{
    std::int64_t s0, s1, len, out;
    bool spliceIn, spliceOut;
};

std::vector<Seg> sampleSegments(const std::vector<Segment>& segments, double sr, std::int64_t& total)
{
    std::vector<Seg> segs;
    segs.reserve(segments.size());
    total = 0;
    for (const Segment& s : segments)
    {
        const double a = jsRound(s.start * sr);
        const double b = jsRound(s.end * sr);
        if (!std::isfinite(a) || !std::isfinite(b) || b <= a)
            continue;
        const std::int64_t s0 = static_cast<std::int64_t>(a);
        const std::int64_t s1 = static_cast<std::int64_t>(b);
        segs.push_back(Seg{s0, s1, s1 - s0, total, false, false});
        total += s1 - s0;
    }
    return segs;
}
} // namespace

std::int64_t renderedLength(const std::vector<Segment>& segments, double sampleRate)
{
    if (!(sampleRate > 0) || !std::isfinite(sampleRate))
        return 0;
    std::int64_t total = 0;
    sampleSegments(segments, sampleRate, total);
    return total;
}

void mixCrossfade(const double* a, const double* b, std::size_t L, const double* c, const double* s, double* y)
{
    double saa = 0, sbb = 0, sab = 0, peak = 0;
    for (std::size_t j = 0; j < L; ++j)
    {
        const double va = a[j];
        const double vb = b[j];
        saa += va * va;
        sbb += vb * vb;
        sab += va * vb;
        const double m = std::max(std::fabs(va), std::fabs(vb));
        if (m > peak)
            peak = m;
    }
    const double rho = saa > 0 && sbb > 0 ? std::min(1.0, std::max(0.0, sab / std::sqrt(saa * sbb))) : 0;
    const double limit = std::max(peak, kSpliceCeiling) * (1 + 1e-6);
    for (double t : kGuardBlends)
    {
        bool over = false;
        for (std::size_t j = 0; j < L; ++j)
        {
            const double cj = c[j];
            const double sj = s[j];
            const double k = (1 - t) / std::sqrt(1 + 2 * rho * cj * sj);
            const double v = a[j] * cj * (k + t * cj) + b[j] * sj * (k + t * sj);
            y[j] = v;
            if (std::fabs(v) > limit)
                over = true;
        }
        if (!over)
            break;
    }
}

void renderSegments(const float* const* in, int numChannels, std::size_t inLength, double sampleRate,
                    const std::vector<Segment>& segments, double crossfadeSec, double fadeOutSec,
                    const std::string& curve, std::vector<std::vector<float>>& out)
{
    const int nCh = std::max(0, numChannels);
    out.assign(static_cast<std::size_t>(nCh), std::vector<float>());
    if (!nCh)
        return;
    const double sr = sampleRate;
    if (!(sr > 0) || !std::isfinite(sr))
        return;

    // Rangos en muestras (índice = round(t · sr)); lo que cae fuera de la fuente es silencio.
    std::int64_t total = 0;
    std::vector<Seg> segs = sampleSegments(segments, sr, total);
    for (std::size_t i = 0; i + 1 < segs.size(); ++i)
    {
        const std::int64_t gap = segs[i].s1 - segs[i + 1].s0;
        if (gap > 1 || gap < -1)
        {
            segs[i].spliceOut = true;
            segs[i + 1].spliceIn = true;
        }
    }

    const std::int64_t n = static_cast<std::int64_t>(inLength);
    // Copia directa (bit a bit) de cada rango; lo que cae fuera de la fuente queda en 0.
    for (int c = 0; c < nCh; ++c)
    {
        std::vector<float>& dst = out[static_cast<std::size_t>(c)];
        dst.assign(static_cast<std::size_t>(total), 0.0f);
        const float* src = in[c];
        for (const Seg& g : segs)
        {
            const std::int64_t a = std::max<std::int64_t>(g.s0, 0);
            const std::int64_t b = std::min<std::int64_t>(g.s1, n);
            if (b > a)
                std::memcpy(dst.data() + g.out + (a - g.s0), src + a, static_cast<std::size_t>(b - a) * sizeof(float));
        }
    }

    // Crossfades centrados en cada empalme: A sigue sonando después de su fin, B empieza antes de su inicio.
    // Se acortan en los bordes de la fuente y en segmentos cortos (un segmento con empalmes en ambos lados cede
    // como mucho la mitad a cada uno).
    const double xfD = jsRound((std::isnan(crossfadeSec) ? 0.0 : crossfadeSec) * sr);
    const std::int64_t xf = std::isfinite(xfD) ? std::max<std::int64_t>(0, static_cast<std::int64_t>(xfD)) : 0;
    if (xf >= 2 && segs.size() > 1)
    {
        const std::int64_t srcLen = n;
        std::vector<double> gA(static_cast<std::size_t>(xf)), gB(static_cast<std::size_t>(xf));
        std::vector<double> va(static_cast<std::size_t>(xf)), vb(static_cast<std::size_t>(xf));
        std::vector<double> mix(static_cast<std::size_t>(xf));
        std::int64_t gLen = 0;
        for (std::size_t i = 0; i + 1 < segs.size(); ++i)
        {
            const Seg& A = segs[i];
            const Seg& B = segs[i + 1];
            if (!A.spliceOut)
                continue;
            std::int64_t h = xf >> 1;
            std::int64_t r = xf - h;
            h = std::max<std::int64_t>(0, std::min({h, A.spliceIn ? A.len / 2 : A.len, B.s0}));
            r = std::max<std::int64_t>(0, std::min({r, B.spliceOut ? B.len / 2 : B.len, srcLen - A.s1}));
            const std::int64_t L = h + r;
            if (L < 2)
                continue;
            const std::int64_t o0 = B.out - h;
            if (L != gLen)
            {
                for (std::int64_t j = 0; j < L; ++j)
                {
                    const double x = (static_cast<double>(j) + 0.5) / static_cast<double>(L);
                    gA[static_cast<std::size_t>(j)] = std::cos(x * kHalfPi);
                    gB[static_cast<std::size_t>(j)] = std::sin(x * kHalfPi);
                }
                gLen = L;
            }
            const std::int64_t ia0 = A.s1 - h;
            const std::int64_t ib0 = B.s0 - h;
            for (int c = 0; c < nCh; ++c)
            {
                const float* src = in[c];
                float* dst = out[static_cast<std::size_t>(c)].data();
                for (std::int64_t j = 0; j < L; ++j)
                {
                    const std::int64_t ia = ia0 + j;
                    const std::int64_t ib = ib0 + j;
                    va[static_cast<std::size_t>(j)] = ia >= 0 && ia < n ? static_cast<double>(src[ia]) : 0.0;
                    vb[static_cast<std::size_t>(j)] = ib >= 0 && ib < n ? static_cast<double>(src[ib]) : 0.0;
                }
                mixCrossfade(va.data(), vb.data(), static_cast<std::size_t>(L), gA.data(), gB.data(), mix.data());
                for (std::int64_t j = 0; j < L; ++j)
                    dst[o0 + j] = static_cast<float>(mix[static_cast<std::size_t>(j)]);
            }
        }
    }

    // Fade-out final (siempre al menos el anti-clic); la última muestra queda en 0. Mismas ganancias que el corte.
    const double fo = std::isnan(fadeOutSec) ? 0.0 : fadeOutSec;
    const double fD = jsRound(std::max(fo, kAntiClickSec) * sr);
    const std::int64_t F = std::min<std::int64_t>(total, std::isfinite(fD) ? static_cast<std::int64_t>(fD) : total);
    if (F > 0)
    {
        const std::int64_t start = total - F;
        const std::vector<float> gains = fadeOutGains(static_cast<std::size_t>(F), curve);
        for (int c = 0; c < nCh; ++c)
        {
            float* dst = out[static_cast<std::size_t>(c)].data() + start;
            for (std::size_t i = 0; i < gains.size(); ++i)
                dst[i] *= gains[i];
        }
    }
}

} // namespace djec
