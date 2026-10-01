// Hilos de fondo en reposo: el repositorio de trozos (PoolFeeder) se despierta cada ~25 ms (antes, cada 4 ms en cada
// instancia) y el worker, con el transporte parado, cada ~25 ms; aun así los trozos que gasta el audio se reponen
// enseguida (el worker avisa al repositorio). El hilo de audio nunca espera ni reserva (alloc_test.cpp, y el test de
// «sin trozos libres» de state_test.cpp).
#include "HostSim.h"

using namespace djec_test;

TEST_CASE ("reposo: el repositorio de trozos y el worker se despiertan poco y los trozos se reponen enseguida")
{
    Host host;
    REQUIRE (host.proc->waitForWorker (30000));
    juce::Thread::sleep (1300);   // el worker sigue mirando seguido 1 s después de la última actividad
    djec::plugin::PoolFeeder& pool = host.proc->getHub().pool;
    const long long p0 = pool.wakeups(), all0 = host.proc->backgroundWakeups();
    const auto t0 = std::chrono::steady_clock::now();
    juce::Thread::sleep (1000);
    const double sec = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
    const long long poolWakes = pool.wakeups() - p0;
    const long long workerWakes = host.proc->backgroundWakeups() - all0 - poolWakes;
    MESSAGE ("en reposo, en " << sec << " s: repositorio " << poolWakes << " veces, worker " << workerWakes << " veces");
    CHECK (static_cast<double> (poolWakes) <= 60 * sec);     // cada 25 ms ≈ 40 por segundo (antes cada 4 ms ≈ 250)
    CHECK (static_cast<double> (workerWakes) <= 60 * sec);   // cada 25 ms con el transporte parado (antes cada 5 ms ≈ 200)

    // el audio se lleva todos los trozos libres (aquí los saca el test, sin audio corriendo): se reponen enseguida
    auto& q = pool.freeQueue();
    const std::size_t target = pool.target();
    REQUIRE (target > 0);
    std::vector<djec::plugin::Chunk*> taken;
    djec::plugin::Chunk* c = nullptr;
    while (q.pop (c))
        taken.push_back (c);
    CHECK (taken.size() >= target);
    const auto t1 = std::chrono::steady_clock::now();
    while (q.sizeApprox() < target && std::chrono::steady_clock::now() - t1 < std::chrono::seconds (2))
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    const double ms = std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now() - t1).count();
    MESSAGE ("repuso " << target << " trozos en " << ms << " ms");
    CHECK (q.sizeApprox() >= target);
    CHECK (ms < 500);
    for (auto* x : taken)
        pool.recycle (x);   // vuelven al repositorio (sobran: los libera)
    pool.wake();

    // y una toma de verdad sigue funcionando con el margen por defecto
    SongSpec spec;
    spec.bars = 4;
    const Audio song = makeSong (spec);
    host.play (song, 0, frames (song), BlockSizes::constant (512));
    host.stopAndWait();
    CHECK (host.view().session->numSamples == frames (song));
}
