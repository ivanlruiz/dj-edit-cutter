// Resultado del análisis rítmico (espejo del AnalysisResult de la app web, en segundos sobre la línea de tiempo del
// audio analizado). Lo producen djec::Analyzer (detección) y djec::gridFromHost (cuadrícula de FL); lo consumen el
// modelo de compases (bars) y el plan de edición.
#pragma once

#include <vector>

namespace djec
{

struct AnalysisResult
{                                       // mirrors the JS AnalysisResult (seconds)
    double duration = 0, musicStart = 0, musicEnd = 0, lastOnset = 0, bpm = 0, bpmLo = 0, bpmHi = 0;
    std::vector<double> beats, beatStrength;
    int beatsPerBar = 4;
    bool meterAuto = true;
    std::vector<int> positions, downbeats, forcedDownbeats;
    double confBeats = 0, confBars = 0;
    int tailBeatsFrom = -1;
};

} // namespace djec
