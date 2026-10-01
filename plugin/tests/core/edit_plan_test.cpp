// Plan de edición (djec/edit_plan.h) y PARIDAD con la web de todo el motor de recorte: bars, meter, edit-plan,
// fades y renderSegments. Datos: plugin/tools/golden-edit.mjs → <DJEC_GOLDEN_DIR>/edit/ (variable de entorno o
// definición de compilación). Si no están, los tests de paridad se saltan con un mensaje.
#include <doctest.h>

#include "djec/bars.h"
#include "djec/edit_plan.h"
#include "djec/fade.h"
#include "djec/meter.h"
#include "djec/splice.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef DJEC_GOLDEN_DIR
#define DJEC_GOLDEN_DIR ""
#endif

using namespace djec;

namespace
{
// ------------------------------------------------------------------------------------------ JSON mínimo

struct Json
{
    enum class T
    {
        Null,
        Bool,
        Num,
        Str,
        Arr,
        Obj
    } t = T::Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Json> a;
    std::map<std::string, Json> o;

    const Json& operator[](const std::string& k) const
    {
        static const Json null;
        auto it = o.find(k);
        return it == o.end() ? null : it->second;
    }
    const Json& operator[](std::size_t i) const { return a.at(i); }
    std::size_t size() const { return a.size(); }
    bool isNull() const { return t == T::Null; }
    double num() const { return t == T::Num ? n : std::nan(""); }   // null (NaN en la web) → NaN
    int i() const { return t == T::Num ? static_cast<int>(std::lround(n)) : 0; }
    std::string str() const { return t == T::Str ? s : std::string(); }   // null → ""
    bool boolean() const { return t == T::Bool ? b : false; }
};

class JsonParser
{
public:
    explicit JsonParser(const std::string& text) : s_(text) {}
    Json parse()
    {
        Json v = value();
        ws();
        if (p_ != s_.size())
            throw std::runtime_error("JSON: basura al final");
        return v;
    }

private:
    const std::string& s_;
    std::size_t p_ = 0;

    void ws()
    {
        while (p_ < s_.size() && (s_[p_] == ' ' || s_[p_] == '\n' || s_[p_] == '\r' || s_[p_] == '\t'))
            ++p_;
    }
    bool lit(const char* w)
    {
        const std::size_t n = std::char_traits<char>::length(w);
        if (s_.compare(p_, n, w) == 0)
        {
            p_ += n;
            return true;
        }
        return false;
    }
    static void utf8(std::string& out, unsigned cp)
    {
        if (cp < 0x80)
            out += static_cast<char>(cp);
        else if (cp < 0x800)
        {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
        else if (cp < 0x10000)
        {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
        else
        {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }
    unsigned hex4()
    {
        unsigned v = 0;
        for (int k = 0; k < 4; ++k)
        {
            const char c = s_.at(p_++);
            v = v * 16 + static_cast<unsigned>(c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10);
        }
        return v;
    }
    std::string string()
    {
        std::string out;
        ++p_;   // "
        while (true)
        {
            const char c = s_.at(p_++);
            if (c == '"')
                break;
            if (c != '\\')
            {
                out += c;
                continue;
            }
            const char e = s_.at(p_++);
            switch (e)
            {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'u':
                {
                    unsigned cp = hex4();
                    if (cp >= 0xD800 && cp < 0xDC00 && s_.compare(p_, 2, "\\u") == 0)
                    {
                        p_ += 2;
                        const unsigned lo = hex4();
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    utf8(out, cp);
                    break;
                }
                default: out += e;
            }
        }
        return out;
    }
    Json value()
    {
        ws();
        Json v;
        const char c = s_.at(p_);
        if (c == '{')
        {
            v.t = Json::T::Obj;
            ++p_;
            ws();
            if (s_.at(p_) == '}')
            {
                ++p_;
                return v;
            }
            while (true)
            {
                ws();
                std::string k = string();
                ws();
                ++p_;   // :
                v.o.emplace(std::move(k), value());
                ws();
                if (s_.at(p_++) == '}')
                    break;
            }
        }
        else if (c == '[')
        {
            v.t = Json::T::Arr;
            ++p_;
            ws();
            if (s_.at(p_) == ']')
            {
                ++p_;
                return v;
            }
            while (true)
            {
                v.a.push_back(value());
                ws();
                if (s_.at(p_++) == ']')
                    break;
            }
        }
        else if (c == '"')
        {
            v.t = Json::T::Str;
            v.s = string();
        }
        else if (lit("true"))
        {
            v.t = Json::T::Bool;
            v.b = true;
        }
        else if (lit("false"))
            v.t = Json::T::Bool;
        else if (lit("null"))
            v.t = Json::T::Null;
        else
        {
            const char* start = s_.c_str() + p_;
            char* end = nullptr;
            v.n = std::strtod(start, &end);   // JSON.stringify: el double más corto que vuelve exacto
            v.t = Json::T::Num;
            p_ += static_cast<std::size_t>(end - start);
        }
        return v;
    }
};

std::string goldenDir()
{
    if (const char* env = std::getenv("DJEC_GOLDEN_DIR"))
        if (*env)
            return std::string(env) + "/edit";
    return std::string(DJEC_GOLDEN_DIR) + "/edit";
}

const Json* golden()
{
    static std::unique_ptr<Json> g;
    static bool tried = false;
    if (!tried)
    {
        tried = true;
        std::ifstream f(goldenDir() + "/edit.json", std::ios::binary);
        if (f)
        {
            std::stringstream ss;
            ss << f.rdbuf();
            g = std::make_unique<Json>(JsonParser(ss.str()).parse());
        }
    }
    return g.get();
}

#define REQUIRE_GOLDEN()                                                                                               \
    const Json* G = golden();                                                                                          \
    if (!G)                                                                                                            \
    {                                                                                                                  \
        MESSAGE("sin datos golden en " << goldenDir() << " (node plugin/tools/golden-edit.mjs <dir>): se salta");      \
        return;                                                                                                        \
    }

std::vector<float> readF32(const std::string& path)
{
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f)
        return {};
    const std::streamsize bytes = f.tellg();
    f.seekg(0);
    std::vector<float> v(static_cast<std::size_t>(bytes) / sizeof(float));
    f.read(reinterpret_cast<char*>(v.data()), static_cast<std::streamsize>(v.size() * sizeof(float)));
    return v;
}

std::vector<double> nums(const Json& j)
{
    std::vector<double> v;
    for (const Json& e : j.a)
        v.push_back(e.num());
    return v;
}

std::vector<int> ints(const Json& j)
{
    std::vector<int> v;
    for (const Json& e : j.a)
        v.push_back(e.i());
    return v;
}

AnalysisResult toResult(const Json& j)
{
    AnalysisResult r;
    r.duration = j["duration"].num();
    r.musicStart = j["musicStart"].num();
    r.musicEnd = j["musicEnd"].num();
    r.lastOnset = j["lastOnset"].num();   // null = sin lastOnset (NaN)
    r.bpm = j["bpm"].num();
    r.beats = nums(j["beats"]);
    r.beatStrength = nums(j["beatStrength"]);
    r.beatsPerBar = j["beatsPerBar"].i();
    r.positions = ints(j["positions"]);
    r.downbeats = ints(j["downbeats"]);
    return r;
}

std::vector<Segment> toSegments(const Json& j)
{
    std::vector<Segment> v;
    for (const Json& e : j.a)
        v.push_back({e["start"].num(), e["end"].num()});
    return v;
}

// a == b como números de la web (NaN == NaN)
bool same(double a, double b, double tol)
{
    if (std::isnan(a) || std::isnan(b))
        return std::isnan(a) && std::isnan(b);
    if (std::isinf(a) || std::isinf(b))
        return a == b;
    return std::fabs(a - b) <= tol;
}

// Compara listas de segmentos; devuelve el error máximo (s) o +inf si cambia la cantidad.
double segmentsDiff(const std::vector<Segment>& a, const Json& b)
{
    if (a.size() != b.size())
        return INFINITY;
    double m = 0;
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        m = std::max(m, std::fabs(a[i].start - b[i]["start"].num()));
        m = std::max(m, std::fabs(a[i].end - b[i]["end"].num()));
    }
    return m;
}

void checkMeterPlan(const MeterPlan& p, const Json& e, const std::string& ctx)
{
    INFO(ctx);
    CHECK(segmentsDiff(p.segments, e["segments"]) <= 1e-9);
    CHECK(segmentsDiff(p.removed, e["removed"]) <= 1e-9);
    CHECK(segmentsDiff(p.repeated, e["repeated"]) <= 1e-9);
    CHECK(p.barsChanged == e["barsChanged"].i());
    CHECK(p.delta == e["delta"].i());
    CHECK(p.unitsPerBeat == e["unitsPerBeat"].i());
    CHECK(same(p.outputDuration, e["outputDuration"].num(), 1e-9));
    CHECK(p.error == e["error"].str());
    CHECK(p.info == e["info"].str());
}

EditSettings toSettings(const Json& s)
{
    EditSettings o;
    o.trimEachBar = s["trimEachBar"].boolean();
    o.amount = s["amount"].str();
    o.otherNum = s["otherNum"].i();
    o.otherDen = s["otherDen"].i();
    o.crossfadeSec = s["crossfadeSec"].num();
    o.removeEnd = s["removeEnd"].boolean();
    o.barsToRemove = s["barsToRemove"].i();
    o.fadeBeats = s["fadeBeats"].num();
    o.curve = s["curve"].str();
    return o;
}

// Compara un plan completo con el de la web; devuelve la diferencia máxima de segmentos.
double checkEditPlan(const EditPlan& p, const Json& x)
{
    CHECK(p.target.amount == x["target"]["amount"].str());
    CHECK(p.target.num == x["target"]["num"].i());
    CHECK(p.target.den == x["target"]["den"].i());
    CHECK(same(p.cutTime, x["cutTime"].num(), 1e-12));
    CHECK(p.cutFromBars == x["cutFromBars"].boolean());
    CHECK(p.barsRemoved == x["barsRemoved"].i());
    CHECK(same(p.fadeSec, x["fadeSec"].num(), 1e-12));
    const double diff = segmentsDiff(p.segments, x["segments"]);
    CHECK(diff <= 1e-9);
    CHECK(same(p.outputDuration, x["outputDuration"].num(), 1e-9));
    CHECK(same(p.sourceEnd, x["sourceEnd"].num(), 1e-12));
    CHECK(p.preroll == x["preroll"].num());
    CHECK(same(p.crossfadeSec, x["crossfadeSec"].num(), 0));
    CHECK(same(p.fadeOutSec, x["fadeOutSec"].num(), 1e-12));
    CHECK(p.hasMeter == !x["meter"].isNull());
    if (p.hasMeter && !x["meter"].isNull())
        checkMeterPlan(p.meter, x["meter"], "meter");
    CHECK(p.meterApplies == x["meterApplies"].boolean());
    CHECK(p.blocker == x["blocker"].str());
    return diff;
}

// 4/4 a 120 BPM, 2 beats de anacrusa, 16 compases + compás final (como tests/ui-edit-plan.test.js)
AnalysisResult song(int bars = 16)
{
    AnalysisResult r;
    for (int i = 0; i < 2; ++i)
        r.positions.push_back(2 + i);
    for (int b = 0; b <= bars; ++b)
    {
        r.downbeats.push_back(static_cast<int>(r.positions.size()));
        for (int i = 0; i < 4; ++i)
            r.positions.push_back(i);
    }
    for (std::size_t i = 0; i < r.positions.size(); ++i)
        r.beats.push_back(0.3 + static_cast<double>(i) * 0.5);
    r.duration = r.beats.back() + 2;
    r.musicEnd = r.beats.back() + 1.5;
    r.lastOnset = r.beats[static_cast<std::size_t>(r.downbeats[static_cast<std::size_t>(bars)])] + 0.01;
    r.bpm = 120;
    r.beatsPerBar = 4;
    return r;
}
} // namespace

// ================================================================================================ plan (unidad)

TEST_SUITE("edit_plan")
{
TEST_CASE("botones de «Recortar cada compás» en 4/4 y 3/4 (web) y en x/8 (cuadrícula de FL)")
{
    const auto c4 = meterAmountChips(4);
    REQUIRE(c4.size() == 6);
    const char* names[] = {"½ tiempo (corchea)", "1 tiempo", "2 tiempos", "¼ tiempo (semicorchea)",
                           "Alargar: repetir el último tiempo", "Otro compás…"};
    const char* results[] = {"7/8", "3/4", "2/4", "15/16", "5/4", ""};
    for (std::size_t k = 0; k < 6; ++k)
    {
        CHECK(c4[k].name == names[k]);
        CHECK(c4[k].result == results[k]);
    }
    CHECK(meterAmountChips(3)[0].result == "5/8");
    CHECK(meterAmountChips(2).size() == 5);   // «2 tiempos» dejaría el compás vacío
    CHECK(kDefaultMeterAmount == std::string("eighth"));

    // FL en 7/8: el tiempo es la corchea
    const auto c78 = meterAmountChips(7, 8);
    std::map<std::string, std::string> res, name;
    for (const auto& c : c78)
    {
        res[c.id] = c.result;
        name[c.id] = c.name;
    }
    CHECK(res.size() == 5);   // sin «¼ tiempo» (sería /32)
    CHECK(res["eighth"] == "13/16");
    CHECK(name["eighth"] == "½ tiempo (semicorchea)");
    CHECK(res["beat"] == "6/8");
    CHECK(res["two-beats"] == "5/8");
    CHECK(res["extend"] == "8/8");
    CHECK(res.count("sixteenth") == 0);
    const TargetMeter t = targetMeter("sixteenth", 0, 0, 7, 8);   // no existe en 7/8 → la de por defecto
    CHECK(t.amount == "eighth");
    CHECK(t.num == 13);
    CHECK(t.den == 16);
    CHECK(describeMeterChange(7, 13, 16, 8).text == "Se quita la última semicorchea de cada compás.");
}

TEST_CASE("buildEditPlan: por defecto quita 1/8 de compás en cada compás (4/4 → 7/8)")
{
    const AnalysisResult r = song();
    const EditPlan p = buildEditPlan(r, 4, EditSettings{});
    CHECK(p.blocker.empty());
    CHECK(p.blockerId.empty());
    CHECK(p.hasMeter);
    CHECK(p.meterApplies);
    CHECK(p.target.num == 7);
    CHECK(p.target.den == 8);
    CHECK(p.meter.barsChanged == 16);
    for (const Segment& s : p.meter.removed)
        CHECK(s.end - s.start == doctest::Approx(0.25).epsilon(1e-9));
    CHECK(p.preroll == doctest::Approx(0.02));
    CHECK(p.fadeOutSec == 0);
    CHECK_FALSE(p.useCut);
    CHECK(p.outputDuration == doctest::Approx(r.duration - 4));
}

TEST_CASE("buildEditPlan: quitar compases del final, fade en beats y bloqueos")
{
    const AnalysisResult r = song();
    EditSettings s;
    s.trimEachBar = false;
    s.removeEnd = true;
    s.barsToRemove = 2;
    s.fadeBeats = 2;
    const EditPlan p = buildEditPlan(r, 4, s);
    REQUIRE(p.segments.size() == 1);
    const double cut = r.beats[static_cast<std::size_t>(r.downbeats[15])] - kCutPrerollSec;
    CHECK(p.cutTime == doctest::Approx(cut));
    CHECK(p.segments[0].end == doctest::Approx(cut));
    CHECK(p.barsRemoved == 2);
    CHECK(p.cutFromBars);
    CHECK(p.fadeOutSec == doctest::Approx(1.0));   // 2 beats a 120 BPM
    CHECK_FALSE(p.hasMeter);

    EditSettings none;
    none.trimEachBar = false;
    CHECK(buildEditPlan(r, 4, none).blocker ==
          "Activa «Recortar cada compás» o «Quitar compases del final» para poder descargar.");
    EditSettings bad;
    bad.amount = "other";
    bad.otherNum = 7;
    bad.otherDen = 3;
    const EditPlan pb = buildEditPlan(r, 4, bad);
    CHECK(pb.blockerId == "bad-meter");
    CHECK(pb.blocker == "Elige un compás válido o desactiva «Recortar cada compás».");
    EditSettings same;
    same.amount = "other";
    same.otherNum = 4;
    same.otherDen = 4;
    CHECK(buildEditPlan(r, 4, same).blocker == "Con ese compás la canción no cambia: elige otro compás.");
    CHECK(buildEditPlan(AnalysisResult{}, 4, EditSettings{}).blockerId == "no-grid");
}

TEST_CASE("buildEditPlan (plugin): toma que termina justo en la barra de compás")
{
    // 8 compases de 4/4 a 120 BPM desde 0 y el "1" final en el último instante de la toma (como gridFromHost)
    AnalysisResult g;
    for (int i = 0; i <= 32; ++i)
    {
        g.beats.push_back(i * 0.5);
        g.positions.push_back(i % 4);
        if (i % 4 == 0)
            g.downbeats.push_back(i);
    }
    g.duration = 16;
    g.musicEnd = 16;
    g.lastOnset = 16;
    g.bpm = 120;
    g.beatsPerBar = 4;
    EditSettings s;
    const EditPlan all = buildEditPlan(g, 4, s);
    CHECK(all.meter.barsChanged == 8);   // todos los compases completos
    CHECK(all.outputDuration == doctest::Approx(16 - 8 * 0.25));
    s.removeEnd = true;
    s.barsToRemove = 1;
    const EditPlan one = buildEditPlan(g, 4, s);
    CHECK(one.cutFromBars);
    CHECK(one.barsRemoved == 1);
    CHECK(one.cutTime == doctest::Approx(14 - kCutPrerollSec));   // se quita el compás 8 (no el vacío)
    CHECK(one.meter.barsChanged == 7);
    s.barsToRemove = 3;
    CHECK(buildEditPlan(g, 4, s).cutTime == doctest::Approx(10 - kCutPrerollSec));
    s.barsToRemove = 50;   // queda al menos 1 compás
    const EditPlan many = buildEditPlan(g, 4, s);
    CHECK(many.cutTime == doctest::Approx(2 - kCutPrerollSec));
    CHECK(many.barsRemoved == 7);
}

TEST_CASE("medianBeatInterval / fadeBeatsToSeconds")
{
    std::vector<double> beats;
    for (int i = 0; i < 20; ++i)
        beats.push_back(i * 0.5);
    CHECK(medianBeatInterval(beats, 5) == doctest::Approx(0.5));
    CHECK(fadeBeatsToSeconds(4, beats, 5, 120) == doctest::Approx(2));
    CHECK(fadeBeatsToSeconds(0, beats, 5, 120) == 0);
    CHECK(medianBeatInterval({}, 5, 8, 100) == doctest::Approx(0.6));
}
}

// ====================================================================================== paridad con la web

TEST_SUITE("paridad web: edición")
{
TEST_CASE("constantes")
{
    REQUIRE_GOLDEN();
    const Json& c = (*G)["constants"];
    CHECK(kCutPrerollSec == c["CUT_PREROLL_SEC"].num());
    CHECK(kAntiClickSec == c["ANTICLICK_SEC"].num());
    CHECK(kLastBarTolerance == c["LAST_BAR_TOLERANCE"].num());
    CHECK(kSpliceGuardSec == c["SPLICE_GUARD_SEC"].num());
    CHECK(kSpliceCeiling == doctest::Approx(c["SPLICE_CEILING"].num()).epsilon(1e-15));
    CHECK(kSnapMaxSec == c["SNAP_MAX_SEC"].num());
    CHECK(kSnapWindowSec == c["SNAP_WINDOW_SEC"].num());
    CHECK(kCrossfadeMinMs == c["XFADE_MS"]["min"].num());
    CHECK(kCrossfadeMaxMs == c["XFADE_MS"]["max"].num());
    CHECK(kCrossfadeDefMs == c["XFADE_MS"]["def"].num());
    CHECK(kDefaultMeterAmount == c["DEFAULT_METER_AMOUNT"].str());
    const std::vector<double> steps = nums(c["FADE_BEAT_STEPS"]);
    REQUIRE(steps.size() == 7);
    for (std::size_t k = 0; k < 7; ++k)
        CHECK(kFadeBeatSteps[k] == steps[k]);
}

TEST_CASE("describeMeterChange: textos y unidades idénticos")
{
    REQUIRE_GOLDEN();
    int bad = 0;
    const Json& list = (*G)["describe"];
    for (const Json& e : list.a)
    {
        const MeterDescription d = describeMeterChange(e[0].i(), e[1].i(), e[2].i(), e[3].i());
        const bool ok = d.unitsPerBeat == e[4].i() && d.sourceUnits == e[5].i() && d.targetUnits == e[6].i() &&
                        d.delta == e[7].i() && d.unitName == e[8].str() && d.text == e[9].str() &&
                        d.error == e[10].str();
        if (!ok && ++bad <= 5)
            FAIL_CHECK(e[0].i() << "/" << e[3].i() << " → " << e[1].i() << "/" << e[2].i() << ": '" << d.text << "' '"
                                << d.error << "' vs '" << e[9].str() << "' '" << e[10].str() << "'");
    }
    MESSAGE(list.size() << " casos de describeMeterChange");
    CHECK(bad == 0);
}

TEST_CASE("meterAmountChips y targetMeter idénticos")
{
    REQUIRE_GOLDEN();
    for (const Json& e : (*G)["chips"].a)
    {
        const auto chips = meterAmountChips(e["bpb"].i());
        const Json& exp = e["chips"];
        INFO("bpb " << e["bpb"].i());
        REQUIRE(chips.size() == exp.size());
        for (std::size_t k = 0; k < chips.size(); ++k)
        {
            CHECK(chips[k].id == exp[k]["id"].str());
            CHECK(chips[k].main == exp[k]["main"].str());
            CHECK(chips[k].note == exp[k]["note"].str());
            CHECK(chips[k].name == exp[k]["name"].str());
            CHECK(chips[k].num == exp[k]["num"].i());
            CHECK(chips[k].den == exp[k]["den"].i());
            CHECK(chips[k].result == exp[k]["result"].str());
        }
    }
    for (const Json& e : (*G)["targets"].a)
    {
        const TargetMeter t = targetMeter(e["amount"].str(), e["num"].i(), e["den"].i(), e["bpb"].i());
        INFO(e["amount"].str() << " bpb " << e["bpb"].i());
        CHECK(t.amount == e["out"]["amount"].str());
        CHECK(t.num == e["out"]["num"].i());   // NaN (null) → 0
        CHECK(t.den == e["out"]["den"].i());
    }
}

TEST_CASE("fadeGain y fadeOutGains (float32) idénticos")
{
    REQUIRE_GOLDEN();
    const Json& f = (*G)["fade"];
    const std::vector<double> xs = nums(f["xs"]);
    double maxDiff = 0;
    int exact = 0, total = 0;
    for (const char* c : {"linear", "smooth", "exp", "otra"})
    {
        const std::vector<double> g = nums(f["gains"][c]);
        REQUIRE(g.size() == xs.size());
        for (std::size_t k = 0; k < xs.size(); ++k)
        {
            const float v = fadeGain(xs[k], c);
            maxDiff = std::max(maxDiff, std::fabs(static_cast<double>(v) - g[k]));
            exact += static_cast<double>(v) == g[k];
            ++total;
        }
    }
    for (const Json& e : (*G)["fadeOut"].a)
    {
        const auto g = fadeOutGains(static_cast<std::size_t>(e["len"].i()), e["curve"].str(),
                                    static_cast<std::size_t>(e["from"].i()), static_cast<std::size_t>(e["to"].i()));
        const std::vector<double> exp = nums(e["gains"]);
        REQUIRE(g.size() == exp.size());
        for (std::size_t k = 0; k < g.size(); ++k)
        {
            maxDiff = std::max(maxDiff, std::fabs(static_cast<double>(g[k]) - exp[k]));
            exact += static_cast<double>(g[k]) == exp[k];
            ++total;
        }
    }
    MESSAGE("ganancias de fade: " << exact << "/" << total << " idénticas, diferencia máxima " << maxDiff);
    CHECK(maxDiff <= 1.2e-7);   // a lo sumo 1 ulp de float por cos/pow de la librería
}

TEST_CASE("bars: getBars, findLastBarIndex, cutForBarsRemoved, barsRemovedAt, nearest, step")
{
    REQUIRE_GOLDEN();
    for (const Json& g : (*G)["grids"].a)
    {
        const AnalysisResult r = toResult(g["result"]);
        const std::string name = g["name"].str();
        INFO("cuadrícula " << name);
        const auto bars = getBars(r);
        const Json& eb = g["bars"];
        REQUIRE(bars.size() == eb.size());
        for (std::size_t k = 0; k < bars.size(); ++k)
        {
            CHECK(bars[k].index == eb[k]["index"].i());
            CHECK(bars[k].number == eb[k]["number"].i());
            CHECK(bars[k].beatIndex == eb[k]["beatIndex"].i());
            CHECK(bars[k].beatCount == eb[k]["beatCount"].i());
            CHECK(same(bars[k].start, eb[k]["start"].num(), 0));
            CHECK(same(bars[k].end, eb[k]["end"].num(), 1e-12));
        }
        CHECK(findLastBarIndex(r) == g["lastBarIndex"].i());
        for (const Json& c : g["cuts"].a)
        {
            const auto cut = cutForBarsRemoved(r, c[0].i());
            INFO("n = " << c[0].i());
            REQUIRE(cut.has_value() == !c[1].isNull());
            if (cut)
            {
                CHECK(cut->barIndex == c[1]["barIndex"].i());
                CHECK(cut->beatIndex == c[1]["beatIndex"].i());
                CHECK(cut->time == c[1]["time"].num());
                CHECK(cut->barsRemoved == c[1]["barsRemoved"].i());
            }
        }
        int bad = 0;
        for (const Json& e : g["removedAt"].a)
            bad += !same(barsRemovedAt(r, e[0].num()), e[1].num(), 1e-12);
        for (const Json& e : g["nearest"].a)
            bad += nearestBeatIndex(r, e[0].num()) != e[1].i();
        for (const Json& e : g["step"].a)
        {
            bad += !same(stepBeat(r, e[0].num(), e[1].i()), e[2].num(), 0);
            bad += !same(stepBar(r, e[0].num(), e[1].i()), e[3].num(), 0);
        }
        CHECK(bad == 0);
    }
}

TEST_CASE("planMeterChange: segmentos (±1e-9 s), textos y cuentas idénticos")
{
    REQUIRE_GOLDEN();
    const Json& grids = (*G)["grids"];
    std::vector<AnalysisResult> rs;
    for (const Json& g : grids.a)
        rs.push_back(toResult(g["result"]));
    double maxDiff = 0;
    for (const Json& e : (*G)["meterPlans"].a)
    {
        const AnalysisResult& r = rs[static_cast<std::size_t>(e["grid"].i())];
        const double limit = e["limitTime"].isNull() ? -1 : e["limitTime"].num();
        const MeterPlan p = planMeterChange(r, e["targetNum"].i(), e["targetDen"].i(), e["sourceDen"].i(), limit,
                                            e["preroll"].num());
        std::ostringstream ctx;
        ctx << grids[static_cast<std::size_t>(e["grid"].i())]["name"].str() << " → " << e["targetNum"].i() << "/"
            << e["targetDen"].i() << " (fuente /" << e["sourceDen"].i() << ", límite " << limit << ", pre-roll "
            << e["preroll"].num() << ")";
        checkMeterPlan(p, e["plan"], ctx.str());
        maxDiff = std::max(maxDiff, segmentsDiff(p.segments, e["plan"]["segments"]));
    }
    MESSAGE((*G)["meterPlans"].size() << " planes de compás; diferencia máxima de segmentos " << maxDiff << " s");
    for (const Json& m : (*G)["timeMaps"].a)
    {
        const std::vector<Segment> segs = toSegments(m["segments"]);
        for (const Json& e : m["s2o"].a)
        {
            const auto o = sourceToOutputTime(segs, e[0].num());
            REQUIRE(o.has_value() == !e[1].isNull());
            if (o)
                CHECK(same(*o, e[1].num(), 1e-12));
        }
        for (const Json& e : m["o2s"].a)
            CHECK(same(outputToSourceTime(segs, e[0].num()), e[1].num(), 1e-12));
    }
}

TEST_CASE("buildEditPlan: estado de la interfaz → plan idéntico al de la web (los dos modos)")
{
    REQUIRE_GOLDEN();
    const Json& grids = (*G)["grids"];
    std::vector<AnalysisResult> rs;
    for (const Json& g : grids.a)
        rs.push_back(toResult(g["result"]));
    double maxDiff = 0;
    for (const Json& e : (*G)["editPlans"].a)
    {
        const AnalysisResult& r = rs[static_cast<std::size_t>(e["grid"].i())];
        const EditSettings s = toSettings(e["settings"]);
        const EditPlan p = buildEditPlan(r, 4, s);
        INFO(grids[static_cast<std::size_t>(e["grid"].i())]["name"].str()
             << ": recortar " << s.trimEachBar << " (" << s.amount << " " << s.otherNum << "/" << s.otherDen << ", xf "
             << s.crossfadeSec << "), quitar " << s.removeEnd << " (" << s.barsToRemove << ", fade " << s.fadeBeats
             << " beats " << s.curve << ")");
        maxDiff = std::max(maxDiff, checkEditPlan(p, e["plan"]));
    }
    MESSAGE((*G)["editPlans"].size() << " planes completos; diferencia máxima de segmentos " << maxDiff << " s");
    for (const Json& e : (*G)["ibiCases"].a)
    {
        const std::vector<double> beats = nums(e["beats"]);
        if (!e["v"].isNull() || e.o.count("count"))
            CHECK(same(medianBeatInterval(beats, e["t"].num(), e["count"].i(), e["bpm"].num()), e["v"].num(), 1e-15));
        if (e.o.count("fade"))
            CHECK(same(fadeBeatsToSeconds(e["fadeBeats"].num(), beats, e["t"].num(), e["bpm"].num()), e["fade"].num(),
                       1e-15));
    }
}

TEST_CASE("makeTransientSnap (imán de los límites internos) y planes con imán idénticos")
{
    REQUIRE_GOLDEN();
    const Json& rd = (*G)["renders"];
    const std::vector<float> input = readF32(goldenDir() + "/input.f32");
    const std::size_t n = static_cast<std::size_t>(rd["inputLength"].i());
    REQUIRE(input.size() == 2 * n);
    const float* ch[2] = {input.data(), input.data() + n};
    const auto snap = makeTransientSnap(ch, 2, n, rd["sampleRate"].num());
    REQUIRE(snap);
    int moved = 0, bad = 0;
    double maxDiff = 0;
    for (const Json& e : (*G)["snapCases"].a)
    {
        const double t = e[0].num(), v = snap(t);
        if (!same(v, e[1].num(), 1e-9))
        {
            if (++bad <= 5)
                FAIL_CHECK("imán en " << t << ": " << v << " vs web " << e[1].num());
        }
        else if (std::isfinite(v))
            maxDiff = std::max(maxDiff, std::fabs(v - e[1].num()));
        moved += std::isfinite(t) && std::fabs(e[1].num() - t) > 1e-6;
    }
    MESSAGE((*G)["snapCases"].size() << " instantes, " << moved << " movidos por el imán en la web; diferencia máxima "
                                      << maxDiff << " s");
    CHECK(bad == 0);
    CHECK(moved > 0);
    CHECK_FALSE(makeTransientSnap(ch, 0, n, 44100));
    const Json& grids = (*G)["grids"];
    for (const Json& e : (*G)["snapPlans"].a)
    {
        const AnalysisResult r = toResult(grids[static_cast<std::size_t>(e["grid"].i())]["result"]);
        const EditSettings s = toSettings(e["settings"]);
        INFO("con imán: " << s.amount << ", quitar " << s.removeEnd);
        checkEditPlan(buildEditPlan(r, 4, s, snap), e["plan"]);
    }
}

TEST_CASE("renderSegments: mismas longitudes y muestras (< 1e-5) que la web")
{
    REQUIRE_GOLDEN();
    const Json& rd = (*G)["renders"];
    const std::vector<float> input = readF32(goldenDir() + "/input.f32");
    const std::vector<float> renders = readF32(goldenDir() + "/renders.f32");
    const std::size_t n = static_cast<std::size_t>(rd["inputLength"].i());
    REQUIRE(input.size() == 2 * n);
    const float* ch[2] = {input.data(), input.data() + n};
    double maxDiff = 0;
    std::size_t differing = 0, samples = 0;
    for (const Json& c : rd["cases"].a)
    {
        INFO("render " << c["name"].str());
        std::vector<std::vector<float>> out;
        renderSegments(ch, 2, n, rd["sampleRate"].num(), toSegments(c["segments"]), c["crossfadeSec"].num(),
                       c["fadeOutSec"].num(), c["curve"].str(), out);
        const std::size_t len = static_cast<std::size_t>(c["length"].i());
        const std::size_t off = static_cast<std::size_t>(c["offset"].num());
        REQUIRE(out.size() == 2);
        REQUIRE(out[0].size() == len);
        REQUIRE(off + 2 * len <= renders.size());
        double caseMax = 0;
        for (std::size_t k = 0; k < 2; ++k)
            for (std::size_t i = 0; i < len; ++i)
            {
                const double d = std::fabs(static_cast<double>(out[k][i]) - renders[off + k * len + i]);
                caseMax = std::max(caseMax, d);
                differing += d != 0;
                ++samples;
            }
        CHECK(caseMax < 1e-5);
        maxDiff = std::max(maxDiff, caseMax);
    }
    MESSAGE(rd["cases"].size() << " renders, " << samples << " muestras: " << differing
                               << " distintas, diferencia máxima " << maxDiff);
}
}
