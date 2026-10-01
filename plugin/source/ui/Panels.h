// Paneles bajo la forma de onda (como los de la web, numerados): 1 Compases, 2 Recortar cada compás, 3 Quitar compases
// del final, 4 Resultado. Cada panel lee el ViewState del procesador y manda las órdenes de PluginProcessor.h; los
// ajustes (EditSettings) se leen siempre con getEditSettings() para que un clic se vea al instante, sin esperar a que
// el worker publique la sesión nueva.
#pragma once

#include "PluginProcessor.h"
#include "ui/Strings.h"
#include "ui/Theme.h"
#include "ui/Widgets.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>
#include <memory>
#include <vector>

namespace djec::ui
{

/** Lo que los paneles necesitan del editor. */
struct UiContext
{
    explicit UiContext (DjecAudioProcessor& p) : processor (p) {}
    DjecAudioProcessor& processor;
    /** Aviso local (errores de lo que escribió el usuario, exportación…). */
    std::function<void (const juce::String&, djec::plugin::NoticeKind)> message;
    /** Instante de la toma (s) para «Este beat es el 1» / «Mover el 1»: el cabezal de FL o el centro de la vista. */
    std::function<double()> referenceTime;
    /** El alto que necesita algún panel cambió. */
    std::function<void()> relayout;
};

/** ¿Mismos ajustes? (EditSettings no tiene operator==). */
bool sameSettings (const djec::EditSettings& a, const djec::EditSettings& b);

/** Coloca filas de arriba abajo; con apply = false solo mide. */
struct Stack
{
    juce::Rectangle<int> area;
    bool apply = true;
    int y = 0;
    Stack (juce::Rectangle<int> a, bool doApply) : area (a), apply (doApply), y (a.getY()) {}
    juce::Rectangle<int> take (int h)
    {
        juce::Rectangle<int> r (area.getX(), y, area.getWidth(), h);
        y += h;
        return r;
    }
    void place (juce::Component& c, int h)
    {
        const auto r = take (h);
        if (apply)
            c.setBounds (r);
    }
    void gap (int h = theme::rowGap) { y += h; }
    int used() const { return y - area.getY(); }
};

//==============================================================================================================
/** Tarjeta con título (número de paso + título + subtítulo + interruptor opcional). */
class Panel : public juce::Component
{
public:
    /** step 0 = sin número (ícono de resultado). */
    Panel (UiContext& ctx, int step, const juce::String& title, const juce::String& subtitle = {},
           bool withSwitch = false, juce::Colour switchColour = theme::accent);

    virtual void update (const djec::plugin::ViewState& vs, bool sessionChanged) = 0;
    int preferredHeight (int width);

    void paint (juce::Graphics&) override;
    void resized() override;

protected:
    /** Coloca el cuerpo en area y devuelve el alto usado (apply = false: solo mide). */
    virtual int layoutBody (juce::Rectangle<int> area, bool apply) = 0;
    Switch* headerSwitch() noexcept { return sw.get(); }
    /** Un control a la derecha de la cabecera (p. ej. «Restablecer»), de ese ancho. */
    void setHeaderExtra (juce::Component* c, int width);
    /** ¿El control extra cabe en la cabecera junto al título? (si no, el panel lo pone en el cuerpo) */
    bool extraInHeader (int panelWidth) const;
    void setStepActive (bool active, juce::Colour colour, juce::Colour textColour);
    /** Si cambió el alto que necesita el cuerpo, avisa al editor. */
    void bodyChanged();

    UiContext& ctx;

private:
    int headerHeight (int width) const;
    bool subtitleInline (int width) const;
    int titleWidth (int width) const;
    bool titleFits (int width) const;
    int step;
    juce::Component* extra = nullptr;
    int extraWidth = 0;
    juce::String title, subtitle;
    std::unique_ptr<Switch> sw;
    bool stepActive = false;
    juce::Colour stepColour = theme::surface3, stepText = theme::muted;
    int lastPreferred = -1;
};

/** Etiqueta de fila (.row-label). */
class RowLabel : public juce::Component
{
public:
    explicit RowLabel (const juce::String& text = {}, bool bold = true);
    void setText (const juce::String& t);
    void setColour (juce::Colour c);
    void setFontHeight (float h);
    int idealWidth() const;
    void paint (juce::Graphics&) override;

private:
    juce::String text;
    bool bold;
    float height = theme::fontBody;
    juce::Colour colour = theme::text;
};

//==============================================================================================================
/** 1 · Compases: Cuadrícula de FL / Detectar del audio y las correcciones de la web. */
class GridPanel final : public Panel
{
public:
    explicit GridPanel (UiContext& ctx);
    void update (const djec::plugin::ViewState& vs, bool sessionChanged) override;

private:
    int layoutBody (juce::Rectangle<int> area, bool apply) override;
    void changeTempo (double factor);
    void applyManualTempo();
    void tap();
    djec::plugin::GridMode shownMode() const;

    Segmented mode { juce::StringArray { T (str::gridHost), T (str::gridDetect) } };
    TextBlock info, help;
    Pill confidence;
    RowLabel manualLabel { T (str::tempoManual) }, meterLabel { T (str::beatsPerBar) },
        oneLabel { T (str::moveOne) }, sourceLabel { T (str::sourceMeter) };
    juce::TextButton tempoDouble { T (str::tempoDouble) }, tempoHalf { T (str::tempoHalf) }, applyBpm { T (str::apply) },
        tapButton { T (str::tap) }, thisOne { T (str::thisBeatIsOne) }, resetButton { T (str::reset) };
    juce::TextEditor bpm;
    TextBlock tapValue;
    juce::ComboBox meterBox;
    juce::ComboBox sourceBox;   // «Compás original» (cuadrícula de FL)
    void syncSourceBox (int num, int den);
    IconButton onePrev { IconButton::Icon::Prev, T (str::moveOnePrevTip) },
        oneNext { IconButton::Icon::Next, T (str::moveOneNextTip) };
    Spinner spinner;
    HintBox lowConf;

    std::shared_ptr<const djec::plugin::SessionView> session;
    // modo elegido con un clic (hasta que la sesión lo refleje)
    int pendingMode = -1;
    juce::int64 pendingSince = 0;
    int pendingMeter = -1;
    int pendingSource = -1;   // id elegido en «Compás original» hasta que la sesión lo refleje
    juce::int64 pendingSourceSince = 0;
    std::vector<double> taps;
    bool hasTake = false, detect = false, busy = false;
};

//==============================================================================================================
/** 2 · Recortar cada compás (cambia el compás de la canción). */
class TrimPanel final : public Panel
{
public:
    explicit TrimPanel (UiContext& ctx);
    void update (const djec::plugin::ViewState& vs, bool sessionChanged) override;

private:
    int layoutBody (juce::Rectangle<int> area, bool apply) override;
    void rebuildChips (const std::vector<djec::MeterAmountChip>& chips);
    void chooseAmount (const std::string& id);
    void otherChanged();
    void refreshControls();

    TextBlock offNote, amountLabel;
    std::vector<std::unique_ptr<Chip>> chips;
    std::vector<djec::MeterAmountChip> chipData;
    RowLabel otherLabel { T (str::otherMeter) }, slash { "/" };
    juce::TextEditor otherNum;
    juce::ComboBox otherDen;
    struct Summary : juce::Component
    {
        TextBlock change, desc, stats, hint;
        Summary();
        int heightFor (int w) const;
        void resized() override;
        void paint (juce::Graphics&) override;
    } summary;
    HintBox meterMsg;
    RowLabel xfadeLabel { T (str::crossfade) }, xfadeValue { {}, true };
    juce::Slider xfade { juce::Slider::LinearHorizontal, juce::Slider::NoTextBox };

    std::shared_ptr<const djec::plugin::SessionView> session;
    djec::EditSettings shownSettings;
    bool on = true;
    bool showOther = false;
};

//==============================================================================================================
/** 3 · Quitar compases del final. */
class EndPanel final : public Panel
{
public:
    explicit EndPanel (UiContext& ctx);
    void update (const djec::plugin::ViewState& vs, bool sessionChanged) override;

private:
    int layoutBody (juce::Rectangle<int> area, bool apply) override;
    void setBars (int n);
    void refreshControls();

    TextBlock offNote;
    RowLabel barsLabel { T (str::barsToRemove) }, barsValue { "1", true };
    IconButton minus { IconButton::Icon::Minus, T (str::barsMinusTip) }, plus { IconButton::Icon::Plus, T (str::barsPlusTip) };
    std::vector<std::unique_ptr<Chip>> chips;
    HintBox readout;
    RowLabel fadeLabel { T (str::fadeOut) }, fadeValue { {}, true };
    juce::Slider fade { juce::Slider::LinearHorizontal, juce::Slider::NoTextBox };
    struct Ticks : juce::Component
    {
        void paint (juce::Graphics&) override;
    } ticks;
    RowLabel curveLabel { T (str::fadeCurve) };
    juce::ComboBox curve;

    std::shared_ptr<const djec::plugin::SessionView> session;
    djec::EditSettings shownSettings;
    bool on = false;
    int maxBars = 0;
};

//==============================================================================================================
/** 4 · Resultado: arrastrar a FL y exportar WAV. */
class ResultPanel final : public Panel
{
public:
    explicit ResultPanel (UiContext& ctx);
    ~ResultPanel() override;
    void update (const djec::plugin::ViewState& vs, bool sessionChanged) override;

private:
    int layoutBody (juce::Rectangle<int> area, bool apply) override;
    void startExport();
    void exportFinished (const juce::Result& r, const juce::File& file);

    class DragHandle;
    TextBlock summary;
    std::unique_ptr<DragHandle> handle;
    Segmented bits { juce::StringArray { T (str::bits16), T (str::bits24) } };
    juce::TextButton exportButton { T (str::exportWav) };
    TextBlock fileName;
    HintBox status;
    std::unique_ptr<juce::FileChooser> chooser;

    std::shared_ptr<const djec::plugin::SessionView> session;
    bool exporting = false;
    juce::String exportMessage;
    bool exportFailed = false;
    std::uint64_t exportRenderId = 0;
};

} // namespace djec::ui
