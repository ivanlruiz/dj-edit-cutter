// TODOS los textos en español de la interfaz del plugin, en un solo lugar (este archivo) (mismo tono que la web: tú, imperativos
// cortos). Los textos que arma el procesador (línea de estado, avisos, motivos por los que no se recorta) vienen ya en
// español desde PluginState.h; los del núcleo (describeMeterChange, errores del plan) desde djec::*.
// Constantes en UTF-8: usar T() para convertirlas a juce::String.
#pragma once

#include "PluginState.h"
#include "ui/Format.h"

#include <juce_core/juce_core.h>

#include <cmath>
#include <string>

namespace djec::ui
{

/** UTF-8 → juce::String (los literales con acentos no pueden pasar por String (const char*)). */
inline juce::String T (const char* utf8) { return juce::String::fromUTF8 (utf8); }

namespace str
{
// ---- cabecera ----
constexpr const char* appName = "DJ Edit Cutter";
constexpr const char* abOriginal = "Original";
constexpr const char* abEdited = "Editado";
constexpr const char* abTip = "Compara: «Original» deja pasar el audio del canal tal cual; «Editado» suena recortado.";
constexpr const char* abDisabledTip = "Cuando haya audio editado podrás compararlo con el original.";

// ---- pastilla de estado (corta) ----
constexpr const char* pillWaiting = "Esperando Play";
constexpr const char* pillTaking = "Tomando el audio";
constexpr const char* pillTakingMore = "Tomando lo que faltaba";
constexpr const char* pillLoading = "Leyendo el archivo";
constexpr const char* pillWaitingFile = "Falta ubicar el archivo";
constexpr const char* pillSearching = "Buscando el archivo";
constexpr const char* pillNotFound = "Archivo no encontrado";
constexpr const char* pillProcessing = "Procesando";
constexpr const char* pillReady = "Listo";
constexpr const char* pillPlayingEdited = "Suena recortado";
constexpr const char* pillPlayingOriginal = "Suena el original";
constexpr const char* pillOutside = "Fuera de la toma";
constexpr const char* pillNothing = "Sin recorte";

// ---- explicación bajo la línea de estado (una por fase) ----
constexpr const char* helpWaiting =
    "Pon el plugin en el canal del Mixer donde suena tu audio y dale Play: mientras lo toma, escuchas el original.";
constexpr const char* helpTaking =
    "Cuando pares FL, preparo el recorte. Para tomar toda la canción, déjala sonar hasta el final.";
constexpr const char* helpTakingMore = "Sigue sonando de corrido: añado a la toma lo que faltaba.";
constexpr const char* helpLoading = "Lo decodifico y lo llevo a la frecuencia del proyecto.";
constexpr const char* helpWaitingFile =
    "Mientras lo busco escuchas el original. Si el archivo no suena en este canal, usa «El archivo empieza en el compás 1».";
constexpr const char* helpNotFound =
    "Comprueba que el archivo suena en este canal, o usa «El archivo empieza en el compás 1».";
constexpr const char* helpProcessing = "Armo los compases y el recorte. Mientras tanto el audio pasa sin cambios.";
constexpr const char* helpReady = "Dale Play en FL: dentro de lo tomado suena recortado. Arrastra el resultado a FL o expórtalo.";
constexpr const char* helpPlayingEdited = "Lo que suena sale del plugin, alineado con la línea de tiempo de FL.";
constexpr const char* helpPlayingOriginal = "Pasa a «Editado», arriba a la derecha, para escuchar el recorte.";
constexpr const char* helpOutside =
    "Si suena de corrido hasta el principio de la toma (o sigue después del final), la añado sola.";
constexpr const char* helpNothing = "Mientras tanto suena el original.";

constexpr const char* retake = "Volver a tomar el audio";
constexpr const char* retakeTip = "Borra lo tomado: desde el próximo Play el plugin vuelve a tomar el audio del canal.";
constexpr const char* closeNotice = "Cerrar aviso";

// ---- soltar un archivo ----
constexpr const char* dropTitle = "Suelta aquí un archivo de audio (opcional)";
constexpr const char* dropSub = "WAV, AIFF, FLAC, OGG o MP3 · se ubica solo en FL";
constexpr const char* dropTip =
    "Suelta un archivo de audio en cualquier parte del plugin: le das Play en FL y lo ubico solo en la línea de tiempo.";
constexpr const char* dropHover = "Suelta para cargar el archivo";
constexpr const char* dropBad = "Ese archivo no parece de audio: suelta un WAV, AIFF, FLAC, OGG o MP3.";
constexpr const char* alignLoading = "Leyendo el archivo…";
constexpr const char* alignWaiting = "Buscando dónde está el archivo… dale Play";
constexpr const char* alignSearching = "Buscando dónde está el archivo…";
constexpr const char* alignNotFound = "No encuentro este audio en el canal";
constexpr const char* alignManual = "Colocado: empieza en el compás 1";
constexpr const char* barOne = "El archivo empieza en el compás 1";
constexpr const char* barOneTip = "Úsalo si el archivo empieza al principio del proyecto de FL (compás 1).";

// ---- forma de onda ----
constexpr const char* takeLabel = "Toma";
constexpr const char* fileLabel = "Archivo";
constexpr const char* takeFromChannel = "Toma del canal";
constexpr const char* zoomAll = "Ver todo";
constexpr const char* zoomInTip = "Acercar (también con la rueda del ratón)";
constexpr const char* zoomOutTip = "Alejar";
constexpr const char* zoomAllTip = "Ver toda la toma";
constexpr const char* waveTip = "Rueda: zoom (Mayús + rueda: desplazar) · arrastra para desplazarte · doble clic: ver todo";
constexpr const char* removedLabel = "Se quita";
constexpr const char* cutPill = "CORTE";
constexpr const char* repeatMark = "×2";
constexpr const char* emptyTitle = "Todavía no hay audio tomado";
constexpr const char* emptyStep1 = "Dale Play en FL: el plugin toma el audio de este canal (escuchas el original).";
constexpr const char* emptyStep2 = "Para FL cuando quieras: el plugin arma los compases y el recorte.";
constexpr const char* emptyStep3 = "Desde el próximo Play suena recortado. Arrastra el resultado a FL o expórtalo.";
constexpr const char* emptyDrop = "¿Ya tienes el archivo? Suéltalo en el plugin y lo ubico solo en la línea de tiempo.";
constexpr const char* takingTitle = "Tomando el audio…";
constexpr const char* takingSub = "Cuando pares FL, aquí aparece la forma de onda con los compases.";
constexpr const char* processingTitle = "Procesando…";   // también el busyText genérico del procesador
constexpr const char* filePendingTitle = "Falta ubicar el archivo en la línea de tiempo";
constexpr const char* filePendingSub = "Dale Play en FL donde suena este audio y lo ubico solo.";

// ---- 1 · Compases ----
constexpr const char* gridTitle = "Compases";
constexpr const char* gridHost = "Cuadrícula de FL";
constexpr const char* gridDetect = "Detectar del audio";
constexpr const char* gridHostTip = "Los compases salen del proyecto de FL (tempo, compás e inicio de compás).";
constexpr const char* gridDetectTip =
    "Detecta beats y compases en el audio: para grabaciones en vivo o canciones que no siguen la cuadrícula de FL.";
constexpr const char* gridHostHelp = "Si el «1» no cae donde debe (por ejemplo, una anacrusa), muévelo un beat.";
constexpr const char* gridNoTake = "Cuando haya audio tomado podrás revisar los compases.";
constexpr const char* gridFilePending = "Cuando el archivo esté ubicado, los compases salen de la cuadrícula de FL.";
constexpr const char* tempoDouble = "Tempo ×2";
constexpr const char* tempoHalf = "Tempo ÷2";
constexpr const char* tempoDoubleTip = "La cuadrícula va a la mitad del ritmo real: duplica el tempo.";
constexpr const char* tempoHalfTip = "La cuadrícula va al doble del ritmo real: divide el tempo a la mitad.";
constexpr const char* tempoManual = "Tempo manual";
constexpr const char* bpmPlaceholder = "BPM";
constexpr const char* apply = "Aplicar";
constexpr const char* applyTip = "Recalcula la cuadrícula con el tempo escrito.";
constexpr const char* tap = "Marcar tempo";
constexpr const char* tapTip = "Toca al ritmo de la canción: el tempo aparece en «Tempo manual».";
constexpr const char* tapIdle = "Toca al ritmo";
constexpr const char* tapMore = "Sigue tocando…";
constexpr const char* beatsPerBar = "Tiempos por compás";
constexpr const char* beatsPerBarAuto = "Auto";
constexpr const char* moveOne = "Mover el 1";
constexpr const char* moveOnePrevTip = "Mover el 1 un beat antes";
constexpr const char* moveOneNextTip = "Mover el 1 un beat después";
constexpr const char* thisBeatIsOne = "Este beat es el 1";
constexpr const char* thisBeatIsOneTip = "Usa el beat más cercano al cabezal de FL.";
constexpr const char* reset = "Restablecer";
constexpr const char* resetDetectTip = "Vuelve a la detección automática.";
constexpr const char* resetHostTip = "Vuelve al «1» de la cuadrícula de FL.";
// etiquetas de confianza que manda el procesador (SessionView::confidenceLabel), para elegir el color
constexpr const char* confManual = "Cuadrícula ajustada a mano";
constexpr const char* confMedium = "Detección aceptable";
constexpr const char* lowConfidence =
    "La detección no es segura. Escucha con FL: si el «1» no cae donde debe, prueba «Tempo ×2 / ÷2», cambia los "
    "tiempos por compás o usa «Mover el 1».";
constexpr const char* tempoOutOfRange = "Ese tempo queda fuera del rango que se puede detectar.";
constexpr const char* hostNoInfo = "FL no informó el tempo: prueba «Detectar del audio».";
constexpr const char* sourceMeter = "Compás original";
constexpr const char* sourceMeterAuto = "Auto (de FL)";
constexpr const char* sourceMeterTip =
    "El compás en que está el audio tomado. «Auto» usa el de FL y, si ya pusiste FL en el compás nuevo, el de la "
    "primera toma. Elige otro si la cuadrícula no coincide con la canción.";
constexpr const char* meterFromFirstTake = " (compás original de la primera toma)";
constexpr const char* meterChosenByHand = " (elegido a mano)";

// ---- 2 · Recortar cada compás ----
constexpr const char* trimTitle = "Recortar cada compás";
constexpr const char* trimSub = "cambia el compás de la canción";
constexpr const char* trimSwitchTip = "Activa o desactiva el recorte de cada compás.";
constexpr const char* trimOff =
    "Desactivado: los compases quedan enteros. Actívalo para quitar un trozo del final de cada compás (por ejemplo, "
    "de 4/4 a 7/8).";
constexpr const char* trimAmount = "¿Cuánto quitar de cada compás?";
constexpr const char* otherMeter = "Compás nuevo";
constexpr const char* otherNumTip = "Tiempos del compás nuevo (1 a 32)";
constexpr const char* otherDenTip = "Figura del compás nuevo";
constexpr const char* crossfade = "Suavizado de empalmes";
constexpr const char* crossfadeNote = "Crossfade en cada empalme: más corto = más nítido, más largo = más suave.";
constexpr const char* setFlMeterSuffix = " para que la cuadrícula coincida.";

// ---- 3 · Quitar compases del final ----
constexpr const char* endTitle = "Quitar compases del final";
constexpr const char* endSwitchTip = "Activa o desactiva el corte del final.";
constexpr const char* endOff =
    "Desactivado: suena hasta el final de la toma. Actívalo para cortar unos compases antes, con fade out.";
constexpr const char* barsToRemove = "Compases a quitar";
constexpr const char* barsMinusTip = "Quitar un compás menos";
constexpr const char* barsPlusTip = "Quitar un compás más";
constexpr const char* fadeOut = "Fade out";
constexpr const char* fadeNote = "En beats. 0 = corte seco (con una rampa mínima para evitar el clic).";
constexpr const char* fadeNone = "Corte seco (sin fade)";
constexpr const char* fadeCurve = "Curva del fade";
constexpr const char* curveLinear = "Lineal";
constexpr const char* curveSmooth = "Suave";
constexpr const char* curveExp = "Exponencial";
constexpr const char* endNoBars = "No hay compases que quitar en esta toma.";

// ---- 4 · Resultado ----
constexpr const char* resultTitle = "Resultado";
constexpr const char* dragToFl = "Arrastrar a FL";
constexpr const char* dragSub = "al Playlist o a un canal";
constexpr const char* dragTip =
    "Arrastra el audio editado al Playlist de FL (se guarda un WAV de 24 bits en Documentos/DJ Edit Cutter).";
constexpr const char* dragPreparing = "Preparando…";
constexpr const char* exportWav = "Exportar WAV…";
constexpr const char* exportTip = "Guarda el audio editado como WAV donde elijas.";
constexpr const char* bits16 = "16 bits";
constexpr const char* bits24 = "24 bits";
constexpr const char* bitsTip = "Profundidad del WAV: 24 bits conserva todo el detalle; 16 bits (calidad CD) lleva dither.";
constexpr const char* exportChooserTitle = "Exportar el audio editado";
constexpr const char* exporting = "Guardando…";
constexpr const char* noRender = "Todavía no hay audio editado.";
constexpr const char* exportFailed = "No se pudo exportar el archivo.";

} // namespace str

// ---- textos con datos ----
namespace text
{
namespace detail
{
inline juce::String meterLabel (int num, int den)
{
    return num > 0 && den > 0 ? juce::String (num) + "/" + juce::String (den) : juce::String ("?");
}

// "Se quita la última corchea de cada compás." → "se quita la última corchea de cada compás"
inline juce::String clause (const juce::String& s)
{
    juce::String t = s.trim();
    if (t.endsWithChar ('.'))
        t = t.dropLastCharacters (1);
    if (t.isEmpty())
        return t;
    return t.substring (0, 1).toLowerCase() + t.substring (1);
}
} // namespace detail

/**
 * "FL: 120 BPM · 4/4" (cuadrícula de FL), con de dónde sale el compás si no es el que informó FL:
 * "FL: 120 BPM · 4/4 (compás original de la primera toma)" / "… (elegido a mano)".
 */
inline juce::String hostInfo (double bpm, int num, int den,
                              djec::plugin::MeterOrigin origin = djec::plugin::MeterOrigin::Host)
{
    juce::String s ("FL: ");
    s << (bpm > 0 ? fmt::number (bpm, 2) + " BPM" : T ("tempo desconocido"));
    if (num > 0 && den > 0)
    {
        s << T (" · ") << num << "/" << den;
        if (origin == djec::plugin::MeterOrigin::FirstTake)
            s << T (str::meterFromFirstTake);
        else if (origin == djec::plugin::MeterOrigin::Manual)
            s << T (str::meterChosenByHand);
    }
    return s;
}

/** "Detectado: ≈ 123,4 BPM · 4/4". */
inline juce::String detectInfo (double bpm, int beatsPerBar)
{
    juce::String s = T ("Detectado: ");
    s << (bpm > 0 ? T ("≈ ") + fmt::number (bpm, 1) + " BPM" : T ("sin tempo"));
    if (beatsPerBar > 0)
        s << T (" · ") << beatsPerBar << "/4";
    return s;
}

/** "0:42 · 21 compases" (tomando). */
inline juce::String takingProgress (double seconds, int bars, bool barsKnown)
{
    juce::String s = fmt::duration (seconds);
    if (barsKnown)
        s << T (" · ") << (bars == 1 ? T ("1 compás") : juce::String (bars) + " compases");
    return s;
}

/** "Toma «Guitarra»" / "Archivo «tema»". */
inline juce::String takeTitle (bool file, const juce::String& name)
{
    return T (file ? str::fileLabel : str::takeLabel) + T (" «") + name + T ("»");
}

/** "3:52 · 48 kHz · estéreo". */
inline juce::String takeMeta (double seconds, double sampleRate, int channels)
{
    juce::String s = fmt::duration (seconds);
    if (sampleRate > 0)
        s << T (" · ") << fmt::number (sampleRate / 1000.0, 1) << " kHz";
    if (channels > 0)
        s << T (" · ") << (channels == 1 ? T ("mono") : T ("estéreo"));
    return s;
}

/** "Ubicado: empieza en el compás 5". */
inline juce::String alignFound (int bar)
{
    return T ("Ubicado: empieza en el compás ") + juce::String (bar);
}

/** "Se cambian 28 compases" / "Se cambia 1 compás" / "No cambia ningún compás". */
inline juce::String barsChanged (int n)
{
    if (n <= 0)
        return T ("No cambia ningún compás");
    return n == 1 ? T ("Se cambia 1 compás") : T ("Se cambian ") + juce::String (n) + " compases";
}

/** "1:04 → 0:57". */
inline juce::String durationChange (double before, double after)
{
    return fmt::duration (before) + T (" → ") + fmt::duration (after);
}

/** "Original: 4/4 → Nuevo: 7/8" (num/den 0 = no válido: "?"). */
inline juce::String meterChange (int beatsPerBar, int sourceDen, int num, int den)
{
    const juce::String orig = beatsPerBar > 0 && sourceDen > 0 ? detail::meterLabel (beatsPerBar, sourceDen) : T ("–");
    return T ("Original: ") + orig + T (" → Nuevo: ") + detail::meterLabel (num, den);
}

/** "Se cambian 28 compases · dura 1:04 → 0:57". */
inline juce::String meterStats (int n, double before, double after)
{
    return barsChanged (n) + T (" · dura ") + durationChange (before, after);
}

/** "Pon el compás del proyecto de FL en 7/8 para que la cuadrícula coincida." */
inline juce::String flMeterHint (const juce::String& processorHint)
{
    return processorHint + T (str::setFlMeterSuffix);
}

/** Leyenda bajo la onda: "En rojo: se quita la última corchea de cada compás". */
inline juce::String legend (bool repeated, const juce::String& describeText)
{
    return T (repeated ? "En verde: " : "En rojo: ") + detail::clause (describeText);
}

/** "Escuchar…"-free resumen del resultado: "Compás 7/8 · −2 compases del final · dura 1:04 → 0:51". */
inline juce::String resultSummary (bool meterApplies, int num, int den, bool useCut, int barsRemoved, double before, double after)
{
    juce::StringArray parts;
    if (meterApplies)
        parts.add (T ("Compás ") + detail::meterLabel (num, den));
    if (useCut)
        parts.add (barsRemoved > 0 ? T ("−") + (barsRemoved == 1 ? T ("1 compás") : juce::String (barsRemoved) + " compases") + " del final"
                                   : T ("corte en el último golpe"));
    parts.add (T ("dura ") + durationChange (before, after));
    return parts.joinIntoString (T (" · "));
}

/** "Corte en 3:41.25 · la toma pasa de 3:52 a 3:41" (con compás nuevo: "… con el compás nuevo pasa de 3:52 a 3:18"). */
inline juce::String cutReadout (double cutTime, double duration, double outputDuration, bool withMeter)
{
    if (withMeter)
        return T ("Corte en ") + fmt::time (cutTime) + T (" · con el compás nuevo pasa de ") + fmt::duration (duration)
               + " a " + fmt::duration (outputDuration);
    return T ("Corte en ") + fmt::time (cutTime) + T (" · la toma pasa de ") + fmt::duration (duration) + " a "
           + fmt::duration (cutTime);
}

/** "½ beat", "1 beat", "2 beats". */
inline juce::String beats (double n)
{
    if (std::fabs (n - 0.5) < 1e-9)
        return T ("½ beat");
    const juce::String s = fmt::number (n, 2);
    return s == "1" ? T ("1 beat") : s + " beats";
}

/** "Corte seco (sin fade)" / "2 beats ≈ 0,97 s". */
inline juce::String fade (double beatCount, double seconds)
{
    if (beatCount <= 0)
        return T (str::fadeNone);
    return beats (beatCount) + T (" ≈ ") + fmt::seconds (seconds);
}

/** "½" "1" "2"… para las marcas del fade. */
inline juce::String fadeTick (double beats)
{
    if (std::fabs (beats - 0.5) < 1e-9)
        return T ("½");
    return fmt::number (beats, 1);
}

/** "10 ms". */
inline juce::String milliseconds (double ms)
{
    return fmt::number (ms, 0) + " ms";
}

/** "Quitar 4 compases". */
inline juce::String removeBarsTip (int n)
{
    return T ("Quitar ") + (n == 1 ? T ("1 compás") : juce::String (n) + " compases");
}

/** "≈ 123,4 BPM" (marcar tempo). */
inline juce::String tapValue (double bpm)
{
    return T ("≈ ") + fmt::number (bpm, 1) + " BPM";
}

/** "Escribe un tempo entre 30 y 300 BPM." */
inline juce::String bpmRange (double lo, double hi)
{
    return T ("Escribe un tempo entre ") + fmt::number (lo, 0) + " y " + fmt::number (hi, 0) + " BPM.";
}

/** "Se guardará como «x.wav»". */
inline juce::String saveAs (const juce::String& fileName)
{
    return T ("Se guardará como «") + fileName + T ("»");
}

/** "Listo: se guardó «x.wav»." */
inline juce::String exported (const juce::String& fileName)
{
    return T ("Listo: se guardó «") + fileName + T ("».");
}

/** "No se pudo exportar el archivo. (detalle)". */
inline juce::String exportError (const juce::String& detail)
{
    return T (str::exportFailed) + (detail.isNotEmpty() ? " (" + detail + ")" : juce::String());
}

/** Etiqueta de un botón de cantidad: "½ tiempo (corchea)". */
inline juce::String chipName (const std::string& main, const std::string& note)
{
    return note.empty() ? T (main.c_str()) : T (main.c_str()) + " " + T (note.c_str());
}

/** "→ 7/8". */
inline juce::String chipResult (const std::string& result)
{
    return result.empty() ? juce::String() : T ("→ ") + T (result.c_str());
}
} // namespace text

} // namespace djec::ui
