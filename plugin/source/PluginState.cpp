#include "PluginState.h"

#include <cmath>

namespace djec::plugin
{

const WaveformPeaks::Level* WaveformPeaks::levelFor(double samplesPerPixel) const noexcept
{
    if (levels.empty())
        return nullptr;
    const Level* best = &levels.front();
    for (const Level& l : levels)
        if (l.samplesPerPeak <= samplesPerPixel)
            best = &l;
    return best;
}

juce::String formatClock(double sec)
{
    if (!std::isfinite(sec))
        return juce::String::fromUTF8("–:––");
    const long long whole = static_cast<long long>(std::floor(std::max(0.0, sec) + 1e-6));
    const long long h = whole / 3600, m = (whole % 3600) / 60, s = whole % 60;
    juce::String out;
    if (h > 0)
        out << juce::String(h) << ":" << juce::String(m).paddedLeft('0', 2);
    else
        out << juce::String(m);
    out << ":" << juce::String(s).paddedLeft('0', 2);
    return out;
}

namespace
{
juce::String formatNumber(double x, int maxDecimals)
{
    if (!std::isfinite(x))
        return juce::String::fromUTF8("–");
    const double f = std::pow(10.0, maxDecimals);
    const double r = std::floor(x * f + 0.5) / f;
    if (std::fabs(r - std::round(r)) < 1e-9)
        return juce::String(static_cast<long long>(std::llround(r)));
    juce::String s(r, maxDecimals);
    while (s.endsWithChar('0'))
        s = s.dropLastCharacters(1);
    return s.replaceCharacter('.', ',');
}
} // namespace

juce::String formatBpm(double bpm)
{
    if (!std::isfinite(bpm) || bpm <= 0)
        return "Tempo desconocido";
    return juce::String::fromUTF8("≈ ") + formatNumber(bpm, 1) + " BPM";
}

juce::String stageLabel(const juce::String& stage)
{
    if (stage == "features")
        return "Detectando notas";
    if (stage == "tempo")
        return "Calculando tempo";
    if (stage == "beats")
        return "Buscando beats";
    if (stage == "bars")
        return "Buscando compases";
    if (stage == "read")
        return "Leyendo archivo";
    return {};
}

juce::String formatBars(int n)
{
    return n == 1 ? juce::String::fromUTF8("1 compás") : juce::String(n) + " compases";
}

juce::String suggestFileName(const juce::String& baseName, const djec::EditPlan& plan, bool meterChanges)
{
    // suggestFileName de js/audio/export.js (formato WAV)
    juce::String base = baseName.fromLastOccurrenceOf("/", false, false).fromLastOccurrenceOf("\\", false, false);
    {
        const int dot = base.lastIndexOfChar('.');
        if (dot > 0 && base.length() - dot - 1 >= 1 && base.length() - dot - 1 <= 5 &&
            base.substring(dot + 1).containsOnly("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
            base = base.substring(0, dot);
    }
    juce::String clean;
    for (auto p = base.getCharPointer(); !p.isEmpty(); ++p)
    {
        const juce::juce_wchar c = *p;
        if (c < 32 || c == 127 || juce::String("<>:\"/\\|?*").containsChar(c))
            clean << ' ';
        else
            clean << juce::String::charToString(c);
    }
    while (clean.contains("  "))
        clean = clean.replace("  ", " ");
    clean = clean.trim();
    while (clean.startsWithChar('.'))
        clean = clean.substring(1).trimStart();
    while (clean.endsWithChar('.'))
        clean = clean.dropLastCharacters(1).trimEnd();
    if (clean.length() > 120)
        clean = clean.substring(0, 120).trim();
    if (clean.isEmpty())
        clean = juce::String::fromUTF8("Canción");

    juce::StringArray parts;
    const bool meterTag = meterChanges && plan.target.num > 0 && plan.target.den > 0;
    if (meterTag)
        parts.add(juce::String(plan.target.num) + "-" + juce::String(plan.target.den));
    if (!meterTag || plan.useCut)
    {
        juce::String tag = "edit";
        if (plan.useCut && plan.barsRemoved > 0)
            tag = "edit -" + juce::String(plan.barsRemoved) + " " +
                  (plan.barsRemoved == 1 ? juce::String::fromUTF8("compás") : juce::String("compases"));
        parts.add(tag);
    }
    return clean + " (" + parts.joinIntoString(", ") + ").wav";
}

} // namespace djec::plugin
