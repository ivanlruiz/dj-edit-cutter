// Fades y constantes del corte — port de js/audio/edit.js (CUT_PREROLL_SEC, ANTICLICK_SEC, fadeGain, fadeOutGains).
// Un solo fadeGain para el fade-out del final (modo 1) y para splice.cpp, como en la web.
#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace djec
{

/** El corte (y cada empalme) va este tanto ANTES del beat/downbeat para no comerse su ataque (edit.js: 20 ms). */
constexpr double kCutPrerollSec = 0.02;
/** Fade mínimo que siempre se aplica al final (anti-clic). */
constexpr double kAntiClickSec = 0.005;

/** Curvas del fade-out: "linear" | "smooth" | "exp" (UI: Lineal / Suave / Exponencial). Otra cosa = "smooth". */
extern const char* const kFadeCurves[3];
bool isFadeCurve(const std::string& curve);

/**
 * x ∈ [0, 1] = avance del fade; g(0) = 1, g(1) = 0, monótona no creciente (NaN o x <= 0 → 1, x >= 1 → 0).
 * Se calcula en double y se devuelve en float: exactamente el valor que guarda fadeOutGains (Float32Array en la web).
 */
float fadeGain(double x, const std::string& curve);

/**
 * Ganancias del fade-out de `len` muestras (la última vale 0) para las posiciones [from, to) del fade:
 * g[i - from] = fadeGain((i + 1) / len, curve). Curva desconocida → "smooth". from/to se limitan a [0, len].
 */
std::vector<float> fadeOutGains(std::size_t len, const std::string& curve, std::size_t from, std::size_t to);
inline std::vector<float> fadeOutGains(std::size_t len, const std::string& curve)
{
    return fadeOutGains(len, curve, 0, len);
}

} // namespace djec
