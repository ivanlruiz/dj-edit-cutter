// Detección de cambios en el audio del canal (USER DECISION v2, A.4) y del tempo/frecuencia (A.5).
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::Phase;

namespace
{
constexpr std::int64_t kBar = 96000;   // 2 s a 48 kHz

struct Taken
{
    Host host;
    Audio song;
    std::uint32_t takeId = 0;
    Audio expected;
};

/** Toma de 16 compases y su render esperado. */
void takeSong (Taken& t, const SongSpec& spec)
{
    t.song = makeSong (spec);
    t.host.play (t.song, 0, frames (t.song), BlockSizes::random (1, 2048, 5));
    t.host.stopAndWait();
    const auto v = t.host.view();
    REQUIRE (v.session->hasTake);
    t.takeId = v.session->takeId;
    t.expected = expectedHostEdit (t.song, 48000, 0, 120, 4, 4, djec::EditSettings {});
}

void addNoise (Audio& a, double rms, unsigned seed, std::int64_t from = 0, std::int64_t to = -1)
{
    std::mt19937 rng (seed);
    std::normal_distribution<double> d (0.0, rms);
    for (auto& c : a)
    {
        const std::int64_t end = to < 0 ? static_cast<std::int64_t> (c.size()) : to;
        for (std::int64_t i = from; i < end; ++i)
            c[static_cast<std::size_t> (i)] += static_cast<float> (d (rng));
    }
}

/** Una pasada con la entrada cambiada; la toma NO tiene que dejar de valer. */
void expectKept (Taken& t, const Audio& input)
{
    const std::int64_t n = frames (t.song);
    const Audio out = t.host.play (input, 0, n, BlockSizes::random (1, 2048, 6));
    t.host.stopAndWait();
    const auto v = t.host.view();
    CHECK (v.session->hasTake);
    CHECK (v.session->takeId == t.takeId);
    CHECK_FALSE (hasNotice (v, "audio-changed"));
    // sigue sonando lo editado (no se cortó a la mitad)
    CHECK (maxDiff (out, 0, t.expected, 0, frames (t.expected)) <= 1e-6);
}

/** Una pasada con [from, to) cambiado; la toma tiene que dejar de valer en ~1 s y volver a tomarse desde ahí. */
void expectRetaken (Taken& t, const Audio& input, std::int64_t from)
{
    const std::int64_t n = frames (t.song);
    const Audio out = t.host.play (input, 0, n, BlockSizes::random (1, 2048, 8));
    t.host.stopAndWait();
    const auto v = t.host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->takeId != t.takeId);
    CHECK (hasNotice (v, "audio-changed"));
    const std::int64_t A = v.session->hostStart;
    // ventanas de 200 ms con señal: 5 seguidas = 1 s (más lo que tarda en completarse la ventana en curso)
    CHECK (A >= from + 48000);
    CHECK (A <= from + 48000 + 2 * 9600 + 2048);
    CHECK (v.session->numSamples == n - A);
    // desde que se volvió a tomar suena el original (y es lo que se tomó)
    CHECK (maxDiff (out, A, input, A, n - A) == 0.0);
    // y lo de antes del cambio sonó editado
    CHECK (maxDiff (out, 0, t.expected, 0, from - 4800) <= 1e-6);
}
} // namespace

TEST_CASE ("cambios del canal: misma entrada, ruido a −90 dB y silencio NO invalidan la toma")
{
    SongSpec spec;
    SUBCASE ("la misma entrada")
    {
        Taken t;
        takeSong (t, spec);
        expectKept (t, t.song);
    }
    SUBCASE ("ruido a −90 dBFS (dither, denormales…)")
    {
        Taken t;
        takeSong (t, spec);
        Audio in = t.song;
        addNoise (in, std::pow (10.0, -90.0 / 20), 42);
        expectKept (t, in);
    }
    SUBCASE ("ganancia de +0,3 dB (automatización mínima)")
    {
        Taken t;
        takeSong (t, spec);
        Audio in = t.song;
        const float g = static_cast<float> (std::pow (10.0, 0.3 / 20));
        for (auto& c : in)
            for (auto& x : c)
                x *= g;
        expectKept (t, in);
    }
    SUBCASE ("silencio donde lo tomado era silencio")
    {
        Taken t;
        SongSpec s2 = spec;
        s2.startSec = 8;   // 8 s de silencio antes
        s2.bars = 12;
        takeSong (t, s2);
        Audio in = t.song;
        addNoise (in, std::pow (10.0, -100.0 / 20), 7, 0, 8 * 48000);
        expectKept (t, in);
    }
    SUBCASE ("canal en silencio (silenciado): no se pierde la toma")
    {
        Taken t;
        takeSong (t, spec);
        const Audio silent (2, std::vector<float> (t.song[0].size(), 0.0f));
        const std::int64_t n = frames (t.song);
        t.host.play (silent, 0, n);
        t.host.stopAndWait();
        const auto v = t.host.view();
        CHECK (v.session->takeId == t.takeId);
        CHECK_FALSE (hasNotice (v, "audio-changed"));
    }
}

TEST_CASE ("cambios del canal: otro audio, +6 dB y −6 dB SÍ invalidan la toma y se vuelve a tomar")
{
    SongSpec spec;
    const std::int64_t from = 5 * kBar, to = 9 * kBar;   // compases 6–9
    SUBCASE ("otro clip en los compases 6–9")
    {
        Taken t;
        takeSong (t, spec);
        SongSpec other = spec;
        other.variant = 1;
        const Audio b = makeSong (other);
        Audio in = t.song;
        for (std::size_t c = 0; c < in.size(); ++c)
            for (std::int64_t i = from; i < to; ++i)
                in[c][static_cast<std::size_t> (i)] = b[c][static_cast<std::size_t> (i)];
        expectRetaken (t, in, from);
    }
    SUBCASE ("+6 dB en los compases 6–9 (fader antes del slot)")
    {
        Taken t;
        takeSong (t, spec);
        Audio in = t.song;
        for (auto& c : in)
            for (std::int64_t i = from; i < to; ++i)
                c[static_cast<std::size_t> (i)] *= 2.0f;
        expectRetaken (t, in, from);
    }
    SUBCASE ("−6 dB desde el compás 6")
    {
        Taken t;
        takeSong (t, spec);
        Audio in = t.song;
        for (auto& c : in)
            for (std::size_t i = static_cast<std::size_t> (from); i < c.size(); ++i)
                c[i] *= 0.5f;
        expectRetaken (t, in, from);
    }
}

TEST_CASE ("cambio de tempo del proyecto: la toma deja de valer")
{
    SongSpec spec;
    spec.bars = 8;
    SUBCASE ("al darle Play con otro tempo")
    {
        Taken t;
        takeSong (t, spec);
        t.host.head.bpm = 125;
        const std::int64_t n = frames (t.song);
        const Audio out = t.host.play (t.song, 0, n, BlockSizes::constant (512));
        t.host.stopAndWait();
        const auto v = t.host.view();
        CHECK (hasNotice (v, "tempo-changed"));
        REQUIRE (v.session->hasTake);
        CHECK (v.session->takeId != t.takeId);
        CHECK (v.session->hostStart <= 3 * 512);   // se vuelve a tomar enseguida
        CHECK (maxDiff (out, 3 * 512, t.song, 3 * 512, n - 3 * 512) == 0.0);
        CHECK (v.session->displayBpm == doctest::Approx (125));
    }
    SUBCASE ("con el transporte parado (se nota antes del Play)")
    {
        Taken t;
        takeSong (t, spec);
        t.host.head.bpm = 130;
        t.host.head.time = 4 * 48000;
        t.host.idle (8);
        REQUIRE (t.host.proc->waitForWorker (30000));
        const auto v = t.host.view();
        CHECK_FALSE (v.session->hasTake);
        CHECK (hasNotice (v, "tempo-changed"));
        CHECK (v.phase == Phase::WaitingForPlay);
    }
    SUBCASE ("cambiar el compás de FL a 7/8 (lo que pide el plugin) NO invalida la toma")
    {
        Taken t;
        takeSong (t, spec);
        t.host.head.num = 7;
        t.host.head.den = 8;
        const std::int64_t n = frames (t.song);
        const Audio out = t.host.play (t.song, 0, n);
        t.host.stopAndWait();
        const auto v = t.host.view();
        CHECK (v.session->takeId == t.takeId);
        CHECK_FALSE (hasNotice (v, "tempo-changed"));
        CHECK (maxDiff (out, 0, t.expected, 0, frames (t.expected)) <= 1e-6);
    }
}

TEST_CASE ("cambio de frecuencia de muestreo: la toma deja de valer")
{
    Taken t;
    SongSpec spec;
    spec.bars = 4;
    takeSong (t, spec);
    t.host.proc->releaseResources();
    t.host.proc->setRateAndBufferSizeDetails (44100, Host::kMaxBlock);
    t.host.proc->prepareToPlay (44100, Host::kMaxBlock);
    REQUIRE (t.host.proc->waitForWorker (30000));
    t.host.idle (2);
    const auto v = t.host.view();
    CHECK_FALSE (v.session->hasTake);
    CHECK (hasNotice (v, "rate-changed"));
    // vuelve a la frecuencia de antes para que el destructor del Host no se queje
    t.host.proc->prepareToPlay (48000, Host::kMaxBlock);
}

TEST_CASE ("«Volver a tomar el audio» borra la toma; el próximo Play toma de nuevo")
{
    Taken t;
    SongSpec spec;
    spec.bars = 6;
    takeSong (t, spec);
    const juce::File wav = t.host.view().session->takeFile;
    CHECK (wav.existsAsFile());
    t.host.proc->clearTake();
    REQUIRE (t.host.proc->waitForWorker (30000));
    t.host.idle (2);
    auto v = t.host.view();
    CHECK_FALSE (v.session->hasTake);
    CHECK (v.phase == Phase::WaitingForPlay);
    CHECK_FALSE (wav.existsAsFile());   // nunca se guardó en un proyecto: se borra
    const std::int64_t n = frames (t.song);
    const Audio out = t.host.play (t.song, 0, n);
    CHECK (maxDiff (out, 0, t.song, 0, n) == 0.0);
    t.host.stopAndWait();
    v = t.host.view();
    CHECK (v.session->hasTake);
    CHECK (v.session->takeId != t.takeId);
}
