// Aspecto del plugin: tema oscuro de la web (Theme.h) para los controles de JUCE (botones, desplegables, deslizadores,
// cajas de texto, menús, ayudas emergentes, barras de desplazamiento) y la tipografía de la interfaz.
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace djec::ui
{

/** Fuente de la interfaz (Segoe UI en Windows, como la web con system-ui). */
juce::Font uiFont (float height, bool bold = false);
/** Fuente de números (cifras de ancho fijo para tiempos que cambian). */
juce::Font monoFont (float height, bool bold = false);
/** Cambia la familia de la interfaz (la herramienta de capturas prueba con otras); "" = la de la plataforma. */
void setUiTypefaceName (const juce::String& name);
juce::String getUiTypefaceName();

class LookAndFeel final : public juce::LookAndFeel_V4
{
public:
    LookAndFeel();

    juce::Font getTextButtonFont (juce::TextButton&, int buttonHeight) override;
    void drawButtonBackground (juce::Graphics&, juce::Button&, const juce::Colour& backgroundColour,
                               bool highlighted, bool down) override;
    void drawButtonText (juce::Graphics&, juce::TextButton&, bool highlighted, bool down) override;

    void drawComboBox (juce::Graphics&, int width, int height, bool isButtonDown, int buttonX, int buttonY,
                       int buttonW, int buttonH, juce::ComboBox&) override;
    juce::Font getComboBoxFont (juce::ComboBox&) override;
    void positionComboBoxText (juce::ComboBox&, juce::Label&) override;

    juce::Font getPopupMenuFont() override;
    void drawPopupMenuBackground (juce::Graphics&, int width, int height) override;
    void drawPopupMenuItem (juce::Graphics&, const juce::Rectangle<int>& area, bool isSeparator, bool isActive,
                            bool isHighlighted, bool isTicked, bool hasSubMenu, const juce::String& text,
                            const juce::String& shortcutKeyText, const juce::Drawable* icon,
                            const juce::Colour* textColour) override;
    void getIdealPopupMenuItemSize (const juce::String& text, bool isSeparator, int standardMenuItemHeight,
                                    int& idealWidth, int& idealHeight) override;

    int getSliderThumbRadius (juce::Slider&) override;
    void drawLinearSlider (juce::Graphics&, int x, int y, int width, int height, float sliderPos, float minSliderPos,
                           float maxSliderPos, juce::Slider::SliderStyle, juce::Slider&) override;

    void fillTextEditorBackground (juce::Graphics&, int width, int height, juce::TextEditor&) override;
    void drawTextEditorOutline (juce::Graphics&, int width, int height, juce::TextEditor&) override;

    juce::Rectangle<int> getTooltipBounds (const juce::String& tipText, juce::Point<int> screenPos,
                                           juce::Rectangle<int> parentArea) override;
    void drawTooltip (juce::Graphics&, const juce::String& text, int width, int height) override;

    int getDefaultScrollbarWidth() override { return 10; }
    void drawScrollbar (juce::Graphics&, juce::ScrollBar&, int x, int y, int width, int height, bool vertical,
                        int thumbStart, int thumbSize, bool isMouseOver, bool isMouseDown) override;

    juce::Font getLabelFont (juce::Label&) override;

private:
    juce::TextLayout tooltipLayout (const juce::String& text) const;
};

/** Anillo de foco (solo con el teclado: los clics no se llevan el foco). */
void drawFocusRing (juce::Graphics&, juce::Rectangle<float> bounds, float cornerRadius);

} // namespace djec::ui
