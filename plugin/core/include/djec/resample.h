// Remuestreo FIR sinc·Kaiser de fase lineal y mezcla mono para el análisis — port de js/audio/decode.js
// (createResampler, resample, downmixMono, analysisMixWeights, toAnalysisMono). Sin JUCE; fuera del hilo de audio.
#pragma once

#include <cstddef>
#include <utility>
#include <vector>

namespace djec
{

struct ResamplerOptions
{
    int zeroCrossings = 12; // semiancho del núcleo (en muestras de la frecuencia más baja)
    double rolloff = 0.93;  // corte relativo a la Nyquist de la frecuencia más baja
};

/** Opciones del remuestreo para el análisis (ANALYSIS_RESAMPLER de la web). */
constexpr ResamplerOptions kAnalysisResampler{10, 0.92};

class Resampler
{
public:
    /** std::invalid_argument("Frecuencia de muestreo no válida.") si alguna frecuencia redondeada no es > 0. */
    Resampler(double fromRate, double toRate, ResamplerOptions options = {});

    int fromRate() const { return from_; }
    int toRate() const { return to_; }
    std::size_t outLength(std::size_t n) const;
    /** Tramo de la entrada [lo, hi) necesario para calcular out[j0, j1) de una entrada de `total` muestras. */
    std::pair<std::size_t, std::size_t> inputRange(std::size_t j0, std::size_t j1, std::size_t total) const;
    /** Calcula out[j0, j1). x contiene las muestras [xOffset, xOffset + ...) de una entrada de `total` muestras. */
    void process(const float* x, float* out, std::size_t j0, std::size_t j1, std::size_t xOffset, std::size_t total) const;

private:
    double kernel(double t) const;

    int from_, to_;
    double cutoff_, i0b_;
    long long half_, taps_;
    long long P_, Q_, phases_;
    double step_;
    std::vector<float> coef_;
};

/** Remuestrea una señal entera (copia si las frecuencias redondeadas coinciden). */
std::vector<float> resample(const float* x, std::size_t n, double fromRate, double toRate, ResamplerOptions options = {});

/** Promedio de canales (mismo orden de operaciones que la web). */
std::vector<float> downmixMono(const float* const* channels, int numChannels, std::size_t n);

/** Pesos de la mezcla mono: promedio; con canales en contrafase, (L − R)/2 o el canal más fuerte. */
std::vector<double> analysisMixWeights(const float* const* channels, int numChannels, std::size_t n);

/** Mono a targetRate (normalmente 22050 Hz) para djec::Analyzer. n = muestras por canal. */
std::vector<float> toAnalysisMono(const float* const* channels, int numChannels, std::size_t n, double sampleRate,
                                  double targetRate = 22050);

} // namespace djec
