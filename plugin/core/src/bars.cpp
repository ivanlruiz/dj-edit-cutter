// Port de js/core/bars.js.
#include "djec/bars.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace djec
{

namespace
{
constexpr double kOnGridSec = 0.001;   // a menos de esto un tiempo "está" sobre un beat

double jsRound(double x)
{
    if (!std::isfinite(x))
        return x;
    const double f = std::floor(x);
    return (x - f >= 0.5) ? f + 1.0 : f;
}

double medianIbi(const std::vector<double>& beats, double bpm)
{
    std::vector<double> d;
    d.reserve(beats.size());
    for (std::size_t i = 1; i < beats.size(); ++i)
    {
        const double x = beats[i] - beats[i - 1];
        if (x > 0)
            d.push_back(x);
    }
    if (d.empty())
        return bpm > 0 ? 60 / bpm : 0;
    std::sort(d.begin(), d.end());
    const std::size_t m = d.size() >> 1;
    return (d.size() % 2) ? d[m] : (d[m - 1] + d[m]) / 2;
}

int lastBarIndexOf(const std::vector<Bar>& bars, double lastOnset)
{
    if (bars.empty())
        return -1;
    if (!std::isfinite(lastOnset))
        return static_cast<int>(bars.size()) - 1;
    int idx = -1;
    for (std::size_t k = 0; k < bars.size(); ++k)
        if (bars[k].start <= lastOnset + kLastBarTolerance)
            idx = static_cast<int>(k);
    return idx;
}

// Primer índice i con arr[i] >= t
std::size_t lowerBound(const std::vector<double>& arr, double t)
{
    std::size_t lo = 0, hi = arr.size();
    while (lo < hi)
    {
        const std::size_t mid = (lo + hi) >> 1;
        if (arr[mid] < t)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}

int nearestIn(const std::vector<double>& times, double t)
{
    if (times.empty())
        return -1;
    const std::size_t i = lowerBound(times, t);
    if (i == 0)
        return 0;
    if (i >= times.size())
        return static_cast<int>(times.size()) - 1;
    return (t - times[i - 1] <= times[i] - t) ? static_cast<int>(i) - 1 : static_cast<int>(i);
}

double stepIn(const std::vector<double>& times, double time, int d)
{
    if (times.empty())
        return time;
    int base = nearestIn(times, time);
    // time NaN: como en el JS, la comparación da false y se parte del índice 0 (nearestIn(NaN) = 0).
    if (d != 0 && std::fabs(times[base] - time) > kOnGridSec)
    {
        if (d > 0 && times[base] > time)
            base -= 1;   // el siguiente tiempo cuenta como +1
        if (d < 0 && times[base] < time)
            base += 1;   // el anterior cuenta como −1
    }
    const long long i = std::max<long long>(0, std::min<long long>(static_cast<long long>(times.size()) - 1,
                                                                  static_cast<long long>(base) + d));
    return times[static_cast<std::size_t>(i)];
}
} // namespace

std::vector<int> validDownbeats(const AnalysisResult& result)
{
    const int n = static_cast<int>(result.beats.size());
    std::vector<int> src;
    if (!result.downbeats.empty())
        src = result.downbeats;
    else
    {
        const int m = std::min(n, static_cast<int>(result.positions.size()));
        for (int i = 0; i < m; ++i)
            if (result.positions[static_cast<std::size_t>(i)] == 0)
                src.push_back(i);
    }
    std::sort(src.begin(), src.end());
    std::vector<int> out;
    for (int v : src)
        if (v >= 0 && v < n && (out.empty() || out.back() != v))
            out.push_back(v);
    return out;
}

std::vector<Bar> getBars(const AnalysisResult& result)
{
    const std::vector<double>& beats = result.beats;
    const std::vector<int> db = validDownbeats(result);
    std::vector<Bar> bars;
    if (db.empty())
        return bars;
    const double lastBeat = beats.back();
    double finalEnd = lastBeat + medianIbi(beats, result.bpm);
    const double musicEnd = result.musicEnd;
    if (std::isfinite(musicEnd))
    {
        // Math.min / Math.max propagan NaN (finalEnd puede ser NaN si un beat lo es)
        const double cap = std::max(musicEnd, lastBeat);
        finalEnd = (std::isnan(finalEnd) || std::isnan(lastBeat)) ? std::numeric_limits<double>::quiet_NaN()
                                                                  : std::min(finalEnd, cap);
    }
    bars.reserve(db.size());
    for (std::size_t k = 0; k < db.size(); ++k)
    {
        const int bi = db[k];
        const int next = k + 1 < db.size() ? db[k + 1] : static_cast<int>(beats.size());
        Bar b;
        b.index = static_cast<int>(k);
        b.number = static_cast<int>(k) + 1;
        b.beatIndex = bi;
        b.start = beats[static_cast<std::size_t>(bi)];
        b.end = k + 1 < db.size() ? beats[static_cast<std::size_t>(next)] : finalEnd;
        b.beatCount = next - bi;
        bars.push_back(b);
    }
    return bars;
}

int findLastBarIndex(const AnalysisResult& result)
{
    return lastBarIndexOf(getBars(result), result.lastOnset);
}

std::optional<BarCut> cutForBarsRemoved(const AnalysisResult& result, int n)
{
    if (!(n >= 1))
        return std::nullopt;
    const std::vector<Bar> bars = getBars(result);
    const int last = lastBarIndexOf(bars, result.lastOnset);
    if (last < 1)
        return std::nullopt;   // hace falta al menos un compás que quede
    const int barIndex = std::max(1, last - n + 1);
    const Bar& bar = bars[static_cast<std::size_t>(barIndex)];
    return BarCut{barIndex, bar.beatIndex, bar.start, last - barIndex + 1};
}

double barsRemovedAt(const AnalysisResult& result, double time)
{
    const std::vector<double>& beats = result.beats;
    const std::vector<Bar> bars = getBars(result);
    const int last = lastBarIndexOf(bars, result.lastOnset);
    if (last < 0 || !std::isfinite(time))
        return 0;
    double total = 0;
    for (int k = 0; k <= last; ++k)
    {
        const Bar& bar = bars[static_cast<std::size_t>(k)];
        if (time <= bar.start)
        {
            total += 1;
            continue;
        }
        if (time >= bar.end)
            continue;
        // beat j del compás que contiene time
        int j = bar.beatIndex;
        const int jEnd = bar.beatIndex + bar.beatCount - 1;
        while (j < jEnd && beats[static_cast<std::size_t>(j + 1)] <= time)
            ++j;
        const double bj = beats[static_cast<std::size_t>(j)];
        const double next = j < jEnd ? beats[static_cast<std::size_t>(j + 1)] : bar.end;
        const double frac = next > bj ? std::min(1.0, (time - bj) / (next - bj)) : 0;
        total += 1 - (static_cast<double>(j - bar.beatIndex) + frac) / bar.beatCount;
    }
    return jsRound(total * 10) / 10;
}

int nearestBeatIndex(const AnalysisResult& result, double time)
{
    return nearestIn(result.beats, time);
}

double stepBeat(const AnalysisResult& result, double time, int delta)
{
    return stepIn(result.beats, time, delta);
}

double stepBar(const AnalysisResult& result, double time, int delta)
{
    const std::vector<int> db = validDownbeats(result);
    if (db.empty())
        return stepBeat(result, time, delta * (result.beatsPerBar ? result.beatsPerBar : 4));
    std::vector<double> times;
    times.reserve(db.size());
    for (int i : db)
        times.push_back(result.beats[static_cast<std::size_t>(i)]);
    return stepIn(times, time, delta);
}

} // namespace djec
