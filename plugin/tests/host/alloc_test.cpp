// processBlock no reserva ni libera memoria en ningún caso: tomar, reproducir lo editado, agregar delante/detrás,
// detectar un cambio y volver a tomar, cambio de tempo, escuchar para ubicar un archivo, A/B, bypass, saltos.
// (alloc_tracker.cpp reemplaza operator new/delete y cuenta lo que pasa con el contador armado alrededor de
// processBlock.)
#include "HostSim.h"

using namespace djec_test;

TEST_CASE ("tiempo real: ninguna reserva de memoria dentro de processBlock")
{
    const long long a0 = gAudioAllocs.load(), f0 = gAudioFrees.load();
    constexpr std::int64_t kBar = 96000;
    SongSpec spec;
    spec.bars = 12;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    {
        Host host;
        // toma desde el compás 3 con bloques de 512, de 1 y aleatorios
        host.play (song, 2 * kBar, 2 * kBar, BlockSizes::constant (512));
        host.play (song, 4 * kBar, 48000, BlockSizes::constant (1));
        host.play (song, 4 * kBar + 48000, 3 * kBar, BlockSizes::random (1, 2048, 1));
        host.stopAndWait();
        // delante (prepend) + editado + detrás (append)
        host.play (song, 0, n, BlockSizes::random (1, 2048, 2));
        host.stopAndWait();
        // editado, A/B a mitad, salto hacia atrás (bucle), bypass
        host.play (song, 0, 3 * kBar, BlockSizes::constant (1));
        host.proc->setListenOriginal (true);
        host.play (song, 3 * kBar, kBar);
        host.proc->setListenOriginal (false);
        host.play (song, kBar, 2 * kBar, BlockSizes::random (1, 2048, 3));
        host.bypassed = true;
        host.play (song, 0, kBar);
        host.bypassed = false;
        host.stopAndWait();
        // cambio en el canal (+6 dB) → deja de valer y se vuelve a tomar en la misma pasada
        Audio loud = song;
        for (auto& c : loud)
            for (auto& x : c)
                x *= 2.0f;
        host.play (loud, 0, n, BlockSizes::random (1, 2048, 4));
        host.stopAndWait();
        REQUIRE (hasNotice (host.view(), "audio-changed"));
        // cambio de tempo (parado y sonando)
        host.head.bpm = 126;
        host.head.time = 2 * kBar;
        host.idle (6);
        host.play (loud, 0, 2 * kBar);
        host.stopAndWait();
        host.head.bpm = 120;
        // archivo soltado: escuchar y ubicar
        const juce::File f = testDataDir().getChildFile ("alloc.wav");
        {
            std::vector<const float*> ptrs { song[0].data(), song[1].data() };
            REQUIRE (djec::plugin::wav::write (f, ptrs.data(), 2, n, 48000, djec::plugin::wav::Format::Float32).wasOk());
        }
        REQUIRE (host.proc->loadDroppedFile (f));
        REQUIRE (host.proc->waitForWorker (60000));
        host.sleepMs = 6;
        host.play (song, 0, n, BlockSizes::random (64, 1024, 5), [&] (std::int64_t) { return host.view().session->placed; });
        host.stopAndWait();
        REQUIRE (host.view().session->placed);
        host.play (song, 0, n, BlockSizes::random (1, 2048, 6));
        // «Volver a tomar el audio» a mitad de una pasada
        host.proc->clearTake();
        REQUIRE (host.proc->waitForWorker (60000));
        host.play (song, 0, 3 * kBar);
        host.stopAndWait();
    }
    CHECK (gAudioAllocs.load() - a0 == 0);
    CHECK (gAudioFrees.load() - f0 == 0);

    // el contador funciona (si no, el test de arriba no probaría nada)
    gAudioArmed = true;
    void* p = ::operator new (16);   // llamada explícita: el compilador no la puede quitar
    ::operator delete (p);
    gAudioArmed = false;
    CHECK (gAudioAllocs.load() - a0 == 1);
    CHECK (gAudioFrees.load() - f0 == 1);
    gAudioAllocs -= 1;
    gAudioFrees -= 1;
}
