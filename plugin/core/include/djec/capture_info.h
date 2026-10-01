// Lo que la toma del audio ("tomar el audio") guarda de la línea de tiempo de FL, para armar la cuadrícula de compases
// (gridFromHost, djec/grid.h). Lo produce el procesador (fuera del hilo de audio, a partir de lo que anotó en cada
// bloque) y lo consume el worker.
#pragma once

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace djec
{

/** Posición del host al principio de un bloque (juce::AudioPlayHead::PositionInfo). */
struct HostBlockInfo
{
    std::int64_t hostSample = 0;     // timeInSamples
    double ppq = 0;                  // ppqPosition (negras desde el inicio del proyecto)
    double bpm = 0;                  // tempo en negras por minuto (<= 0 = desconocido)
    int tsNum = 4, tsDen = 4;        // compás del proyecto (<= 0 = desconocido → 4/4)
    double lastBarStartPpq = 0;      // ppqPositionOfLastBarStart
    bool ppqValid = false;           // false → ppq = hostSample / sampleRate · bpm / 60
    bool barValid = false;           // false → compases desde ppq 0
};

/**
 * Una toma contigua. blocks: (muestra de la toma donde empieza el bloque, posición del host), ascendente.
 * Puede ser densa (uno por bloque, de cualquier tamaño: 1, 64, 512, impares…) o rala: entre dos anclas el ppq se
 * interpola linealmente, que es exacto si el tempo no cambia entre ellas. Por eso basta con anotar el primer bloque
 * y cada bloque en el que cambie el tempo, el compás o el inicio de compás (y, si se quiere, uno cada tanto).
 */
struct CaptureInfo
{
    double sampleRate = 0;
    std::int64_t hostStartSample = 0;
    std::size_t numSamples = 0;
    std::vector<std::pair<std::int64_t /*capture sample offset*/, HostBlockInfo>> blocks;   // one per processed block
};

} // namespace djec
