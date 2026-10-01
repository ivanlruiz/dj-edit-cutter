// La toma crece: Play desde antes del principio (se agrega delante al llegar de corrido) y más allá del final (se
// agrega detrás); un salto durante la toma la cierra (USER DECISION v2, A.2–A.3).
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::Phase;

namespace
{
constexpr std::int64_t kBar = 96000;   // 2 s a 48 kHz (4/4 a 120 BPM)
}

TEST_CASE ("toma a mitad de la canción, después se agrega delante y detrás")
{
    Host host;
    SongSpec spec;
    spec.bars = 24;
    const Audio song = makeSong (spec);
    const djec::EditSettings settings;

    // 1.ª pasada: del compás 5 al 13 (sin el principio)
    host.play (song, 4 * kBar, 8 * kBar, BlockSizes::random (1, 2048, 11));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->hostStart == 4 * kBar);
    CHECK (v.session->numSamples == 8 * kBar);
    const Audio take1 = slice (song, 4 * kBar, 12 * kBar);
    const Audio ed1 = expectedHostEdit (take1, 48000, 4 * kBar, 120, 4, 4, settings);

    // 2.ª pasada: desde el compás 1 → lo de delante suena original (y se toma); desde el compás 5, lo editado
    bool sawTakingMore = false;
    const Audio out2 = host.play (song, 0, 12 * kBar, BlockSizes::random (1, 2048, 12), [&] (std::int64_t h) {
        if (h < 4 * kBar && host.view().phase == Phase::TakingMore)
            sawTakingMore = true;
        return false;
    });
    CHECK (sawTakingMore);
    CHECK (maxDiff (out2, 0, song, 0, 4 * kBar) == 0.0);
    CHECK (maxDiff (out2, 4 * kBar, ed1, 0, frames (ed1)) <= 1e-6);
    host.stopAndWait();
    v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == 12 * kBar);
    const Audio ed2 = expectedHostEdit (slice (song, 0, 12 * kBar), 48000, 0, 120, 4, 4, settings);

    // 3.ª pasada: hasta el compás 17 → lo tomado suena editado; desde el final de la toma, original (y se toma)
    const Audio out3 = host.play (song, 0, 16 * kBar, BlockSizes::constant (512));
    CHECK (maxDiff (out3, 0, ed2, 0, frames (ed2)) <= 1e-6);
    CHECK (maxAbs (out3, frames (ed2), 12 * kBar - frames (ed2)) == 0.0);
    CHECK (maxDiff (out3, 12 * kBar, song, 12 * kBar, 4 * kBar) == 0.0);
    host.stopAndWait();
    v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == 16 * kBar);

    // 4.ª pasada: todo editado, igual que si se hubiera tomado de una vez
    const Audio ed3 = expectedHostEdit (slice (song, 0, 16 * kBar), 48000, 0, 120, 4, 4, settings);
    const Audio out4 = host.play (song, 0, 16 * kBar, BlockSizes::random (1, 2048, 13));
    CHECK (maxDiff (out4, 0, ed3, 0, frames (ed3)) <= 1e-6);
    CHECK (maxAbs (out4, frames (ed3), 16 * kBar - frames (ed3)) == 0.0);

    // la toma guardada en disco es la unida (y solo queda un WAV: los intermedios se borran)
    CHECK (v.session->takeFile.existsAsFile());
    host.idle();
}

TEST_CASE ("Play desde antes de la toma que se para antes de llegar: no se agrega nada")
{
    Host host;
    SongSpec spec;
    spec.bars = 12;
    const Audio song = makeSong (spec);
    host.play (song, 6 * kBar, 4 * kBar);
    host.stopAndWait();
    REQUIRE (host.view().session->hostStart == 6 * kBar);
    const Audio out = host.play (song, 1 * kBar, 3 * kBar);   // compases 2–4: no llega al 7
    CHECK (maxDiff (out, 0, song, kBar, 3 * kBar) == 0.0);
    host.stopAndWait();
    const auto v = host.view();
    CHECK (v.session->hostStart == 6 * kBar);
    CHECK (v.session->numSamples == 4 * kBar);
}

TEST_CASE ("salto de posición durante la toma: se queda lo tomado hasta el salto")
{
    Host host;
    SongSpec spec;
    spec.bars = 16;
    const Audio song = makeSong (spec);
    const djec::EditSettings settings;

    // suena 0–10 s, salta a 20 s y sigue hasta 25 s
    const std::int64_t s10 = 10 * 48000, s20 = 20 * 48000, s5 = 5 * 48000;
    host.play (song, 0, s10, BlockSizes::random (1, 2048, 21));
    bool sawOutside = false;
    const Audio after = host.play (song, s20, s5, BlockSizes::random (1, 2048, 22), [&] (std::int64_t) {
        const auto v = host.view();
        if (v.phase == Phase::OutsideTake
            && v.statusText == juce::String::fromUTF8 ("Esta parte todavía no fue tomada: dale Play desde el principio."))
            sawOutside = true;
        return false;
    });
    CHECK (maxDiff (after, 0, song, s20, s5) == 0.0);   // fuera de la toma: original
    host.stopAndWait();
    CHECK (sawOutside);
    const auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == s10);
    CHECK (hasNotice (v, "take-jump"));

    const Audio ed = expectedHostEdit (slice (song, 0, s10), 48000, 0, 120, 4, 4, settings);
    const Audio out = host.play (song, 0, s10);
    CHECK (maxDiff (out, 0, ed, 0, frames (ed)) <= 1e-6);

    // otra pasada que salta de dentro de la toma a fuera: lo de fuera no se toma
    host.play (song, 0, 2 * 48000);
    host.play (song, 14 * 48000, 2 * 48000);
    host.stopAndWait();
    CHECK (host.view().session->numSamples == s10);
}

TEST_CASE ("una toma de menos de 1 s se descarta")
{
    Host host;
    SongSpec spec;
    spec.bars = 2;
    const Audio song = makeSong (spec);
    host.play (song, 0, 24000);
    host.stopAndWait();
    const auto v = host.view();
    CHECK_FALSE (v.session->hasTake);
    CHECK (hasNotice (v, "take-short"));
    CHECK (v.phase == Phase::WaitingForPlay);
}
