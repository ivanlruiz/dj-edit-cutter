// Render offline (exportar en FL), estado guardado en el proyecto, exportar WAV y archivo para arrastrar a FL.
#include "HostSim.h"

#include "Paths.h"

using namespace djec_test;
using djec::plugin::Phase;

namespace
{
constexpr std::int64_t kBar = 96000;

void setTrackName (DjecAudioProcessor& p, const juce::String& name)
{
    juce::AudioProcessor::TrackProperties props;
    props.name = name;
    p.updateTrackProperties (props);
}
} // namespace

TEST_CASE ("render offline (isNonRealtime): toma y reproducción a toda velocidad, sin quedarse sin memoria")
{
    Host host (48000, 2, /*poolSeconds*/ 1);   // margen mínimo: en offline se reserva lo que haga falta
    host.proc->setNonRealtime (true);
    SongSpec spec;
    spec.bars = 20;   // 40 s
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    host.play (song, 0, n, BlockSizes::constant (4096));
    host.stopAndWait();
    const auto v = host.view();
    REQUIRE (v.session->hasTake);
    CHECK (v.session->numSamples == n);
    CHECK_FALSE (hasNotice (v, "take-memory"));
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});
    const Audio out = host.play (song, 0, n, BlockSizes::constant (4096));
    CHECK (maxDiff (out, 0, expected, 0, frames (expected)) <= 1e-6);
    CHECK (maxAbs (out, frames (expected), n - frames (expected)) == 0.0);
    host.proc->setNonRealtime (false);
}

TEST_CASE ("tiempo real sin trozos libres: se corta la toma y se avisa, nunca se reserva memoria")
{
    Host host (48000, 2, /*poolSeconds*/ 1);
    SongSpec spec;
    spec.bars = 20;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    const long long before = gAudioAllocs.load();
    host.play (song, 0, n, BlockSizes::constant (4096));   // mucho más rápido que el tiempo real
    CHECK (gAudioAllocs.load() == before);
    host.stopAndWait();
    const auto v = host.view();
    REQUIRE (v.session->hasTake);
    if (v.session->numSamples < n)
        CHECK (hasNotice (v, "take-memory"));
    MESSAGE ("toma en tiempo real con 1 s de margen y sin pausas: " << v.session->numSamples << " de " << n << " muestras");
}

TEST_CASE ("estado: guardar → instancia nueva → cargar → suena igual")
{
    SongSpec spec;
    spec.bars = 12;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    djec::EditSettings settings;
    settings.amount = "beat";   // 1 tiempo → 3/4
    settings.removeEnd = true;
    settings.barsToRemove = 2;
    settings.fadeBeats = 2;
    settings.curve = "exp";
    settings.crossfadeSec = 0.02;

    juce::MemoryBlock state;
    Audio outA;
    juce::File wav;
    {
        Host a;
        setTrackName (*a.proc, "Guitarra");
        a.play (song, 0, n);
        a.stopAndWait();
        a.proc->setEditSettings (settings);
        a.proc->setBarOffset (0);
        REQUIRE (a.proc->waitForWorker (30000));
        a.idle (2);
        const auto v = a.view();
        REQUIRE (v.session->hasRender);
        CHECK (v.session->plan.useCut);
        CHECK (v.session->plan.barsRemoved == 2);
        CHECK (v.session->meterHint == juce::String::fromUTF8 ("Pon el compás del proyecto de FL en 3/4"));
        CHECK (a.proc->suggestedFileName() == juce::String::fromUTF8 ("Guitarra (3-4, edit -2 compases).wav"));
        outA = a.play (song, 0, n);
        a.idle();
        a.proc->getStateInformation (state);
        wav = v.session->takeFile;
        // después de guardarse en un proyecto, borrar la toma no borra su WAV
        a.proc->clearTake();
        REQUIRE (a.proc->waitForWorker (30000));
        CHECK (wav.existsAsFile());
    }
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, settings);
    CHECK (maxDiff (outA, 0, expected, 0, frames (expected)) <= 1e-6);

    SUBCASE ("cargando después de prepareToPlay")
    {
        Host b;
        b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        REQUIRE (b.proc->waitForWorker (30000));
        b.idle (2);
        const auto v = b.view();
        REQUIRE (v.session->hasTake);
        CHECK (v.session->hostStart == 0);
        CHECK (v.session->numSamples == n);
        CHECK (v.session->settings.amount == "beat");
        CHECK (v.session->settings.barsToRemove == 2);
        CHECK (b.proc->getEditSettings().curve == "exp");
        CHECK (v.phase == Phase::Ready);
        const Audio outB = b.play (song, 0, n, BlockSizes::random (1, 2048, 77));
        CHECK (maxDiff (outB, 0, outA, 0, n) == 0.0);
    }
    SUBCASE ("cargando antes de prepareToPlay (como al abrir un proyecto)")
    {
        Host b (48000, 2, 120, /*prepareNow*/ false);
        b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        REQUIRE (b.proc->waitForWorker (30000));
        CHECK_FALSE (b.view().session->hasTake);   // todavía no conoce la frecuencia del host
        b.prepare();
        REQUIRE (b.proc->waitForWorker (30000));
        b.idle (2);
        REQUIRE (b.view().session->hasTake);
        const Audio outB = b.play (song, 0, n);
        CHECK (maxDiff (outB, 0, outA, 0, n) == 0.0);
    }
    SUBCASE ("si falta el WAV de la toma: se avisa y se vuelve a tomar")
    {
        REQUIRE (wav.deleteFile());
        Host b;
        b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        REQUIRE (b.proc->waitForWorker (30000));
        b.idle (2);
        const auto v = b.view();
        CHECK_FALSE (v.session->hasTake);
        CHECK (hasNotice (v, "take-missing"));
        CHECK (v.session->settings.amount == "beat");   // los ajustes sí se cargan
        const Audio out = b.play (song, 0, n);
        CHECK (maxDiff (out, 0, song, 0, n) == 0.0);    // se toma de nuevo
        b.stopAndWait();
        CHECK (b.view().session->hasTake);
    }
    SUBCASE ("con otra frecuencia de muestreo: se vuelve a tomar")
    {
        Host b (44100);
        b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
        REQUIRE (b.proc->waitForWorker (30000));
        const auto v = b.view();
        CHECK_FALSE (v.session->hasTake);
        CHECK (hasNotice (v, "take-missing"));
    }
}

TEST_CASE ("estado sin toma y estado basura")
{
    Host a;
    juce::MemoryBlock state;
    a.proc->getStateInformation (state);
    Host b;
    b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
    const char junk[] = "esto no es un estado";
    b.proc->setStateInformation (junk, static_cast<int> (sizeof (junk)));
    REQUIRE (b.proc->waitForWorker (30000));
    CHECK_FALSE (b.view().session->hasTake);
}

TEST_CASE ("exportar WAV 16/24 bits y archivo para arrastrar a FL")
{
    Host host;
    SongSpec spec;
    spec.bars = 8;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);

    // sin nada editado todavía
    juce::String err;
    CHECK (host.proc->writeDragFile (&err) == juce::File());
    CHECK (err.isNotEmpty());
    CHECK (host.proc->exportWav (testDataDir().getChildFile ("x.wav"), 16).failed());

    host.play (song, 0, n);
    host.stopAndWait();
    const Audio expected = expectedHostEdit (song, 48000, 0, 120, 4, 4, djec::EditSettings {});

    const juce::File f24 = testDataDir().getChildFile ("exportado 24.wav");
    REQUIRE (host.proc->exportWav (f24, 24).wasOk());
    djec::plugin::wav::Audio r24;
    REQUIRE (djec::plugin::wav::read (f24, r24).wasOk());
    CHECK (r24.sampleRate == 48000);
    REQUIRE (r24.frames() == frames (expected));
    CHECK (maxDiff (r24.channels, 0, expected, 0, frames (expected)) <= 0.6 / 8388608.0);

    const juce::File f16 = testDataDir().getChildFile ("exportado 16.wav");
    REQUIRE (host.proc->exportWav (f16, 16).wasOk());
    djec::plugin::wav::Audio r16;
    REQUIRE (djec::plugin::wav::read (f16, r16).wasOk());
    REQUIRE (r16.frames() == frames (expected));
    CHECK (maxDiff (r16.channels, 0, expected, 0, frames (expected)) <= 1.6 / 32768.0);   // dither TPDF ±1 LSB
    CHECK (host.proc->exportWav (f16, 20).failed());

    // arrastrar a FL: Documentos/DJ Edit Cutter/<nombre>.wav; el mismo render → el mismo archivo
    const juce::File drag = host.proc->writeDragFile (&err);
    REQUIRE (drag.existsAsFile());
    CHECK (drag.getParentDirectory() == djec::plugin::paths::exportsDir());
    CHECK (drag.getFileName() == "Toma (7-8).wav");
    CHECK (host.proc->writeDragFile() == drag);

    // otro render con el mismo nombre: archivo nuevo (no se pisa lo que FL ya pueda estar usando)
    djec::EditSettings s;
    s.crossfadeSec = 0.03;
    host.proc->setEditSettings (s);
    REQUIRE (host.proc->waitForWorker (30000));
    const juce::File drag2 = host.proc->writeDragFile();
    REQUIRE (drag2.existsAsFile());
    CHECK (drag2 != drag);
    CHECK (drag.existsAsFile());

    // exportar en segundo plano (onDone va al hilo de mensajes, que aquí no se despacha: se mira el archivo)
    const juce::File fa = testDataDir().getChildFile ("async.wav");
    host.proc->exportWavAsync (fa, 24, {});
    for (int i = 0; i < 500 && ! (fa.existsAsFile() && fa.getSize() > 0); ++i)
        juce::Thread::sleep (10);
    juce::Thread::sleep (50);
    djec::plugin::wav::Audio ra;
    REQUIRE (djec::plugin::wav::read (fa, ra).wasOk());
    CHECK (ra.frames() > 0);
}
