// Etiquetado de compases (posición de cada beat; 0 = "1") — port de js/analysis/downbeats.js.
#pragma once

#include "djec/analysis/features.h"

#include <vector>

namespace djec
{
namespace analysis
{

struct DownbeatOptions
{
    int onsetWin = 2;
    double chromaSkip = 0.06, chromaSkipFrac = 0.3, chromaTail = 0.02, logFloor = 0.05;
    int normHalf = 12;
    double stdFloorRel = 0.5;
    double wLow = 0.6, wOns = 0, wHc1 = 0.5, wHc2 = 0.5, wAcc = 0.15; // weights
    int meterWindow = 24, meterHop = 12;
    double meterBias = 0.25, meterConfSpan = 0.75;
    double emissionScale = 1, shortBarLog = -5, longBarLog = -5, resetLog = -14, forcedPenaltyMul = 3;
    int templateIters = 2;
    double templateShrink = 8, templateScale = 1;
    double confEffectLow = 0.2, confEffectHigh = 1, confIrregularFactor = 0.93;
};

struct LabelResult
{
    int beatsPerBar = 4;
    bool meterAuto = true;
    std::vector<int> positions, downbeats;
    double confidence = 0;
    double meterScore3 = 0, meterScore4 = 0;
};

/** beatsPerBar: 2..7 fijo; cualquier otro valor (0) = automático (3 o 4). forced: índices de beat que son "1". */
LabelResult labelBars(const Features& f, const std::vector<double>& beats, int beatsPerBar,
                      const std::vector<int>& forcedDownbeats, const DownbeatOptions& o = {});

/** Normaliza con media y desviación locales (±half beats). NaN → 0. */
std::vector<double> localStandardize(const std::vector<double>& x, int half, double stdFloorRel = 0.5);

double meterPeriodicity(const std::vector<double>& Z, int n, int K, int M, int W = 24, int hop = 12);

} // namespace analysis
} // namespace djec
