// Cambio de compás («Recortar cada compás»): se quita o se repite el FINAL de cada compás y se empalma, sin estirar
// el tiempo — port de js/core/meter.js (mismos textos en español, mismas reglas). Todo en segundos sobre la línea
// de tiempo del audio original.
#pragma once

#include "djec/analysis_result.h"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace djec
{

/** Rango de la fuente en segundos; una lista de Segment está en orden de SALIDA. */
struct Segment
{
    double start, end;
};

struct MeterChoice
{
    int targetNum, targetDen;
};

/** Compases de la primera versión de la web (METER_PRESETS); la interfaz actual elige por cantidad (meterAmountChips). */
constexpr MeterChoice kMeterPresets[3] = {{7, 8}, {3, 4}, {5, 4}};
constexpr int kMeterNumMax = 32;
constexpr double kSnapMaxSec = 0.025;   // el imán solo puede mover un límite menos de 25 ms (SNAP_MAX_SEC)

// Textos que la interfaz necesita reconocer (METER_MESSAGES de la web)
extern const char* const kMeterMsgNoBeats;   // "No hay beats detectados en la canción."
extern const char* const kMeterMsgNoBars;    // "No se detectaron compases en la canción."
extern const char* const kMeterMsgNothing;   // "No hay compases completos que cambiar."

struct MeterDescription
{
    int unitsPerBeat = 0, sourceUnits = 0, targetUnits = 0, delta = 0;
    std::string unitName;   // "corchea", "semicorchea", "negra", "blanca"… ("" si no aplica)
    std::string text;       // "Se quita la última corchea de cada compás." (o "La canción ya está en ese compás.")
    std::string error;      // "" = sin error
};

/**
 * Unidad u = 1 / mcm(sourceDen, targetDen) de redonda; S = beatsPerBar·k, T = targetNum·(mcm/targetDen), Δ = T − S.
 * Errores (texto de la web): compás original desconocido (beatsPerBar fuera de 1..32 o sourceDen no válido),
 * denominador no válido (2, 4, 8, 16), numerador > 32 (para "no es un número" pasa cualquier valor > 32),
 * demasiado corto (|Δ| > S − 1, incluye numerador <= 0) o demasiado largo (Δ > S).
 */
MeterDescription describeMeterChange(int beatsPerBar, int targetNum, int targetDen, int sourceDen = 4);

struct MeterPlan
{
    std::vector<Segment> segments;   // fuente, en orden de salida, desde 0 hasta el final de lo que se conserva
    std::vector<Segment> removed;    // para dibujar (Δ < 0)
    std::vector<Segment> repeated;   // para dibujar (Δ > 0)
    int barsChanged = 0, delta = 0, unitsPerBeat = 0;
    double outputDuration = 0;
    std::string error, info;         // "" = nada
};

/**
 * Plan del cambio de compás (planMeterChange de la web).
 * limitTime < 0 (o no finito) = sin límite (fin = result.duration); si no, fin = min(max(limitTime, 0), duración).
 * Solo se transforman compases completos (con "1" siguiente) que terminan antes del compás del golpe final
 * (findLastBarIndex) y de limitTime; cada empalme va `preroll` s antes de su límite musical.
 * snap (opcional) puede mover cada límite interno (nunca los "1") si lo mueve < kSnapMaxSec y queda dentro del compás.
 */
MeterPlan planMeterChange(const AnalysisResult& result, int targetNum, int targetDen, int sourceDen,
                          double limitTime /*<0 = none*/, double preroll,
                          const std::function<double(double)>& snap = {});

/** Posición en la salida de un instante de la fuente; nullopt si ese audio se quitó (primera aparición si se repite). */
std::optional<double> sourceToOutputTime(const std::vector<Segment>& segments, double t);

/** Instante de la fuente que suena en la posición t de la salida (limitado a [inicio, fin]). */
double outputToSourceTime(const std::vector<Segment>& segments, double t);

} // namespace djec
