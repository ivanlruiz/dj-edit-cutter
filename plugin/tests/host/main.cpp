// Runner de doctest para djec_host_tests (simulación de host contra el procesador del plugin).
// Inicializa JUCE (MessageManager) una vez para todo el proceso y redirige las carpetas del plugin (tomas guardadas,
// archivos para arrastrar) a una carpeta temporal que se borra al terminar. Los tests van en
// plugin/tests/host/*_test.cpp y entran solos por GLOB. Mismas macros que djec_core_tests
// (DJEC_GOLDEN_DIR, DJEC_GOLDEN_ENABLED, DJEC_PLUGIN_SOURCE_DIR, DJEC_REPO_ROOT).
#define DOCTEST_CONFIG_IMPLEMENT
#include <doctest.h>

#include "HostSim.h"
#include "Paths.h"

#include <juce_events/juce_events.h>

namespace djec_test
{
juce::File testDataDir()
{
    static const juce::File dir = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                      .getChildFile ("djec-host-tests-" + juce::String (juce::Random::getSystemRandom().nextInt64()));
    return dir;
}
} // namespace djec_test

int main (int argc, char** argv)
{
    const juce::ScopedJuceInitialiser_GUI juceInit;
    const juce::File dir = djec_test::testDataDir();
    dir.createDirectory();
    djec::plugin::paths::setRootOverride (dir);

    doctest::Context context;
    context.applyCommandLine (argc, argv);
    const int rc = context.run();

    djec::plugin::paths::setRootOverride ({});
    dir.deleteRecursively();
    return rc;
}
