// Toma automática al darle Play y reproducción de lo editado en el Play siguiente (USER DECISION v2, A.1–A.3).
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::Phase;

namespace
{
void checkAutoTake (BlockSizes bs1, BlockSizes bs2)
{
    Host host;
    SongSpec spec;   // 16 compases de 4/4 a 120 BPM, estéreo, desde la muestra 0
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    REQUIRE (n == 16 * 2 * 48000);

    // antes de sonar
    CHECK (host.view().phase == Phase::WaitingForPlay);
    CHECK (host.view().statusText == juce::String::fromUTF8 ("Dale Play en FL: el plugin toma el audio del canal."));

    // 1.ª pasada: se toma (y suena el original)
    bool sawTaking = false;
    const Audio out1 = host.play (song, 0, n, bs1, [&] (std::int64_t) {
        const auto v = host.view();
        if (v.phase == Phase::Taking && v.statusText.startsWith (juce::String::fromUTF8 ("Tomando el audio… ")))
            sawTaking = true;
        return false;
    });
    CHECK (sawTaking);
    CHECK (maxDiff (out1, 0, song, 0, n) == 0.0);
    host.stopAndWait();

    const auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->source == djec::plugin::TakeSource::Playback);
    CHECK (v.session->placed);
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == n);
    CHECK (v.session->gridValid);
    CHECK (v.session->hasRender);
    CHECK (v.phase == Phase::Ready);
    CHECK (v.statusText == juce::String::fromUTF8 ("Listo: desde el próximo Play suena recortado."));
    CHECK (v.session->meterHint == juce::String::fromUTF8 ("Pon el compás del proyecto de FL en 7/8"));
    CHECK (v.session->grid.beatsPerBar == 4);
    CHECK (v.session->displayBpm == doctest::Approx (120));
    CHECK (v.session->takeFile.existsAsFile());   // la toma quedó guardada en …/Tomas

    // lo esperado: render de la cuadrícula de FL con los ajustes por defecto (½ tiempo → 7/8)
    djec::EditPlan plan;
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {}, &plan);
    const std::int64_t edLen = frames (expected);
    CHECK (edLen == 16 * 84000);   // 16 compases de 1,75 s
    CHECK (v.session->editedLength == edLen);

    // 2.ª pasada: suena lo editado alineado a la línea de tiempo y silencio hasta el final de la toma
    bool sawEdited = false;
    const Audio out2 = host.play (song, 0, n, bs2, [&] (std::int64_t) {
        if (host.view().phase == Phase::PlayingEdited)
            sawEdited = true;
        return false;
    });
    CHECK (sawEdited);
    CHECK (maxDiff (out2, 0, expected, 0, edLen) <= 1e-6);
    CHECK (maxAbs (out2, edLen, n - edLen) == 0.0);

    // el "1" de cada compás suena cada 1,75 s, intacto (copiado bit a bit)
    const std::int64_t click = static_cast<std::int64_t> (0.03 * 48000);
    for (int k = 0; k < 16; ++k)
    {
        const std::int64_t at = static_cast<std::int64_t> (k) * 84000;
        CHECK (maxDiff (out2, at, song, static_cast<std::int64_t> (k) * 96000, click) == 0.0);
    }
    host.idle();
}
} // namespace

TEST_CASE ("toma automática: 1.ª pasada toma, 2.ª suena editado (bloques de 512)")
{
    checkAutoTake (BlockSizes::constant (512), BlockSizes::constant (512));
}

TEST_CASE ("toma automática: bloques de 1 muestra")
{
    checkAutoTake (BlockSizes::constant (1), BlockSizes::constant (1));
}

TEST_CASE ("toma automática: bloques aleatorios 1..2048 (distintos en cada pasada)")
{
    checkAutoTake (BlockSizes::random (1, 2048, 7), BlockSizes::random (1, 2048, 99));
}

TEST_CASE ("toma automática: bus mono")
{
    Host host (48000, 1);
    SongSpec spec;
    spec.numCh = 1;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n);
    host.stopAndWait();
    const auto v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->numChannels == 1);
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
    const Audio out = host.play (song, 0, n, BlockSizes::random (1, 700, 3));
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);
}

TEST_CASE ("A/B «Original / Editado» y bypass")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n);
    host.stopAndWait();
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});

    host.proc->setListenOriginal (true);
    CHECK (host.proc->isListeningOriginal());
    bool sawOriginal = false;
    const Audio a = host.play (song, 0, n, BlockSizes::constant (512), [&] (std::int64_t) {
        if (host.view().phase == Phase::PlayingOriginal)
            sawOriginal = true;
        return false;
    });
    CHECK (sawOriginal);
    CHECK (maxDiff (a, 0, song, 0, n) == 0.0);

    // cambiar a «Editado» a mitad de la pasada cambia al instante
    host.proc->setListenOriginal (false);
    const Audio b = host.play (song, 0, n / 2);
    CHECK (maxDiff (b, 0, expected, 0, n / 2) <= 1e-6);
    const std::int64_t half = n / 2;
    host.proc->setListenOriginal (true);
    Audio c (2, std::vector<float> (static_cast<std::size_t> (n - half)));
    {
        // sigue de corrido (sin salto) desde la mitad
        const Audio rest = host.play (song, half, n - half);
        CHECK (maxDiff (rest, 0, song, half, n - half) == 0.0);
    }
    host.proc->setListenOriginal (false);

    // bypass: pasa la entrada y no toma nada
    host.bypassed = true;
    const Audio d = host.play (song, 0, n);
    CHECK (maxDiff (d, 0, song, 0, n) == 0.0);
    host.bypassed = false;
    host.idle();
}

TEST_CASE ("«Mover el 1» en la cuadrícula de FL (anacrusa de un tiempo)")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n);
    host.stopAndWait();
    host.proc->moveDownbeat (+1, 0.0);
    REQUIRE (host.proc->waitForWorker (30000));
    host.idle (2);
    auto v = host.view();
    CHECK (v.session->barOffsetBeats == 1);
    REQUIRE (v.session->grid.positions.size() > 2);
    CHECK (v.session->grid.positions[0] == 3);
    CHECK (v.session->grid.positions[1] == 0);

    // lo esperado con el mismo corrimiento
    djec::CaptureInfo cap;
    cap.sampleRate = 48000;
    cap.numSamples = static_cast<std::size_t> (n);
    djec::HostBlockInfo i;
    i.bpm = 120;
    i.ppqValid = i.barValid = true;
    cap.blocks.emplace_back (0, i);
    djec::HostGridMeta meta;
    const auto grid = djec::gridFromHost (cap, 1, &meta);
    const auto plan = djec::buildEditPlan (grid, 4, djec::EditSettings {});
    Audio expected;
    std::vector<const float*> ptrs { song[0].data(), song[1].data() };
    djec::renderSegments (ptrs.data(), 2, static_cast<std::size_t> (n), 48000, plan.segments, plan.crossfadeSec,
                          plan.fadeOutSec, plan.curve, expected);
    const Audio out = host.play (song, 0, n);
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);

    host.proc->moveDownbeat (-1, 0.0);
    REQUIRE (host.proc->waitForWorker (30000));
    v = host.view();
    CHECK (v.session->barOffsetBeats == 0);
    CHECK (v.session->grid.positions[0] == 0);
}
