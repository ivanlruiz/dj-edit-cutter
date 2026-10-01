// Ayudas numéricas para portar el JS del análisis con la misma semántica:
//   - js::round: Math.round (redondea .5 hacia +∞; std::round lo hace alejándose de 0).
//   - jmax / jmin: Math.max / Math.min (propagan NaN; std::max no). Nombres sin 'max'/'min' a secas: así no chocan
//     con las macros de <windows.h> sin NOMINMAX.
//   - Las funciones trascendentes van por std:: (glibc / CRT). V8 usa fdlibm: pueden diferir en 1 ulp de double,
//     diferencia que el almacenamiento en float de casi todas las señales absorbe (ver los tests de paridad).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

namespace djec
{
namespace js
{

constexpr double kPi = 3.141592653589793;           // Math.PI
constexpr double kLog10E = 0.4342944819032518;      // Math.LOG10E
constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

/** Math.round: el entero más cercano; los .5 hacia +∞. */
inline double round(double x)
{
    if (!std::isfinite(x))
        return x;
    const double f = std::floor(x);
    return (x - f >= 0.5) ? f + 1.0 : f;
}

/** Math.round como entero (para índices). */
inline long long roundi(double x) { return static_cast<long long>(round(x)); }

inline double jmax(double a, double b)
{
    if (std::isnan(a) || std::isnan(b))
        return kNaN;
    return a > b ? a : b;
}

inline double jmin(double a, double b)
{
    if (std::isnan(a) || std::isnan(b))
        return kNaN;
    return a < b ? a : b;
}

inline bool isFinite(double x) { return std::isfinite(x); }

/** Number.isInteger */
inline bool isInteger(double x) { return std::isfinite(x) && std::floor(x) == x; }

/** Math.floor / Math.ceil como entero */
inline long long floori(double x) { return static_cast<long long>(std::floor(x)); }
inline long long ceili(double x) { return static_cast<long long>(std::ceil(x)); }

inline double log(double x) { return std::log(x); }
inline double log2(double x) { return std::log2(x); }
inline double log10(double x) { return std::log10(x); }
inline double exp(double x) { return std::exp(x); }
inline double pow(double x, double y) { return std::pow(x, y); }
inline double sin(double x) { return std::sin(x); }
inline double cos(double x) { return std::cos(x); }
inline double sqrt(double x) { return std::sqrt(x); }

/** Copia ordenada de forma ascendente (Float64Array.from(a).sort() / a.slice().sort((x, y) => x - y)). */
template <typename T>
inline std::vector<T> sorted(std::vector<T> v)
{
    std::sort(v.begin(), v.end());
    return v;
}

} // namespace js
} // namespace djec
