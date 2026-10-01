// Continuidad de la posición del host: FL puede redondear las posiciones que informa (±1 muestra, una corrección de
// 0,3 ms) mientras el audio llega de corrido. Eso no es un salto: hasta max(2 muestras, 0,5 ms) de diferencia con
// la posición esperada (anterior + largo del bloque) sigue siendo de corrido. Un salto de verdad (10 ms) sí lo es.
#include "HostSim.h"

#include "TakeEngine.h"

using namespace djec_test;

namespace
{
/**
 * Suena [from, from + len) con el audio de corrido, pero el host informa la posición con offset(bloque, muestra)
 * muestras de diferencia (el primer bloque de cada pasada, sin diferencia: es donde empieza la pasada).
 */
Audio playJittered (Host& host, const Audio& input, std::int64_t from, std::int64_t len, BlockSizes bs,
                    const std::function<std::int64_t (int, std::int64_t)>& offset)
{
    Audio out (static_cast<std::size_t> (host.numCh), std::vector<float> (static_cast<std::size_t> (len), 0.0f));
    host.head.playing = true;
    std::int64_t done = 0;
    int k = 0;
    while (done < len)
    {
        const int n = static_cast<int> (std::min<std::int64_t> ({ static_cast<std::int64_t> (bs.next()), len - done, Host::kMaxBlock }));
        host.head.time = from + done;
        host.head.reportOffset = k == 0 ? 0 : offset (k, from + done);
        host.block (input, n, &out, done);
        done += n;
        ++k;
    }
    host.head.reportOffset = 0;
    host.head.time = from + done;
    return out;
}

/**
 * Toma con la posición informada temblando y comprueba que se tomó todo, de corrido, sin aviso de salto.
 * ppqFollows: el ppq que informa FL también sale de la posición redondeada (si no, solo tiembla la posición en
 * muestras y el ppq es exacto).
 */
void takeAndPlayJittered (const std::function<std::int64_t (int, std::int64_t)>& offset, BlockSizes bs1, BlockSizes bs2,
                          bool ppqFollows)
{
    Host host;
    host.head.ppqFollowsReport = ppqFollows;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);

    const Audio out1 = playJittered (host, song, 0, n, bs1, offset);
    CHECK (maxDiff (out1, 0, song, 0, n) == 0.0);   // mientras toma suena el original
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK_FALSE (hasNotice (v, "take-jump"));
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == n);   // toda la canción en una sola toma
    const auto id = v.session->takeId;

    // la toma es el audio tal cual (sin muestras perdidas ni repetidas): lo editado suena de corrido aunque la
    // posición informada siga temblando, y no se toma por un "cambio" del canal
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
    CHECK (v.session->plan.meter.barsChanged == 8);
    const Audio out2 = playJittered (host, song, 0, n, bs2, offset);
    if (! ppqFollows)
    {
        // con el ppq exacto, la cuadrícula es la misma: lo editado es exactamente lo esperado
        CHECK (v.session->editedLength == frames (expected));
        CHECK (maxDiff (out2, 0, expected, 0, frames (expected)) <= 1e-6);
        CHECK (maxAbs (out2, frames (expected), n - frames (expected)) == 0.0);
    }
    else
    {
        // con el ppq redondeado, la cuadrícula se corre lo mismo que la posición informada (unas muestras, < 0,5 ms):
        // lo editado es el de esa cuadrícula y suena tal cual (la muestra i en la muestra i de la pasada)
        CHECK (std::llabs (v.session->editedLength - frames (expected)) <= 2 * 8 * 24);
        const std::int64_t edLen = v.session->editedLength;
        CHECK (maxAbs (out2, edLen, n - edLen) == 0.0);
        CHECK (maxAbs (out2, 0, edLen) > 0.1);
    }
    host.stopAndWait();
    v = host.view();
    CHECK (v.session->takeId == id);
    CHECK_FALSE (hasNotice (v, "audio-changed"));
    CHECK_FALSE (hasNotice (v, "take-jump"));
}
} // namespace

TEST_CASE ("continuidad: tolerancia max(2 muestras, 0,5 ms)")
{
    CHECK (djec::plugin::contiguityToleranceSamples (48000) == 24);
    CHECK (djec::plugin::contiguityToleranceSamples (44100) == 22);
    CHECK (djec::plugin::contiguityToleranceSamples (96000) == 48);
    CHECK (djec::plugin::contiguityToleranceSamples (2000) == 2);
}

TEST_CASE ("continuidad: posición informada con ±1 muestra de diferencia no es un salto")
{
    for (const bool ppqFollows : { false, true })
    {
        CAPTURE (ppqFollows);
        std::mt19937 rng (17);
        takeAndPlayJittered ([&] (int, std::int64_t) { return static_cast<std::int64_t> (rng() % 3) - 1; },
                             BlockSizes::random (64, 2048, 51), BlockSizes::random (1, 2048, 52), ppqFollows);
    }
}

TEST_CASE ("continuidad: una corrección de 0,3 ms (14 muestras) de FL no es un salto")
{
    for (const bool ppqFollows : { false, true })
    {
        CAPTURE (ppqFollows);
        // hacia adelante, desde el segundo 5
        takeAndPlayJittered ([] (int, std::int64_t h) { return h >= 5 * 48000 ? std::int64_t (14) : std::int64_t (0); },
                             BlockSizes::constant (512), BlockSizes::random (1, 1024, 53), ppqFollows);
        // hacia atrás, desde el segundo 3
        takeAndPlayJittered ([] (int, std::int64_t h) { return h >= 3 * 48000 ? std::int64_t (-14) : std::int64_t (0); },
                             BlockSizes::random (32, 700, 54), BlockSizes::constant (480), ppqFollows);
    }
}

TEST_CASE ("continuidad: Play donde terminó la toma, con la posición informada 1 muestra corrida, agrega lo de detrás")
{
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    const std::int64_t E = 4 * 96000;
    for (const std::int64_t off : { std::int64_t (1), std::int64_t (-1), std::int64_t (20) })
    {
        CAPTURE (off);
        Host host;
        host.play (song, 0, E, BlockSizes::constant (512));
        host.stopAndWait();
        REQUIRE (host.view().session->numSamples == E);
        // FL arranca donde paró, pero informa la posición corrida
        host.head.reportOffset = off;
        bool sawOutside = false;
        const Audio out = host.play (song, E, n - E, BlockSizes::random (64, 1024, 55), [&] (std::int64_t) {
            sawOutside = sawOutside || host.view().phase == djec::plugin::Phase::OutsideTake;
            return false;
        });
        host.head.reportOffset = 0;
        CHECK (maxDiff (out, 0, song, E, n - E) == 0.0);   // lo de detrás suena original (y se toma)
        host.stopAndWait();
        CHECK_FALSE (sawOutside);
        const auto v = host.view();
        CHECK (v.session->hostStart == 0);
        CHECK (v.session->numSamples == n);
        // la toma unida es la canción entera, sin huecos: suena igual que si se hubiera tomado de una vez
        const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
        const Audio out2 = host.play (song, 0, n, BlockSizes::constant (512));
        CHECK (maxDiff (out2, 0, expected, 0, frames (expected)) <= 1e-6);
        host.stopAndWait();
    }
}

TEST_CASE ("continuidad: un salto de 10 ms sí es un salto (aviso y la toma se queda con lo de antes)")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    const std::int64_t at = 5 * 48000, jump = 480;   // 10 ms

    // suena de corrido hasta el segundo 5 y FL salta 10 ms (el audio también: es un salto de verdad)
    host.play (song, 0, at, BlockSizes::constant (512));
    host.play (song, at + jump, n - at - jump, BlockSizes::constant (512));
    host.stopAndWait();
    auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (hasNotice (v, "take-jump"));
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->numSamples == at);

    // justo por encima de la tolerancia (25 muestras a 48 kHz) también es un salto
    Host h2;
    h2.play (song, 0, at, BlockSizes::constant (512));
    h2.play (song, at + 25, 48000, BlockSizes::constant (512));
    h2.stopAndWait();
    v = h2.view();
    CHECK (hasNotice (v, "take-jump"));
    CHECK (v.session->numSamples == at);

    // y en el límite (24 muestras = 0,5 ms), no (el audio llega de corrido; la posición informada se corrió)
    Host h3;
    h3.play (song, 0, at, BlockSizes::constant (512));
    h3.head.reportOffset = 24;
    h3.play (song, at, n - at, BlockSizes::constant (512));
    h3.head.reportOffset = 0;
    h3.stopAndWait();
    v = h3.view();
    CHECK_FALSE (hasNotice (v, "take-jump"));
    CHECK (v.session->numSamples == n);
}
