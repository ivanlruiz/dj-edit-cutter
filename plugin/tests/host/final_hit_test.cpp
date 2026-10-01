// Cuadrícula de FL: «Quitar compases del final» cuenta desde el golpe final, como la web. El silencio o la resonancia
// que quedan al final de la toma no cuentan como compases (musicEnd / lastOnset de analyzeBounds en vez de la duración
// de la toma), y «Recortar cada compás» deja intactos el compás del golpe final y los de después (regla de la web).
// Una toma que corta la canción mientras sigue sonando cuenta todos sus compases completos.
#include "HostSim.h"

#include "djec/fade.h"

using namespace djec_test;

namespace
{
constexpr std::int64_t kBar = 96000;   // 2 s a 48 kHz (4/4 a 120 BPM)

void apply (Host& host, const djec::EditSettings& s)
{
    host.proc->setEditSettings (s);
    REQUIRE (host.proc->waitForWorker (60000));
    host.idle (2);
}

djec::EditSettings removeBars (int n)
{
    djec::EditSettings s;
    s.removeEnd = true;
    s.barsToRemove = n;
    return s;
}

/** 8 compases y un golpe final en el "1" del compás 9 que resuena 6 s (sin nada más encima). */
Audio makeRingOut()
{
    SongSpec spec;
    spec.bars = 8;
    spec.tailSec = 6;   // 16 s de canción + 6 s = 22 s = 11 compases justos
    Audio a = makeSong (spec);
    const auto i0 = static_cast<std::int64_t> (16 * 48000);
    for (std::int64_t k = 0; i0 + k < frames (a); ++k)
    {
        const double t = static_cast<double> (k) / 48000.0;
        const double click = t < 0.03 ? 0.8 * std::exp (-t / 0.008) * std::sin (2 * kPi * 2000 * t) : 0.0;
        const double chord = 0.6 * std::exp (-t / 0.8) * (std::sin (2 * kPi * 110 * t) + 0.5 * std::sin (2 * kPi * 165 * t));
        for (auto& c : a)
            c[static_cast<std::size_t> (i0 + k)] += static_cast<float> (click + chord);
    }
    return a;
}
} // namespace

TEST_CASE ("golpe final: el silencio del final de la toma no cuenta como compases")
{
    Host host;
    SongSpec spec;
    spec.bars = 12;     // 24 s de música
    spec.tailSec = 5;   // + 5 s de silencio (se dejó sonar FL después del final)
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n, BlockSizes::random (64, 2048, 61));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasRender);
    REQUIRE (v.session->gridValid);
    MESSAGE ("silencio al final: musicEnd " << v.session->grid.musicEnd << " s, lastOnset " << v.session->grid.lastOnset << " s");
    CHECK (v.session->grid.duration == doctest::Approx (29.0));
    CHECK (v.session->grid.musicEnd == doctest::Approx (24.0).epsilon (0.01));
    CHECK (v.session->grid.lastOnset > 23.0);
    CHECK (v.session->grid.lastOnset < 24.0);
    CHECK (v.session->lastBarIndex == 11);   // el compás 12 (22–24 s) tiene el golpe final

    // «Recortar cada compás» (por defecto, ½ tiempo → 7/8): los 11 compases antes del del golpe final; ni ese ni los
    // de silencio (antes: 14, también los compases vacíos)
    CHECK (v.session->plan.meter.barsChanged == 11);
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
    CHECK (v.session->editedLength == frames (expected));
    const Audio out = host.play (song, 0, n, BlockSizes::random (1, 2048, 62));
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);
    host.stopAndWait();

    // «Quitar 1 compás del final»: se va el compás del golpe final (antes: el último compás de silencio)
    apply (host, removeBars (1));
    v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->plan.cutFromBars);
    CHECK (v.session->plan.barsRemoved == 1);
    CHECK (v.session->plan.cutTime == doctest::Approx (22.0 - djec::kCutPrerollSec));
    apply (host, removeBars (3));
    v = host.view();
    CHECK (v.session->plan.barsRemoved == 3);
    CHECK (v.session->plan.cutTime == doctest::Approx (18.0 - djec::kCutPrerollSec));
    const Audio expected3 = expectedHostEdit (song, 48000, 0, 120, 4, 4, removeBars (3));
    CHECK (v.session->editedLength == frames (expected3));
}

TEST_CASE ("golpe final: la resonancia del último golpe no cuenta como compases")
{
    Host host;
    const Audio song = makeRingOut();
    const std::int64_t n = frames (song);
    REQUIRE (n == 11 * kBar);
    host.play (song, 0, n, BlockSizes::constant (512));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasRender);
    MESSAGE ("resonancia: musicEnd " << v.session->grid.musicEnd << " s, lastOnset " << v.session->grid.lastOnset << " s");
    CHECK (v.session->grid.lastOnset == doctest::Approx (16.0).epsilon (0.003));
    CHECK (v.session->grid.musicEnd < 21.0);
    CHECK (v.session->lastBarIndex == 8);

    // los 8 compases de la canción cambian; el del golpe final y su resonancia, no (antes: 11)
    CHECK (v.session->plan.meter.barsChanged == 8);
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
    CHECK (v.session->editedLength == frames (expected));
    const Audio out = host.play (song, 0, n);
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);
    host.stopAndWait();

    // «Quitar 1 compás»: el del golpe final, con su resonancia (antes: el compás 11, que es pura cola)
    apply (host, removeBars (1));
    v = host.view();
    CHECK (v.session->plan.barsRemoved == 1);
    CHECK (v.session->plan.cutTime == doctest::Approx (16.0 - djec::kCutPrerollSec));
    apply (host, removeBars (2));
    CHECK (host.view().session->plan.cutTime == doctest::Approx (14.0 - djec::kCutPrerollSec));

    // «Detectar del audio» usa los mismos límites (mismo audio, mismas funciones) y al volver a FL se reusan
    host.proc->setGridMode (djec::plugin::GridMode::Detect);
    REQUIRE (host.proc->waitForWorker (120000));
    const auto d = host.view();
    REQUIRE (d.session->detect.analyzed);
    CHECK (d.session->grid.lastOnset == v.session->grid.lastOnset);
    CHECK (d.session->grid.musicEnd == v.session->grid.musicEnd);
    host.proc->setGridMode (djec::plugin::GridMode::Host);
    REQUIRE (host.proc->waitForWorker (120000));
    CHECK (host.view().session->grid.lastOnset == v.session->grid.lastOnset);
}

TEST_CASE ("golpe final: una toma que corta la canción mientras sigue sonando cuenta todos sus compases")
{
    Host host;
    SongSpec spec;
    spec.bars = 16;
    const Audio song = makeSong (spec);
    // se toman los compases 3–10 (la canción sigue después)
    host.play (song, 2 * kBar, 8 * kBar, BlockSizes::random (64, 2048, 63));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->hostStart == 2 * kBar);
    // el golpe final es el final de la toma
    CHECK (v.session->grid.lastOnset == doctest::Approx (16.0));
    CHECK (v.session->grid.musicEnd == doctest::Approx (16.0));
    CHECK (v.session->plan.meter.barsChanged == 8);
    const Audio take = slice (song, 2 * kBar, 10 * kBar);
    const Audio expected = expectedHostEdit (take, 48000, 2 * kBar, 120, 4, 4, djec::EditSettings {});
    CHECK (frames (expected) == 8 * 84000);

    apply (host, removeBars (1));
    v = host.view();
    CHECK (v.session->plan.barsRemoved == 1);
    CHECK (v.session->plan.cutTime == doctest::Approx (14.0 - djec::kCutPrerollSec));
    CHECK (v.session->plan.meter.barsChanged == 7);

    // lo mismo si la toma termina a mitad de un compás (la música sigue): cuenta hasta el último "1"
    Host h2;
    h2.play (song, 0, 9 * kBar + kBar / 2, BlockSizes::constant (512));
    h2.stopAndWait();
    v = h2.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->grid.lastOnset == doctest::Approx (19.0));
    CHECK (v.session->plan.meter.barsChanged == 9);
    apply (h2, removeBars (1));
    CHECK (h2.view().session->plan.cutTime == doctest::Approx (18.0 - djec::kCutPrerollSec));
}
