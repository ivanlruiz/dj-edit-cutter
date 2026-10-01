// Port de js/audio/edit.js (fadeGain / fadeOutGains).
#include "djec/fade.h"

#include <algorithm>
#include <cmath>

namespace djec
{

namespace
{
constexpr double kPi = 3.141592653589793;   // Math.PI
constexpr double kExpRangeDb = 60;          // 'exp' es una recta en dB hasta -60 dB…
// …desplazada para terminar exactamente en 0 (10 ** (-60 / 20))
const double kExpFloor = std::pow(10.0, -kExpRangeDb / 20);

double fadeGainD(double x, const std::string& curve)
{
    if (!(x > 0))
        return 1;   // también NaN
    if (x >= 1)
        return 0;
    if (curve == "linear")
        return 1 - x;
    if (curve == "exp")
        return (std::pow(10.0, -kExpRangeDb * x / 20) - kExpFloor) / (1 - kExpFloor);
    // 'smooth': coseno elevado (pendiente 0 en ambos extremos)
    return 0.5 * (1 + std::cos(kPi * x));
}
} // namespace

const char* const kFadeCurves[3] = {"linear", "smooth", "exp"};

bool isFadeCurve(const std::string& curve)
{
    return curve == "linear" || curve == "smooth" || curve == "exp";
}

float fadeGain(double x, const std::string& curve)
{
    return static_cast<float>(fadeGainD(x, curve));
}

std::vector<float> fadeOutGains(std::size_t len, const std::string& curve, std::size_t from, std::size_t to)
{
    const std::size_t a = std::min(len, from);
    const std::size_t b = std::max(a, std::min(len, to));
    const std::string crv = isFadeCurve(curve) ? curve : std::string("smooth");
    std::vector<float> g(b - a);
    const double L = static_cast<double>(len);
    for (std::size_t i = a; i < b; ++i)
        g[i - a] = static_cast<float>(fadeGainD(static_cast<double>(i + 1) / L, crv));
    return g;
}

} // namespace djec
