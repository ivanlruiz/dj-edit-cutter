// Port de js/analysis/fft.js.
#include "djec/analysis/fft.h"

#include "djec/analysis/js_math.h"

#include <stdexcept>
#include <string>
#include <utility>

namespace djec
{
namespace analysis
{

bool isPow2(std::size_t n) { return n >= 2 && (n & (n - 1)) == 0; }

std::size_t nextPow2(std::size_t n)
{
    std::size_t p = 1;
    while (p < n)
        p <<= 1;
    return p;
}

ComplexFFT::ComplexFFT(std::size_t n) : n_(n)
{
    if (!isPow2(n))
        throw std::invalid_argument("Tamaño de FFT no potencia de 2: " + std::to_string(n));
    unsigned bits = 0;
    while ((std::size_t(1) << bits) < n)
        ++bits;
    rev_.resize(n);
    for (std::size_t i = 0; i < n; ++i)
    {
        uint32_t r = 0;
        for (unsigned b = 0; b < bits; ++b)
            r |= static_cast<uint32_t>(((i >> b) & 1u) << (bits - 1 - b));
        rev_[i] = r;
    }
    cos_.resize(n / 2);
    sin_.resize(n / 2);
    for (std::size_t k = 0; k < n / 2; ++k)
    {
        cos_[k] = js::cos((2 * js::kPi * double(k)) / double(n));
        sin_[k] = -js::sin((2 * js::kPi * double(k)) / double(n));
    }
}

void ComplexFFT::transform(double* re, double* im, bool inverse) const
{
    const std::size_t n = n_;
    for (std::size_t i = 0; i < n; ++i)
    {
        const std::size_t j = rev_[i];
        if (j > i)
        {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }
    butterflies(re, im, inverse);
}

void ComplexFFT::butterflies(double* re, double* im, bool inverse) const
{
    const std::size_t n = n_;
    for (std::size_t a = 0; a < n; a += 2)
    {
        const std::size_t b = a + 1;
        const double xr = re[b];
        const double xi = im[b];
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
    }
    if (n < 4)
        return;
    const double s4 = inverse ? -1 : 1;
    for (std::size_t a = 0; a < n; a += 4)
    {
        double xr = re[a + 2];
        double xi = im[a + 2];
        re[a + 2] = re[a] - xr;
        im[a + 2] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const double br = re[a + 3];
        const double bi = im[a + 3];
        xr = s4 * bi;
        xi = -s4 * br;
        re[a + 3] = re[a + 1] - xr;
        im[a + 3] = im[a + 1] - xi;
        re[a + 1] += xr;
        im[a + 1] += xi;
    }
    const double sgn = inverse ? -1 : 1;
    for (std::size_t size = 8; size <= n; size <<= 1)
    {
        const std::size_t half = size >> 1;
        const std::size_t step = n / size;
        for (std::size_t k = 0; k < half; ++k)
        {
            const double wr = cos_[k * step];
            const double wi = sgn * sin_[k * step];
            for (std::size_t a = k; a < n; a += size)
            {
                const std::size_t b = a + half;
                const double rb = re[b];
                const double ib = im[b];
                const double xr = rb * wr - ib * wi;
                const double xi = rb * wi + ib * wr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
}

RealFFT::RealFFT(std::size_t n)
    : n_(n), half_(n / 2), cfft_((isPow2(n) && n >= 4) ? n / 2 : 2)
{
    if (!isPow2(n) || n < 4)
        throw std::invalid_argument("Tamaño de FFT real inválido: " + std::to_string(n));
    zr_.assign(half_, 0.0);
    zi_.assign(half_, 0.0);
    re_.assign(half_ + 1, 0.0);
    im_.assign(half_ + 1, 0.0);
    twr_.resize(half_);
    twi_.resize(half_);
    for (std::size_t k = 0; k < half_; ++k)
    {
        twr_[k] = js::cos((2 * js::kPi * double(k)) / double(n));
        twi_[k] = -js::sin((2 * js::kPi * double(k)) / double(n));
    }
}

void RealFFT::forward(const double* x)
{
    const std::size_t h = half_;
    const auto& rev = cfft_.rev();
    for (std::size_t k = 0; k < h; ++k)
    {
        const std::size_t j = rev[k];
        zr_[j] = x[2 * k];
        zi_[j] = x[2 * k + 1];
    }
    cfft_.butterflies(zr_.data(), zi_.data(), false);
    re_[0] = zr_[0] + zi_[0];
    im_[0] = 0;
    re_[h] = zr_[0] - zi_[0];
    im_[h] = 0;
    for (std::size_t k = 1; k < h; ++k)
    {
        const double ar = zr_[k];
        const double ai = zi_[k];
        const double br = zr_[h - k];
        const double bi = -zi_[h - k];
        const double er = 0.5 * (ar + br);
        const double ei = 0.5 * (ai + bi);
        const double orr = 0.5 * (ai - bi);
        const double oi = -0.5 * (ar - br);
        const double wr = twr_[k];
        const double wi = twi_[k];
        re_[k] = er + wr * orr - wi * oi;
        im_[k] = ei + wr * oi + wi * orr;
    }
}

std::vector<float> hannWindow(std::size_t n)
{
    std::vector<float> w(n);
    for (std::size_t i = 0; i < n; ++i)
        w[i] = static_cast<float>(0.5 - 0.5 * js::cos((2 * js::kPi * double(i)) / double(n)));
    return w;
}

} // namespace analysis
} // namespace djec
