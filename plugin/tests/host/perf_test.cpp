// Rendimiento (informativo): coste de processBlock al tomar y al reproducir lo editado, y cuánto tarda el worker en
// tener lista una toma de 5 minutos. Los límites solo se comprueban en builds optimizados y son muy holgados.
#include "HostSim.h"

using namespace djec_test;

TEST_CASE ("rendimiento: toma de 5 minutos (bloques de 512 a 48 kHz)")
{
    Host host;
    SongSpec spec;
    spec.bars = 150;   // 300 s
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);

    host.resetTiming();
    host.play (song, 0, n, BlockSizes::constant (512));
    const double takeAvg = host.blockMicros / static_cast<double> (host.blockCount);
    const double takeMax = host.maxBlockMicros;

    const auto t0 = std::chrono::steady_clock::now();
    host.idle (4);
    for (int i = 0; i < 6000 && ! host.view().session->hasRender; ++i)
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    const double readyMs = std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now() - t0).count();
    REQUIRE (host.view().session->hasRender);
    host.stopAndWait();   // (también espera a que se escriba el WAV de la toma)
    const double savedMs = std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now() - t0).count();

    host.resetTiming();
    host.play (song, 0, n, BlockSizes::constant (512));
    const double playAvg = host.blockMicros / static_cast<double> (host.blockCount);
    const double playMax = host.maxBlockMicros;

    MESSAGE ("processBlock (512 muestras = 10,7 ms de audio): tomando media " << takeAvg << " µs, máx " << takeMax
             << " µs; editado + detección de cambios media " << playAvg << " µs, máx " << playMax << " µs");
    MESSAGE ("toma de 5 min: render listo " << readyMs << " ms después de parar; WAV guardado a los " << savedMs << " ms");
    // de eso, los límites de la música para la cuadrícula de FL (analyzeBounds: lo que la web usa para el golpe final)
    const auto tb = std::chrono::steady_clock::now();
    const djec::MusicBoundsResult b = takeBounds (song, 48000);
    const double boundsMs = std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now() - tb).count();
    MESSAGE ("límites de la música de 5 min (analyzeBounds): " << boundsMs << " ms (musicEnd " << b.musicEnd << " s)");
    CHECK (b.musicEnd == doctest::Approx (300.0).epsilon (0.001));
#if defined(NDEBUG)
    CHECK (takeAvg < 200);
    CHECK (playAvg < 200);
    CHECK (readyMs < 20000);
#endif
}
