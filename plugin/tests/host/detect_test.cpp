// «Detectar del audio»: canción que no sigue la cuadrícula de FL (123 BPM empezando a los 0,37 s, con el proyecto a
// 120 BPM). El plan tiene que ser el del análisis portado de la web (el mismo que da el core en C++, que tiene
// paridad bit a bit con la web) con el imán a los ataques, y sonar alineado.
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::GridMode;
using djec::plugin::Phase;

namespace
{
/** Batería sintética: bombo en 1 y 3, caja en 2 y 4, charles en corcheas, bajo en cada "1". */
Audio makeDrums (double sr, double bpm, double startSec, int bars, unsigned seed = 5)
{
    const double beat = 60.0 / bpm;
    const double len = startSec + bars * 4 * beat + 1.0;
    const auto n = static_cast<std::size_t> (len * sr);
    Audio a (2, std::vector<float> (n, 0.0f));
    std::mt19937 rng (seed);
    std::uniform_real_distribution<double> u (-1.0, 1.0);
    auto add = [&] (double t0, double dur, const std::function<double (double)>& f, double panL, double panR) {
        const auto i0 = static_cast<std::int64_t> (std::llround (t0 * sr));
        const auto m = static_cast<std::int64_t> (dur * sr);
        for (std::int64_t k = 0; k < m; ++k)
        {
            const std::int64_t i = i0 + k;
            if (i < 0 || i >= static_cast<std::int64_t> (n))
                continue;
            const double v = f (static_cast<double> (k) / sr);
            a[0][static_cast<std::size_t> (i)] += static_cast<float> (panL * v);
            a[1][static_cast<std::size_t> (i)] += static_cast<float> (panR * v);
        }
    };
    double hp = 0, prev = 0;
    for (int b = 0; b < bars * 4; ++b)
    {
        const double t = startSec + b * beat;
        const int pos = b % 4;
        if (pos == 0 || pos == 2)
            add (t, 0.25, [&] (double x) {
                const double f = 50 + 70 * std::exp (-x / 0.03);
                return 0.9 * std::exp (-x / 0.09) * std::sin (2 * kPi * f * x);
            }, 1.0, 1.0);
        else
            add (t, 0.2, [&] (double x) {
                return 0.45 * std::exp (-x / 0.05) * (0.7 * u (rng) + 0.3 * std::sin (2 * kPi * 190 * x));
            }, 0.9, 1.0);
        if (pos == 0)
            add (t, 0.9 * 4 * beat, [&] (double x) {
                const int bar = b / 4;
                const double f = (bar % 2 == 0 ? 55.0 : 49.0);
                return 0.35 * std::exp (-x / 0.6) * std::sin (2 * kPi * f * x);
            }, 1.0, 0.9);
        for (int e = 0; e < 2; ++e)
            add (t + e * beat / 2, 0.06, [&] (double x) {
                const double w = u (rng);
                hp = w - prev;   // ruido "agudo"
                prev = w;
                return (e == 0 ? 0.18 : 0.12) * std::exp (-x / 0.015) * hp;
            }, 0.8, 1.0);
    }
    return a;
}
} // namespace

TEST_CASE ("detectar del audio: 123 BPM desplazado 0,37 s (no sigue la cuadrícula de FL)")
{
    Host host;
    const Audio song = makeDrums (48000, 123, 0.37, 20);
    const std::int64_t n = frames (song);
    host.play (song, 0, n, BlockSizes::random (1, 2048, 41));
    host.stopAndWait();
    REQUIRE (host.view().session->hasTake);
    CHECK (host.view().session->gridMode == GridMode::Host);
    CHECK (host.view().session->displayBpm == doctest::Approx (120));

    host.proc->setGridMode (GridMode::Detect);
    REQUIRE (host.proc->waitForWorker (120000));
    host.idle (2);
    auto v = host.view();
    CHECK (v.session->gridMode == GridMode::Detect);
    CHECK (v.session->gridSourceText == "Detectado del audio");
    REQUIRE (v.session->gridValid);
    CHECK (v.session->grid.bpm == doctest::Approx (123).epsilon (0.01));
    CHECK (v.session->grid.beatsPerBar == 4);
    CHECK (v.session->detect.analyzed);
    CHECK (v.session->confidenceLabel.isNotEmpty());
    // los beats caen en los golpes (0,37 + k·60/123)
    {
        int near = 0;
        const auto& beats = v.session->grid.beats;
        for (double b : beats)
        {
            const double k = std::round ((b - 0.37) * 123 / 60);
            if (std::fabs (b - (0.37 + k * 60.0 / 123)) < 0.015)
                ++near;
        }
        CHECK (near >= static_cast<int> (beats.size()) - 2);
        CHECK (beats.size() >= 78);
    }

    // lo esperado, calculado aparte con el core (análisis → plan con imán → render)
    std::vector<const float*> ptrs { song[0].data(), song[1].data() };
    std::vector<float> mono = djec::toAnalysisMono (ptrs.data(), 2, static_cast<std::size_t> (n), 48000);
    djec::Analyzer an;
    djec::AnalysisResult r = an.analyze (mono.data(), mono.size(), djec::kAnalysisSampleRate);
    r.duration = static_cast<double> (n) / 48000;
    CHECK (r.beats == v.session->grid.beats);
    CHECK (r.downbeats == v.session->grid.downbeats);
    const djec::EditPlan plan = djec::buildEditPlan (r, 4, djec::EditSettings {},
                                                     djec::makeTransientSnap (ptrs.data(), 2, static_cast<std::size_t> (n), 48000));
    REQUIRE (plan.blocker.empty());
    CHECK (plan.segments.size() == v.session->plan.segments.size());
    Audio expected;
    djec::renderSegments (ptrs.data(), 2, static_cast<std::size_t> (n), 48000, plan.segments, plan.crossfadeSec,
                          plan.fadeOutSec, plan.curve, expected);
    CHECK (frames (expected) == v.session->editedLength);

    const Audio out = host.play (song, 0, n, BlockSizes::random (1, 2048, 42));
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);
    CHECK (maxAbs (out, frames (expected), n - frames (expected)) == 0.0);
    host.idle();

    // Tempo ×2 → ≈ 246; Restablecer → ≈ 123
    host.proc->retrack (v.session->grid.bpm * 2, true);
    REQUIRE (host.proc->waitForWorker (120000));
    v = host.view();
    CHECK (v.session->grid.bpm == doctest::Approx (246).epsilon (0.02));
    CHECK (v.session->detect.tempoChanged);
    CHECK (v.session->detect.bpmHint == doctest::Approx (r.bpm * 2));
    host.proc->resetDetection();
    REQUIRE (host.proc->waitForWorker (120000));
    v = host.view();
    CHECK (v.session->grid.bpm == doctest::Approx (123).epsilon (0.01));
    CHECK_FALSE (v.session->detect.tempoChanged);

    // «Este beat es el 1»: el beat 1 pasa a ser "1"
    host.proc->relabel (0, { 1 });
    REQUIRE (host.proc->waitForWorker (120000));
    v = host.view();
    CHECK (v.session->grid.positions[1] == 0);
    CHECK (v.session->confidenceLabel == juce::String::fromUTF8 ("Cuadrícula ajustada a mano"));
    host.proc->beatIsOne (v.session->grid.beats[2] + 0.01);
    REQUIRE (host.proc->waitForWorker (120000));
    v = host.view();
    CHECK (v.session->grid.positions[2] == 0);
    host.proc->moveDownbeat (+1, v.session->grid.beats[2]);
    REQUIRE (host.proc->waitForWorker (120000));
    v = host.view();
    CHECK (v.session->grid.positions[3] == 0);
    CHECK (v.session->detect.forced == std::vector<int> { 3 });

    // el estado guarda el modo y las correcciones: otra instancia da la misma cuadrícula
    juce::MemoryBlock state;
    host.proc->getStateInformation (state);
    {
        Host b;
        b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        REQUIRE (b.proc->waitForWorker (120000));
        b.idle (2);
        const auto vb = b.view();
        CHECK (vb.session->gridMode == GridMode::Detect);
        CHECK (vb.session->grid.beats == v.session->grid.beats);
        CHECK (vb.session->grid.positions == v.session->grid.positions);
    }

    // volver a la cuadrícula de FL
    host.proc->setGridMode (GridMode::Host);
    REQUIRE (host.proc->waitForWorker (60000));
    v = host.view();
    CHECK (v.session->gridMode == GridMode::Host);
    CHECK (v.session->grid.bpm == doctest::Approx (120));
}
