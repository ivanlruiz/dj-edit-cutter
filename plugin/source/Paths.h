// Carpetas del plugin: tomas guardadas (…/DJ Edit Cutter/Tomas, en %APPDATA% en Windows) y archivos para arrastrar a
// FL (Documentos/DJ Edit Cutter). Los tests las redirigen con setRootOverride o la variable DJEC_DATA_DIR.
#pragma once

#include <juce_core/juce_core.h>

namespace djec::plugin::paths
{

/** Carpeta de datos: userApplicationDataDirectory/"DJ Edit Cutter" (o la redirección). */
juce::File dataRoot();
/** Donde se guardan las tomas (WAV float de 32 bits): dataRoot()/"Tomas". */
juce::File takesDir();
/** Donde se escriben los archivos para arrastrar a FL: Documentos/"DJ Edit Cutter" (o redirección/"Documentos"). */
juce::File exportsDir();

/**
 * Redirige todas las carpetas a `root` (tests). Un File vacío quita la redirección. También se puede usar la
 * variable de entorno DJEC_DATA_DIR.
 */
void setRootOverride(const juce::File& root);

} // namespace djec::plugin::paths
