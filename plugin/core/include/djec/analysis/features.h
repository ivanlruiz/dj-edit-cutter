// Características para el análisis rítmico — port de js/analysis/features.js.
// Tramas CENTRADAS: la trama i está centrada en la muestra i*hop; time(i) = i*hop/sampleRate.
#pragma once

#include <cstddef>
#include <functional>
#include <vector>

namespace djec
{
namespace analysis
{

struct FeatureOptions
{
    int frameSize = 1024;
    int hop = 256;
    int bandsPerOctave = 24;
    double fmin = 30, fmax = 11000;
    double lowCutoff = 200;
    double logMul = 1;
    int maxFilterBands = 3;
    int lag = 1;
    int refFrames = 3;
    int chromaFrameSize = 2048;
    int chromaHopFactor = 4;
    double chromaFmin = 100, chromaFmax = 4000;
    double normQuantile = 0.99;
    double whitenTau = 1, whitenFloor = 0.02;
    double highCutoff = 2000;
    double flatnessFmin = 300, flatnessFmax = 5000;
    double flatnessSec = 0.25;
    int flatnessStep = 4;
    std::function<void(double)> onProgress; // fracción 0..1 creciente (puede estar vacío)
};

/** Ver el typedef Features de features.js (mismos campos y unidades). */
struct Features
{
    double sampleRate = 0;
    int hop = 256, frameSize = 1024;
    double fps = 0;
    int numFrames = 0;
    double duration = 0;
    double peak = 0;
    std::vector<float> onset, onsetLow;
    double onsetScale = 1, onsetLowScale = 1;
    int numBands = 0, numLowBands = 0;
    int firstValidFrame = 0, lastValidFrame = 0;
    std::vector<float> chroma; // numFrames*12
    std::vector<float> rms, rmsHigh, flatness;
};

Features computeFeatures(const float* samples, std::size_t n, double sampleRate, const FeatureOptions& opts = {});

struct PeakOptions
{
    double threshold = 0.02, relThreshold = 1, preMax = 0.03, postMax = 0.03, preAvg = 0.1, postAvg = 0.07,
           combine = 0.03, minValue = 0;
};

/** Selección de picos estilo madmom (pickPeaks de features.js). Devuelve índices de trama. */
std::vector<int> pickPeaks(const std::vector<float>& env, double fps, const PeakOptions& o = {});

} // namespace analysis
} // namespace djec
