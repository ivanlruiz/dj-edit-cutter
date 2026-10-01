// Piezas puras de js/analysis/analyze.js (expuestas para los tests).
#pragma once

#include <cstddef>
#include <vector>

namespace djec
{
namespace analysis
{

/** Copia lista para analizar: 22050 Hz, sin no finitos y sin componente continua (media + paso alto 1 polo a 10 Hz).
    std::invalid_argument("frecuencia de muestreo no válida") fuera de [3000, 384000] Hz. */
std::vector<float> prepareSamples(const float* samples, std::size_t n, double sampleRate);

/** Índices de beat dentro de [0, n), ordenados y sin repetir. */
std::vector<int> sanitizeForced(const std::vector<int>& list, int n);

/** Tras un retrack: cada "1" forzado (por tiempo) pasa al beat nuevo más cercano si está cerca; si no, se descarta. */
std::vector<int> remapForced(const std::vector<double>& oldTimes, const std::vector<double>& newBeats);

/** Completa positions hasta n beats continuando la cuenta del compás; un "1" forzado reinicia la cuenta. */
void extendPositions(std::vector<int>& positions, std::size_t n, int beatsPerBar, const std::vector<int>& forced);

struct TempoSummary
{
    double bpm = 0, bpmLo = 0, bpmHi = 0;
};
/** BPM (mediana de 60/IBI, redondeado a 0.1) y rango p10–p90 del tempo local. */
TempoSummary tempoSummary(const std::vector<double>& beats);

} // namespace analysis
} // namespace djec
