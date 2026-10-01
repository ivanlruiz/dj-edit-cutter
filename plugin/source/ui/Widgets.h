// Piezas de la interfaz con el aspecto de la web: tarjetas, texto con ajuste de línea que sabe cuánto mide, cajas de
// aviso, interruptor, botones de opción ("chips"), control segmentado, botones con icono y un indicador de actividad.
#pragma once

#include "ui/Theme.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>
#include <memory>
#include <vector>

namespace djec::ui
{

/** Tarjeta redondeada (fondo surface + borde), como .card de la web. */
void paintCard (juce::Graphics&, juce::Rectangle<float> bounds, juce::Colour fill = theme::surface,
                juce::Colour outline = theme::border, float radius = theme::radius);
/** Rayado diagonal dentro de r (zonas que se quitan). */
void paintHatch (juce::Graphics&, juce::Rectangle<float> r, juce::Colour colour, float spacing, float thickness = 1.2f);
/** Medida de un texto de una línea. */
int textWidth (const juce::Font&, const juce::String&);

//==============================================================================================================
/** Texto con ajuste de línea (TextLayout). heightFor(ancho) dice cuánto alto necesita. */
class TextBlock : public juce::Component
{
public:
    TextBlock();
    void setText (const juce::String& text);
    void setStyle (const juce::Font& font, juce::Colour colour,
                   juce::Justification just = juce::Justification::topLeft);
    void setColourOnly (juce::Colour colour);
    void setMaxLines (int n) { maxLines = n; repaint(); }
    const juce::String& getText() const noexcept { return text; }
    int heightFor (int width) const;
    void paint (juce::Graphics&) override;

private:
    juce::AttributedString build() const;
    juce::String text;
    juce::Font font;
    juce::Colour colour = theme::text;
    juce::Justification just = juce::Justification::topLeft;
    int maxLines = 0;
};

//==============================================================================================================
/** Caja de aviso (.hint de la web): fondo suave, borde y texto. */
class HintBox : public juce::Component
{
public:
    enum class Kind
    {
        Info,
        Warn,
        Error,
        Meter,
        Ok,
        Cut
    };
    HintBox();
    void set (const juce::String& text, Kind kind);
    const juce::String& getText() const noexcept { return body.getText(); }
    int heightFor (int width) const;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    Kind kind = Kind::Info;
    TextBlock body;
};

//==============================================================================================================
/** Interruptor (.switch de la web). */
class Switch : public juce::ToggleButton
{
public:
    explicit Switch (juce::Colour onColour = theme::accent);
    void setOnColour (juce::Colour c) { on = c; repaint(); }
    void paintButton (juce::Graphics&, bool highlighted, bool down) override;

private:
    juce::Colour on;
};

//==============================================================================================================
/** Botón de opción: "½ tiempo (corchea)  → 7/8" (.amount-chip) o un número ("4"). */
class Chip : public juce::Button
{
public:
    Chip();
    void setContent (const juce::String& main, const juce::String& note, const juce::String& result);
    void setAccent (juce::Colour fillWhenOn, juce::Colour textWhenOn, juce::Colour resultColour);
    void setCentred (bool c) { centred = c; repaint(); }
    void paintButton (juce::Graphics&, bool highlighted, bool down) override;
    int idealWidth() const;
    /** Alto que necesita con este ancho (el texto pasa a 2 o 3 líneas si hace falta; mínimo 32). */
    int heightFor (int width) const;

private:
    juce::TextLayout textLayout (int width, bool on) const;
    int resultWidth() const;
    juce::String main, note, result;
    juce::Colour fillOn = theme::meter, textOn = theme::onMeter, resultColour = theme::meter;
    bool centred = false;
};

//==============================================================================================================
/** Control segmentado: varias opciones, una elegida (A/B, cuadrícula, 16/24 bits). */
class Segmented : public juce::Component
{
public:
    explicit Segmented (const juce::StringArray& labels);
    ~Segmented() override;
    std::function<void (int)> onChange;
    void setSelected (int index);
    int getSelected() const noexcept { return selected; }
    void setAccent (juce::Colour fill, juce::Colour textOn);
    void setTooltips (const juce::StringArray& tips);
    void setTooltipAll (const juce::String& tip);
    void setFontHeight (float h) { fontHeight = h; repaint(); }
    int idealWidth() const;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    class Segment;
    std::vector<std::unique_ptr<Segment>> segments;
    int selected = 0;
    juce::Colour fill = theme::accent, textOn = theme::onAccent;
    float fontHeight = theme::fontSmall;
    friend class Segment;
};

//==============================================================================================================
/** Botón con un icono vectorial. */
class IconButton : public juce::Button
{
public:
    enum class Icon
    {
        Prev,
        Next,
        Minus,
        Plus,
        Close,
        ZoomIn,
        ZoomOut
    };
    IconButton (Icon icon, const juce::String& tooltip);
    void paintButton (juce::Graphics&, bool highlighted, bool down) override;
    void setFlat (bool f) { flat = f; repaint(); }

private:
    Icon icon;
    bool flat = false;
};

//==============================================================================================================
/** Indicador de actividad (.spinner). */
class Spinner : public juce::Component, private juce::Timer
{
public:
    Spinner();
    void setActive (bool a);
    void paint (juce::Graphics&) override;

private:
    void timerCallback() override;
    float angle = 0;
    bool active = false;
};

/** Insignia redondeada con punto (.badge de la web): estado en la cabecera, confianza de la detección. */
class Pill : public juce::Component
{
public:
    Pill();
    void set (const juce::String& text, juce::Colour fg, juce::Colour bg, bool pulse = false);
    int idealWidth() const;
    void paint (juce::Graphics&) override;

private:
    juce::String text;
    juce::Colour fg = theme::muted, bg = theme::surface3;
    bool pulse = false;
};

/** Botón de texto con el estilo de la web; variante "primary" (azul) y "ghost" (transparente). */
void styleButton (juce::TextButton&, const juce::String& tooltip = {});
void stylePrimary (juce::TextButton&);
void styleGhost (juce::TextButton&);
/** Las pulsaciones con el ratón no se llevan el foco (el anillo de foco solo aparece con Tab). */
void noClickFocus (juce::Component&);

} // namespace djec::ui
