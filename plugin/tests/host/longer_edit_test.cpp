// Lo editado puede durar MÁS que la toma («Alargar: repetir el último tiempo», 4/4 → 5/4): la muestra i de lo
// editado suena en A + i también después de E (antes se cortaba en E y volvía a sonar el canal).
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::Phase;

namespace
{
constexpr std::int64_t kBar = 96000;   // 2 s a 48 kHz (4/4 a 120 BPM)

djec::EditSettings extendSettings()
{
    djec::EditSettings s;
    s.amount = "extend";
    return s;
}

void applySettings (Host& host, const djec::EditSettings& s)
{
    host.proc->setEditSettings (s);
    REQUIRE (host.proc->waitForWorker (60000));
    host.idle (2);
}
} // namespace

TEST_CASE ("«Alargar»: lo editado sigue sonando después del final de la toma (y se toma lo de detrás)")
{
    Host host;
    SongSpec spec;
    spec.bars = 12;
    const Audio song = makeSong (spec);   // la pista sigue sonando después de lo tomado

    // 1.ª pasada: se toman los compases 1–8
    host.play (song, 0, 8 * kBar, BlockSizes::random (1, 2048, 21));
    host.stopAndWait();
    applySettings (host, extendSettings());
    auto v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->numSamples == 8 * kBar);

    const Audio expected = expectedHostEdit (slice (song, 0, 8 * kBar), 48000, 0, 120, 4, 4, extendSettings());
    const std::int64_t edLen = frames (expected);
    // los 8 compases tienen un tiempo repetido (la toma termina justo en una barra: el último compás también cuenta)
    CHECK (edLen == 8 * kBar + 8 * 24000);
    CHECK (v.session->editedLength == edLen);

    // 2.ª pasada de corrido: todo lo editado suena alineado, también lo que cae después de E = 8 compases
    bool sawEditedTail = false;
    const Audio out2 = host.play (song, 0, edLen, BlockSizes::random (1, 2048, 22), [&] (std::int64_t h) {
        const auto vv = host.view();
        if (h > 8 * kBar + 48000 && vv.phase == Phase::TakingMore && vv.live.outputEdited
            && vv.statusText.contains (juce::String::fromUTF8 ("(suena lo editado)")))
            sawEditedTail = true;
        return false;
    });
    CHECK (sawEditedTail);
    CHECK (maxDiff (out2, 0, expected, 0, edLen) <= 1e-6);
    host.stopAndWait();

    // lo que sonó en el canal detrás de E se tomó (la entrada, no lo editado que sonaba encima)
    v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == edLen);
    const Audio expected2 = expectedHostEdit (slice (song, 0, edLen), 48000, 0, 120, 4, 4, extendSettings());
    REQUIRE (frames (expected2) > edLen);
    CHECK (v.session->editedLength == frames (expected2));

    // 3.ª pasada: igual que si se hubiera tomado todo de una vez
    const std::int64_t len3 = std::min (frames (expected2), frames (song));
    const Audio out3 = host.play (song, 0, len3, BlockSizes::constant (512));
    CHECK (maxDiff (out3, 0, expected2, 0, len3) <= 1e-6);
    host.stopAndWait();
}

TEST_CASE ("«Alargar»: con «Original» (A/B) suena el canal también detrás de la toma")
{
    Host host;
    SongSpec spec;
    spec.bars = 10;
    const Audio song = makeSong (spec);
    host.play (song, 0, 6 * kBar);
    host.stopAndWait();
    applySettings (host, extendSettings());
    const std::int64_t edLen = host.view().session->editedLength;
    REQUIRE (edLen > 6 * kBar);

    host.proc->setListenOriginal (true);
    const Audio out = host.play (song, 0, edLen, BlockSizes::random (1, 2048, 23));
    CHECK (maxDiff (out, 0, song, 0, edLen) == 0.0);
    host.proc->setListenOriginal (false);
    host.stopAndWait();
}

TEST_CASE ("«Alargar»: Play que empieza después de E pero dentro de lo editado")
{
    Host host;
    SongSpec spec;
    spec.bars = 10;
    const Audio song = makeSong (spec);
    host.play (song, 0, 6 * kBar);
    host.stopAndWait();
    applySettings (host, extendSettings());
    const Audio expected = expectedHostEdit (slice (song, 0, 6 * kBar), 48000, 0, 120, 4, 4, extendSettings());
    const std::int64_t edLen = frames (expected);
    REQUIRE (edLen > 6 * kBar + kBar / 2);

    // sin continuidad con E: no se toma nada, pero la parte editada que cae ahí suena (y después, el canal)
    const std::int64_t from = 6 * kBar + kBar / 4;
    const std::int64_t len = edLen - from + kBar;
    const Audio out = host.play (song, from, len, BlockSizes::random (1, 2048, 24));
    CHECK (maxDiff (out, 0, expected, from, edLen - from) <= 1e-6);
    CHECK (maxDiff (out, edLen - from, song, edLen, kBar) == 0.0);
    host.stopAndWait();
    CHECK (host.view().session->numSamples == 6 * kBar);   // la toma no cambió
}
