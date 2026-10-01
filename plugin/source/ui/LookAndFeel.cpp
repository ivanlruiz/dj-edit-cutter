#include "ui/LookAndFeel.h"

#include "ui/Theme.h"

namespace djec::ui
{

namespace
{
juce::String& typefaceOverride()
{
    static juce::String name;
    return name;
}

juce::String platformTypefaceName()
{
   #if JUCE_WINDOWS
    return "Segoe UI";
   #elif JUCE_MAC
    return {};
   #else
    // Linux (CI, capturas): Liberation Sans tiene métricas parecidas a Segoe UI/Arial
    static const juce::String name = [] {
        const juce::StringArray all = juce::Font::findAllTypefaceNames();
        for (const char* n : { "Liberation Sans", "Noto Sans", "DejaVu Sans" })
            if (all.contains (n))
                return juce::String (n);
        return juce::String();
    }();
    return name;
   #endif
}
} // namespace

void setUiTypefaceName (const juce::String& name) { typefaceOverride() = name; }

juce::String getUiTypefaceName()
{
    return typefaceOverride().isNotEmpty() ? typefaceOverride() : platformTypefaceName();
}

juce::Font uiFont (float height, bool bold)
{
    const juce::String name = getUiTypefaceName();
    const int style = bold ? juce::Font::bold : juce::Font::plain;
    if (name.isEmpty())
        return juce::Font (juce::FontOptions (height, style));
    return juce::Font (juce::FontOptions (name, height, style));
}

juce::Font monoFont (float height, bool bold)
{
    // las cifras de Segoe UI / Liberation Sans ya son tabulares; se usa la misma familia para no mezclar estilos
    return uiFont (height, bold);
}

void drawFocusRing (juce::Graphics& g, juce::Rectangle<float> b, float cornerRadius)
{
    g.setColour (theme::focus);
    g.drawRoundedRectangle (b.expanded (2.0f), cornerRadius + 2.0f, 2.0f);
}

//==============================================================================================================

LookAndFeel::LookAndFeel()
{
    using namespace theme;
    setColourScheme ({ surface,        // windowBackground
                       bg,             // widgetBackground
                       surface2,       // menuBackground
                       border,         // outline
                       text,           // defaultText
                       surface3,       // defaultFill
                       onAccent,       // highlightedText
                       accent,         // highlightedFill
                       text });        // menuText

    setColour (juce::ResizableWindow::backgroundColourId, bg);
    setColour (juce::TextButton::buttonColourId, surface2);
    setColour (juce::TextButton::buttonOnColourId, accent);
    setColour (juce::TextButton::textColourOffId, text);
    setColour (juce::TextButton::textColourOnId, onAccent);
    setColour (juce::ComboBox::backgroundColourId, surface2);
    setColour (juce::ComboBox::outlineColourId, border);
    setColour (juce::ComboBox::textColourId, text);
    setColour (juce::ComboBox::arrowColourId, muted);
    setColour (juce::ComboBox::focusedOutlineColourId, focus);
    setColour (juce::PopupMenu::backgroundColourId, surface3);
    setColour (juce::PopupMenu::textColourId, text);
    setColour (juce::PopupMenu::highlightedBackgroundColourId, accentSoft);
    setColour (juce::PopupMenu::highlightedTextColourId, text);
    setColour (juce::TextEditor::backgroundColourId, surface2);
    setColour (juce::TextEditor::textColourId, text);
    setColour (juce::TextEditor::outlineColourId, border);
    setColour (juce::TextEditor::focusedOutlineColourId, focus);
    setColour (juce::TextEditor::highlightColourId, accent.withAlpha (0.35f));
    setColour (juce::TextEditor::highlightedTextColourId, text);
    setColour (juce::CaretComponent::caretColourId, accent);
    setColour (juce::Label::textColourId, text);
    setColour (juce::Slider::trackColourId, accent);
    setColour (juce::Slider::backgroundColourId, surface3);
    setColour (juce::Slider::thumbColourId, juce::Colours::white);
    setColour (juce::TooltipWindow::backgroundColourId, surface3);
    setColour (juce::TooltipWindow::textColourId, text);
    setColour (juce::TooltipWindow::outlineColourId, borderStrong);
    setColour (juce::ScrollBar::thumbColourId, borderStrong);
    setColour (juce::ScrollBar::trackColourId, juce::Colours::transparentBlack);
}

juce::Font LookAndFeel::getTextButtonFont (juce::TextButton&, int buttonHeight)
{
    return uiFont (juce::jmin (theme::fontBody, static_cast<float> (buttonHeight) * 0.55f), true);
}

void LookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& b, const juce::Colour& backgroundColour,
                                        bool highlighted, bool down)
{
    auto r = b.getLocalBounds().toFloat().reduced (0.5f);
    const bool on = b.getToggleState();
    // "plain" = botón normal de la web (.btn); si no, botón de color (primary) o transparente (ghost)
    const bool ghost = backgroundColour.isTransparent();
    const bool plain = ghost || backgroundColour == theme::surface2;
    juce::Colour fill = on ? b.findColour (juce::TextButton::buttonOnColourId) : backgroundColour;
    juce::Colour edge = on ? fill : (plain ? theme::border : backgroundColour);
    if (! b.isEnabled())
    {
        fill = fill.withMultipliedAlpha (0.45f);
        edge = edge.withMultipliedAlpha (0.45f);
    }
    else if (down)
        fill = on || ! plain ? fill.darker (0.12f) : theme::surface3.brighter (0.05f);
    else if (highlighted)
    {
        fill = on || ! plain ? fill.brighter (0.10f) : theme::surface3;
        edge = on || ! plain ? fill : theme::borderStrong;
    }
    const float rad = static_cast<float> (b.getProperties().getWithDefault ("radius", theme::radiusSm));
    g.setColour (fill);
    g.fillRoundedRectangle (r, rad);
    g.setColour (edge);
    g.drawRoundedRectangle (r, rad, 1.0f);
    if (b.hasKeyboardFocus (false) && b.isShowing())
        drawFocusRing (g, r, rad);
}

void LookAndFeel::drawButtonText (juce::Graphics& g, juce::TextButton& b, bool, bool)
{
    const juce::Font font = getTextButtonFont (b, b.getHeight());
    g.setFont (font);
    juce::Colour c = b.findColour (b.getToggleState() ? juce::TextButton::textColourOnId : juce::TextButton::textColourOffId);
    if (! b.isEnabled())
        c = c.withMultipliedAlpha (0.5f);
    g.setColour (c);
    g.drawFittedText (b.getButtonText(), b.getLocalBounds().reduced (8, 2), juce::Justification::centred, 2, 0.9f);
}

void LookAndFeel::drawComboBox (juce::Graphics& g, int width, int height, bool, int, int, int, int, juce::ComboBox& box)
{
    auto r = juce::Rectangle<float> (0, 0, static_cast<float> (width), static_cast<float> (height)).reduced (0.5f);
    const bool hover = box.isMouseOver (true) && box.isEnabled();
    g.setColour (hover ? theme::surface3 : theme::surface2);
    g.fillRoundedRectangle (r, theme::radiusSm);
    g.setColour (hover ? theme::borderStrong : theme::border);
    g.drawRoundedRectangle (r, theme::radiusSm, 1.0f);
    // flecha
    const float cx = static_cast<float> (width) - 14.0f, cy = static_cast<float> (height) * 0.5f;
    juce::Path p;
    p.startNewSubPath (cx - 4.5f, cy - 2.0f);
    p.lineTo (cx, cy + 2.5f);
    p.lineTo (cx + 4.5f, cy - 2.0f);
    g.setColour (box.isEnabled() ? theme::muted : theme::muted.withAlpha (0.4f));
    g.strokePath (p, juce::PathStrokeType (1.6f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    if (box.hasKeyboardFocus (true))
        drawFocusRing (g, r, theme::radiusSm);
}

juce::Font LookAndFeel::getComboBoxFont (juce::ComboBox&) { return uiFont (theme::fontBody, true); }

void LookAndFeel::positionComboBoxText (juce::ComboBox& box, juce::Label& label)
{
    label.setBounds (4, 1, box.getWidth() - 26, box.getHeight() - 2);
    label.setFont (getComboBoxFont (box));
    label.setJustificationType (juce::Justification::centredLeft);
}

juce::Font LookAndFeel::getPopupMenuFont() { return uiFont (theme::fontBody); }

void LookAndFeel::drawPopupMenuBackground (juce::Graphics& g, int width, int height)
{
    g.fillAll (theme::surface3);
    g.setColour (theme::borderStrong);
    g.drawRect (0, 0, width, height, 1);
}

void LookAndFeel::drawPopupMenuItem (juce::Graphics& g, const juce::Rectangle<int>& area, bool isSeparator,
                                     bool isActive, bool isHighlighted, bool isTicked, bool, const juce::String& text,
                                     const juce::String&, const juce::Drawable*, const juce::Colour*)
{
    if (isSeparator)
    {
        g.setColour (theme::border);
        g.fillRect (area.reduced (8, 0).withHeight (1).withCentre (area.getCentre()));
        return;
    }
    auto r = area.reduced (3, 1);
    if (isHighlighted && isActive)
    {
        g.setColour (theme::accentSoft);
        g.fillRoundedRectangle (r.toFloat(), 6.0f);
    }
    if (isTicked)
    {
        g.setColour (theme::accent);
        g.fillEllipse (juce::Rectangle<float> (6.0f, 6.0f).withCentre ({ static_cast<float> (r.getX()) + 12.0f,
                                                                          static_cast<float> (r.getCentreY()) }));
    }
    g.setColour (isActive ? theme::text : theme::muted.withAlpha (0.6f));
    g.setFont (getPopupMenuFont());
    g.drawFittedText (text, r.withTrimmedLeft (24).withTrimmedRight (8), juce::Justification::centredLeft, 1);
}

void LookAndFeel::getIdealPopupMenuItemSize (const juce::String& text, bool isSeparator, int, int& idealWidth,
                                             int& idealHeight)
{
    if (isSeparator)
    {
        idealWidth = 50;
        idealHeight = 9;
        return;
    }
    idealHeight = 28;
    idealWidth = juce::GlyphArrangement::getStringWidthInt (getPopupMenuFont(), text) + 40;
}

int LookAndFeel::getSliderThumbRadius (juce::Slider&) { return 8; }

void LookAndFeel::drawLinearSlider (juce::Graphics& g, int x, int y, int width, int height, float sliderPos, float,
                                    float, juce::Slider::SliderStyle, juce::Slider& s)
{
    const float cy = static_cast<float> (y) + static_cast<float> (height) * 0.5f;
    const float x0 = static_cast<float> (x), x1 = static_cast<float> (x + width);
    const juce::Colour fill = s.findColour (juce::Slider::trackColourId);
    const float alpha = s.isEnabled() ? 1.0f : 0.45f;
    g.setColour (theme::surface3.withMultipliedAlpha (alpha));
    g.fillRoundedRectangle (juce::Rectangle<float> (x0, cy - 3.0f, x1 - x0, 6.0f), 3.0f);
    g.setColour (theme::borderStrong.withMultipliedAlpha (alpha));
    g.drawRoundedRectangle (juce::Rectangle<float> (x0, cy - 3.0f, x1 - x0, 6.0f), 3.0f, 1.0f);
    g.setColour (fill.withMultipliedAlpha (alpha));
    g.fillRoundedRectangle (juce::Rectangle<float> (x0, cy - 3.0f, juce::jmax (0.0f, sliderPos - x0), 6.0f), 3.0f);
    const auto thumb = juce::Rectangle<float> (16.0f, 16.0f).withCentre ({ sliderPos, cy });
    g.setColour (juce::Colours::black.withAlpha (0.35f * alpha));
    g.fillEllipse (thumb.translated (0, 1.0f));
    g.setColour (juce::Colours::white.withMultipliedAlpha (alpha));
    g.fillEllipse (thumb);
    g.setColour (fill.withMultipliedAlpha (alpha));
    g.drawEllipse (thumb.reduced (0.5f), 1.5f);
    if (s.hasKeyboardFocus (false))
        drawFocusRing (g, thumb, 8.0f);
}

void LookAndFeel::fillTextEditorBackground (juce::Graphics& g, int width, int height, juce::TextEditor& e)
{
    g.setColour (e.findColour (juce::TextEditor::backgroundColourId));
    g.fillRoundedRectangle (juce::Rectangle<float> (static_cast<float> (width), static_cast<float> (height)).reduced (0.5f),
                            theme::radiusSm);
}

void LookAndFeel::drawTextEditorOutline (juce::Graphics& g, int width, int height, juce::TextEditor& e)
{
    const auto r = juce::Rectangle<float> (static_cast<float> (width), static_cast<float> (height)).reduced (0.5f);
    const bool invalid = static_cast<bool> (e.getProperties().getWithDefault ("invalid", false));
    if (invalid)
    {
        g.setColour (theme::danger);
        g.drawRoundedRectangle (r.reduced (0.5f), theme::radiusSm, 2.0f);
        return;
    }
    if (e.hasKeyboardFocus (true) && ! e.isReadOnly())
    {
        g.setColour (theme::focus);
        g.drawRoundedRectangle (r.reduced (0.5f), theme::radiusSm, 2.0f);
        return;
    }
    g.setColour (e.isMouseOver (true) ? theme::borderStrong : theme::border);
    g.drawRoundedRectangle (r, theme::radiusSm, 1.0f);
}

juce::TextLayout LookAndFeel::tooltipLayout (const juce::String& text) const
{
    juce::AttributedString s;
    s.setJustification (juce::Justification::topLeft);
    s.append (text, uiFont (theme::fontSmall), theme::text);
    juce::TextLayout tl;
    tl.createLayoutWithBalancedLineLengths (s, 320.0f);
    return tl;
}

juce::Rectangle<int> LookAndFeel::getTooltipBounds (const juce::String& tipText, juce::Point<int> screenPos,
                                                    juce::Rectangle<int> parentArea)
{
    const juce::TextLayout tl = tooltipLayout (tipText);
    const int w = static_cast<int> (std::ceil (tl.getWidth())) + 20;
    const int h = static_cast<int> (std::ceil (tl.getHeight())) + 12;
    return juce::Rectangle<int> (screenPos.x > parentArea.getCentreX() ? screenPos.x - (w + 12) : screenPos.x + 18,
                                 screenPos.y > parentArea.getCentreY() ? screenPos.y - (h + 8) : screenPos.y + 18, w, h)
        .constrainedWithin (parentArea);
}

void LookAndFeel::drawTooltip (juce::Graphics& g, const juce::String& text, int width, int height)
{
    g.fillAll (theme::surface3);
    g.setColour (theme::borderStrong);
    g.drawRect (0, 0, width, height, 1);
    tooltipLayout (text).draw (g, juce::Rectangle<float> (static_cast<float> (width), static_cast<float> (height)).reduced (10.0f, 6.0f));
}

void LookAndFeel::drawScrollbar (juce::Graphics& g, juce::ScrollBar&, int x, int y, int width, int height, bool vertical,
                                 int thumbStart, int thumbSize, bool isMouseOver, bool isMouseDown)
{
    juce::Rectangle<int> thumb;
    if (vertical)
        thumb = { x + 2, thumbStart, width - 4, thumbSize };
    else
        thumb = { thumbStart, y + 2, thumbSize, height - 4 };
    g.setColour (isMouseDown ? theme::muted : isMouseOver ? theme::borderStrong.brighter (0.2f) : theme::borderStrong);
    g.fillRoundedRectangle (thumb.toFloat(), 3.0f);
}

juce::Font LookAndFeel::getLabelFont (juce::Label& l)
{
    return uiFont (l.getFont().getHeight(), l.getFont().isBold());
}

} // namespace djec::ui
