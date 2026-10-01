// WAV: escritura por tramos (port de encodeWav de js/audio/wav.js: 16 bits con dither TPDF xorshift32 y el silencio
// digital en 0, 24 bits redondeando; además float de 32 bits para guardar las tomas sin pérdida) y lectura (JUCE).
// Fuera del hilo de audio.
#pragma once

#include <juce_core/juce_core.h>

#include <cstdint>
#include <vector>

namespace djec::plugin::wav
{

enum class Format
{
    Pcm16,     // dither TPDF ±1 LSB, mismos bytes que la web
    Pcm24,
    Float32    // tomas guardadas: idéntico a lo tomado
};

/**
 * Escribe channels[0..numChannels) (frames muestras cada uno) en `file` (archivo temporal + reemplazo: nunca deja un
 * WAV a medias). Crea la carpeta si hace falta. Errores en español ("No pude escribir …").
 */
juce::Result write(const juce::File& file, const float* const* channels, int numChannels, std::int64_t frames,
                   double sampleRate, Format format);

struct Audio
{
    double sampleRate = 0;
    std::vector<std::vector<float>> channels;
    std::int64_t frames() const { return channels.empty() ? 0 : static_cast<std::int64_t>(channels[0].size()); }
};

/** Lee un WAV entero (cualquier formato que lea JUCE). */
juce::Result read(const juce::File& file, Audio& out);

/** Huella de 64 bits de las muestras (para reconocer la toma guardada). */
std::uint64_t hashAudio(const float* const* channels, int numChannels, std::int64_t frames);

} // namespace djec::plugin::wav
