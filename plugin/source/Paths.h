// Carpetas del plugin: tomas guardadas (…/DJ Edit Cutter/Tomas: en Windows en la carpeta LOCAL de datos de programa,
// %LOCALAPPDATA%, que no viaja con un perfil móvil) y archivos para arrastrar a FL (Documentos/DJ Edit Cutter). Los
// tests las redirigen con setRootOverride o la variable DJEC_DATA_DIR.
#pragma once

#include <juce_core/juce_core.h>

namespace djec::plugin::paths
{

/** Carpeta de datos: userApplicationDataDirectory/"DJ Edit Cutter" (o la redirección). */
juce::File dataRoot();
/** Donde se guardan las tomas (WAV float de 32 bits): defaultTakesDir(), o redirección/"Tomas". */
juce::File takesDir();
/**
 * Sin redirección: en Windows %LOCALAPPDATA%/"DJ Edit Cutter"/"Tomas" (juce::File::windowsLocalAppData: las tomas
 * pesan cientos de MB y no deben viajar con un perfil móvil); en los demás sistemas
 * userApplicationDataDirectory/"DJ Edit Cutter"/"Tomas".
 */
juce::File defaultTakesDir();
/**
 * Donde guardaban las tomas las versiones anteriores, si es otra carpeta: en Windows %APPDATA%/"DJ Edit Cutter"/"Tomas"
 * (la carpeta móvil). Vacío si coincide con takesDir() (Linux, macOS). Con redirección: redirección/"Tomas (antes)"
 * (para probar la migración). Los estados guardados con rutas de ahí se siguen leyendo; al abrirlos, la toma se pasa a
 * takesDir().
 */
juce::File legacyTakesDir();
/** Donde se escriben los archivos para arrastrar a FL: Documentos/"DJ Edit Cutter" (o redirección/"Documentos"). */
juce::File exportsDir();

/**
 * Redirige todas las carpetas a `root` (tests). Un File vacío quita la redirección. También se puede usar la
 * variable de entorno DJEC_DATA_DIR.
 */
void setRootOverride(const juce::File& root);

} // namespace djec::plugin::paths
