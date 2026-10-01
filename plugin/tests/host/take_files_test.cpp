// WAV de las tomas: carpeta (en Windows la LOCAL, %LOCALAPPDATA%), lectura y migración de las rutas de antes
// (%APPDATA%), y la limpieza: la carpeta no pasa de 3 GB (se borran las tomas más viejas) y se borran las que llevan
// más de 60 días sin usarse; nunca un archivo en uso. Todo en carpetas temporales (main.cpp redirige las del plugin).
#include "HostSim.h"

#include "Paths.h"
#include "TakeFiles.h"

using namespace djec_test;
namespace takefiles = djec::plugin::takefiles;
namespace paths = djec::plugin::paths;

namespace
{
juce::File makeFile (const juce::File& dir, const juce::String& name, int bytes, double daysAgo,
                     juce::Time now = juce::Time::getCurrentTime())
{
    REQUIRE (dir.createDirectory().wasOk());
    const juce::File f = dir.getChildFile (name);
    juce::MemoryBlock mb (static_cast<std::size_t> (bytes), true);
    REQUIRE (f.replaceWithData (mb.getData(), mb.getSize()));
    REQUIRE (f.setLastModificationTime (now - juce::RelativeTime::days (daysAgo)));
    return f;
}

juce::String takeName() { return juce::Uuid().toDashedString() + ".wav"; }

/** Estado del procesador → XML (para cambiar la ruta de la toma como la guardaba una versión anterior). */
std::unique_ptr<juce::XmlElement> stateXml (const juce::MemoryBlock& state)
{
    return juce::AudioProcessor::getXmlFromBinary (state.getData(), static_cast<int> (state.getSize()));
}
} // namespace

TEST_CASE ("tomas: carpetas (LOCAL en Windows) y nombres")
{
    CHECK (paths::takesDir() == testDataDir().getChildFile ("Tomas"));
    CHECK (paths::legacyTakesDir() == testDataDir().getChildFile ("Tomas (antes)"));
#if JUCE_WINDOWS
    CHECK (paths::defaultTakesDir()
           == juce::File::getSpecialLocation (juce::File::windowsLocalAppData).getChildFile ("DJ Edit Cutter").getChildFile ("Tomas"));
#else
    CHECK (paths::defaultTakesDir()
           == juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("DJ Edit Cutter").getChildFile ("Tomas"));
#endif
    CHECK (takefiles::isTakeFileName (takeName()));
    CHECK (takefiles::isTakeFileName ("0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0.WAV"));
    CHECK_FALSE (takefiles::isTakeFileName ("cancion.wav"));
    CHECK_FALSE (takefiles::isTakeFileName ("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.mp3"));
    CHECK_FALSE (takefiles::isTakeFileName ("0f1e2d3c_4b5a-6978-8796-a5b4c3d2e1f0.wav"));
}

TEST_CASE ("tomas: limpieza en una carpeta temporal (máximo de tamaño, 60 días, nunca en uso)")
{
    const juce::File dir = testDataDir().getChildFile ("limpieza");
    const juce::Time now = juce::Time::getCurrentTime();
    const int kb = 100 * 1024;
    const juce::File a = makeFile (dir, takeName(), kb, 90, now);     // viejísima → se borra
    const juce::File b = makeFile (dir, takeName(), kb, 61, now);     // vieja pero en uso → se queda
    const juce::File c = makeFile (dir, takeName(), kb, 10, now);
    const juce::File d = makeFile (dir, takeName(), kb, 5, now);
    const juce::File e = makeFile (dir, takeName(), kb, 2, now);
    const juce::File f = makeFile (dir, takeName(), kb, 1, now);
    const juce::File g = makeFile (dir, takeName(), kb, 1.0 / 24 / 60, now);   // hace 1 minuto: otro proceso la usa
    const juce::File k = makeFile (dir, takeName(), kb, 20, now);     // la de quien limpia
    const juce::File notas = makeFile (dir, "notas.txt", kb, 400, now);
    const juce::File mia = makeFile (dir, "mi cancion.wav", kb, 400, now);
    takefiles::acquire (b);
    CHECK (takefiles::isInUse (b));

    takefiles::Policy p;
    p.maxBytes = 350 * 1024;
    const takefiles::Result r = takefiles::cleanup (dir, p, now, k);
    CHECK (r.scanned == 8);
    CHECK (r.bytesBefore == 8 * kb);
    // 60 días: a (b está en uso). Tamaño: de las que quedan (700 KB) se van las más viejas que se pueden borrar
    // (c, d, e, f; k es la de quien limpia y g se usó hace un minuto) hasta bajar de 350 KB.
    CHECK_FALSE (a.exists());
    CHECK (b.exists());
    CHECK_FALSE (c.exists());
    CHECK_FALSE (d.exists());
    CHECK_FALSE (e.exists());
    CHECK_FALSE (f.exists());
    CHECK (g.exists());
    CHECK (k.exists());
    CHECK (notas.exists());   // solo se tocan archivos con nombre de toma
    CHECK (mia.exists());
    CHECK (r.deleted == 5);
    CHECK (r.bytesAfter == 3 * kb);

    // al dejar de usarse, la vieja se borra en la próxima limpieza
    takefiles::release (b);
    CHECK_FALSE (takefiles::isInUse (b));
    const takefiles::Result r2 = takefiles::cleanup (dir, p, now);
    CHECK_FALSE (b.exists());
    CHECK (r2.deleted == 1);
    CHECK (g.exists());
    CHECK (k.exists());   // 20 días y la carpeta ya no pasa del máximo

    // el registro cuenta: dos instancias con el mismo archivo
    takefiles::acquire (k);
    takefiles::acquire (k);
    takefiles::release (k);
    CHECK (takefiles::isInUse (k));
    takefiles::release (k);
    CHECK_FALSE (takefiles::isInUse (k));
    dir.deleteRecursively();
}

TEST_CASE ("tomas: después de cada toma nueva se borran las viejas, nunca las que están en uso")
{
    const juce::File dir = paths::takesDir();
    const juce::File old1 = makeFile (dir, takeName(), 4096, 61);
    const juce::File old2 = makeFile (dir, takeName(), 4096, 200);
    const juce::File recent = makeFile (dir, takeName(), 4096, 3);

    SongSpec spec;
    spec.bars = 4;
    const Audio song = makeSong (spec);

    // otra instancia (otro canal del Mixer) con su toma: en uso aunque sea la más vieja
    Host other;
    other.play (song, 0, frames (song));
    other.stopAndWait();
    const juce::File otherWav = other.view().session->takeFile;
    REQUIRE (otherWav.existsAsFile());
    REQUIRE (otherWav.getParentDirectory() == dir);
    REQUIRE (otherWav.setLastModificationTime (juce::Time::getCurrentTime() - juce::RelativeTime::days (100)));
    CHECK_FALSE (old1.exists());   // la toma de `other` ya limpió las de más de 60 días
    CHECK_FALSE (old2.exists());
    CHECK (recent.exists());

    Host host;
    takefiles::Policy p;
    p.maxBytes = 1;   // todo lo que se pueda borrar sobra
    host.proc->setTakeCleanupPolicy (p);
    host.play (song, 0, frames (song));
    host.stopAndWait();
    const juce::File mine = host.view().session->takeFile;
    REQUIRE (mine.existsAsFile());
    CHECK (otherWav.existsAsFile());   // en uso por la otra instancia (aunque tenga 100 días)
    CHECK_FALSE (recent.exists());     // la carpeta pasaba del máximo: se borró la más vieja que se podía borrar

    // la otra instancia se cierra sin guardar el proyecto: su WAV deja de estar en uso y la próxima limpieza lo borra
    other.proc.reset();
    host.proc->clearTake();
    REQUIRE (host.proc->waitForWorker (30000));
    host.play (song, 0, frames (song));
    host.stopAndWait();
    CHECK_FALSE (otherWav.existsAsFile());
    CHECK (host.view().session->takeFile.existsAsFile());
}

TEST_CASE ("tomas: limpieza al arrancar (cuando FL ya abrió el proyecto)")
{
    const juce::File dir = paths::takesDir();
    const juce::File old = makeFile (dir, takeName(), 4096, 75);
    {
        // por defecto espera (al abrir un proyecto viejo, sus instancias todavía no cargaron sus tomas)
        Host host;
        REQUIRE (host.proc->waitForWorker (30000));
        juce::Thread::sleep (100);
        CHECK (old.exists());
        takefiles::Policy p;
        p.startupDelayMs = 0;
        host.proc->setTakeCleanupPolicy (p);
        for (int i = 0; i < 200 && old.exists(); ++i)
            juce::Thread::sleep (10);
        CHECK_FALSE (old.exists());
    }
}

TEST_CASE ("tomas: una toma de 70 días que se abre en un proyecto no se borra (se marca como usada)")
{
    SongSpec spec;
    spec.bars = 4;
    const Audio song = makeSong (spec);
    juce::MemoryBlock state;
    juce::File wav;
    {
        Host a;
        a.play (song, 0, frames (song));
        a.stopAndWait();
        a.proc->getStateInformation (state);
        wav = a.view().session->takeFile;
    }
    REQUIRE (wav.setLastModificationTime (juce::Time::getCurrentTime() - juce::RelativeTime::days (70)));
    // como al abrir un proyecto: el estado llega antes que prepareToPlay; la limpieza de arranque (aquí sin espera)
    // corre mientras la toma todavía no se cargó
    Host b (48000, 2, 120, /*prepareNow*/ false);
    b.proc->setStateInformation (state.getData(), static_cast<int> (state.getSize()));
    takefiles::Policy p;
    p.startupDelayMs = 0;
    b.proc->setTakeCleanupPolicy (p);
    juce::Thread::sleep (150);
    CHECK (wav.existsAsFile());  // en uso desde setStateInformation
    b.prepare();
    REQUIRE (b.proc->waitForWorker (30000));
    REQUIRE (b.view().session->hasTake);
    CHECK (wav.existsAsFile());
    CHECK (wav.getLastModificationTime() > juce::Time::getCurrentTime() - juce::RelativeTime::hours (1));
}

TEST_CASE ("tomas: un proyecto guardado con la carpeta de antes (%APPDATA%) se sigue leyendo y la toma se migra")
{
    SongSpec spec;
    spec.bars = 6;
    const Audio song = makeSong (spec);
    const std::int64_t n = frames (song);
    juce::MemoryBlock state;
    Audio outA;
    juce::File wav;
    {
        Host a;
        a.play (song, 0, n);
        a.stopAndWait();
        outA = a.play (song, 0, n);
        a.idle();
        a.proc->getStateInformation (state);
        wav = a.view().session->takeFile;
    }
    // como lo habría guardado una versión anterior: el WAV en la carpeta de antes y esa ruta en el estado
    const juce::File legacy = paths::legacyTakesDir();
    REQUIRE (legacy.createDirectory().wasOk());
    const juce::File legacyWav = legacy.getChildFile (wav.getFileName());
    REQUIRE (wav.moveFileTo (legacyWav));
    auto xml = stateXml (state);
    REQUIRE (xml != nullptr);
    auto* take = xml->getChildByName ("Take");
    REQUIRE (take != nullptr);
    take->setAttribute ("path", legacyWav.getFullPathName());
    juce::MemoryBlock legacyState;
    juce::AudioProcessor::copyXmlToBinary (*xml, legacyState);

    SUBCASE ("se lee y pasa a la carpeta nueva")
    {
        Host b;
        b.proc->setStateInformation (legacyState.getData(), static_cast<int> (legacyState.getSize()));
        REQUIRE (b.proc->waitForWorker (30000));
        b.idle (2);
        const auto v = b.view();
        REQUIRE (v.session->hasTake);
        CHECK (v.session->takeFile == paths::takesDir().getChildFile (wav.getFileName()));
        CHECK (v.session->takeFile.existsAsFile());
        CHECK_FALSE (legacyWav.exists());
        const Audio outB = b.play (song, 0, n);
        CHECK (maxDiff (outB, 0, outA, 0, n) == 0.0);
        // el estado nuevo guarda la ruta nueva
        juce::MemoryBlock s2;
        b.proc->getStateInformation (s2);
        auto x2 = stateXml (s2);
        CHECK (x2->getChildByName ("Take")->getStringAttribute ("path") == v.session->takeFile.getFullPathName());

        // y otro proyecto con la ruta de antes (ya migrada) la encuentra en la carpeta nueva
        Host c;
        c.proc->setStateInformation (legacyState.getData(), static_cast<int> (legacyState.getSize()));
        REQUIRE (c.proc->waitForWorker (30000));
        CHECK (c.view().session->hasTake);
        CHECK (c.view().session->takeFile == v.session->takeFile);
    }
}
