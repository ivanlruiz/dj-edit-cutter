// Partes fijas del editor: cabecera (nombre, estado, A/B «Original / Editado»), tarjeta de estado (qué pasa ahora y
// qué hacer, avisos, «Volver a tomar el audio»), zona para soltar un archivo (y dónde se ubicó) y la tarjeta de la
// forma de onda (barra de herramientas, leyenda, estados vacío / tomando / procesando).
#pragma once

#include "PluginProcessor.h"
#include "ui/Panels.h"
#include "ui/WaveformView.h"
#include "ui/Widgets.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <vector>

namespace djec::ui
{

/** Logo de la web (ondas + corte naranja). */
void paintLogo (juce::Graphics&, juce::Rectangle<float> area);

//==============================================================================================================
/** Zona compacta (en la cabecera) para soltar un archivo; con un archivo cargado dice dónde se ubicó. */
class DropZone final : public juce::Component, public juce::SettableTooltipClient
{
public:
    explicit DropZone (UiContext& ctx);
    void update (const djec::plugin::ViewState& vs);
    void setDragState (bool hovering, bool acceptable);
    void paint (juce::Graphics&) override;

private:
    bool hover = false, acceptable = true;
    bool showFile = false, warn = false, found = false;
    juce::String fileLine, alignLine;
};

//==============================================================================================================
class HeaderBar final : public juce::Component
{
public:
    /** dropZone va en el hueco entre el estado y el A/B. */
    HeaderBar (UiContext& ctx, juce::Component& dropZone);
    void update (const djec::plugin::ViewState& vs);
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    UiContext& ctx;
    Pill pill;
    Segmented ab { juce::StringArray { T (str::abOriginal), T (str::abEdited) } };
    juce::Component& drop;
    bool hasRender = false;
};

//==============================================================================================================
class StatusCard final : public juce::Component
{
public:
    explicit StatusCard (UiContext& ctx);
    /** notice: el aviso que se muestra (id 0 = ninguno, se muestra la ayuda de la fase). true si cambió algo. */
    bool update (const djec::plugin::ViewState& vs, const djec::plugin::Notice& notice);
    std::function<void (std::uint64_t)> onDismiss;
    int preferredHeight (int width) const;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    juce::Rectangle<int> textArea (juce::Rectangle<int> r) const;
    int buttonsWidth() const;
    UiContext& ctx;
    TextBlock status, secondary;
    IconButton close { IconButton::Icon::Close, T (str::closeNotice) };
    juce::TextButton barOne { T (str::barOne) };
    juce::TextButton retake { T (str::retake) };
    djec::plugin::Notice notice;
    bool warning = false;
};

//==============================================================================================================
class WaveCard final : public juce::Component
{
public:
    explicit WaveCard (UiContext& ctx);
    void update (const djec::plugin::ViewState& vs, bool sessionChanged);
    /** Referencia para «Mover el 1» / «Este beat es el 1»: el cabezal si está en la toma, si no el centro de la vista. */
    double referenceTime() const;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    enum class Placeholder
    {
        None,
        Empty,
        Taking,
        Loading,
        Processing,
        FilePending
    };
    void updateZoomButtons();
    void layoutToolbar (juce::Rectangle<int> bar);

    WaveformView wave;
    IconButton zoomOut { IconButton::Icon::ZoomOut, T (str::zoomOutTip) }, zoomIn { IconButton::Icon::ZoomIn, T (str::zoomInTip) };
    juce::TextButton zoomAll { T (str::zoomAll) };
    Spinner spinner;
    juce::String title, meta, legendText;
    bool legendRepeated = false;
    juce::Rectangle<int> legendArea, titleArea;
    Placeholder placeholder = Placeholder::Empty;
    juce::String takingLine;
    double playheadSec = std::numeric_limits<double>::quiet_NaN();
};

} // namespace djec::ui
