// Seguimiento de beats por programación dinámica con tempo variable — port de js/analysis/beats-dp.js
// (+ refineBeats de js/analysis/beats.js).
#pragma once

#include "djec/analysis/features.h"
#include "djec/analysis/tempo.h"

#include <cstddef>
#include <limits>
#include <optional>
#include <vector>

namespace djec
{
namespace analysis
{

/** DP_DEFAULTS de beats-dp.js. */
struct DpOptions
{
    double minBpm = 50, maxBpm = 220;
    double lowWeight = 0.5, normSec = 3, normFloor = 0.15, smoothSigma = 1;
    double tempoWindowBeats = 8, tempoWindowMin = 4, tempoWindowMax = 8, tempoHopSec = 0.25;
    double pathLo = -0.75, pathHi = 0.5, pathStep = 1.0 / 96, pathWeight = 4;
    double combSub = 1, combDouble = 0.5, combBar = 0.5, barThreeBias = 1.1, combWindowBeats = 16, combWindowMax = 12;
    double pathSigma = 0.05, pathPrior = 1, endBeats = 8, endSigmaMult = 2;
    enum class PathCore
    {
        Auto,
        Always,
        Off
    } pathCore = PathCore::Auto;
    double pathCoreLo = -0.35, pathCoreHi = 0.35, pathCoreMaxOff = 0.5;
    bool sectionCheck = true;
    double sectionLo = -0.5;
    int sectionMinBeats = 8;
    double sectionCoreLo = -0.45;
    double hintLo = -0.52, hintHi = 0.38, strictLo = 0.8, strictHi = 1.25;
    double tightness = 300;
    int passes = 2, ibiSmoothBeats = 2;
    double edgeRatio = 0.3;
    int maxTailBeats = 8;
    double tailDropDb = 24, tailCutDb = 8;
    int refineFrames = 2;
    double refineMinSal = 1.5, strengthHalf = 3;
    bool octaveCheck = true;
    double octaveHalfThreshold = 0.48, octaveDoubleThreshold = 0.5, octaveEvidenceWeight = 3, octavePriorCenter = 115,
           octavePriorSigma = 0.8;
    int octaveMinBeats = 16;
    double steadyBelowContrast = 2, steadyTightnessMult = 10, octaveMinContrast = 2;
    double confidenceLo = 1.5, confidenceHi = 4; // confidenceContrast
};

/** Ajustes del camino de tempo para una decodificación (opts.lo/hi/coreLo/coreHi/endFrame de tempoPath). */
struct PathOverrides
{
    std::optional<double> lo, hi;
    double coreLo = std::numeric_limits<double>::quiet_NaN();
    double coreHi = std::numeric_limits<double>::quiet_NaN();
    double endFrame = std::numeric_limits<double>::quiet_NaN();
};

struct BeatEnvelope
{
    std::vector<float> env, score;
};

BeatEnvelope beatEnvelope(const Features& f, int f0, int f1, const DpOptions& o = {});

/** Periodo local (tramas por beat) para cada trama de env. */
std::vector<double> tempoPath(const std::vector<float>& env, double fps, double bpm0, const DpOptions& o,
                              const PathOverrides& p = {});

struct DpForward
{
    std::vector<double> cum;
    std::vector<int> back;
};

DpForward dpForward(const std::vector<float>& score, const std::vector<double>& period, double tightness, bool alwaysLink = false);

double offCoreFraction(const std::vector<int>& beatsF, double bpm0, double fps, double endF, double lo, double hi);

struct BeatRun
{
    int from, to;
};
std::optional<BeatRun> slowRun(const std::vector<int>& beatsF, double bpm0, double fps, double endF, double lo);

struct OctaveEvidence
{
    double parity, mid;
    int n;
};

struct TrackOptions
{
    DpOptions dp;
    double bpmHint = 0; // > 0: tempo indicado (botones ×2 / ÷2, tempo manual)
    bool strict = false;
    double musicStart = std::numeric_limits<double>::quiet_NaN();
    double musicEnd = std::numeric_limits<double>::quiet_NaN();
    const float* samples = nullptr; // para findMusicBounds si faltan musicStart / musicEnd
    std::size_t numSamples = 0;
    double sampleRate = 0;
    const TempoEstimate* tempo = nullptr; // tempo global ya estimado (se recalcula con bpmHint)
};

struct TrackResult
{
    std::vector<double> beats, strength;
    double bpm = 0, confidence = 0, contrast = 0;
    int extrapolated = 0;
    bool octaveApplied = false, metricLevelApplied = false, sectionApplied = false;
};

TrackResult trackBeats(const Features& f, const TrackOptions& opts);

/** refineBeats de beats.js: lleva cada beat al ataque cercano (nunca > maxLater más tarde), orden estricto. */
std::vector<double> refineBeats(const float* samples, std::size_t n, double sampleRate, const std::vector<double>& beats,
                                double musicStart, double musicEnd, double window = 0.03, double maxLater = 0.005);

} // namespace analysis
} // namespace djec
