// Ubicar un archivo en la línea de tiempo (ver djec/align.h).
//
// 1) Decimación (archivo y trozo igual): mezcla mono, dos medias móviles de D muestras (filtro paso bajo de tipo
//    CIC-2, nulos en los múltiplos de la frecuencia nueva) y una muestra de cada D (≈ 2 kHz).
// 2) Correlación cruzada de las señales decimadas por FFT en bloques (overlap-save, dos bloques reales por FFT
//    compleja), normalizada en cada posición con la energía del solape (prefijos): ρ ∈ [−1, 1], insensible a la
//    ganancia. Se quedan las mejores posiciones separadas al menos 50 ms.
// 3) Cada candidata se afina a la muestra a frecuencia completa (±D muestras, ρ sobre ≤ 4 s del trozo) y la mejor
//    se confirma con ρ sobre todo el solape. Si otra candidata correlaciona casi igual, la música se repite: ambiguo.
#include "djec/align.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <vector>

namespace djec
{

namespace
{
constexpr double kPi = 3.141592653589793;
constexpr int kCandidates = 4;
constexpr double kSeparationSec = 0.05;   // candidatas distintas: a más de 50 ms
constexpr double kRefineWindowSec = 4.0;  // ρ del afinado sobre como mucho 4 s del trozo
constexpr double kQuietRms = 1e-4;        // −80 dBFS: el trozo es silencio
constexpr double kRefineCoarseGap = 0.2;  // se afinan las candidatas con ρ grueso >= el mejor − esto

class Fft
{
public:
    explicit Fft(std::size_t n) : n_(n), rev_(n), cos_(n / 2), sin_(n / 2)
    {
        int bits = 0;
        while ((std::size_t(1) << bits) < n)
            ++bits;
        for (std::size_t i = 0; i < n; ++i)
        {
            std::size_t r = 0;
            for (int b = 0; b < bits; ++b)
                if (i & (std::size_t(1) << b))
                    r |= std::size_t(1) << (bits - 1 - b);
            rev_[i] = r;
        }
        for (std::size_t k = 0; k < n / 2; ++k)
        {
            cos_[k] = std::cos(2 * kPi * static_cast<double>(k) / static_cast<double>(n));
            sin_[k] = std::sin(2 * kPi * static_cast<double>(k) / static_cast<double>(n));
        }
    }

    std::size_t size() const { return n_; }

    // En el lugar; inverse sin normalizar (el llamador divide por n).
    void run(double* re, double* im, bool inverse) const
    {
        const std::size_t n = n_;
        for (std::size_t i = 0; i < n; ++i)
        {
            const std::size_t r = rev_[i];
            if (r > i)
            {
                std::swap(re[i], re[r]);
                std::swap(im[i], im[r]);
            }
        }
        const double sgn = inverse ? 1.0 : -1.0;
        for (std::size_t len = 2; len <= n; len <<= 1)
        {
            const std::size_t half = len >> 1;
            const std::size_t step = n / len;
            for (std::size_t i = 0; i < n; i += len)
            {
                double* ra = re + i;
                double* ia = im + i;
                double* rb = re + i + half;
                double* ib = im + i + half;
                for (std::size_t k = 0; k < half; ++k)
                {
                    const double wr = cos_[k * step];
                    const double wi = sgn * sin_[k * step];
                    const double tr = rb[k] * wr - ib[k] * wi;
                    const double ti = rb[k] * wi + ib[k] * wr;
                    rb[k] = ra[k] - tr;
                    ib[k] = ia[k] - ti;
                    ra[k] += tr;
                    ia[k] += ti;
                }
            }
        }
    }

private:
    std::size_t n_;
    std::vector<std::size_t> rev_;
    std::vector<double> cos_, sin_;
};

std::size_t nextPow2(std::size_t x)
{
    std::size_t p = 1;
    while (p < x)
        p <<= 1;
    return p;
}

// Mezcla mono de los canales en la muestra i
inline float monoAt(const float* const* ch, int nCh, std::size_t i)
{
    if (nCh == 1)
        return ch[0][i];
    float s = 0;
    for (int c = 0; c < nCh; ++c)
        s += ch[c][i];
    return s / static_cast<float>(nCh);
}

// Paso bajo CIC-2 (dos medias móviles de D) + una muestra de cada D. Salida m = filtro en la muestra m·D + D − 1.
std::vector<float> decimate(const float* const* ch, int nCh, std::size_t len, int D)
{
    const std::size_t outN = (len + static_cast<std::size_t>(D) - 1) / static_cast<std::size_t>(D);
    std::vector<float> out(outN);
    std::vector<double> xr(static_cast<std::size_t>(D), 0.0), s1r(static_cast<std::size_t>(D), 0.0);
    double s1 = 0, s2 = 0;
    const double inv = 1.0 / (static_cast<double>(D) * D);
    std::size_t idx = 0, m = 0;
    const std::size_t total = outN * static_cast<std::size_t>(D);
    for (std::size_t n = 0; n < total; ++n)
    {
        const double x = n < len ? static_cast<double>(monoAt(ch, nCh, n)) : 0.0;
        s1 += x - xr[idx];
        xr[idx] = x;
        s2 += s1 - s1r[idx];
        s1r[idx] = s1;
        if (++idx == static_cast<std::size_t>(D))
        {
            idx = 0;
            out[m++] = static_cast<float>(s2 * inv);
        }
    }
    return out;
}

std::vector<double> prefixEnergy(const float* x, std::size_t n)
{
    std::vector<double> p(n + 1);
    p[0] = 0;
    for (std::size_t i = 0; i < n; ++i)
        p[i + 1] = p[i] + static_cast<double>(x[i]) * x[i];
    return p;
}

struct Candidate
{
    long long m;        // posición gruesa (muestras decimadas)
    double coarse;      // ρ grueso
    long long L = 0;    // posición afinada (muestras)
    double fine = -2;   // ρ afinado (ventana)
};
} // namespace

struct Aligner::Impl
{
    std::vector<const float*> channels;
    int numChannels = 0;
    std::size_t fileLen = 0;
    double sampleRate = 0;
    AlignOptions options;
    int D = 1;
    std::vector<float> fileDec;
    std::vector<double> fileDecEnergy;   // prefijos de fileDec²
    bool ready = false;

    double fileMonoAt(long long i) const
    {
        if (i < 0 || static_cast<std::size_t>(i) >= fileLen)
            return 0.0;
        return monoAt(channels.data(), numChannels, static_cast<std::size_t>(i));
    }

    // ρ a frecuencia completa del trozo [j0, j1) contra el archivo en la posición L (fm: mono del archivo desde base)
    static double nccAt(const float* x, long long j0, long long j1, const std::vector<float>& fm, long long base,
                        long long L)
    {
        double num = 0, ex = 0, ef = 0;
        for (long long j = j0; j < j1; ++j)
        {
            const double xv = x[j];
            const double fv = fm[static_cast<std::size_t>(L + j - base)];
            num += xv * fv;
            ex += xv * xv;
            ef += fv * fv;
        }
        if (!(ex > 0) || !(ef > 0))
            return 0;
        return num / std::sqrt(ex * ef);
    }
};

Aligner::Aligner() : impl_(std::make_unique<Impl>()) {}
Aligner::~Aligner() = default;
Aligner::Aligner(Aligner&&) noexcept = default;
Aligner& Aligner::operator=(Aligner&&) noexcept = default;

void Aligner::prepare(const float* fileMono, std::size_t fileLen, double sampleRate, const AlignOptions& options)
{
    const float* ch[1] = {fileMono};
    prepare(ch, 1, fileLen, sampleRate, options);
}

void Aligner::prepare(const float* const* fileChannels, int numChannels, std::size_t fileLen, double sampleRate,
                      const AlignOptions& options)
{
    Impl& d = *impl_;
    d = Impl();
    d.options = options;
    if (!fileChannels || numChannels < 1 || !(sampleRate > 0) || !std::isfinite(sampleRate) || fileLen == 0)
        return;
    for (int c = 0; c < numChannels; ++c)
        if (!fileChannels[c])
            return;
    d.channels.assign(fileChannels, fileChannels + numChannels);
    d.numChannels = numChannels;
    d.fileLen = fileLen;
    d.sampleRate = sampleRate;
    const double rc = options.coarseRate > 0 ? options.coarseRate : 2000;
    d.D = std::max(1, static_cast<int>(std::lround(sampleRate / rc)));
    d.fileDec = decimate(d.channels.data(), numChannels, fileLen, d.D);
    d.fileDecEnergy = prefixEnergy(d.fileDec.data(), d.fileDec.size());
    d.ready = true;
}

bool Aligner::prepared() const
{
    return impl_->ready;
}

AlignResult Aligner::find(const float* x, std::size_t inputLen) const
{
    const auto t0 = std::chrono::steady_clock::now();
    AlignResult res;
    auto finish = [&]() {
        res.elapsedMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        return res;
    };
    const Impl& d = *impl_;
    if (!d.ready || !x || inputLen == 0)
        return finish();
    const double sr = d.sampleRate;
    const int D = d.D;
    const AlignOptions& o = d.options;

    // ¿hay señal en el trozo?
    {
        double e = 0;
        for (std::size_t i = 0; i < inputLen; ++i)
            e += static_cast<double>(x[i]) * x[i];
        if (!(std::sqrt(e / static_cast<double>(inputLen)) >= kQuietRms))
        {
            res.tooQuiet = true;
            return finish();
        }
    }

    // ---- búsqueda gruesa ----
    const float* xin[1] = {x};
    const std::vector<float> xd = decimate(xin, 1, inputLen, D);
    const long long Nx = static_cast<long long>(xd.size());
    const long long Nf = static_cast<long long>(d.fileDec.size());
    if (Nx < 8 || Nf < 8)
        return finish();
    const std::vector<double> px = prefixEnergy(xd.data(), xd.size());
    const double rc = sr / D;
    const long long minOvD = std::max<long long>(4, std::min<long long>(Nx, std::llround(o.minOverlapSec * rc)));
    long long mMin = -(Nx - minOvD);
    long long mMax = Nf - minOvD;
    if (o.minFileOffset != std::numeric_limits<std::int64_t>::min())
        mMin = std::max(mMin, static_cast<long long>(std::floor(static_cast<double>(o.minFileOffset) / D)) - 2);
    if (o.maxFileOffset != std::numeric_limits<std::int64_t>::max())
        mMax = std::min(mMax, static_cast<long long>(std::ceil(static_cast<double>(o.maxFileOffset) / D)) + 2);
    if (mMax < mMin)
        return finish();

    const std::size_t B = nextPow2(static_cast<std::size_t>(std::max<long long>(4096, 4 * Nx)));
    const long long step = static_cast<long long>(B) - Nx + 1;
    const Fft fft(B);
    std::vector<double> xr(B, 0.0), xi(B, 0.0);
    for (long long j = 0; j < Nx; ++j)
        xr[static_cast<std::size_t>(j)] = xd[static_cast<std::size_t>(j)];
    fft.run(xr.data(), xi.data(), false);

    const long long nLags = mMax - mMin + 1;
    std::vector<float> ncc(static_cast<std::size_t>(nLags), -2.0f);
    std::vector<double> zr(B), zi(B);
    const double invB = 1.0 / static_cast<double>(B);
    auto fileDecAt = [&](long long i) -> double {
        return (i >= 0 && i < Nf) ? static_cast<double>(d.fileDec[static_cast<std::size_t>(i)]) : 0.0;
    };
    auto store = [&](long long m, double c) {
        const long long j0 = std::max<long long>(0, -m);
        const long long j1 = std::min<long long>(Nx, Nf - m);
        if (j1 - j0 < minOvD)
            return;
        const double ex = px[static_cast<std::size_t>(j1)] - px[static_cast<std::size_t>(j0)];
        const double ef = d.fileDecEnergy[static_cast<std::size_t>(m + j1)] -
                          d.fileDecEnergy[static_cast<std::size_t>(m + j0)];
        const double ov = static_cast<double>(j1 - j0);
        if (!(ex > 1e-12 * ov) || !(ef > 1e-12 * ov))
            return;
        ncc[static_cast<std::size_t>(m - mMin)] = static_cast<float>(c / std::sqrt(ex * ef));
    };
    for (long long s = mMin; s <= mMax; s += 2 * step)
    {
        // dos bloques reales en una FFT compleja: z = bloque1 + i·bloque2
        for (std::size_t q = 0; q < B; ++q)
        {
            zr[q] = fileDecAt(s + static_cast<long long>(q));
            zi[q] = fileDecAt(s + step + static_cast<long long>(q));
        }
        fft.run(zr.data(), zi.data(), false);
        for (std::size_t q = 0; q < B; ++q)
        {
            // Z · conj(X)
            const double ar = zr[q], ai = zi[q], br = xr[q], bi = -xi[q];
            zr[q] = ar * br - ai * bi;
            zi[q] = ar * bi + ai * br;
        }
        fft.run(zr.data(), zi.data(), true);
        for (long long q = 0; q < step; ++q)
        {
            const long long m1 = s + q;
            const long long m2 = s + step + q;
            if (m1 <= mMax)
                store(m1, zr[static_cast<std::size_t>(q)] * invB);
            if (m2 <= mMax)
                store(m2, zi[static_cast<std::size_t>(q)] * invB);
        }
    }

    // mejores posiciones separadas al menos 50 ms
    std::vector<Candidate> cands;
    {
        std::vector<float> work = ncc;
        const long long sep = std::max<long long>(1, std::llround(kSeparationSec * rc));
        for (int k = 0; k < kCandidates; ++k)
        {
            long long best = -1;
            float bv = -1.5f;
            for (long long i = 0; i < nLags; ++i)
                if (work[static_cast<std::size_t>(i)] > bv)
                {
                    bv = work[static_cast<std::size_t>(i)];
                    best = i;
                }
            if (best < 0 || !(bv > 0))
                break;
            cands.push_back(Candidate{best + mMin, bv});
            for (long long i = std::max<long long>(0, best - sep); i <= std::min(nLags - 1, best + sep); ++i)
                work[static_cast<std::size_t>(i)] = -2.0f;
        }
    }
    if (cands.empty())
        return finish();

    // ---- afinado a frecuencia completa ----
    const long long N = static_cast<long long>(inputLen);
    const long long fileLen = static_cast<long long>(d.fileLen);
    const long long minOv = std::max<long long>(16, std::min<long long>(N, std::llround(o.minOverlapSec * sr)));
    const long long W = std::max<long long>(16, std::llround(kRefineWindowSec * sr));
    const double bestCoarse = cands.front().coarse;
    for (Candidate& c : cands)
    {
        // una candidata mucho peor en la búsqueda gruesa no puede competir: no se afina (ahorra tiempo)
        if (c.coarse < bestCoarse - kRefineCoarseGap)
            continue;
        const long long Lc = c.m * D;
        long long lo = Lc - D - 2, hi = Lc + D + 2;
        lo = std::max<long long>(lo, -(N - minOv));
        hi = std::min<long long>(hi, fileLen - minOv);
        if (o.minFileOffset != std::numeric_limits<std::int64_t>::min())
            lo = std::max<long long>(lo, o.minFileOffset);
        if (o.maxFileOffset != std::numeric_limits<std::int64_t>::max())
            hi = std::min<long long>(hi, o.maxFileOffset);
        if (hi < lo)
            continue;
        // ventana del trozo: dentro del solape de todas las posiciones, centrada, como mucho W
        long long j0 = std::max<long long>(0, -lo);
        long long j1 = std::min<long long>(N, fileLen - hi);
        if (j1 - j0 < 16)
        {
            j0 = std::max<long long>(0, -hi);
            j1 = std::min<long long>(N, fileLen - lo);
        }
        if (j1 - j0 > W)
        {
            const long long mid = (j0 + j1) / 2;
            j0 = mid - W / 2;
            j1 = j0 + W;
        }
        const long long base = lo + j0;
        std::vector<float> fm(static_cast<std::size_t>(hi + j1 - base));
        for (std::size_t i = 0; i < fm.size(); ++i)
            fm[i] = static_cast<float>(d.fileMonoAt(base + static_cast<long long>(i)));
        for (long long L = lo; L <= hi; ++L)
        {
            const double r = Impl::nccAt(x, j0, j1, fm, base, L);
            if (r > c.fine)
            {
                c.fine = r;
                c.L = L;
            }
        }
    }
    std::sort(cands.begin(), cands.end(), [](const Candidate& a, const Candidate& b) { return a.fine > b.fine; });
    const Candidate& best = cands.front();
    if (!(best.fine > -2))
        return finish();
    res.fileOffsetOfInputStart = best.L;
    res.coarseScore = best.coarse;
    for (std::size_t i = 1; i < cands.size(); ++i)
        if (std::llabs(cands[i].L - best.L) > std::llround(kSeparationSec * sr) && cands[i].fine > res.secondConfidence)
        {
            res.secondConfidence = cands[i].fine;
            res.secondOffset = cands[i].L;
        }

    // ρ final sobre todo el solape
    {
        const long long j0 = std::max<long long>(0, -best.L);
        const long long j1 = std::min<long long>(N, fileLen - best.L);
        double num = 0, ex = 0, ef = 0;
        for (long long j = j0; j < j1; ++j)
        {
            const double xv = x[j];
            const double fv = d.fileMonoAt(best.L + j);
            num += xv * fv;
            ex += xv * xv;
            ef += fv * fv;
        }
        res.confidence = (ex > 0 && ef > 0) ? num / std::sqrt(ex * ef) : 0;
    }
    res.ambiguous = res.secondConfidence > 0 && res.secondConfidence >= best.fine - o.ambiguityMargin;
    res.found = !res.ambiguous && res.confidence >= o.minConfidence;
    return finish();
}

AlignResult findAlignment(const float* fileMono, std::size_t fileLen, const float* inputMono, std::size_t inputLen,
                          double sampleRate, const AlignOptions& options)
{
    const auto t0 = std::chrono::steady_clock::now();
    Aligner a;
    a.prepare(fileMono, fileLen, sampleRate, options);
    AlignResult r = a.find(inputMono, inputLen);
    r.elapsedMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    return r;
}

} // namespace djec
