// WAV de las tomas (…/DJ Edit Cutter/Tomas): qué archivos están en uso y la limpieza de los viejos.
//
// Uso: cada instancia del plugin registra el WAV de su toma (acquire/release) mientras lo usa; el registro es de todo
// el proceso (FL carga todas las instancias en el mismo proceso). La limpieza (cleanup) corre en el worker, nunca en el
// hilo de audio: al rato de arrancar y después de cada toma nueva guardada.
//
// Política (cleanup):
//   1. Se borran las tomas con más de maxAgeDays días sin usarse (fecha de modificación).
//   2. Si la carpeta sigue pasando de maxBytes, se borran las más viejas (por fecha de modificación) hasta bajar.
//   Nunca se borra un archivo en uso: registrado en este proceso, el `keep` de quien limpia, o modificado hace menos de
//   graceMinutes (otro proceso de FL que lo usa lo «toca» cada touchIntervalMinutes con touch()). Solo se miran los
//   archivos con nombre de toma (<uuid>.wav) directamente en la carpeta; nada más se toca.
#pragma once

#include <juce_core/juce_core.h>

namespace djec::plugin::takefiles
{

struct Policy
{
    juce::int64 maxBytes = juce::int64(3) * 1024 * 1024 * 1024;   // 3 GB
    double maxAgeDays = 60;
    double graceMinutes = 30;          // modificado hace menos de esto = en uso (por otro proceso, o recién hecho)
    double touchIntervalMinutes = 10;  // cada cuánto una instancia «toca» el WAV que usa
    int startupDelayMs = 60 * 1000;    // la limpieza de arranque espera a que FL termine de abrir el proyecto
};

struct Result
{
    int scanned = 0;                   // archivos de toma en la carpeta
    int deleted = 0;
    juce::int64 bytesBefore = 0, bytesAfter = 0;
    juce::StringArray deletedNames;
};

/** ¿Tiene nombre de toma? (<uuid>.wav, como los escribe el plugin) */
bool isTakeFileName(const juce::String& fileName);

/** Registro de archivos en uso en este proceso (se cuentan: dos instancias pueden usar el mismo). Cualquier hilo. */
void acquire(const juce::File& file);
void release(const juce::File& file);
bool isInUse(const juce::File& file);

/** Pone la fecha de modificación en `now` (el archivo cuenta como usado). false si no se pudo. */
bool touch(const juce::File& file, juce::Time now = juce::Time::getCurrentTime());

/** Aplica la política en `dir`. `keep`: el archivo de quien limpia (nunca se borra). Serializado en todo el proceso. */
Result cleanup(const juce::File& dir, const Policy& policy, juce::Time now = juce::Time::getCurrentTime(),
               const juce::File& keep = {});

} // namespace djec::plugin::takefiles
