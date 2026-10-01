// Port de js/ui/edit-plan.js (buildEditPlan, meterAmountChips, targetMeter, exportBlocker), de fadeBeatsToSeconds
// (js/ui/format.js) y de la parte de js/main.js que arma el corte del modo 1 (setCutBars / defaultManualCut).
#include "djec/edit_plan.h"

#include "djec/analysis/bounds.h"
#include "djec/bars.h"
#include "djec/fade.h"

#include <algorithm>
#include <cmath>

namespace djec
{

const char* const kDefaultMeterAmount = "eighth";

namespace
{
const char* const kBlockNoMode = "Activa «Recortar cada compás» o «Quitar compases del final» para poder descargar.";
const char* const kBlockNoGrid = "Sin beats ni compases detectados no se puede recortar cada compás: desactiva "
                                 "«Recortar cada compás» para guardar.";
const char* const kBlockBadMeter = "Elige un compás válido o desactiva «Recortar cada compás».";
const char* const kBlockNoChange = "Con ese compás la canción no cambia: elige otro compás.";
const char* const kBlockEmpty = "No queda audio que guardar.";

bool validDen(int d)
{
    return d == 2 || d == 4 || d == 8 || d == 16;
}

int sourceBeats(int beatsPerBar)
{
    return beatsPerBar >= 1 && beatsPerBar <= kMeterNumMax ? beatsPerBar : 4;
}

const char* noteName(int n)
{
    switch (n)
    {
        case 2: return "blanca";
        case 4: return "negra";
        case 8: return "corchea";
        case 16: return "semicorchea";
        case 32: return "fusa";
        case 64: return "semifusa";
        default: return "";
    }
}

struct AmountDef
{
    const char* id;
    const char* main;
    int noteMul;     // nota = figura de 1/(noteMul·sourceDen) ("(corchea)" en 4/4); 0 = sin nota fija
    const char* fixedNote;
    // compás nuevo: num = a·m + b, den = denMul·sourceDen; a == 0 && b == 0 → «Otro»
    int a, b, denMul;
};

const AmountDef kAmounts[] = {
    {"eighth", "½ tiempo", 2, "", 2, -1, 2},
    {"beat", "1 tiempo", 0, "", 1, -1, 1},
    {"two-beats", "2 tiempos", 0, "", 1, -2, 1},
    {"sixteenth", "¼ tiempo", 4, "", 4, -1, 4},
    {"extend", "Alargar:", 0, "repetir el último tiempo", 1, 1, 1},
    {"other", "Otro compás…", 0, "", 0, 0, 0},
};

double medianOf(std::vector<double> v)
{
    if (v.empty())
        return std::numeric_limits<double>::quiet_NaN();
    std::sort(v.begin(), v.end());
    const std::size_t m = v.size() >> 1;
    return (v.size() % 2) ? v[m] : (v[m - 1] + v[m]) / 2;
}

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

double clampJs(double x, double lo, double hi)
{
    return x < lo ? lo : x > hi ? hi : x;
}
} // namespace

std::vector<MeterAmountChip> meterAmountChips(int beatsPerBar, int sourceDen)
{
    const int m = sourceBeats(beatsPerBar);
    const int sDen = validDen(sourceDen) ? sourceDen : 4;
    std::vector<MeterAmountChip> out;
    for (const AmountDef& a : kAmounts)
    {
        MeterAmountChip c;
        c.id = a.id;
        c.main = a.main;
        if (a.noteMul)
            c.note = std::string("(") + noteName(a.noteMul * sDen) + ")";
        else
            c.note = a.fixedNote;
        c.name = c.note.empty() ? c.main : c.main + " " + c.note;
        if (a.a == 0 && a.b == 0)
        {
            out.push_back(c);   // «Otro» siempre
            continue;
        }
        const int num = a.a * m + a.b;
        const int den = a.denMul * sDen;
        if (!(num >= 1 && num <= kMeterNumMax))
            continue;
        const MeterDescription d = describeMeterChange(m, num, den, sDen);
        if (!d.error.empty() || d.delta == 0)
            continue;
        c.num = num;
        c.den = den;
        c.result = std::to_string(num) + "/" + std::to_string(den);
        out.push_back(c);
    }
    return out;
}

TargetMeter targetMeter(const std::string& amount, int otherNum, int otherDen, int beatsPerBar, int sourceDen)
{
    if (amount == "other")
        return TargetMeter{amount, otherNum, otherDen};
    const std::vector<MeterAmountChip> chips = meterAmountChips(beatsPerBar, sourceDen);
    const MeterAmountChip* c = nullptr;
    for (const MeterAmountChip& x : chips)
        if (x.id == amount && x.id != "other")
        {
            c = &x;
            break;
        }
    if (!c)
        for (const MeterAmountChip& x : chips)
            if (x.id == kDefaultMeterAmount)
            {
                c = &x;
                break;
            }
    if (c)
        return TargetMeter{c->id, c->num, c->den};
    return TargetMeter{"other", 0, 0};
}

std::function<double(double)> makeTransientSnap(const float* const* channels, int numChannels, std::size_t length,
                                                double sampleRate, double window)
{
    if (!channels || numChannels < 1 || !(sampleRate > 0) || !std::isfinite(sampleRate))
        return {};
    std::vector<const float*> chans(channels, channels + numChannels);
    for (const float* c : chans)
        if (!c)
            return {};
    const double sr = sampleRate;
    const double margin = window + 0.03;   // bloques previos/posteriores que mira el detector
    return [chans, length, sr, window, margin](double t) -> double {
        if (!std::isfinite(t))
            return t;
        const long long i0 = std::max<long long>(0, static_cast<long long>(std::floor((t - margin) * sr)));
        const long long i1 = std::min<long long>(static_cast<long long>(length),
                                                 static_cast<long long>(std::ceil((t + margin) * sr)));
        if (i1 - i0 < 16)
            return t;
        // Float32Array en la web: cada suma y la división se redondean a float
        std::vector<float> mono(static_cast<std::size_t>(i1 - i0), 0.0f);
        for (const float* c : chans)
            for (long long i = i0; i < i1; ++i)
                mono[static_cast<std::size_t>(i - i0)] += c[i];
        if (chans.size() > 1)
            for (float& v : mono)
                v /= static_cast<float>(chans.size());
        const double off = static_cast<double>(i0) / sr;
        analysis::RefineOptions o;
        o.window = window;
        const std::vector<double> v = analysis::refineToTransients(mono.data(), mono.size(), sr, {t - off}, o);
        return !v.empty() && std::isfinite(v[0]) ? v[0] + off : t;
    };
}

double medianBeatInterval(const std::vector<double>& beats, double time, int count, double fallbackBpm)
{
    const double fallback = 60 / (std::isfinite(fallbackBpm) && fallbackBpm > 0 ? fallbackBpm : 120);
    if (beats.size() < 2)
        return fallback;
    std::size_t end = lowerBound(beats, time + 0.02);   // exclusivo
    if (end < 2)
        end = std::min(beats.size(), static_cast<std::size_t>(std::max(0, count)));
    const std::size_t start = end > static_cast<std::size_t>(std::max(0, count)) ? end - count : 0;
    std::vector<double> ibis;
    for (std::size_t i = start + 1; i < end; ++i)
    {
        const double d = beats[i] - beats[i - 1];
        if (d > 0)
            ibis.push_back(d);
    }
    const double m = medianOf(std::move(ibis));
    return std::isfinite(m) && m > 0 ? m : fallback;
}

double fadeBeatsToSeconds(double fadeBeats, const std::vector<double>& beats, double cutTime, double bpm)
{
    if (!(fadeBeats != 0) || std::isnan(fadeBeats))
        return 0;
    return fadeBeats * medianBeatInterval(beats, cutTime, 8, bpm);
}

EditPlan combineEditPlan(const AnalysisResult& r, int sourceDen, const EditPlanOptions& o)
{
    EditPlan plan;
    const double rDur = std::isnan(r.duration) ? 0 : r.duration;
    const double dur = std::isfinite(o.duration) && o.duration > 0 ? o.duration : std::max(0.0, rDur);
    const bool useCut = o.mode1 && std::isfinite(o.cutTime);
    const double sourceEnd = useCut ? std::min(std::max(0.0, o.cutTime), dur) : dur;
    const double xf = std::max(0.0, std::isnan(o.crossfadeSec) ? 0.0 : o.crossfadeSec);
    // el crossfade no debe llegar al ataque siguiente: el empalme va xf/2 + margen antes del límite musical.
    const double preroll = std::max(kCutPrerollSec, xf / 2 + kSpliceGuardSec);
    if (o.mode2)
    {
        AnalysisResult rr = r;
        rr.duration = dur;
        plan.meter = planMeterChange(rr, o.targetNum, o.targetDen, sourceDen, useCut ? sourceEnd : -1, preroll, o.snap);
        plan.hasMeter = true;
        plan.segments = plan.meter.segments;
    }
    else if (sourceEnd > 0)
    {
        plan.segments.push_back({0, sourceEnd});
    }
    double outputDuration = 0;
    for (const Segment& s : plan.segments)
        outputDuration += s.end - s.start;
    plan.outputDuration = outputDuration;
    plan.sourceEnd = sourceEnd;
    plan.preroll = preroll;
    plan.crossfadeSec = xf;
    plan.fadeOutSec = useCut ? std::max(0.0, std::isnan(o.fadeSec) ? 0.0 : o.fadeSec) : 0;
    plan.meterApplies = plan.hasMeter && plan.meter.error.empty() && plan.meter.barsChanged > 0;
    return plan;
}

std::string exportBlocker(const EditPlan& plan, bool mode1, bool mode2, std::string* id)
{
    auto ret = [&](const char* blockId, const char* text) {
        if (id)
            *id = blockId;
        return std::string(text);
    };
    if (!mode1 && !mode2)
        return ret("no-mode", kBlockNoMode);
    const MeterPlan* m = plan.hasMeter ? &plan.meter : nullptr;
    if (mode2 && m && (m->error == kMeterMsgNoBeats || m->error == kMeterMsgNoBars))
        // ningún compás serviría: el problema es la cuadrícula, no el compás elegido
        return ret("no-grid", kBlockNoGrid);
    if (mode2 && m && !m->error.empty())
        return ret("bad-meter", kBlockBadMeter);
    if (!mode1 && mode2 && (!m || !m->barsChanged))
        return ret("no-change", kBlockNoChange);
    if (!(plan.outputDuration > 0))
        return ret("empty", kBlockEmpty);
    return ret("", "");
}

EditPlan buildEditPlan(const AnalysisResult& grid, int sourceDen, const EditSettings& s,
                       const std::function<double(double)>& snap)
{
    const TargetMeter tm = targetMeter(s.amount, s.otherNum, s.otherDen, grid.beatsPerBar, sourceDen);
    const double dur = std::isfinite(grid.duration) && grid.duration > 0 ? grid.duration : 0;

    // Corte del modo 1 (setCutBars de main.js; si no hay compases que quitar, el corte "a mano" por defecto)
    bool cutFromBars = false;
    int barsRemoved = 0;
    double cutTime = -1;
    if (s.removeEnd)
    {
        const std::vector<Bar> bars = getBars(grid);
        int last = findLastBarIndex(grid);
        int extra = 0;
        // (plugin) último compás vacío: la toma terminó en la barra de compás → se cuenta desde el anterior
        if (last >= 1 && !(bars[static_cast<std::size_t>(last)].end - bars[static_cast<std::size_t>(last)].start > 1e-9))
            extra = 1;
        last -= extra;
        std::optional<BarCut> c;
        if (last >= 1)
            c = cutForBarsRemoved(grid, s.barsToRemove >= 1 ? s.barsToRemove + extra : s.barsToRemove);
        if (c && std::isfinite(c->time))
        {
            cutTime = std::max(0.0, c->time - kCutPrerollSec);
            barsRemoved = std::max(1, last - c->barIndex + 1);
            cutFromBars = true;
        }
        else
        {
            const double t = std::isfinite(grid.lastOnset) && grid.lastOnset > 0.5 ? grid.lastOnset - kCutPrerollSec
                                                                                    : std::max(0.05, dur - 1);
            cutTime = clampJs(t, 0.05, dur);
        }
    }
    const double fadeSec = s.removeEnd ? fadeBeatsToSeconds(s.fadeBeats, grid.beats, cutTime, grid.bpm) : 0;

    EditPlanOptions o;
    o.duration = dur;
    o.mode1 = s.removeEnd;
    o.cutTime = s.removeEnd ? cutTime : std::numeric_limits<double>::quiet_NaN();
    o.fadeSec = fadeSec;
    o.mode2 = s.trimEachBar;
    o.targetNum = tm.num;
    o.targetDen = tm.den;
    o.crossfadeSec = s.crossfadeSec;
    o.snap = snap;
    EditPlan plan = combineEditPlan(grid, sourceDen, o);
    plan.curve = s.curve;
    plan.useCut = s.removeEnd;
    plan.cutTime = cutTime;
    plan.cutFromBars = cutFromBars;
    plan.barsRemoved = barsRemoved;
    plan.fadeSec = fadeSec;
    plan.target = tm;
    plan.blocker = exportBlocker(plan, s.removeEnd, s.trimEachBar, &plan.blockerId);
    return plan;
}

} // namespace djec
