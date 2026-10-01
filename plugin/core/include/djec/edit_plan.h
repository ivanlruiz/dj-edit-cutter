// Plan de edición: combina «Recortar cada compás» (cambio de compás, el modo principal) y «Quitar compases del final»
// en UNA lista de segmentos de la fuente — port de js/ui/edit-plan.js (buildEditPlan, meterAmountChips, targetMeter,
// exportBlocker) más la parte de js/main.js que convierte lo que eligió el usuario en el corte y el fade
// (setCutBars / defaultManualCut / fadeBeatsToSeconds de js/ui/format.js).
#pragma once

#include "djec/analysis_result.h"
#include "djec/meter.h"

#include <cstddef>
#include <functional>
#include <limits>
#include <string>
#include <vector>

namespace djec
{

// «Suavizado de empalmes» (XFADE_MS)
constexpr double kCrossfadeMinMs = 5, kCrossfadeMaxMs = 40, kCrossfadeDefMs = 10;
/** Margen entre el final del crossfade y el límite musical (SPLICE_GUARD_SEC). */
constexpr double kSpliceGuardSec = 0.015;
/** Ventana del imán de los límites internos al ataque real más cercano (SNAP_WINDOW_SEC). */
constexpr double kSnapWindowSec = 0.025;
/** Pasos del fade en beats (FADE_BEAT_STEPS). */
constexpr double kFadeBeatSteps[7] = {0, 0.5, 1, 2, 4, 8, 16};
/** La última corchea de cada compás: 4/4 → 7/8 (DEFAULT_METER_AMOUNT). */
extern const char* const kDefaultMeterAmount;   // "eighth"

/**
 * Botón de «Recortar cada compás». id: "eighth" | "beat" | "two-beats" | "sixteenth" | "extend" | "other".
 * main + note = texto del botón ("½ tiempo" + "(corchea)"); name = "½ tiempo (corchea)"; result = "7/8" ("" en «Otro»).
 * num/den = compás nuevo (0/0 en «Otro»).
 */
struct MeterAmountChip
{
    std::string id, main, note, name;
    int num = 0, den = 0;
    std::string result;
};

/**
 * Botones para un compás de M/sourceDen (M = beatsPerBar, fuera de 1..32 → 4): solo los que dan un compás válido y
 * distinto del original; «Otro» siempre. Con sourceDen = 4 (la web) los textos y compases son los de la web.
 * Extensión del plugin para la cuadrícula de FL en x/8, x/2 o x/16: «½ tiempo» es medio tiempo del compás del proyecto
 * (en 7/8: "½ tiempo (semicorchea)" → 13/16) y «¼ tiempo» un cuarto (desaparece si necesitaría /32).
 */
std::vector<MeterAmountChip> meterAmountChips(int beatsPerBar, int sourceDen = 4);

struct TargetMeter
{
    std::string amount;   // el botón que vale de verdad
    int num = 0, den = 0; // 0/0 = sin compás válido (NaN en la web → "El denominador del compás debe ser…")
};

/**
 * Elección del usuario → compás nuevo. Con «Otro», otherNum/otherDen tal cual (puede ser inválido y el plan lo dice).
 * Una cantidad que no existe para este compás (o desconocida) usa la de por defecto.
 */
TargetMeter targetMeter(const std::string& amount, int otherNum, int otherDen, int beatsPerBar, int sourceDen = 4);

/**
 * Imán de los límites internos del recorte (makeTransientSnap de la web): lleva un instante al ataque real más cercano
 * (±window) con el detector de transitorios del análisis (refineToTransients), sobre una mezcla mono de un trozo corto
 * de la fuente alrededor del instante. Guarda los punteros: los canales tienen que seguir vivos mientras se use.
 * Sin canales o con frecuencia no válida devuelve una función vacía (sin imán), como el null de la web.
 */
std::function<double(double)> makeTransientSnap(const float* const* channels, int numChannels, std::size_t length,
                                                double sampleRate, double window = kSnapWindowSec);

/** Mediana de los intervalos entre los `count` beats anteriores al corte (beats <= time + 20 ms). */
double medianBeatInterval(const std::vector<double>& beats, double time, int count = 8, double fallbackBpm = 120);
/** Fade en beats → segundos con el IBI mediano antes del corte (0 si fadeBeats == 0). */
double fadeBeatsToSeconds(double fadeBeats, const std::vector<double>& beats, double cutTime, double bpm);

// ---- nivel "web": buildEditPlan(result, {...}) tal cual ----

struct EditPlanOptions
{
    double duration = 0;          // s del audio (<= 0 o no finito → result.duration)
    bool mode1 = false;           // quitar compases del final (usa cutTime si es finito)
    double cutTime = std::numeric_limits<double>::quiet_NaN();
    double fadeSec = 0;
    bool mode2 = false;           // recortar cada compás
    int targetNum = 0, targetDen = 0;
    double crossfadeSec = kCrossfadeDefMs / 1000;
    std::function<double(double)> snap;   // imán de los límites internos (puede estar vacío)
};

struct EditPlan
{
    std::vector<Segment> segments;   // rangos de la fuente en orden de salida (lo que se renderiza)
    double outputDuration = 0;
    double sourceEnd = 0;            // fin de lo que se usa de la fuente (el corte del modo 1, o la duración)
    double preroll = 0;              // max(kCutPrerollSec, crossfade/2 + kSpliceGuardSec)
    double crossfadeSec = 0, fadeOutSec = 0;
    std::string curve = "smooth";
    bool hasMeter = false;           // false = modo 2 apagado (meter = null en la web)
    MeterPlan meter;
    bool meterApplies = false;       // el recorte de cada compás cambia algo de verdad (meterApplies de la web)

    // ---- solo buildEditPlan(grid, sourceDen, settings) (nivel plugin) ----
    bool useCut = false;             // «Quitar compases del final» activo
    double cutTime = -1;             // s (ya con el pre-roll), -1 sin corte
    bool cutFromBars = false;        // el corte cae en un "1" (si no, corte "a mano" en el último golpe, como la web)
    int barsRemoved = 0;             // compases que se quitan de verdad (0 con corte "a mano")
    double fadeSec = 0;              // fade del corte en segundos
    TargetMeter target;              // compás nuevo elegido
    std::string blocker;             // motivo en español por el que no se puede renderizar ("" = se puede)
    std::string blockerId;           // "" | "no-mode" | "no-grid" | "bad-meter" | "no-change" | "empty"
};

/** Port exacto de buildEditPlan de la web (sin exportBlocker). sourceDen = denominador del compás original. */
EditPlan combineEditPlan(const AnalysisResult& result, int sourceDen, const EditPlanOptions& options);

/** exportBlocker de la web: "" si se puede guardar/renderizar, o el motivo (texto de la web). id: ver EditPlan. */
std::string exportBlocker(const EditPlan& plan, bool mode1, bool mode2, std::string* id = nullptr);

// ---- nivel plugin: lo que eligió el usuario → plan ----

struct EditSettings
{   // everything the user sets (mirrors the web UI state)
    bool trimEachBar = true;
    std::string amount = "eighth";
    int otherNum = 7, otherDen = 8;
    double crossfadeSec = 0.010;
    bool removeEnd = false;
    int barsToRemove = 1;
    double fadeBeats = 0;
    std::string curve = "smooth";
};

/**
 * Lo que hace la web con el estado de la interfaz: compás nuevo (targetMeter), corte del modo 1 (cutForBarsRemoved
 * − kCutPrerollSec; si no hay compases que quitar, corte "a mano" en lastOnset − pre-roll como defaultManualCut),
 * fade (fadeBeatsToSeconds), combineEditPlan y exportBlocker. duration = grid.duration.
 * Única diferencia con la web: si el último compás está vacío (la toma terminó justo en una barra de compás y la
 * cuadrícula tiene el "1" final en ese instante), «Quitar N compases» cuenta desde el compás anterior a ese.
 */
EditPlan buildEditPlan(const AnalysisResult& grid, int sourceDen, const EditSettings& settings,
                       const std::function<double(double)>& snap = {});

} // namespace djec
