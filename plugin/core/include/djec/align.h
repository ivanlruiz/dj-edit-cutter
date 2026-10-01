// Ubicar un archivo soltado en la línea de tiempo de FL («Suelta aquí el archivo»): busca en qué muestra del archivo
// empieza un trozo del audio que entra al plugin (unos segundos), con correlación cruzada normalizada (insensible a la
// ganancia: fader, efectos anteriores) sobre versiones decimadas (≈ 2 kHz, por FFT en bloques) y luego afinada a la
// muestra con la señal completa. Fuera del hilo de audio. Sin dependencias (C++17).
#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>

namespace djec
{

struct AlignOptions
{
    // correlación (−1..1) a frecuencia completa para dar el archivo por ubicado. Medido con música sintética: el mismo
    // audio da > 0,99 (remuestreado con otro algoritmo 0,998; −6 dB + EQ suave 0,94–0,95), otra canción ≤ 0,42.
    double minConfidence = 0.7;
    double ambiguityMargin = 0.05;   // si otra posición (a más de 50 ms) correlaciona casi igual → ambiguo
    double coarseRate = 2000;        // Hz de la búsqueda gruesa
    double minOverlapSec = 2.0;      // el trozo y el archivo tienen que solaparse al menos esto (o todo el trozo)
    // Límites para la posición (muestras del archivo donde empieza el trozo): p. ej. maxFileOffset = muestra del
    // host del trozo (el archivo no puede empezar antes del principio del proyecto).
    std::int64_t minFileOffset = std::numeric_limits<std::int64_t>::min();
    std::int64_t maxFileOffset = std::numeric_limits<std::int64_t>::max();
};

struct AlignResult
{
    bool found = false;                     // ubicado con confianza y sin ambigüedad
    // input[j] ≈ g · file[fileOffsetOfInputStart + j] (puede ser < 0). Exacto con el mismo audio (o solo otra
    // ganancia); con EQ antes del plugin queda corrido su retardo de grupo (unas muestras: 6–7 a 48 kHz con estantes
    // de ±4–6 dB y una campana), inaudible.
    std::int64_t fileOffsetOfInputStart = 0;
    double confidence = 0;                  // correlación normalizada a frecuencia completa en esa posición
    // diagnóstico
    double coarseScore = 0;                 // correlación de la búsqueda gruesa en esa posición
    double secondConfidence = 0;            // la mejor alternativa a más de 50 ms (frecuencia completa)
    std::int64_t secondOffset = 0;
    bool ambiguous = false;                 // la alternativa está a menos de ambiguityMargin (música que se repite)
    bool tooQuiet = false;                  // el trozo de entrada es (casi) silencio: hay que escuchar más
    double elapsedMs = 0;
};

/**
 * Prepara el archivo una vez (decimación + energía) y busca muchos trozos: es lo que conviene mientras FL reproduce
 * (cada segundo, con el trozo cada vez más largo, hasta ubicarlo). fileMono y el trozo, a la misma frecuencia.
 */
class Aligner
{
public:
    Aligner();
    ~Aligner();
    Aligner(Aligner&&) noexcept;
    Aligner& operator=(Aligner&&) noexcept;
    Aligner(const Aligner&) = delete;
    Aligner& operator=(const Aligner&) = delete;

    /**
     * Decima el archivo (mezcla mono de sus canales) y guarda los punteros: los canales tienen que seguir vivos (y sin
     * cambiar) mientras se use find(), que lee de ellos solo el tramo que afina.
     */
    void prepare(const float* const* fileChannels, int numChannels, std::size_t fileLen, double sampleRate,
                 const AlignOptions& options = {});
    void prepare(const float* fileMono, std::size_t fileLen, double sampleRate, const AlignOptions& options = {});
    bool prepared() const;
    AlignResult find(const float* inputMono, std::size_t inputLen) const;

    struct Impl;

private:
    std::unique_ptr<Impl> impl_;
};

/** Todo de una vez (prepare + find). */
AlignResult findAlignment(const float* fileMono, std::size_t fileLen, const float* inputMono, std::size_t inputLen,
                          double sampleRate, const AlignOptions& options = {});

} // namespace djec
