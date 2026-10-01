// Límites de la música, último onset, zona de aplausos y ajuste a transitorios — port de js/analysis/bounds.js.
#pragma once

#include "djec/analysis/features.h"

#include <cstddef>
#include <optional>
#include <vector>

namespace djec
{
namespace analysis
{

struct BoundsOptions
{
    double thresholdDb = -50, maxThresholdDb = -35, noiseMarginDb = 10;
    double windowSec = 0.02, hopSec = 0.01, minActiveSec = 0.03;
};

struct MusicBounds
{
    double musicStart = 0, musicEnd = 0, thresholdDb = -50, noiseFloorDb = 0, peakRms = 0;
};

MusicBounds findMusicBounds(const float* samples, std::size_t n, double sampleRate, const BoundsOptions& o = {});

struct NoiseTailOptions
{
    double step = 0.25, flatHalf = 0.5, minFlatness = 0.6, densHalf = 0.75, minDensity = 5, periodWin = 3,
           maxPeriodicity = 0.35, maxLevelDb = -4, maxGap = 1.5, minRun = 1, minTotal = 2, tailSlack = 2.5;
    bool weakExtend = true;
    double extendFlatness = 0.5, maxExtend = 3, extendDropDb = 18, margin = 0.4, outstanding = 4;
};

struct NoiseTail
{
    double start, coreStart, end, peakRef, minHeight;
};

/** peaks: picos de onset hasta musicEnd (si es nullptr se calculan). */
std::optional<NoiseTail> findNoiseTail(const Features& f, double musicEnd, const NoiseTailOptions& o = {},
                                       const std::vector<int>* peaks = nullptr);

struct LastOnsetOptions
{
    double relHeight = 0.2, minLevelDb = -38, minContrast = 3, contrastSec = 1, contextSec = 4, minContextRel = 0.08;
    double minRiseDb = 1.5, minHighRiseDb = 6, highRiseContrast = 5, strongContrast = 5, strongRel = 0.5,
           strongLevelDb = -12;
    PeakOptions pick = lastOnsetPick();
    bool useNoise = true; // noise: false en la web
    NoiseTailOptions noise;

    static PeakOptions lastOnsetPick()
    {
        PeakOptions p;
        p.threshold = 0.02;
        p.relThreshold = 0.5;
        return p;
    }
};

double findLastOnset(const Features& f, double musicEnd, const LastOnsetOptions& o = {});

struct RefineOptions
{
    double window = 0.04, blockSec = 0.001, minRiseDb = 6, relRise = 0.5, maxBelowPeakDb = 12;
    int smoothBlocks = 2, preBlocks = 6, postBlocks = 3;
    double preEmphasis = 0.95;
};

/** Mueve cada tiempo al inicio de la subida de energía significativa más cercana (NaN se deja igual). */
std::vector<double> refineToTransients(const float* samples, std::size_t n, double sampleRate,
                                       const std::vector<double>& times, const RefineOptions& o = {});

} // namespace analysis
} // namespace djec
