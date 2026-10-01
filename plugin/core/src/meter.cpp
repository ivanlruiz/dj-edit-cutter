// Port de js/core/meter.js.
#include "djec/meter.h"

#include "djec/bars.h"
#include "djec/fade.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>

namespace djec
{

const char* const kMeterMsgNoBeats = "No hay beats detectados en la canción.";
const char* const kMeterMsgNoBars = "No se detectaron compases en la canción.";
const char* const kMeterMsgNothing = "No hay compases completos que cambiar.";

namespace
{
const char* const kMsgTooShort = "Ese compás es demasiado corto para esta canción.";
const char* const kMsgTooLong = "Ese compás es demasiado largo: como máximo se puede duplicar el compás.";
const char* const kMsgSame = "La canción ya está en ese compás.";
const char* const kMsgBadNum = "El numerador del compás debe ser un número entero entre 1 y 32.";
const char* const kMsgBadDen = "El denominador del compás debe ser 2, 4, 8 o 16.";
const char* const kMsgBadSource = "No se conoce el compás original de la canción.";

constexpr double kEps = 1e-6;

bool validDen(int d)
{
    return d == 2 || d == 4 || d == 8 || d == 16;
}

int gcd(int a, int b)
{
    while (b)
    {
        const int t = a % b;
        a = b;
        b = t;
    }
    return a;
}

int lcm(int a, int b)
{
    return (a / gcd(a, b)) * b;
}

// Figura cuya duración es 1/n de redonda.
const char* noteName(int n)
{
    switch (n)
    {
        case 1: return "redonda";
        case 2: return "blanca";
        case 4: return "negra";
        case 8: return "corchea";
        case 16: return "semicorchea";
        case 32: return "fusa";
        default: return "";
    }
}

// "Se quita la última corchea…", "Se repiten los últimos 2 tiempos…"
std::string changeText(int delta, int sourceUnits, bool isBeat, const std::string& unitName)
{
    const int n = std::abs(delta);
    if (delta > 0 && n == sourceUnits)
        return "Se repite cada compás completo.";
    const std::string verb = delta < 0 ? (n == 1 ? "Se quita" : "Se quitan") : (n == 1 ? "Se repite" : "Se repiten");
    std::string what;
    if (isBeat)
        what = n == 1 ? std::string("el último tiempo") : "los últimos " + std::to_string(n) + " tiempos";
    else
        what = n == 1 ? "la última " + unitName : "las últimas " + std::to_string(n) + " " + unitName + "s";
    return verb + " " + what + " de cada compás.";
}

double finiteOr(double a, double b, double c)
{
    if (std::isfinite(a))
        return a;
    if (std::isfinite(b))
        return b;
    if (std::isfinite(c))
        return c;
    return 0;
}

// Tiempo del límite de unidad u (0..S) dentro del compás que empieza en el beat b0: interpolación lineal dentro
// del beat; el final del último beat es el siguiente "1". NaN si falta un beat (undefined en el JS).
double unitTime(const std::vector<double>& beats, int b0, int u, int k)
{
    const int bi = u / k;   // u >= 0
    const double frac = static_cast<double>(u - bi * k) / k;
    const std::size_t i0 = static_cast<std::size_t>(b0 + bi);
    if (i0 >= beats.size())
        return std::numeric_limits<double>::quiet_NaN();
    const double t0 = beats[i0];
    if (frac == 0)
        return t0;
    if (i0 + 1 >= beats.size())
        return std::numeric_limits<double>::quiet_NaN();
    return t0 + frac * (beats[i0 + 1] - t0);
}

MeterPlan noopPlan(double end, int delta, int unitsPerBeat, const std::string& error, const std::string& info)
{
    MeterPlan p;
    if (end > 0)
        p.segments.push_back({0, end});
    p.delta = delta;
    p.unitsPerBeat = unitsPerBeat;
    p.outputDuration = std::max(0.0, end);
    p.error = error;
    p.info = info;
    return p;
}
} // namespace

MeterDescription describeMeterChange(int beatsPerBar, int targetNum, int targetDen, int sourceDen)
{
    MeterDescription res;
    if (!(beatsPerBar >= 1 && beatsPerBar <= kMeterNumMax) || !validDen(sourceDen))
    {
        res.error = kMsgBadSource;
        return res;
    }
    if (!validDen(targetDen))
    {
        res.error = kMsgBadDen;
        return res;
    }
    // Numerador 0 o negativo cae en "demasiado corto" (abajo); > 32 es inválido.
    if (targetNum > kMeterNumMax)
    {
        res.error = kMsgBadNum;
        return res;
    }
    targetNum = std::max(targetNum, -kMeterNumMax);   // sin desbordes; sigue siendo "demasiado corto"
    const int l = lcm(sourceDen, targetDen);
    const int k = l / sourceDen;
    const int S = beatsPerBar * k;
    const int T = targetNum * (l / targetDen);
    const int delta = T - S;
    res.unitsPerBeat = k;
    res.sourceUnits = S;
    res.targetUnits = T;
    res.delta = delta;
    res.unitName = noteName(l);
    if (delta < 0 && -delta > S - 1)
        res.error = kMsgTooShort;
    else if (delta > S)
        res.error = kMsgTooLong;
    else if (delta == 0)
        res.text = kMsgSame;
    else
        res.text = changeText(delta, S, k == 1, res.unitName);
    return res;
}

MeterPlan planMeterChange(const AnalysisResult& r, int targetNum, int targetDen, int sourceDen, double limitTime,
                          double preroll, const std::function<double(double)>& snap)
{
    const std::vector<double>& beats = r.beats;
    const std::size_t nBeats = beats.size();
    const double duration = std::max(0.0, finiteOr(r.duration, r.musicEnd, nBeats ? beats[nBeats - 1] : 0));
    const bool hasLimit = std::isfinite(limitTime) && limitTime >= 0;
    const double end = hasLimit ? std::min(std::max(limitTime, 0.0), duration) : duration;
    const double p = std::isfinite(preroll) && preroll > 0 ? preroll : 0;

    const MeterDescription desc = describeMeterChange(r.beatsPerBar, targetNum, targetDen, sourceDen);
    const int delta = desc.delta;
    const int k = desc.unitsPerBeat;
    if (!nBeats)
        return noopPlan(end, delta, k, kMeterMsgNoBeats, "");
    if (!desc.error.empty())
        return noopPlan(end, delta, k, desc.error, "");
    if (delta == 0)
        return noopPlan(end, delta, k, "", kMsgSame);

    // Mismo modelo de compases que el modo 1 (bars)
    const std::vector<Bar> bars = getBars(r);
    if (bars.empty())
        return noopPlan(end, delta, k, kMeterMsgNoBars, "");

    // Límite de transformación: el inicio del compás del golpe final o, si es antes, el corte del modo 1.
    const int last = findLastBarIndex(r);
    const double limit = std::min(end, bars[static_cast<std::size_t>(last >= 0 ? last : 0)].start);

    const int T = desc.targetUnits;
    MeterPlan plan;
    int barsChanged = 0;
    double cursor = 0;
    auto push = [&](double start, double stop) {
        const double a = std::max(0.0, start);
        const double b = std::min(stop, end);
        if (b - a > 1e-9)
            plan.segments.push_back({a, b});
    };

    for (std::size_t j = 0; j + 1 < bars.size(); ++j)
    {
        const int b0 = bars[j].beatIndex;
        const int b1 = bars[j + 1].beatIndex;
        const double barStart = beats[static_cast<std::size_t>(b0)];
        const double barEnd = beats[static_cast<std::size_t>(b1)];
        if (!(barEnd > barStart))
            continue;
        // Solo compases completos que terminan antes del límite (tolerancia = pre-roll).
        if (barEnd - p > limit + kEps)
            break;
        const int S = (b1 - b0) * k;   // cada compás usa su propia cantidad de beats
        const int d = T - S;
        if (d == 0 || (d < 0 && -d > S - 1) || d > S)
            continue;
        const int m = std::abs(d);

        double cut = unitTime(beats, b0, S - m, k);
        if (!std::isfinite(cut))
            continue;
        if (snap)
        {
            const double s = snap(cut);
            if (std::isfinite(s) && std::fabs(s - cut) < kSnapMaxSec && s > barStart && s < barEnd)
                cut = s;
        }

        // Los empalmes van p segundos ANTES del límite musical para no comerse ataques.
        const double a = std::max(0.0, cut - p);
        const double e = std::min(barEnd - p, end);
        if (!(e > a))
            continue;
        if (d < 0)
        {
            push(cursor, a);
            plan.removed.push_back({a, e});
        }
        else
        {
            push(cursor, e);
            push(a, e);
            plan.repeated.push_back({a, e});
        }
        cursor = e;
        ++barsChanged;
    }
    push(cursor, end);

    if (!barsChanged)
        return noopPlan(end, delta, k, "", kMeterMsgNothing);

    double outputDuration = 0;
    for (const Segment& s : plan.segments)
        outputDuration += s.end - s.start;
    plan.barsChanged = barsChanged;
    plan.delta = delta;
    plan.unitsPerBeat = k;
    plan.outputDuration = outputDuration;
    return plan;
}

std::optional<double> sourceToOutputTime(const std::vector<Segment>& segments, double t)
{
    if (!std::isfinite(t))
        return std::nullopt;
    double acc = 0;
    bool hasLast = false;
    double lastEnd = 0;
    for (const Segment& s : segments)
    {
        const double len = s.end - s.start;
        if (!(len > 0))
            continue;
        if (t >= s.start && t < s.end)
            return acc + (t - s.start);
        acc += len;
        lastEnd = s.end;
        hasLast = true;
    }
    if (hasLast && std::fabs(t - lastEnd) < 1e-9)
        return acc;
    return std::nullopt;
}

double outputToSourceTime(const std::vector<Segment>& segments, double t)
{
    const double x = std::isnan(t) ? 0 : t;
    double acc = 0;
    bool hasLast = false;
    double lastEnd = 0;
    for (const Segment& s : segments)
    {
        const double len = s.end - s.start;
        if (!(len > 0))
            continue;
        if (x < acc + len)
            return s.start + std::max(0.0, x - acc);
        acc += len;
        lastEnd = s.end;
        hasLast = true;
    }
    return hasLast ? lastEnd : std::max(0.0, std::isfinite(x) ? x : 0.0);
}

} // namespace djec
