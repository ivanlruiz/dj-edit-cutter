#include "ui/Format.h"

#include <algorithm>
#include <cmath>

namespace djec::ui::fmt
{

juce::String number (double x, int maxDecimals)
{
    if (! std::isfinite (x))
        return juce::String::fromUTF8 ("–");
    const double f = std::pow (10.0, maxDecimals);
    const double r = std::floor (x * f + 0.5) / f;   // Math.round
    if (std::fabs (r - std::round (r)) < 1e-9)
        return juce::String (static_cast<long long> (std::llround (r)));
    juce::String s (r, maxDecimals);
    while (s.endsWithChar ('0'))
        s = s.dropLastCharacters (1);
    return s.replaceCharacter ('.', ',');
}

juce::String time (double sec, int decimals)
{
    if (! std::isfinite (sec))
        return juce::String::fromUTF8 ("–:––");
    const bool neg = sec < 0;
    const long long f = static_cast<long long> (std::llround (std::pow (10.0, decimals)));
    const long long total = static_cast<long long> (std::llround (std::fabs (sec) * static_cast<double> (f)));
    const long long whole = total / f;
    const long long frac = total - whole * f;
    const long long h = whole / 3600, m = (whole % 3600) / 60, s = whole % 60;
    juce::String out;
    if (h > 0)
        out << juce::String (h) << ":" << juce::String (m).paddedLeft ('0', 2);
    else
        out << juce::String (m);
    out << ":" << juce::String (s).paddedLeft ('0', 2);
    if (decimals > 0)
        out << "." << juce::String (frac).paddedLeft ('0', decimals);
    return (neg && total > 0 ? juce::String::fromUTF8 ("−") : juce::String()) + out;
}

juce::String duration (double sec)
{
    if (! std::isfinite (sec))
        return juce::String::fromUTF8 ("–:––");
    return time (std::floor (std::max (0.0, sec) + 1e-6), 0);
}

juce::String seconds (double sec)
{
    if (! std::isfinite (sec))
        return juce::String::fromUTF8 ("– s");
    const juce::String v (sec, std::fabs (sec) < 10 ? 2 : 1);
    return v.replaceCharacter ('.', ',') + " s";
}

TapResult tapTempo (const std::vector<double>& taps, double nowMs)
{
    constexpr std::size_t kMaxIntervals = 8;
    constexpr double kResetMs = 2000;
    TapResult r;
    for (double t : taps)
        if (std::isfinite (t))
            r.taps.push_back (t);
    if (std::isfinite (nowMs))
    {
        if (! r.taps.empty() && (nowMs - r.taps.back() > kResetMs || nowMs <= r.taps.back()))
            r.taps.clear();
        r.taps.push_back (nowMs);
        if (r.taps.size() > kMaxIntervals + 1)
            r.taps.erase (r.taps.begin(), r.taps.end() - static_cast<std::ptrdiff_t> (kMaxIntervals + 1));
    }
    if (r.taps.size() < 2)
        return r;
    std::vector<double> d;
    for (std::size_t i = 1; i < r.taps.size(); ++i)
        d.push_back (r.taps[i] - r.taps[i - 1]);
    std::sort (d.begin(), d.end());
    const std::size_t m = d.size() / 2;
    const double med = d.size() % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
    if (med > 0)
        r.bpm = std::floor ((60000.0 / med) * 10 + 0.5) / 10;
    return r;
}

std::optional<double> parseBpm (const juce::String& text)
{
    const juce::String s = text.trim().replaceCharacter (',', '.');
    if (s.isEmpty() || ! s.containsOnly ("0123456789.") || s.indexOfChar ('.') != s.lastIndexOfChar ('.'))
        return std::nullopt;
    const double n = s.getDoubleValue();
    if (! std::isfinite (n) || n < kManualBpmMin || n > kManualBpmMax)
        return std::nullopt;
    return std::floor (n * 10 + 0.5) / 10;
}

std::optional<int> parseInt (const juce::String& text)
{
    const juce::String s = text.trim();
    if (s.isEmpty() || s.length() > 6 || ! s.containsOnly ("0123456789"))
        return std::nullopt;
    return s.getIntValue();
}

} // namespace djec::ui::fmt
