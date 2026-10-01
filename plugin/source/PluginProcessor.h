#pragma once

// Procesador de DJ Edit Cutter (efecto VST3 para un slot del Mixer de FL Studio).
//
// Funciona como Edison, pero sin botón: la primera vez que suena el canal el plugin TOMA el audio (lo deja pasar tal
// cual); cuando se para, arma la cuadrícula, el plan y el render en segundo plano; desde el próximo Play, dentro de lo
// tomado suena lo editado alineado a la línea de tiempo de FL. También se puede soltar un archivo, que se ubica solo
// en la línea de tiempo. Ver TakeEngine.h (hilo de audio), Worker.h (segundo plano) y PluginState.h (API para la
// interfaz).
//
// Hilos: processBlock no reserva memoria, no bloquea y no hace E/S. Todas las demás funciones públicas se pueden
// llamar desde el hilo de mensajes (o cualquier otro que no sea el de audio).

#include "PluginState.h"
#include "Take.h"
#include "TakeEngine.h"
#include "Worker.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>
#include <memory>
#include <mutex>

class DjecAudioProcessor final : public juce::AudioProcessor
{
public:
    DjecAudioProcessor();
    ~DjecAudioProcessor() override;

    // ---- juce::AudioProcessor ----
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;

    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void processBlockBypassed (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;
    using AudioProcessor::processBlockBypassed;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;
    void updateTrackProperties (const TrackProperties& properties) override;

    // =================================================================================================
    // API para la interfaz (ver PluginState.h). Todo es seguro desde el hilo de mensajes.
    // =================================================================================================

    /** Estado para dibujar: instantánea del worker + lo que pasa ahora en el audio + la línea de estado. */
    djec::plugin::ViewState getViewState() const;

    /** «Volver a tomar el audio»: borra la toma (o el archivo); desde el próximo Play se vuelve a tomar. */
    void clearTake();

    /** «Suelta aquí el archivo»: decodifica y prepara el archivo (asíncrono). false si la extensión no sirve. */
    bool loadDroppedFile (const juce::File& file);
    /** Para FileDragAndDropTarget::isInterestedInFileDrag. */
    static bool isSupportedAudioFile (const juce::File& file);
    static juce::StringArray supportedAudioExtensions();

    /** Plan B si no se encuentra el archivo en el canal: «El archivo empieza en el compás 1». */
    void fileStartsAtBarOne();

    /** «Cuadrícula de FL» / «Detectar del audio». */
    void setGridMode (djec::plugin::GridMode mode);
    djec::plugin::GridMode getGridMode() const;
    /** Cuadrícula de FL: «Mover el 1 ◀ ▶» (tiempos; positivo = el "1" pasa al tiempo siguiente). */
    void setBarOffset (int beats);

    /** Detectar del audio (como la web): Tempo ×2 / ÷2 / manual / Marcar tempo → retrack(bpm, true);
        bpmHint 0 = detección automática. */
    void retrack (double bpmHint, bool strict);
    /** «Mover el 1» / «Este beat es el 1» / tiempos por compás: relabel(compás elegido o 0 = auto, {índice de beat}). */
    void relabel (int beatsPerBar, const std::vector<int>& forcedDownbeats);
    /** «Restablecer». */
    void resetDetection();
    /**
     * «Mover el 1 ◀ ▶» en los dos modos: FL → corre el inicio de compás delta tiempos; detectado → fuerza como "1"
     * el beat a delta del "1" más cercano a refTimeSec (segundos de la toma; la web usa el corte o la posición).
     */
    void moveDownbeat (int delta, double refTimeSec);
    /** «Este beat es el 1» (detectado): el beat más cercano a timeSec (segundos de la toma) pasa a ser "1". */
    void beatIsOne (double timeSec);

    /** Recortar cada compás / Quitar compases del final (rehace plan y render). */
    void setEditSettings (const djec::EditSettings& settings);
    djec::EditSettings getEditSettings() const;

    /** A/B «Original / Editado» (inmediato, también a mitad de una pasada). */
    void setListenOriginal (bool original);
    bool isListeningOriginal() const;

    /** Cierra un aviso (Notice::id). */
    void dismissNotice (std::uint64_t id);

    /** Exporta lo editado a WAV de 16 (con dither, como la web) o 24 bits. Escribe en el hilo que llama. */
    juce::Result exportWav (const juce::File& file, int bitDepth) const;
    /** Lo mismo en un hilo aparte; onDone se llama en el hilo de mensajes. */
    void exportWavAsync (const juce::File& file, int bitDepth, std::function<void (juce::Result)> onDone);
    /** Nombre sugerido: "<pista o archivo> (7-8, edit -2 compases).wav". */
    juce::String suggestedFileName() const;
    /**
     * «Arrastrar a FL»: escribe lo editado (WAV 24 bits) en Documentos/DJ Edit Cutter y devuelve el archivo para
     * performExternalDragDropOfFiles. Si ese mismo render ya se escribió, devuelve el mismo archivo. Archivo vacío
     * si no hay nada editado o falló (motivo en *error).
     */
    juce::File writeDragFile (juce::String* error = nullptr);
    /** writeDragFile en el hilo de exportación (una toma larga tarda); onDone(archivo, error) en el hilo de mensajes. */
    void writeDragFileAsync (std::function<void (juce::File, juce::String)> onDone);

    /** Toma máxima (15 min). */
    static constexpr double maxTakeSeconds() { return djec::plugin::kMaxTakeSeconds; }

    // ---- para los tests ----
    /** Espera a que el worker termine lo pendiente. */
    bool waitForWorker (int timeoutMs = 30000);
    /** Margen de trozos libres para tomar audio (segundos). Por defecto 30. */
    void setTakePoolSeconds (double seconds);
    djec::plugin::TakeEngine& getEngine() noexcept { return engine; }

private:
    djec::plugin::BlockPosition readPosition() const noexcept;

    std::unique_ptr<djec::plugin::Hub> hub;
    djec::plugin::TakeEngine engine;
    djec::plugin::Worker worker;
    double poolSeconds = djec::plugin::kDefaultPoolSeconds;
    double preparedRate = 0;

    mutable std::mutex dragMutex;
    std::uint64_t dragRenderId = 0;
    juce::File dragFile;

    juce::ThreadPool exportPool { juce::ThreadPoolOptions{}.withThreadName ("DJEC export").withNumberOfThreads (1) };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DjecAudioProcessor)
};
