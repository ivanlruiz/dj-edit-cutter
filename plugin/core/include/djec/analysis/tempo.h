// Tempo global y tempograma — port de js/analysis/tempo.js.
#pragma once

#include "djec/analysis/features.h"

#include <vector>

namespace djec
{
namespace analysis
{

struct TempoOptions
{
    double minBpm = 50, maxBpm = 220;
    double priorCenter = 115, priorSigma = 1.2;
    double windowSec = 8, hopSec = 1;
    double localRange = 0.45, localPenalty = 18;
    double strictLo = 0.8, strictHi = 1.25;
    double w2 = 0.5, w4 = 0.25;
    bool hybrid = true; // method 'hybrid' (true) | 'acf'
    double dftPower = 0.25;
    double bpmHint = 0; // > 0: tempo indicado
    bool strict = false;
    bool computeLocal = true; // localBpm (la web lo calcula; el análisis no lo usa)
};

struct TempoCandidate
{
    double bpm, score;
};

struct TempoEstimate
{
    double bpm = 0; // sin redondear
    std::vector<TempoCandidate> candidates;
    std::vector<float> localBpm;
    std::vector<float> globalAcf, globalDft;
    int lagMin = 0, lagMax = 0;
};

/** Envolvente para periodicidad: onset + 0.5·onsetLow menos su media local, rectificada. */
std::vector<float> periodicityEnvelope(const Features& f, double smoothSec = 0.5);

struct Tempogram
{
    std::vector<std::vector<float>> rows, specs;
    std::size_t specSize = 0;
    std::vector<double> centers; // tramas (pueden ser .5)
    int maxLag = 0;
    int window = 0;
};

Tempogram tempogram(const std::vector<float>& env, double fps, double windowSec, double hopSec, int maxLag,
                    double maxSpecHz = 8);

TempoEstimate estimateTempo(const Features& f, const TempoOptions& o = {});

} // namespace analysis
} // namespace djec
