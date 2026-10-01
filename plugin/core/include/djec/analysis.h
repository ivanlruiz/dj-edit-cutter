// Análisis rítmico (beats, tempo, compases) — port de js/analysis/analyze.js (AnalysisSession).
//
// Uso típico (fuera del hilo de audio):
//   std::vector<float> mono = djec::toAnalysisMono(chans, numCh, n, hostRate);   // 22050 Hz (djec/resample.h)
//   djec::Analyzer an;
//   djec::AnalysisResult r = an.analyze(mono.data(), mono.size(), 22050, {}, progress);
//   r = an.retrack(r.bpm * 2, true);            // "Tempo ×2" (÷2: r.bpm / 2; tempo manual: bpm, true)
//   r = an.retrack(0, false);                   // detección automática otra vez ("Restablecer" si cambió el tempo)
//   r = an.relabel(0, {beatIndex});             // "Este beat es el 1" / "Mover el 1" con el compás automático
//
// Todo es determinista. Errores: std::invalid_argument / std::logic_error con el mensaje en español de la web.
#pragma once

#include "djec/analysis_result.h"

#include <cstddef>
#include <functional>
#include <memory>
#include <vector>

namespace djec
{

/** Frecuencia a la que están ajustados el análisis y sus constantes (ANALYSIS_SAMPLE_RATE). */
constexpr double kAnalysisSampleRate = 22050;

struct AnalyzeOptions
{
    double minBpm = 50, maxBpm = 220;
    int beatsPerBar = 0; /* 0 = auto */
};

/** stage: "features" | "tempo" | "beats" | "bars"; fraction 0..1 (0 y 1 siempre; intermedias cada ≥ 50 ms). */
using ProgressFn = std::function<void(const char* stage, double fraction)>; // may be empty

/** Tiempos de la última operación (ms), como timingsMs de la web (0 si la etapa no se ejecutó). */
struct AnalysisTimings
{
    double features = 0, tempo = 0, beats = 0, bars = 0, total = 0;
};

/**
 * Guarda las características y las muestras preparadas para rehacer sólo los beats (retrack) o sólo los compases
 * (relabel) sin volver a calcular el espectro, como el worker de la web. No es seguro usar el mismo objeto desde dos
 * hilos a la vez; objetos distintos sí.
 */
class Analyzer
{
public:
    Analyzer();
    ~Analyzer();
    Analyzer(Analyzer&&) noexcept;
    Analyzer& operator=(Analyzer&&) noexcept;
    Analyzer(const Analyzer&) = delete;
    Analyzer& operator=(const Analyzer&) = delete;

    /** Análisis completo. sampleRate normalmente 22050 (otras frecuencias se remuestrean con el respaldo lineal). */
    AnalysisResult analyze(const float* mono, std::size_t n, double sampleRate, const AnalyzeOptions& options = {},
                           ProgressFn progress = {});
    /** Rehace los beats. bpmHint 0 = detección automática; strict limita a ≈ [0.8, 1.25] × bpmHint (×2 / ÷2).
        Conserva el compás elegido y los "1" forzados (pasados por tiempo a los beats nuevos). */
    AnalysisResult retrack(double bpmHint /*0 = default search*/, bool strict, ProgressFn progress = {});
    /** Rehace sólo los compases: beatsPerBar 0 = automático (2..7 fijo); forcedDownbeats = índices de beat que son "1". */
    AnalysisResult relabel(int beatsPerBar /*0 = auto*/, const std::vector<int>& forcedDownbeats, ProgressFn progress = {});

    bool hasAnalysis() const;
    /** Resultado del estado actual (std::logic_error si no se analizó nada). */
    AnalysisResult result() const;
    const AnalysisTimings& lastTimings() const;
    /** Libera las muestras y las características. */
    void reset();

    struct Impl;

private:
    std::unique_ptr<Impl> impl_;
};

} // namespace djec
