// FFT radix-2 (compleja y real) — port de js/analysis/fft.js (mismas tablas y mismo orden de operaciones).
// Sin cachés globales: cada objeto tiene sus tablas (el análisis puede correr en varios hilos a la vez).
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace djec
{
namespace analysis
{

bool isPow2(std::size_t n);
std::size_t nextPow2(std::size_t n);

/** FFT compleja in-place de tamaño n (potencia de 2 >= 2). */
class ComplexFFT
{
public:
    explicit ComplexFFT(std::size_t n);
    std::size_t size() const { return n_; }
    /** Transforma (re, im) in-place. inverse = true: inversa SIN normalizar. */
    void transform(double* re, double* im, bool inverse = false) const;
    /** Mariposas sobre datos ya en orden de bits invertidos. */
    void butterflies(double* re, double* im, bool inverse) const;
    const std::vector<uint32_t>& rev() const { return rev_; }

private:
    std::size_t n_;
    std::vector<uint32_t> rev_;
    std::vector<double> cos_, sin_;
};

/** FFT real de tamaño n (potencia de 2 >= 4) mediante una compleja de n/2. Resultado en re()/im() (bins 0..n/2). */
class RealFFT
{
public:
    explicit RealFFT(std::size_t n);
    std::size_t size() const { return n_; }
    void forward(const double* x);
    const std::vector<double>& re() const { return re_; }
    const std::vector<double>& im() const { return im_; }

private:
    std::size_t n_, half_;
    ComplexFFT cfft_;
    std::vector<double> zr_, zi_, re_, im_, twr_, twi_;
};

/** Ventana de Hann periódica de longitud n (valores float, como el Float32Array de la web). */
std::vector<float> hannWindow(std::size_t n);

} // namespace analysis
} // namespace djec
