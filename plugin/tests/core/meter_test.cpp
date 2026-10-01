// Tests de djec/meter.h (port de tests/meter.test.js). La paridad completa con la web está en edit_plan_test.cpp.
#include <doctest.h>

#include "djec/fade.h"
#include "djec/meter.h"

#include <cmath>
#include <functional>
#include <limits>
#include <utility>
#include <vector>

using namespace djec;

namespace
{
const double P = kCutPrerollSec;
const char* const TOO_SHORT = "Ese compás es demasiado corto para esta canción.";
const char* const TOO_LONG = "Ese compás es demasiado largo: como máximo se puede duplicar el compás.";
const char* const SAME = "La canción ya está en ese compás.";

// AnalysisResult sintético. barBeats: beats de cada compás (el último es el compás final, sin "1" siguiente).
AnalysisResult makeResult(int pickup = 2, std::vector<int> barBeats = {}, int beatsPerBar = 4,
                          std::function<double(int)> beatTime = {}, double tail = 2)
{
    if (barBeats.empty())
        barBeats = std::vector<int>(17, 4);
    if (!beatTime)
        beatTime = [](int i) { return 0.3 + i * 0.5; };
    AnalysisResult r;
    for (int i = 0; i < pickup; ++i)
        r.positions.push_back(beatsPerBar - pickup + i);
    for (int n : barBeats)
    {
        r.downbeats.push_back(static_cast<int>(r.positions.size()));
        for (int i = 0; i < n; ++i)
            r.positions.push_back(i);
    }
    for (std::size_t i = 0; i < r.positions.size(); ++i)
        r.beats.push_back(beatTime(static_cast<int>(i)));
    const double last = r.beats.back();
    r.duration = last + tail;
    r.musicStart = r.beats[0];
    r.musicEnd = last + tail * 0.8;
    r.bpm = 120;
    r.beatsPerBar = beatsPerBar;
    r.lastOnset = std::numeric_limits<double>::quiet_NaN();
    return r;
}

void checkInvariants(const MeterPlan& plan, double end, bool exactEnd = true)
{
    double sum = 0;
    for (const Segment& s : plan.segments)
    {
        CHECK(s.start >= 0);
        CHECK(s.end <= end + 1e-9);
        CHECK(s.end > s.start);
        sum += s.end - s.start;
    }
    CHECK(plan.outputDuration == doctest::Approx(sum).epsilon(1e-12));
    if (!plan.segments.empty())
    {
        CHECK(plan.segments.front().start == 0);
        if (exactEnd)
            CHECK(plan.segments.back().end == doctest::Approx(end).epsilon(1e-12));
    }
}
} // namespace

TEST_SUITE("meter")
{
TEST_CASE("describeMeterChange: textos concretos")
{
    struct C
    {
        int bpb, num, den, delta;
        const char* text;
    };
    const C cases[] = {
        {4, 7, 8, -1, "Se quita la última corchea de cada compás."},
        {4, 5, 8, -3, "Se quitan las últimas 3 corcheas de cada compás."},
        {4, 3, 4, -1, "Se quita el último tiempo de cada compás."},
        {4, 2, 4, -2, "Se quitan los últimos 2 tiempos de cada compás."},
        {4, 5, 4, 1, "Se repite el último tiempo de cada compás."},
        {4, 6, 4, 2, "Se repiten los últimos 2 tiempos de cada compás."},
        {4, 3, 2, 2, "Se repiten los últimos 2 tiempos de cada compás."},
        {4, 15, 16, -1, "Se quita la última semicorchea de cada compás."},
        {4, 17, 16, 1, "Se repite la última semicorchea de cada compás."},
        {3, 7, 8, 1, "Se repite la última corchea de cada compás."},
        {4, 8, 4, 4, "Se repite cada compás completo."},
        {4, 1, 4, -3, "Se quitan los últimos 3 tiempos de cada compás."},
    };
    for (const C& c : cases)
    {
        const MeterDescription d = describeMeterChange(c.bpb, c.num, c.den);
        CHECK(d.delta == c.delta);
        CHECK(d.text == c.text);
        CHECK(d.error.empty());
    }
    const MeterDescription d78 = describeMeterChange(4, 7, 8);
    CHECK(d78.unitsPerBeat == 2);
    CHECK(d78.sourceUnits == 8);
    CHECK(d78.targetUnits == 7);
    CHECK(d78.unitName == "corchea");
    CHECK(describeMeterChange(2, 3, 4, 2).text == "Se quita la última negra de cada compás.");
    CHECK(describeMeterChange(2, 3, 2, 2).unitName == "blanca");
    // fuente en corcheas (FL en 7/8)
    CHECK(describeMeterChange(7, 13, 16, 8).text == "Se quita la última semicorchea de cada compás.");
    CHECK(describeMeterChange(7, 6, 8, 8).text == "Se quita el último tiempo de cada compás.");
}

TEST_CASE("describeMeterChange: Δ = 0, errores")
{
    const std::pair<int, int> sameCases[] = {{4, 4}, {8, 8}, {2, 2}, {16, 16}};
    for (const auto& nd : sameCases)
    {
        const MeterDescription d = describeMeterChange(4, nd.first, nd.second);
        CHECK(d.delta == 0);
        CHECK(d.error.empty());
        CHECK(d.text == SAME);
    }
    CHECK(describeMeterChange(4, 9, 4).error == TOO_LONG);
    CHECK(describeMeterChange(4, 16, 8).error.empty());
    CHECK(describeMeterChange(4, 0, 8).error == TOO_SHORT);
    CHECK(describeMeterChange(4, -2, 4).error == TOO_SHORT);
    CHECK(describeMeterChange(4, std::numeric_limits<int>::min(), 4).error == TOO_SHORT);
    CHECK(describeMeterChange(4, 33, 16).error == "El numerador del compás debe ser un número entero entre 1 y 32.");
    CHECK(describeMeterChange(4, 7, 3).error == "El denominador del compás debe ser 2, 4, 8 o 16.");
    CHECK(describeMeterChange(0, 7, 8).error == "No se conoce el compás original de la canción.");
    CHECK(describeMeterChange(4, 7, 8, 3).error == "No se conoce el compás original de la canción.");
}

TEST_CASE("plan 4/4 → 7/8, 3/4, 15/16 y 5/4 a 120 BPM")
{
    const AnalysisResult r = makeResult();
    const MeterPlan plan = planMeterChange(r, 7, 8, 4, -1, P);
    CHECK(plan.error.empty());
    CHECK(plan.delta == -1);
    CHECK(plan.unitsPerBeat == 2);
    CHECK(plan.barsChanged == 16);
    CHECK(plan.removed.size() == 16);
    CHECK(plan.segments.size() == 17);
    checkInvariants(plan, r.duration);
    CHECK(plan.outputDuration == doctest::Approx(r.duration - 16 * 0.25).epsilon(1e-12));
    for (int j = 0; j < 16; ++j)
    {
        const double next = r.beats[static_cast<std::size_t>(r.downbeats[static_cast<std::size_t>(j + 1)])];
        CHECK(plan.removed[static_cast<std::size_t>(j)].end - plan.removed[static_cast<std::size_t>(j)].start ==
              doctest::Approx(0.25).epsilon(1e-9));
        CHECK(plan.removed[static_cast<std::size_t>(j)].end == doctest::Approx(next - P).epsilon(1e-12));
    }
    std::vector<double> outDown;
    for (int j = 0; j < 17; ++j)
        outDown.push_back(*sourceToOutputTime(plan.segments,
                                              r.beats[static_cast<std::size_t>(r.downbeats[static_cast<std::size_t>(j)])]));
    for (std::size_t j = 1; j < outDown.size(); ++j)
        CHECK(outDown[j] - outDown[j - 1] == doctest::Approx(1.75).epsilon(1e-9));

    const MeterPlan p34 = planMeterChange(r, 3, 4, 4, -1, P);
    CHECK(p34.barsChanged == 16);
    CHECK(p34.outputDuration == doctest::Approx(r.duration - 8));
    const MeterPlan p1516 = planMeterChange(r, 15, 16, 4, -1, P);
    CHECK(p1516.unitsPerBeat == 4);
    for (const Segment& s : p1516.removed)
        CHECK(s.end - s.start == doctest::Approx(0.125).epsilon(1e-9));

    const MeterPlan p54 = planMeterChange(r, 5, 4, 4, -1, P);
    CHECK(p54.delta == 1);
    CHECK(p54.repeated.size() == 16);
    CHECK(p54.removed.empty());
    checkInvariants(p54, r.duration);
    CHECK(p54.outputDuration == doctest::Approx(r.duration + 8));
}

TEST_CASE("plan con deriva y con compases irregulares")
{
    const AnalysisResult r = makeResult(2, std::vector<int>(13, 4), 4, [](int i) { return 0.2 + 0.45 * i + 0.0045 * i * i; });
    const MeterPlan p78 = planMeterChange(r, 7, 8, 4, -1, P);
    CHECK(p78.barsChanged == 12);
    for (int j = 0; j < 12; ++j)
    {
        const int b1 = r.downbeats[static_cast<std::size_t>(j + 1)];
        const double ibi = r.beats[static_cast<std::size_t>(b1)] - r.beats[static_cast<std::size_t>(b1 - 1)];
        CHECK(p78.removed[static_cast<std::size_t>(j)].end - p78.removed[static_cast<std::size_t>(j)].start ==
              doctest::Approx(ibi / 2).epsilon(1e-9));
    }

    const AnalysisResult irr = makeResult(2, {4, 4, 5, 4, 3, 4, 4, 4});
    const MeterPlan pi = planMeterChange(irr, 7, 8, 4, -1, P);
    checkInvariants(pi, irr.duration);
    CHECK(pi.barsChanged == 7);
    REQUIRE(pi.removed.size() == 6);
    const double lens[] = {0.25, 0.25, 0.75, 0.25, 0.25, 0.25};
    for (int k = 0; k < 6; ++k)
        CHECK(pi.removed[static_cast<std::size_t>(k)].end - pi.removed[static_cast<std::size_t>(k)].start ==
              doctest::Approx(lens[k]).epsilon(1e-9));
    REQUIRE(pi.repeated.size() == 1);
    CHECK(pi.repeated[0].end - pi.repeated[0].start == doctest::Approx(0.25).epsilon(1e-9));
}

TEST_CASE("plan: limitTime, golpe final, snap, preroll, Δ = 0")
{
    const AnalysisResult r = makeResult();
    const double cut = r.beats[static_cast<std::size_t>(r.downbeats[8])];
    const MeterPlan lim = planMeterChange(r, 7, 8, 4, cut, P);
    CHECK(lim.barsChanged == 8);
    checkInvariants(lim, cut);
    const MeterPlan early = planMeterChange(r, 7, 8, 4, 1, P);
    CHECK(early.barsChanged == 0);
    CHECK(early.info == kMeterMsgNothing);
    REQUIRE(early.segments.size() == 1);
    CHECK(early.segments[0].end == 1);

    AnalysisResult hit = makeResult(2, [] {
        std::vector<int> v(19, 4);
        v.push_back(3);
        return v;
    }());
    CHECK(planMeterChange(hit, 7, 8, 4, -1, P).barsChanged == 19);
    hit.lastOnset = hit.beats[static_cast<std::size_t>(hit.downbeats[16])] + 0.01;
    CHECK(planMeterChange(hit, 7, 8, 4, -1, P).barsChanged == 16);

    int calls = 0;
    const MeterPlan snapped = planMeterChange(r, 7, 8, 4, -1, P, [&](double t) {
        ++calls;
        return t + 0.012;
    });
    CHECK(calls == 16);
    for (const Segment& s : snapped.removed)
        CHECK(s.end - s.start == doctest::Approx(0.25 - 0.012).epsilon(1e-9));
    const MeterPlan far = planMeterChange(r, 7, 8, 4, -1, P, [](double t) { return t + 0.03; });
    for (const Segment& s : far.removed)
        CHECK(s.end - s.start == doctest::Approx(0.25).epsilon(1e-9));

    const MeterPlan p0 = planMeterChange(r, 7, 8, 4, -1, 0);
    CHECK(p0.removed[0].end == doctest::Approx(r.beats[static_cast<std::size_t>(r.downbeats[1])]).epsilon(1e-12));

    const MeterPlan same = planMeterChange(r, 8, 8, 4, -1, P);
    CHECK(same.info == SAME);
    CHECK(same.barsChanged == 0);
    REQUIRE(same.segments.size() == 1);
    CHECK(same.segments[0].end == r.duration);
    CHECK(planMeterChange(r, 9, 4, 4, -1, P).error == TOO_LONG);
    CHECK(planMeterChange(AnalysisResult{}, 7, 8, 4, -1, P).error == kMeterMsgNoBeats);
}

TEST_CASE("sourceToOutputTime / outputToSourceTime")
{
    const AnalysisResult r = makeResult(2, {}, 4, [](int i) { return 0.2 + 0.47 * i + 0.002 * i * i; });
    const MeterPlan plan = planMeterChange(r, 7, 8, 4, -1, P);
    int nulls = 0;
    for (double t = 0; t < r.duration; t += 0.0137)
    {
        const auto o = sourceToOutputTime(plan.segments, t);
        bool inRemoved = false;
        for (const Segment& s : plan.removed)
            inRemoved = inRemoved || (t >= s.start && t < s.end);
        if (inRemoved)
        {
            CHECK_FALSE(o);
            ++nulls;
            continue;
        }
        REQUIRE(o);
        CHECK(outputToSourceTime(plan.segments, *o) == doctest::Approx(t).epsilon(1e-9));
    }
    CHECK(nulls > 0);
    CHECK(outputToSourceTime(plan.segments, -5) == 0);
    CHECK(outputToSourceTime(plan.segments, 1e9) == doctest::Approx(r.duration));
    CHECK_FALSE(sourceToOutputTime(plan.segments, std::numeric_limits<double>::quiet_NaN()));
    CHECK_FALSE(sourceToOutputTime({}, 1));
    CHECK(outputToSourceTime({}, 1) == 1);
}
}
