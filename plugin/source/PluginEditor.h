#pragma once

// Editor de DJ Edit Cutter: la interfaz de la app web (mismos textos, colores y orden) para la toma automática del
// plugin. Arriba la cabecera (estado y A/B «Original / Editado»), debajo qué pasa ahora y qué hacer (con «Volver a
// tomar el audio») junto a la zona para soltar un archivo, la forma de onda de la toma y los paneles 1 Compases,
// 2 Recortar cada compás, 3 Quitar compases del final y 4 Resultado.
//
// Solo usa PluginState.h y la API pública de DjecAudioProcessor: lee getViewState() con un temporizador (~30 Hz) y
// manda órdenes asíncronas; nunca bloquea el audio. Las piezas están en source/ui/ (textos en ui/Strings.h).

#include "PluginProcessor.h"
#include "ui/EditorParts.h"
#include "ui/LookAndFeel.h"
#include "ui/Panels.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <set>
#include <vector>

class DjecAudioProcessorEditor final : public juce::AudioProcessorEditor,
                                       public juce::FileDragAndDropTarget,
                                       private juce::Timer,
                                       private juce::FocusChangeListener
{
public:
    explicit DjecAudioProcessorEditor (DjecAudioProcessor&);
    ~DjecAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void paintOverChildren (juce::Graphics&) override;
    void resized() override;

    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void fileDragEnter (const juce::StringArray& files, int x, int y) override;
    void fileDragExit (const juce::StringArray& files) override;
    void filesDropped (const juce::StringArray& files, int x, int y) override;

    /** Lee el estado del procesador y actualiza todo ya (el temporizador lo hace solo; lo usan las capturas). */
    void refreshNow();
    /** Para las capturas: simula un archivo arrastrado encima (resaltado de la zona). */
    void setDragHoverForTesting (bool hovering, bool acceptable);

    static constexpr int kDefaultWidth = 1100, kDefaultHeight = 700;
    static constexpr int kMinWidth = 900, kMinHeight = 560;

private:
    void timerCallback() override;
    /** Con el teclado (Tab), el control que recibe el foco se desplaza a la vista si está en los paneles. */
    void globalFocusChanged (juce::Component* focused) override;
    void addLocalNotice (const juce::String& text, djec::plugin::NoticeKind kind);
    void dismissNotice (std::uint64_t id);
    djec::plugin::Notice currentNotice (const djec::plugin::ViewState& vs);
    int panelsHeight (int width);
    void layoutPanels (int width, int height);

    DjecAudioProcessor& djecProcessor;
    djec::ui::LookAndFeel lnf;
    djec::ui::UiContext ctx;
    juce::TooltipWindow tooltips { this, 650 };

    djec::ui::DropZone dropZone { ctx };
    djec::ui::HeaderBar header { ctx, dropZone };
    djec::ui::StatusCard statusCard { ctx };
    djec::ui::WaveCard waveCard { ctx };
    juce::Viewport viewport;
    juce::Component panelsArea;
    djec::ui::GridPanel gridPanel { ctx };
    djec::ui::TrimPanel trimPanel { ctx };
    djec::ui::EndPanel endPanel { ctx };
    djec::ui::ResultPanel resultPanel { ctx };

    std::uint64_t shownVersion = 0;
    bool firstUpdate = true;
    bool layoutPending = false;
    std::vector<djec::plugin::Notice> localNotices;
    std::uint64_t nextLocalId = (1ULL << 62);
    std::set<std::uint64_t> hiddenNotices;
    bool dragHover = false, dragAcceptable = true;
    int lastStatusHeight = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DjecAudioProcessorEditor)
};
