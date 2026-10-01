// Modelo de compases y cálculos del corte del modo 1 — port de js/core/bars.js (misma semántica, tiempos en segundos
// sobre la línea de tiempo del audio analizado). Los beats anteriores al primer downbeat (anacrusa) no pertenecen a
// ningún compás. Diferencias con el JS (solo de tipos): lastOnset NaN = "sin lastOnset" (undefined en la web).
#pragma once

#include "djec/analysis_result.h"

#include <optional>
#include <vector>

namespace djec
{

constexpr double kLastBarTolerance = 0.08;   // s (LAST_BAR_TOLERANCE)

struct Bar
{
    int index;       // 0-based
    int beatIndex;   // índice del "1" en result.beats
    double start, end;
    int beatCount;
    int number;      // index + 1
};

/**
 * Compases. end = inicio del compás siguiente; el último termina en último beat + IBI mediano (con tope
 * max(musicEnd, último beat)). Los downbeats salen de result.downbeats o, si está vacío, de positions == 0
 * (se ignoran repetidos o fuera de rango).
 */
std::vector<Bar> getBars(const AnalysisResult& result);

/**
 * El último compás cuyo inicio <= lastOnset + kLastBarTolerance (el que contiene el golpe final). -1 si no hay
 * compases o si todos empiezan después. Con lastOnset no finito: el último compás.
 */
int findLastBarIndex(const AnalysisResult& result);

struct BarCut
{
    int barIndex, beatIndex;
    double time;       // beats[beatIndex] (sin pre-roll)
    int barsRemoved;   // compases que se quitan de verdad tras limitar (<= n)
};

/** Corte para quitar n compases del final: al inicio del compás (último − n + 1), dejando al menos 1. */
std::optional<BarCut> cutForBarsRemoved(const AnalysisResult& result, int n);

/** Compases (redondeado a 0.1) entre `time` y el final del último compás; dentro de un compás, en beats. */
double barsRemovedAt(const AnalysisResult& result, double time);

/** Índice del beat más cercano (-1 sin beats). */
int nearestBeatIndex(const AnalysisResult& result, double time);

/**
 * Tiempo del beat a `delta` beats del más cercano a `time` (limitado a los beats existentes). Fuera de la rejilla,
 * +1 va al siguiente beat posterior y −1 al anterior. Sin beats devuelve `time`.
 */
double stepBeat(const AnalysisResult& result, double time, int delta);

/** Igual que stepBeat pero sobre los inicios de compás (sin downbeats: delta × beatsPerBar beats). */
double stepBar(const AnalysisResult& result, double time, int delta);

/** Índices de downbeat válidos (ascendentes, sin repetir) como los usa getBars. */
std::vector<int> validDownbeats(const AnalysisResult& result);

} // namespace djec
