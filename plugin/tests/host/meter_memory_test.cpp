// Cuadrícula de FL: el plugin pide poner el compás del proyecto de FL en el compás NUEVO (p. ej. 7/8). Una toma
// posterior (cambio en el canal, «Volver a tomar el audio», agregar detrás…) lee ese compás de FL, pero el audio sigue
// en el compás original: el plugin recuerda el compás de la primera toma y lo usa mientras FL diga el compás destino.
// «Compás original» permite elegirlo a mano.
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::MeterOrigin;

namespace
{
constexpr std::int64_t kBar = 96000;   // 2 s a 48 kHz (4/4 a 120 BPM)

/** Todos los "1" de la cuadrícula caen en un múltiplo de `barQ` negras de la línea de tiempo del host. */
void checkDownbeatsEvery (const djec::plugin::SessionView& s, double barQ)
{
    REQUIRE (s.gridValid);
    const double bps = 120.0 / 60.0;   // negras por segundo
    int count = 0;
    for (std::size_t i = 0; i < s.grid.beats.size(); ++i)
        if (s.grid.positions[i] == 0)
        {
            const double ppq = (static_cast<double> (s.hostStart) / 48000.0 + s.grid.beats[i]) * bps;
            const double k = ppq / barQ;
            CHECK (std::fabs (k - std::round (k)) < 1e-6);
            ++count;
        }
    CHECK (count > 0);
}

void retake (Host& host)
{
    host.proc->clearTake();
    REQUIRE (host.proc->waitForWorker (30000));
    host.idle (2);
}
} // namespace

TEST_CASE ("compás original: «Volver a tomar el audio» con FL ya en 7/8 sigue usando el 4/4 de la primera toma")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n, BlockSizes::random (64, 2048, 71));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->meterHint == juce::String::fromUTF8 ("Pon el compás del proyecto de FL en 7/8"));
    CHECK (v.session->meterOrigin == MeterOrigin::Host);
    CHECK (v.session->rememberedNum == 4);
    CHECK (v.session->rememberedDen == 4);

    // el usuario hace lo que pide el plugin…
    host.head.num = 7;
    host.head.den = 8;
    // …y vuelve a tomar el audio
    retake (host);
    host.play (song, 0, n, BlockSizes::random (64, 2048, 72));
    host.stopAndWait();
    v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->grid.beatsPerBar == 4);
    CHECK (v.session->sourceDen == 4);
    CHECK (v.session->hostMeta.tsNum == 4);
    CHECK (v.session->hostMeta.tsDen == 4);
    CHECK (v.session->takeHostNum == 7);   // lo que dijo FL
    CHECK (v.session->takeHostDen == 8);
    CHECK (v.session->meterOrigin == MeterOrigin::FirstTake);
    CHECK (v.session->meterHint == juce::String::fromUTF8 ("Pon el compás del proyecto de FL en 7/8"));
    checkDownbeatsEvery (*v.session, 4.0);

    // suena igual que la primera vez (4/4 → 7/8)
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
    CHECK (frames (expected) == 8 * 84000);
    const Audio out = host.play (song, 0, n, BlockSizes::random (1, 2048, 73));
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);
    host.stopAndWait();
}

TEST_CASE ("compás original: se recuerda también al volver a tomar por un cambio en el canal y al agregar detrás")
{
    Host host;
    SongSpec spec;
    spec.bars = 16;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);

    // 1.ª toma: compases 1–8 en 4/4
    host.play (song, 0, 8 * kBar);
    host.stopAndWait();
    REQUIRE (host.view().session->hasRender);
    host.head.num = 7;
    host.head.den = 8;

    // agregar detrás con FL en 7/8: lo agregado también va en 4/4
    host.play (song, 0, 12 * kBar, BlockSizes::random (64, 2048, 74));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasRender);
    CHECK (v.session->numSamples == 12 * kBar);
    CHECK (v.session->grid.beatsPerBar == 4);
    CHECK_FALSE (v.session->hostMeta.meterChanges);
    CHECK (v.session->meterOrigin == MeterOrigin::FirstTake);
    checkDownbeatsEvery (*v.session, 4.0);
    CHECK (v.session->plan.meter.barsChanged == 12);

    // el canal cambia desde el compás 6 (+6 dB): se vuelve a tomar desde ahí, a mitad de un compás, con FL en 7/8
    Audio loud = song;
    for (auto& c : loud)
        for (std::size_t i = static_cast<std::size_t> (5 * kBar); i < c.size(); ++i)
            c[i] *= 2.0f;
    host.play (loud, 0, n, BlockSizes::random (64, 2048, 75));
    host.stopAndWait();
    v = host.view();
    REQUIRE (hasNotice (v, "audio-changed"));
    REQUIRE (v.session->hasRender);
    CHECK (v.session->hostStart > 5 * kBar);
    CHECK (v.session->grid.beatsPerBar == 4);
    CHECK (v.session->sourceDen == 4);
    CHECK (v.session->meterOrigin == MeterOrigin::FirstTake);
    checkDownbeatsEvery (*v.session, 4.0);   // los "1" donde estaban en la primera toma
}

TEST_CASE ("compás original: si FL dice otro compás (no el destino), ese pasa a ser el original")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n);
    host.stopAndWait();

    // otra canción, en 3/4: FL en 3/4, que no es el compás destino (7/8)
    host.head.num = 3;
    host.head.den = 4;
    retake (host);
    host.play (song, 0, n);
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->gridValid);
    CHECK (v.session->grid.beatsPerBar == 3);
    CHECK (v.session->meterOrigin == MeterOrigin::Host);
    CHECK (v.session->rememberedNum == 3);
    CHECK (v.session->rememberedDen == 4);
    CHECK (v.session->meterHint == juce::String::fromUTF8 ("Pon el compás del proyecto de FL en 5/8"));

    // FL en 5/8 (lo que pide ahora): se usa el 3/4 recordado
    host.head.num = 5;
    host.head.den = 8;
    retake (host);
    host.play (song, 0, n);
    host.stopAndWait();
    v = host.view();
    CHECK (v.session->grid.beatsPerBar == 3);
    CHECK (v.session->sourceDen == 4);
    CHECK (v.session->meterOrigin == MeterOrigin::FirstTake);
    checkDownbeatsEvery (*v.session, 3.0);
}

TEST_CASE ("compás original: elegido a mano («Compás original») y vuelta a Auto")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n);
    host.stopAndWait();

    host.proc->setSourceMeter (3, 4);
    REQUIRE (host.proc->waitForWorker (30000));
    auto v = host.view();
    CHECK (v.session->sourceMeterNum == 3);
    CHECK (v.session->sourceMeterDen == 4);
    CHECK (v.session->meterOrigin == MeterOrigin::Manual);
    CHECK (v.session->grid.beatsPerBar == 3);
    CHECK (v.session->hostMeta.tsNum == 3);
    CHECK (v.session->hostMeta.tsDen == 4);
    CHECK (v.session->grid.positions.front() == 0);   // el "1" de FL sigue siendo un "1"
    checkDownbeatsEvery (*v.session, 3.0);
    CHECK (v.session->meterHint == juce::String::fromUTF8 ("Pon el compás del proyecto de FL en 5/8"));

    host.proc->setSourceMeter (6, 8);
    REQUIRE (host.proc->waitForWorker (30000));
    v = host.view();
    CHECK (v.session->grid.beatsPerBar == 6);
    CHECK (v.session->sourceDen == 8);
    checkDownbeatsEvery (*v.session, 3.0);

    // valores que no son un compás: Auto
    host.proc->setSourceMeter (0, 0);
    REQUIRE (host.proc->waitForWorker (30000));
    v = host.view();
    CHECK (v.session->sourceMeterNum == 0);
    CHECK (v.session->meterOrigin == MeterOrigin::Host);
    CHECK (v.session->grid.beatsPerBar == 4);
    host.proc->setSourceMeter (5, 3);
    REQUIRE (host.proc->waitForWorker (30000));
    CHECK (host.view().session->sourceMeterNum == 0);
}

TEST_CASE ("compás original: se guarda en el proyecto (recordado y elegido a mano)")
{
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    juce::MemoryBlock state, state2;
    {
        Host a;
        a.play (song, 0, n);
        a.stopAndWait();
        a.head.num = 7;
        a.head.den = 8;
        retake (a);
        a.play (song, 0, n);
        a.stopAndWait();
        REQUIRE (a.view().session->meterOrigin == MeterOrigin::FirstTake);
        a.proc->getStateInformation (state);
        a.proc->setSourceMeter (3, 4);
        REQUIRE (a.proc->waitForWorker (30000));
        a.proc->getStateInformation (state2);
    }
    {
        Host b;
        b.head.num = 7;
        b.head.den = 8;
        b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        REQUIRE (b.proc->waitForWorker (30000));
        auto v = b.view();
        REQUIRE (v.session->hasTake);
        CHECK (v.session->grid.beatsPerBar == 4);
        CHECK (v.session->meterOrigin == MeterOrigin::FirstTake);
        CHECK (v.session->rememberedNum == 4);
        // y una toma nueva en esta instancia (FL sigue en 7/8) también usa el 4/4
        retake (b);
        b.play (song, 0, n);
        b.stopAndWait();
        v = b.view();
        CHECK (v.session->grid.beatsPerBar == 4);
        CHECK (v.session->meterOrigin == MeterOrigin::FirstTake);
    }
    {
        Host c;
        c.proc->setStateInformation (state2.getData(), static_cast<int> (state2.getSize()));
        REQUIRE (c.proc->waitForWorker (30000));
        const auto v = c.view();
        CHECK (v.session->sourceMeterNum == 3);
        CHECK (v.session->sourceMeterDen == 4);
        CHECK (v.session->grid.beatsPerBar == 3);
        CHECK (v.session->meterOrigin == MeterOrigin::Manual);
    }
}
