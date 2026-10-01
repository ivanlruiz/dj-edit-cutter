// Tests de djec/bars.h (port de tests/bars.test.js). La paridad completa con la web está en edit_plan_test.cpp.
#include <doctest.h>

#include "djec/bars.h"

#include <cmath>
#include <limits>

using namespace djec;

namespace
{
const double kNaN = std::numeric_limits<double>::quiet_NaN();

// Rejilla regular: `pickup` beats de anacrusa y `nBars` compases de `bpb` beats, IBI fijo.
AnalysisResult grid(int nBars = 10, int bpb = 4, double ibi = 0.5, double t0 = 1, int pickup = 0,
                    double lastOnset = kNaN, double musicEnd = kNaN)
{
    AnalysisResult r;
    for (int i = 0; i < pickup + nBars * bpb; ++i)
    {
        r.beats.push_back(t0 + i * ibi);
        r.positions.push_back((((i - pickup) % bpb) + bpb) % bpb);
    }
    for (std::size_t i = 0; i < r.positions.size(); ++i)
        if (r.positions[i] == 0)
            r.downbeats.push_back(static_cast<int>(i));
    const double lastDb = r.beats[static_cast<std::size_t>(r.downbeats.back())];
    r.beatsPerBar = bpb;
    r.bpm = 60 / ibi;
    r.lastOnset = std::isnan(lastOnset) ? lastDb + 0.01 : lastOnset;
    r.musicEnd = std::isnan(musicEnd) ? r.beats.back() + 3 : musicEnd;
    r.duration = r.musicEnd + 1;
    return r;
}
} // namespace

TEST_SUITE("bars")
{
TEST_CASE("constantes")
{
    CHECK(kLastBarTolerance == 0.08);
}

TEST_CASE("getBars: rejilla regular 4/4 y final del último compás")
{
    const AnalysisResult r = grid();
    const auto bars = getBars(r);
    REQUIRE(bars.size() == 10);
    for (int k = 0; k < 10; ++k)
    {
        CHECK(bars[k].index == k);
        CHECK(bars[k].number == k + 1);
        CHECK(bars[k].beatIndex == 4 * k);
        CHECK(bars[k].beatCount == 4);
        CHECK(bars[k].start == doctest::Approx(1 + 2 * k));
    }
    CHECK(bars[3].end == bars[4].start);
    CHECK(bars[9].end == doctest::Approx(r.beats[39] + 0.5));
    // con tope en musicEnd, pero nunca antes del último beat
    CHECK(getBars(grid(10, 4, 0.5, 1, 0, kNaN, 1 + 39 * 0.5 + 0.2))[9].end == doctest::Approx(1 + 39 * 0.5 + 0.2));
    const AnalysisResult r2 = grid(10, 4, 0.5, 1, 0, kNaN, 1 + 39 * 0.5 - 1);
    CHECK(getBars(r2)[9].end == doctest::Approx(r2.beats[39]));
    AnalysisResult r3 = grid();
    r3.musicEnd = kNaN;   // undefined en la web
    CHECK(getBars(r3)[9].end == doctest::Approx(r3.beats[39] + 0.5));
}

TEST_CASE("getBars: anacrusa, compases irregulares, downbeats raros y vacíos")
{
    const AnalysisResult p = grid(5, 4, 0.5, 1, 2);
    const auto bars = getBars(p);
    REQUIRE(bars.size() == 5);
    CHECK(bars[0].beatIndex == 2);

    AnalysisResult irr;
    irr.positions = {0, 1, 2, 3, 0, 1, 2, 0, 1, 2, 3, 4, 0, 1, 2, 3};
    for (std::size_t i = 0; i < irr.positions.size(); ++i)
        irr.beats.push_back(10 + i * 0.4);
    irr.lastOnset = irr.beats[12];
    irr.musicEnd = 20;
    const auto ib = getBars(irr);
    REQUIRE(ib.size() == 4);
    CHECK(ib[0].beatCount == 4);
    CHECK(ib[1].beatCount == 3);
    CHECK(ib[2].beatCount == 5);
    CHECK(ib[3].beatCount == 4);
    CHECK(ib[2].beatIndex == 7);

    AnalysisResult odd;
    odd.beats = {0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5};
    odd.downbeats = {4, 0, 4, 99, -1};
    odd.musicEnd = 10;
    const auto ob = getBars(odd);
    REQUIRE(ob.size() == 2);
    CHECK(ob[0].beatIndex == 0);
    CHECK(ob[1].beatIndex == 4);
    CHECK(ob[1].end == doctest::Approx(4));

    CHECK(getBars(AnalysisResult{}).empty());
    AnalysisResult one;
    one.beats = {2};
    one.downbeats = {0};
    one.bpm = 120;
    one.musicEnd = 5;
    REQUIRE(getBars(one).size() == 1);
    CHECK(getBars(one)[0].end == doctest::Approx(2.5));
}

TEST_CASE("findLastBarIndex y cutForBarsRemoved")
{
    AnalysisResult r = grid();
    CHECK(findLastBarIndex(r) == 9);
    r.lastOnset = 1 + 7 * 2 + 1.3;
    CHECK(findLastBarIndex(r) == 7);
    r.lastOnset = 1 + 9 * 2 - 0.05;
    CHECK(findLastBarIndex(r) == 9);
    r.lastOnset = 1 + 9 * 2 - 0.1;
    CHECK(findLastBarIndex(r) == 8);
    r.lastOnset = kNaN;
    CHECK(findLastBarIndex(r) == 9);
    r.lastOnset = 0.2;
    CHECK(findLastBarIndex(r) == -1);

    const AnalysisResult g = grid();
    auto c1 = cutForBarsRemoved(g, 1);
    REQUIRE(c1);
    CHECK(c1->barIndex == 9);
    CHECK(c1->beatIndex == 36);
    CHECK(c1->time == g.beats[36]);
    CHECK(c1->barsRemoved == 1);
    auto c4 = cutForBarsRemoved(g, 4);
    REQUIRE(c4);
    CHECK(c4->barIndex == 6);
    CHECK(c4->barsRemoved == 4);
    const AnalysisResult small = grid(5, 4, 0.5, 1, 3);
    auto c32 = cutForBarsRemoved(small, 32);
    REQUIRE(c32);
    CHECK(c32->barIndex == 1);
    CHECK(c32->beatIndex == 7);
    CHECK(c32->barsRemoved == 4);
    CHECK_FALSE(cutForBarsRemoved(g, 0));
    CHECK_FALSE(cutForBarsRemoved(g, -2));
    CHECK_FALSE(cutForBarsRemoved(grid(1), 1));
    CHECK_FALSE(cutForBarsRemoved(AnalysisResult{}, 1));
}

TEST_CASE("barsRemovedAt")
{
    const AnalysisResult r = grid();
    for (int n : {1, 2, 4, 8})
        CHECK(barsRemovedAt(r, cutForBarsRemoved(r, n)->time) == n);
    const double lastStart = 1 + 9 * 2;
    CHECK(barsRemovedAt(r, lastStart + 0.5) == doctest::Approx(0.8));
    CHECK(barsRemovedAt(r, lastStart + 1.0) == doctest::Approx(0.5));
    CHECK(barsRemovedAt(r, lastStart + 0.75) == doctest::Approx(0.6));
    CHECK(barsRemovedAt(r, lastStart - 1.0) == doctest::Approx(1.5));
    CHECK(barsRemovedAt(r, lastStart + 2.0) == 0);
    CHECK(barsRemovedAt(r, 100) == 0);
    CHECK(barsRemovedAt(r, 0) == 10);
    CHECK(barsRemovedAt(r, lastStart - 0.008) == 1);
    CHECK(barsRemovedAt(r, kNaN) == 0);
}

TEST_CASE("nearestBeatIndex, stepBeat, stepBar")
{
    const AnalysisResult r = grid(2);   // beats 1.0 .. 4.5
    CHECK(nearestBeatIndex(r, -5) == 0);
    CHECK(nearestBeatIndex(r, 1.26) == 1);
    CHECK(nearestBeatIndex(r, 1.25) == 0);   // empate: el anterior
    CHECK(nearestBeatIndex(r, 99) == 7);
    CHECK(nearestBeatIndex(AnalysisResult{}, 1) == -1);

    CHECK(stepBeat(r, 2, 1) == doctest::Approx(2.5));
    CHECK(stepBeat(r, 2, -2) == doctest::Approx(1));
    CHECK(stepBeat(r, 2.0004, 1) == doctest::Approx(2.5));
    CHECK(stepBeat(r, 2.4, 1) == doctest::Approx(2.5));
    CHECK(stepBeat(r, 2.1, -1) == doctest::Approx(2));
    CHECK(stepBeat(r, 2.4, -1) == doctest::Approx(2));
    CHECK(stepBeat(r, 4.5, 3) == doctest::Approx(4.5));
    CHECK(stepBeat(r, 0.2, 1) == doctest::Approx(1));
    CHECK(stepBeat(r, 9, -1) == doctest::Approx(4.5));
    CHECK(stepBeat(AnalysisResult{}, 3.3, 1) == 3.3);

    const AnalysisResult p = grid(3, 4, 0.5, 1, 1);   // compases en 1.5, 3.5, 5.5
    CHECK(stepBar(p, 3.5, 1) == doctest::Approx(5.5));
    CHECK(stepBar(p, 3.5, -1) == doctest::Approx(1.5));
    CHECK(stepBar(p, 4.0, -1) == doctest::Approx(3.5));
    CHECK(stepBar(p, 4.0, 1) == doctest::Approx(5.5));
    CHECK(stepBar(p, 1.0, 1) == doctest::Approx(1.5));
    AnalysisResult nb;
    nb.beats = {0, 0.5, 1, 1.5, 2, 2.5, 3};
    nb.beatsPerBar = 3;
    CHECK(stepBar(nb, 0.5, 1) == doctest::Approx(2));
}
}
