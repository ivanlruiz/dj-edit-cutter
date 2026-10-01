#include "Paths.h"

#include <mutex>

namespace djec::plugin::paths
{

namespace
{
std::mutex& overrideMutex()
{
    static std::mutex m;
    return m;
}
juce::File& overrideRoot()
{
    static juce::File f;
    return f;
}

juce::File overridden()
{
    {
        const std::lock_guard<std::mutex> lock(overrideMutex());
        if (overrideRoot() != juce::File())
            return overrideRoot();
    }
    const juce::String env = juce::SystemStats::getEnvironmentVariable("DJEC_DATA_DIR", {});
    if (env.isNotEmpty() && juce::File::isAbsolutePath(env))
        return juce::File(env);
    return {};
}
} // namespace

void setRootOverride(const juce::File& root)
{
    const std::lock_guard<std::mutex> lock(overrideMutex());
    overrideRoot() = root;
}

juce::File dataRoot()
{
    const juce::File o = overridden();
    if (o != juce::File())
        return o;
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("DJ Edit Cutter");
}

juce::File takesDir()
{
    const juce::File o = overridden();
    if (o != juce::File())
        return o.getChildFile("Tomas");
    return defaultTakesDir();
}

juce::File defaultTakesDir()
{
#if JUCE_WINDOWS
    return juce::File::getSpecialLocation(juce::File::windowsLocalAppData)
        .getChildFile("DJ Edit Cutter")
        .getChildFile("Tomas");
#else
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("DJ Edit Cutter")
        .getChildFile("Tomas");
#endif
}

juce::File legacyTakesDir()
{
    const juce::File o = overridden();
    if (o != juce::File())
        return o.getChildFile("Tomas (antes)");
    const juce::File old = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                               .getChildFile("DJ Edit Cutter")
                               .getChildFile("Tomas");
    return old == defaultTakesDir() ? juce::File() : old;
}

juce::File exportsDir()
{
    const juce::File o = overridden();
    if (o != juce::File())
        return o.getChildFile("Documentos");
    return juce::File::getSpecialLocation(juce::File::userDocumentsDirectory).getChildFile("DJ Edit Cutter");
}

} // namespace djec::plugin::paths
