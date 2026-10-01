// Formato de números y tiempos de la interfaz (port de js/ui/format.js y parte de js/ui/edit-plan.js): coma decimal
// como la web, tiempos "3:41.25", duraciones "3:52", tap tempo y lectura del BPM escrito. Sin textos en español (esos
// van en Strings.h).
#pragma once

#include <juce_core/juce_core.h>

#include <optional>
#include <vector>

namespace djec::ui::fmt
{

/** Rango del tempo manual (MANUAL_BPM de la web). */
constexpr double kManualBpmMin = 30, kManualBpmMax = 300;
/** ×2 / ÷2 fuera de este rango no se pide (la web lo comprueba antes de retrack). */
constexpr double kRetrackBpmMin = 30, kRetrackBpmMax = 320;

/** 2 → "2", 2.5 → "2,5" (decimales solo si hacen falta, coma decimal). NaN → "–". */
juce::String number (double x, int maxDecimals = 1);
/** "3:41.25" (m:ss.cc); con horas "1:03:41.25"; negativos con "−". */
juce::String time (double sec, int decimals = 2);
/** "3:52" (truncando, como los reproductores). */
juce::String duration (double sec);
/** "0,97 s", "12,4 s". */
juce::String seconds (double sec);

/** Tap tempo: toques en ms → mediana de los últimos 8 intervalos; se reinicia tras 2 s sin tocar. */
struct TapResult
{
    std::vector<double> taps;
    std::optional<double> bpm;
};
TapResult tapTempo (const std::vector<double>& taps, double nowMs);

/** "97,5" / "97.5" → BPM dentro de [30, 300] redondeado a 0,1; si no, nullopt. */
std::optional<double> parseBpm (const juce::String& text);

/** Entero o nullopt ("7" sí; "7.5", "", "abc" no). */
std::optional<int> parseInt (const juce::String& text);

} // namespace djec::ui::fmt
