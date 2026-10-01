// Tests de djec/grid.h (cuadrícula de FL → AnalysisResult) con un host simulado: bloques de cualquier tamaño,
// automatización de tempo, compases x/8, toma que empieza a mitad de compás, anacrusa («Mover el 1») y el plan
// 4/4 → 7/8 que quita exactamente una corchea de cada compás completo.
#include <doctest.h>

#include "djec/bars.h"
#include "djec/edit_plan.h"
#include "djec/grid.h"
#include "djec/meter.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <vector>

using namespace djec;

namespace
{
struct Sim
{
    double sr = 44100;
    std::int64_t hostStart = 0;   // muestra del host al empezar la toma
    double ppqStart = 0;          // ppq al empezar la toma
    std::size_t numSamples = 0;
    std::function<std::size_t(std::size_t)> blockSize = [](std::size_t) { return std::size_t(512); };
    std::function<double(double)> bpmAt = [](double) { return 120.0; };   // tempo en función del ppq del bloque
    int tsNum = 4, tsDen = 4;
    double tsChangePpq = -1;      // cambio de compás (en una barra) → tsNum2/tsDen2
    int tsNum2 = 3, tsDen2 = 4;
    bool ppqValid = true, barValid = true;
    bool sparse = false;          // solo anclas cuando cambia algo
};

struct Expected
{
    std::vector<double> times;
    std::vector<int> positions;
};

double barStartAt(const Sim& s, double ppq)
{
    const double bl1 = s.tsNum * 4.0 / s.tsDen;
    if (s.tsChangePpq < 0 || ppq < s.tsChangePpq)
        return std::floor(ppq / bl1 + 1e-9) * bl1;
    const double bl2 = s.tsNum2 * 4.0 / s.tsDen2;
    return s.tsChangePpq + std::floor((ppq - s.tsChangePpq) / bl2 + 1e-9) * bl2;
}

// Simula el host bloque a bloque y calcula, por separado, dónde caen los beats (tempo constante dentro del bloque).
CaptureInfo simulate(const Sim& s, Expected* exp = nullptr)
{
    CaptureInfo ci;
    ci.sampleRate = s.sr;
    ci.hostStartSample = s.hostStart;
    ci.numSamples = s.numSamples;
    double ppq = s.ppqStart;
    std::size_t off = 0;
    double lastBpm = -1;
    int lastNum = -1;
    for (std::size_t b = 0; off < s.numSamples; ++b)
    {
        const std::size_t len = std::min(s.blockSize(b), s.numSamples - off);
        const double bpm = s.bpmAt(ppq);
        const bool second = s.tsChangePpq >= 0 && ppq >= s.tsChangePpq - 1e-12;
        const int num = second ? s.tsNum2 : s.tsNum;
        const int den = second ? s.tsDen2 : s.tsDen;
        HostBlockInfo h;
        h.hostSample = s.hostStart + static_cast<std::int64_t>(off);
        h.ppq = ppq;
        h.bpm = bpm;
        h.tsNum = num;
        h.tsDen = den;
        h.lastBarStartPpq = barStartAt(s, ppq);
        h.ppqValid = s.ppqValid;
        h.barValid = s.barValid;
        if (!s.sparse || bpm != lastBpm || num != lastNum)
            ci.blocks.push_back({static_cast<std::int64_t>(off), h});
        lastBpm = bpm;
        lastNum = num;
        const double adv = static_cast<double>(len) * bpm / (60 * s.sr);
        if (exp)
        {
            // beats con ppq en [ppq, ppq + adv)
            const double beatLen = 4.0 / den;
            const double bs = h.lastBarStartPpq;
            for (long long k = static_cast<long long>(std::ceil((ppq - bs) / beatLen - 1e-9));; ++k)
            {
                const double p = bs + k * beatLen;
                if (p >= ppq + adv - 1e-12)
                    break;
                exp->times.push_back((static_cast<double>(off) + (p - ppq) * 60 * s.sr / bpm) / s.sr);
                exp->positions.push_back(static_cast<int>(((k % num) + num) % num));
            }
        }
        ppq += adv;
        off += len;
    }
    return ci;
}

void checkBeats(const AnalysisResult& g, const Expected& e, double tol = 1e-9)
{
    REQUIRE(g.beats.size() >= e.times.size());
    for (std::size_t i = 0; i < e.times.size(); ++i)
    {
        INFO("beat " << i);
        CHECK(std::fabs(g.beats[i] - e.times[i]) <= tol);
        CHECK(g.positions[i] == e.positions[i]);
    }
}

// Todos los compases completos (con "1" siguiente dentro de la toma) se transforman y cada uno pierde media
// unidad del último tiempo (4/4 → 7/8: una corchea).
void checkEighthPerBar(const AnalysisResult& g, int sourceDen = 4)
{
    const EditPlan p = buildEditPlan(g, sourceDen, EditSettings{});
    REQUIRE(p.blocker.empty());
    const auto bars = getBars(g);
    int complete = 0;
    for (std::size_t j = 0; j + 1 < bars.size(); ++j)
        ++complete;
    CHECK(p.meter.barsChanged == complete);
    REQUIRE(p.meter.removed.size() == static_cast<std::size_t>(complete));
    double removed = 0;
    for (int j = 0; j < complete; ++j)
    {
        const int b1 = bars[static_cast<std::size_t>(j + 1)].beatIndex;
        const double lastBeat = g.beats[static_cast<std::size_t>(b1)] - g.beats[static_cast<std::size_t>(b1 - 1)];
        const Segment& rm = p.meter.removed[static_cast<std::size_t>(j)];
        CHECK(rm.end - rm.start == doctest::Approx(lastBeat / 2).epsilon(1e-9));
        CHECK(rm.end == doctest::Approx(g.beats[static_cast<std::size_t>(b1)] - p.preroll).epsilon(1e-12));
        removed += rm.end - rm.start;
    }
    CHECK(p.outputDuration == doctest::Approx(g.duration - removed).epsilon(1e-12));
}
} // namespace

TEST_SUITE("grid")
{
TEST_CASE("120 BPM 4/4 desde el compás 5: beats exactos con bloques de 1, 64, 512 e impares")
{
    Sim s;
    s.ppqStart = 16;                       // compás 5
    s.hostStart = 8 * 44100;
    s.numSamples = static_cast<std::size_t>(8.3 * 2 * 44100);   // 8 compases y algo
    AnalysisResult ref;
    const std::function<std::size_t(std::size_t)> sizes[] = {
        [](std::size_t) { return std::size_t(1); },
        [](std::size_t) { return std::size_t(64); },
        [](std::size_t) { return std::size_t(512); },
        [](std::size_t b) { return std::size_t(1 + (b * 7919 + 13) % 1023) | 1; },   // impares variados
    };
    for (int k = 0; k < 4; ++k)
    {
        s.blockSize = sizes[k];
        HostGridMeta meta;
        const AnalysisResult g = gridFromHost(simulate(s), 0, &meta);
        INFO("tamaños de bloque #" << k);
        CHECK(meta.valid);
        CHECK(meta.tsNum == 4);
        CHECK(meta.tsDen == 4);
        CHECK(meta.hostBpm == 120);
        CHECK_FALSE(meta.tempoChanges);
        CHECK_FALSE(meta.meterChanges);
        CHECK(meta.ppqStart == doctest::Approx(16));
        CHECK(g.duration == doctest::Approx(16.6));
        CHECK(g.lastOnset == g.duration);
        CHECK(g.musicEnd == g.duration);
        CHECK(g.beatsPerBar == 4);
        CHECK(g.bpm == 120);
        CHECK_FALSE(g.meterAuto);
        REQUIRE(g.beats.size() == 34);     // 0, 0.5, … 16.5
        for (std::size_t i = 0; i < g.beats.size(); ++i)
        {
            CHECK(std::fabs(g.beats[i] - 0.5 * static_cast<double>(i)) < 1e-9);
            CHECK(g.positions[i] == static_cast<int>(i % 4));
        }
        CHECK(g.downbeats.size() == 9);
        CHECK(g.beatStrength.size() == g.beats.size());
        if (k == 0)
            ref = g;
        else
            for (std::size_t i = 0; i < g.beats.size(); ++i)
                CHECK(std::fabs(g.beats[i] - ref.beats[i]) < 1e-9);
        checkEighthPerBar(g);
        CHECK(buildEditPlan(g, 4, EditSettings{}).meter.barsChanged == 8);
    }
}

TEST_CASE("toma que termina justo en la barra (bucle de 8 compases): se transforman los 8")
{
    Sim s;
    s.numSamples = 16 * 44100;   // exactamente 8 compases
    for (std::size_t bs : {std::size_t(1), std::size_t(441), std::size_t(512)})
    {
        s.blockSize = [bs](std::size_t) { return bs; };
        const AnalysisResult g = gridFromHost(simulate(s));
        INFO("bloque " << bs);
        REQUIRE(g.beats.size() == 33);
        CHECK(g.beats.back() == g.duration);   // el "1" del compás 9 en el último instante
        CHECK(g.positions.back() == 0);
        checkEighthPerBar(g);
        CHECK(buildEditPlan(g, 4, EditSettings{}).meter.barsChanged == 8);
    }
    // termina 3 ms antes de la barra: el compás 8 sigue contando como completo (el "1" se pega al final)
    s.numSamples = 16 * 44100 - 132;
    s.blockSize = [](std::size_t) { return std::size_t(512); };
    AnalysisResult g = gridFromHost(simulate(s));
    CHECK(g.beats.back() == g.duration);
    CHECK(buildEditPlan(g, 4, EditSettings{}).meter.barsChanged == 8);
    // 12 ms antes: el compás 8 está incompleto
    s.numSamples = 16 * 44100 - 529;
    g = gridFromHost(simulate(s));
    CHECK(g.beats.back() < g.duration);
    CHECK(buildEditPlan(g, 4, EditSettings{}).meter.barsChanged == 7);
}

TEST_CASE("empieza a mitad de compás: la anacrusa no se toca")
{
    Sim s;
    s.ppqStart = 17.5;   // corchea del tiempo 2 del compás 5
    s.numSamples = 10 * 44100;
    s.blockSize = [](std::size_t b) { return std::size_t(b % 3 ? 300 : 211); };
    Expected e;
    const AnalysisResult g = gridFromHost(simulate(s, &e));
    checkBeats(g, e);
    REQUIRE(g.beats.size() >= 3);
    CHECK(g.beats[0] == doctest::Approx(0.25));
    CHECK(g.positions[0] == 2);
    REQUIRE(!g.downbeats.empty());
    CHECK(g.downbeats[0] == 2);
    CHECK(g.beats[2] == doctest::Approx(1.25));
    const EditPlan p = buildEditPlan(g, 4, EditSettings{});
    REQUIRE(!p.meter.removed.empty());
    CHECK(p.meter.removed[0].start > 1.25);   // nada se quita antes del primer "1"
    checkEighthPerBar(g);
}

TEST_CASE("FL en 7/8: beats de corchea, «½ tiempo» quita una semicorchea por compás")
{
    Sim s;
    s.tsNum = 7;
    s.tsDen = 8;
    s.ppqStart = 0;
    s.numSamples = static_cast<std::size_t>(12.4 * 48000);
    s.sr = 48000;
    s.blockSize = [](std::size_t) { return std::size_t(480); };
    HostGridMeta meta;
    Expected e;
    const AnalysisResult g = gridFromHost(simulate(s, &e), 0, &meta);
    checkBeats(g, e);
    CHECK(meta.tsNum == 7);
    CHECK(meta.tsDen == 8);
    CHECK(g.beatsPerBar == 7);
    CHECK(g.bpm == 240);   // corcheas por minuto
    CHECK(g.beats[1] - g.beats[0] == doctest::Approx(0.25));
    const auto bars = getBars(g);
    CHECK(bars[1].start - bars[0].start == doctest::Approx(1.75));
    const EditPlan p = buildEditPlan(g, meta.tsDen, EditSettings{});
    CHECK(p.target.num == 13);
    CHECK(p.target.den == 16);
    CHECK(p.meter.barsChanged == static_cast<int>(bars.size()) - 1);
    for (const Segment& rm : p.meter.removed)
        CHECK(rm.end - rm.start == doctest::Approx(0.125).epsilon(1e-9));
    checkEighthPerBar(g, 8);
    EditSettings beat;
    beat.amount = "beat";
    CHECK(buildEditPlan(g, 8, beat).meter.removed[0].end - buildEditPlan(g, 8, beat).meter.removed[0].start ==
          doctest::Approx(0.25));
}

TEST_CASE("automatización de tempo (100 → 140 BPM): por tramos, con anclas densas o solo en los cambios")
{
    Sim s;
    s.numSamples = 12 * 44100;
    s.bpmAt = [](double ppq) { return std::min(140.0, 100.0 + std::floor(ppq * 4) * 0.25); };   // sube en escalones
    for (int mode = 0; mode < 3; ++mode)
    {
        s.blockSize = mode == 0 ? std::function<std::size_t(std::size_t)>([](std::size_t) { return std::size_t(1); })
                                : [](std::size_t) { return std::size_t(512); };
        s.sparse = mode == 2;
        Expected e;
        HostGridMeta meta;
        const CaptureInfo ci = simulate(s, &e);
        const AnalysisResult g = gridFromHost(ci, 0, &meta);
        INFO("modo " << mode << ", anclas " << ci.blocks.size());
        CHECK(meta.tempoChanges);
        REQUIRE(g.beats.size() >= e.times.size());
        checkBeats(g, e, 1e-9);
        CHECK(g.bpmLo < g.bpmHi);
        checkEighthPerBar(g);
        // el beat se acorta: lo quitado del último compás es menor que lo del primero
        const EditPlan p = buildEditPlan(g, 4, EditSettings{});
        CHECK(p.meter.removed.back().end - p.meter.removed.back().start <
              p.meter.removed.front().end - p.meter.removed.front().start - 0.03);
    }
}

TEST_CASE("«Mover el 1»: barOffsetBeats corre los compases")
{
    Sim s;
    s.numSamples = 10 * 44100;
    const CaptureInfo ci = simulate(s);
    const AnalysisResult g1 = gridFromHost(ci, 1);
    CHECK(g1.positions[0] == 3);
    CHECK(g1.positions[1] == 0);
    CHECK(g1.downbeats[0] == 1);
    const AnalysisResult gm = gridFromHost(ci, -1);
    CHECK(gm.positions[0] == 1);
    CHECK(gm.downbeats[0] == 3);
    const AnalysisResult g5 = gridFromHost(ci, 5);   // 5 ≡ 1 (mod 4)
    CHECK(g5.positions == g1.positions);
    checkEighthPerBar(g1);
}

TEST_CASE("cambio de compás 4/4 → 3/4 en el compás 3 y anclas raras")
{
    Sim s;
    s.numSamples = 14 * 44100;
    s.tsChangePpq = 8;
    s.blockSize = [](std::size_t) { return std::size_t(256); };
    Expected e;
    HostGridMeta meta;
    CaptureInfo ci = simulate(s, &e);
    const AnalysisResult g = gridFromHost(ci, 0, &meta);
    checkBeats(g, e);
    CHECK(meta.meterChanges);
    CHECK(g.beatsPerBar == 3);   // el que cubre más beats
    const auto bars = getBars(g);
    CHECK(bars[0].beatCount == 4);
    CHECK(bars[1].beatCount == 4);
    CHECK(bars[2].beatCount == 3);

    // anclas desordenadas y repetidas: mismo resultado
    CaptureInfo shuffled = ci;
    std::reverse(shuffled.blocks.begin(), shuffled.blocks.end());
    shuffled.blocks.push_back(shuffled.blocks.back());
    const AnalysisResult g2 = gridFromHost(shuffled);
    REQUIRE(g2.beats.size() == g.beats.size());
    for (std::size_t i = 0; i < g.beats.size(); ++i)
        CHECK(g2.beats[i] == g.beats[i]);
}

TEST_CASE("sin ppq ni inicio de compás del host, o sin nada")
{
    Sim s;
    s.hostStart = 2 * 44100;   // 2 s → ppq 4 (compás 2) a 120 BPM
    s.numSamples = 6 * 44100;
    s.ppqStart = 4;
    s.ppqValid = false;
    s.barValid = false;
    const AnalysisResult g = gridFromHost(simulate(s));
    REQUIRE(g.beats.size() == 13);
    CHECK(g.positions[0] == 0);
    CHECK(g.beats[1] == doctest::Approx(0.5));

    CaptureInfo none;
    none.sampleRate = 44100;
    none.numSamples = 44100;
    const AnalysisResult empty = gridFromHost(none);
    CHECK(empty.beats.empty());
    CHECK(empty.duration == 1);
    CHECK(buildEditPlan(empty, 4, EditSettings{}).meter.error == kMeterMsgNoBeats);
    CHECK(gridFromHost(CaptureInfo{}).beats.empty());
}
}
