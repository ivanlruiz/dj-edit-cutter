// Cuadrícula de FL → AnalysisResult: los beats y compases salen de la posición del host anotada durante la toma
// (ppq, tempo, compás, inicio del compás), sin detectar nada. Modo por defecto «Cuadrícula de FL».
#pragma once

#include "djec/analysis_result.h"
#include "djec/capture_info.h"

namespace djec
{

/** Datos de la cuadrícula del host que no caben en AnalysisResult. */
struct HostGridMeta
{
    bool valid = false;          // había posición del host (ppq o tempo) en la toma
    int tsNum = 4, tsDen = 4;    // compás del proyecto (el que cubre más beats si cambió) → sourceDen del plan = tsDen
    double hostBpm = 0;          // tempo del host al principio de la toma (negras por minuto, como lo muestra FL)
    bool tempoChanges = false;   // el tempo cambió durante la toma (automatización)
    bool meterChanges = false;   // el compás o el inicio de compás cambió durante la toma
    double ppqStart = 0, ppqEnd = 0;   // ppq en la muestra 0 y en numSamples de la toma
};

/**
 * Beats en cada tiempo del host (1/tsDen de redonda) dentro de la toma, posiciones desde el inicio de compás del host
 * (lastBarStartPpq) corridas barOffsetBeats tiempos (positivo = el "1" pasa a ser el tiempo siguiente; para
 * anacrusas: «Mover el 1 ◀ ▶»). beatsPerBar = tsNum, duration = numSamples / sampleRate, musicStart = 0,
 * musicEnd = lastOnset = duration (así se transforman todos los compases completos), confBeats = confBars = 1,
 * meterAuto = false, beatStrength = 1. Tempo por tramos: ppq → muestra interpolando entre las anclas de `blocks`
 * (exacto con automatización de tempo si hay un ancla en cada cambio); después del último ancla se extrapola con su
 * tempo. Un "1" que cae hasta 5 ms antes del inicio o después del final de la toma se incluye pegado al borde (un
 * compás al que le faltan unos ms sigue siendo completo); los demás beats fuera de la toma no.
 * bpm = mediana de 60/IBI de los beats de la cuadrícula redondeada a 0.1 (en x/8 son corcheas por minuto: el doble
 * del tempo de FL); bpmLo/bpmHi = percentiles 10/90.
 * Sin posición del host o sin muestras: resultado sin beats (el plan dice "No hay beats detectados en la canción.").
 */
AnalysisResult gridFromHost(const CaptureInfo& capture, int barOffsetBeats = 0, HostGridMeta* meta = nullptr);

} // namespace djec
