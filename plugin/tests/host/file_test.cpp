// Archivo soltado («Suelta aquí el archivo»): se ubica solo en la línea de tiempo de FL escuchando el canal
// (USER DECISION v2, B y C).
#include "HostSim.h"

using namespace djec_test;
using djec::plugin::AlignState;
using djec::plugin::Phase;

namespace
{
constexpr std::int64_t kBar = 96000;   // 2 s a 48 kHz
constexpr std::int64_t kBar5 = 4 * kBar;

juce::File writeWav (const Audio& a, double sr, const juce::String& name)
{
    const juce::File f = testDataDir().getChildFile (name);
    std::vector<const float*> ptrs;
    for (const auto& c : a)
        ptrs.push_back (c.data());
    REQUIRE (djec::plugin::wav::write (f, ptrs.data(), static_cast<int> (ptrs.size()), frames (a), sr,
                                       djec::plugin::wav::Format::Float32)
                 .wasOk());
    return f;
}

/** La pista del host: silencio y `song` desde la muestra `at`. */
Audio placeAt (const Audio& song, std::int64_t at, std::int64_t tail = 0)
{
    Audio a (song.size(), std::vector<float> (static_cast<std::size_t> (at + frames (song) + tail), 0.0f));
    for (std::size_t c = 0; c < song.size(); ++c)
        std::copy (song[c].begin(), song[c].end(), a[c].begin() + at);
    return a;
}

/** Suelta el archivo y le da Play desde el principio hasta que lo ubica (o se acaba la pista). */
void dropAndPlay (Host& host, const juce::File& f, const Audio& track, std::int64_t* placedAtHost = nullptr)
{
    REQUIRE (host.proc->loadDroppedFile (f));
    REQUIRE (host.proc->waitForWorker (60000));
    host.idle (2);
    auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->source == djec::plugin::TakeSource::File);
    CHECK_FALSE (v.session->placed);
    CHECK (v.session->align == AlignState::WaitingForPlay);
    CHECK (v.phase == Phase::WaitingForFilePlay);
    CHECK (v.session->peaks != nullptr);

    host.sleepMs = 6;
    std::int64_t at = -1;
    const Audio out = host.play (track, 0, frames (track), BlockSizes::random (64, 1024, 31), [&] (std::int64_t h) {
        if (at < 0 && host.view().session->placed)
            at = h;
        return false;
    });
    // mientras busca y el resto de esa pasada: suena el original (nunca cambia a mitad de una pasada)
    CHECK (maxDiff (out, 0, track, 0, frames (track)) == 0.0);
    host.stopAndWait();
    if (placedAtHost != nullptr)
        *placedAtHost = at;
}
} // namespace

TEST_CASE ("archivo idéntico al audio del canal que empieza en el compás 5: se ubica a la muestra")
{
    Host host;
    SongSpec spec;   // 16 compases
    const Audio song = makeSong (spec);
    const juce::File f = writeWav (song, 48000, "cancion.wav");
    const Audio track = placeAt (song, kBar5);

    std::int64_t foundAt = -1;
    dropAndPlay (host, f, track, &foundAt);
    const auto v = host.view();
    REQUIRE (v.session->placed);
    CHECK (v.session->hostStart == kBar5);
    CHECK (v.session->align == AlignState::Found);
    CHECK (v.session->fileStartBar == 5);
    CHECK (v.session->alignConfidence > 0.99);
    CHECK (hasNotice (v, "file-found"));
    bool text = false;
    for (const auto& n : v.session->notices)
        text = text || n.text.startsWith (juce::String::fromUTF8 ("Ubicado: el archivo empieza en el compás 5."));
    CHECK (text);
    // cuándo lo ve el test depende de lo rápido que el worker siga al audio (aquí va mucho más rápido que el
    // tiempo real): se informa, y solo se exige que haya sido en la misma pasada
    MESSAGE ("ubicado tras " << (static_cast<double> (foundAt - kBar5) / 48000.0) << " s de canción");
    CHECK (foundAt > kBar5);

    // Play otra vez: desde el compás 5 suena el archivo editado, alineado
    const Audio expected = expectedHostEdit (song, 48000, kBar5, 120, 4, 4, djec::EditSettings {});
    const Audio out = host.play (track, 0, frames (track), BlockSizes::random (1, 2048, 32));
    CHECK (maxAbs (out, 0, kBar5) == 0.0);
    CHECK (maxDiff (out, kBar5, expected, 0, frames (expected)) <= 1e-6);
    CHECK (maxAbs (out, kBar5 + frames (expected), frames (song) - frames (expected)) == 0.0);
    host.stopAndWait();
    CHECK (host.view().session->takeId == v.session->takeId);   // no se invalidó

    // el estado guarda el archivo por ruta y su ubicación
    juce::MemoryBlock state;
    host.proc->getStateInformation (state);
    Host b;
    b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
    REQUIRE (b.proc->waitForWorker (60000));
    b.idle (2);
    const auto vb = b.view();
    REQUIRE (vb.session->placed);
    CHECK (vb.session->hostStart == kBar5);
    const Audio outB = b.play (track, 0, frames (track));
    CHECK (maxDiff (outB, 0, out, 0, frames (track)) == 0.0);
}

TEST_CASE ("archivo con el canal a −6 dB y con EQ: se ubica igual y no se toma por un cambio")
{
    SongSpec spec;
    const Audio song = makeSong (spec);
    const juce::File f = writeWav (song, 48000, "cancion-6db.wav");
    SUBCASE ("−6 dB")
    {
        Host host;
        Audio quiet = song;
        for (auto& c : quiet)
            for (auto& x : c)
                x *= 0.5f;
        const Audio track = placeAt (quiet, kBar5);
        dropAndPlay (host, f, track);
        auto v = host.view();
        REQUIRE (v.session->placed);
        CHECK (v.session->hostStart == kBar5);
        // el plugin suena con el archivo (a su nivel) y la correlación no ve un cambio
        const Audio expected = expectedHostEdit (song, 48000, kBar5, 120, 4, 4, djec::EditSettings {});
        const Audio out = host.play (track, 0, frames (track));
        CHECK (maxDiff (out, kBar5, expected, 0, frames (expected)) <= 1e-6);
        host.stopAndWait();
        v = host.view();
        CHECK (v.session->source == djec::plugin::TakeSource::File);
        CHECK_FALSE (hasNotice (v, "audio-changed"));
    }
    SUBCASE ("EQ (paso bajo de un polo) y −3 dB")
    {
        Host host;
        Audio eq = song;
        for (auto& c : eq)
        {
            double y = 0;
            for (auto& x : c)
            {
                y = 0.55 * x + 0.45 * y;
                x = static_cast<float> (0.7 * y);
            }
        }
        const Audio track = placeAt (eq, kBar5);
        dropAndPlay (host, f, track);
        const auto v = host.view();
        REQUIRE (v.session->placed);
        MESSAGE ("EQ: ubicado en " << v.session->hostStart << " (exacto: " << kBar5 << "), confianza "
                                   << v.session->alignConfidence);
        CHECK (std::llabs (v.session->hostStart - kBar5) <= 16);
        const Audio out = host.play (track, 0, frames (track));
        host.stopAndWait();
        CHECK_FALSE (hasNotice (host.view(), "audio-changed"));
        juce::ignoreUnused (out);
    }
}

TEST_CASE ("archivo equivocado: no se ubica, se avisa y «El archivo empieza en el compás 1» funciona")
{
    Host host;
    SongSpec spec;
    const Audio song = makeSong (spec);
    SongSpec otherSpec = spec;
    otherSpec.variant = 1;
    otherSpec.bpm = 132;
    const Audio other = makeSong (otherSpec);
    const juce::File f = writeWav (other, 48000, "otra.wav");
    const Audio track = placeAt (song, 0);

    REQUIRE (host.proc->loadDroppedFile (f));
    REQUIRE (host.proc->waitForWorker (60000));
    host.sleepMs = 6;
    CHECK (host.view().session->canUseBarOneFallback);
    const Audio out = host.play (track, 0, 14 * 48000, BlockSizes::constant (512), [&] (std::int64_t) { return false; });
    host.stopAndWait();
    auto v = host.view();
    CHECK (v.phase == Phase::FileNotFound);
    CHECK (v.statusText == juce::String::fromUTF8 ("No encuentro este audio en el canal. ¿Pusiste el plugin en el canal correcto?"));
    CHECK_FALSE (v.session->placed);
    CHECK (v.session->align == AlignState::NotFound);
    CHECK (hasNotice (v, "file-not-found"));
    CHECK (v.session->canUseBarOneFallback);
    CHECK (maxDiff (out, 0, track, 0, frames (out)) == 0.0);

    host.proc->fileStartsAtBarOne();
    REQUIRE (host.proc->waitForWorker (60000));
    host.idle (2);
    v = host.view();
    REQUIRE (v.session->placed);
    CHECK (v.session->hostStart == 0);
    CHECK (v.session->align == AlignState::Manual);
    CHECK (v.session->fileStartBar == 1);
    // suena el archivo editado desde el compás 1 (y no se toma el canal por "cambio": lo dijo el usuario)
    const Audio expected = expectedHostEdit (other, 48000, 0, 120, 4, 4, djec::EditSettings {});
    const Audio out2 = host.play (track, 0, frames (track));
    CHECK (maxDiff (out2, 0, expected, 0, std::min (frames (expected), frames (track))) <= 1e-6);
    host.stopAndWait();
    v = host.view();
    CHECK (v.session->source == djec::plugin::TakeSource::File);
    CHECK_FALSE (hasNotice (v, "audio-changed"));
}

TEST_CASE ("archivo a 44,1 kHz en un proyecto a 48 kHz: se remuestrea y se ubica")
{
    Host host;
    SongSpec s44;
    s44.sr = 44100;
    const Audio song44 = makeSong (s44);
    const juce::File f = writeWav (song44, 44100, "cancion-44k.wav");
    // lo que suena en el canal: la misma canción remuestreada por FL (aquí, con otro filtro que el del plugin)
    Audio song48;
    for (const auto& c : song44)
        song48.push_back (djec::resample (c.data(), c.size(), 44100, 48000));
    const Audio track = placeAt (song48, kBar5);
    dropAndPlay (host, f, track);
    const auto v = host.view();
    REQUIRE (v.session->placed);
    CHECK (v.session->sampleRate == 48000);
    CHECK (std::llabs (v.session->numSamples - frames (song48)) <= 1);
    MESSAGE ("44,1 → 48 kHz: ubicado en " << v.session->hostStart << " (exacto: " << kBar5 << "), confianza "
                                          << v.session->alignConfidence);
    CHECK (std::llabs (v.session->hostStart - kBar5) <= 2);
    CHECK (v.session->fileStartBar == 5);
}

TEST_CASE ("archivo que no se puede leer: aviso y sigue la toma anterior")
{
    Host host;
    const juce::File bad = testDataDir().getChildFile ("roto.wav");
    bad.replaceWithText ("esto no es audio");
    const juce::File m4a = testDataDir().getChildFile ("cancion.m4a");
    m4a.replaceWithText ("tampoco");
    CHECK (DjecAudioProcessor::isSupportedAudioFile (bad));
    CHECK (DjecAudioProcessor::isSupportedAudioFile (m4a));
    CHECK_FALSE (DjecAudioProcessor::isSupportedAudioFile (testDataDir().getChildFile ("foto.jpg")));
    CHECK (DjecAudioProcessor::supportedAudioExtensions().contains ("mp3"));
    CHECK (DjecAudioProcessor::supportedAudioExtensions().contains ("flac"));

    SongSpec spec;
    spec.bars = 4;
    const Audio song = makeSong (spec);
    host.play (song, 0, frames (song));
    host.stopAndWait();
    const auto id = host.view().session->takeId;

    REQUIRE (host.proc->loadDroppedFile (bad));
    REQUIRE (host.proc->waitForWorker (30000));
    auto v = host.view();
    CHECK (hasNotice (v, "file-error"));
    CHECK (v.session->takeId == id);
    CHECK (v.session->source == djec::plugin::TakeSource::Playback);

    REQUIRE (host.proc->loadDroppedFile (m4a));
    REQUIRE (host.proc->waitForWorker (30000));
    v = host.view();
    bool m4aText = false;
    for (const auto& n : v.session->notices)
        m4aText = m4aText || n.text.startsWith ("No puedo leer archivos M4A/AAC");
    CHECK (m4aText);
}
