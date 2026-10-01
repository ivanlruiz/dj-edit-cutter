// Archivo soltado en el plugin («Suelta aquí el archivo»): lo decodifica (WAV, AIFF, FLAC, OGG, MP3; WMA en Windows)
// y lo lleva a la frecuencia del host con el remuestreador sinc·Kaiser del core (calidad de exportación de la web).
// Fuera del hilo de audio (lo usa el worker).
#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <vector>

namespace djec::plugin::filedrop
{

/** Extensiones que se pueden soltar (sin punto, en minúsculas). */
juce::StringArray supportedExtensions();
/** ¿Se puede intentar leer este archivo? (por la extensión) */
bool isSupported(const juce::File& file);

struct Decoded
{
    std::vector<std::vector<float>> channels;   // 1 o 2 canales a targetRate
    double sampleRate = 0;                      // = targetRate
    double fileRate = 0;                        // frecuencia original del archivo
    std::int64_t length = 0;
    juce::String error;                         // "" = bien; si no, texto para el usuario
};

/** Decodifica y remuestrea. maxSeconds: más largo → error. */
Decoded decode(const juce::File& file, double targetRate, double maxSeconds);

} // namespace djec::plugin::filedrop
