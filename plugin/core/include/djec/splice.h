// Render de un plan: concatena rangos de la fuente con crossfades en cada empalme y un fade-out final — port de
// js/audio/splice.js (renderSegments + mixCrossfade) con la misma aritmética de muestras: índice = Math.round(t·sr),
// longitud = Σ (round(end·sr) − round(start·sr)) de los segmentos válidos, los crossfades nunca cambian la longitud,
// los segmentos contiguos se copian bit a bit, lo que cae fuera de la fuente es silencio.
// Crossfade adaptado a la correlación (igual potencia si A y B no se parecen, igual ganancia si están en fase) y,
// cerca de 0 dBFS (> −1 dBFS), sin crear un pico mayor que el de las dos señales que une.
#pragma once

#include "djec/meter.h"   // Segment

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace djec
{

/** Por debajo de este nivel (−1 dBFS) un pico nuevo en el empalme no puede recortar (SPLICE_CEILING). */
extern const double kSpliceCeiling;

/** Muestras de la salida de renderSegments para esos segmentos (renderedLength de la web). */
std::int64_t renderedLength(const std::vector<Segment>& segments, double sampleRate);

/**
 * y[j] = a[j]·gA[j] + b[j]·gB[j] para j < L (c/s: cos/sin de la ventana de igual potencia), con la ganancia adaptada
 * a la correlación ρ de a y b y el límite de pico de la web. Expuesto para los tests.
 */
void mixCrossfade(const double* a, const double* b, std::size_t L, const double* c, const double* s, double* y);

/**
 * Render completo (renderSegments de la web con from = 0, to = ∞). in: numChannels punteros a inLength muestras
 * (no se modifican). out se redimensiona a numChannels canales de renderedLength(segments) muestras.
 * crossfadeSec: ventana de cada empalme (centrada: A sigue sonando tras su fin, B empieza antes de su inicio;
 * se acorta en los bordes de la fuente y en segmentos cortos). fadeOutSec: fade-out final, como mínimo
 * kAntiClickSec; la última muestra queda en 0. curve: "linear" | "smooth" | "exp" (otra cosa = "smooth").
 * Sample rate no válido → canales vacíos.
 */
void renderSegments(const float* const* in, int numChannels, std::size_t inLength, double sampleRate,
                    const std::vector<Segment>& segments, double crossfadeSec, double fadeOutSec,
                    const std::string& curve, std::vector<std::vector<float>>& out);

} // namespace djec
