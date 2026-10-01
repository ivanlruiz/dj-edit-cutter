#include "ui/Widgets.h"

#include "ui/LookAndFeel.h"

#include <cmath>

namespace djec::ui
{

void paintCard (juce::Graphics& g, juce::Rectangle<float> b, juce::Colour fill, juce::Colour outline, float radius)
{
    g.setColour (fill);
    g.fillRoundedRectangle (b.reduced (0.5f), radius);
    g.setColour (outline);
    g.drawRoundedRectangle (b.reduced (0.5f), radius, 1.0f);
}

void paintHatch (juce::Graphics& g, juce::Rectangle<float> r, juce::Colour colour, float spacing, float thickness)
{
    if (r.isEmpty())
        return;
    juce::Graphics::ScopedSaveState save (g);
    g.reduceClipRegion (r.getSmallestIntegerContainer());
    g.setColour (colour);
    // líneas a 45° (de abajo a la izquierda hacia arriba a la derecha) alineadas a la rejilla absoluta, así trozos
    // contiguos se ven continuos
    const float h = r.getHeight();
    const float start = std::floor ((r.getX() - h) / spacing) * spacing;
    for (float x = start; x < r.getRight(); x += spacing)
        g.drawLine (x, r.getBottom(), x + h, r.getY(), thickness);
}

int textWidth (const juce::Font& f, const juce::String& s)
{
    return juce::GlyphArrangement::getStringWidthInt (f, s);
}

//==============================================================================================================

TextBlock::TextBlock() : font (uiFont (theme::fontBody))
{
    setInterceptsMouseClicks (false, false);
}

void TextBlock::setText (const juce::String& t)
{
    if (t == text)
        return;
    text = t;
    repaint();
}

void TextBlock::setStyle (const juce::Font& f, juce::Colour c, juce::Justification j)
{
    font = f;
    colour = c;
    just = j;
    repaint();
}

void TextBlock::setColourOnly (juce::Colour c)
{
    if (c == colour)
        return;
    colour = c;
    repaint();
}

juce::AttributedString TextBlock::build() const
{
    juce::AttributedString s;
    s.setJustification (just);
    s.setWordWrap (juce::AttributedString::byWord);
    s.setLineSpacing (1.0f);
    s.append (text, font, colour);
    return s;
}

int TextBlock::heightFor (int width) const
{
    if (text.isEmpty() || width <= 0)
        return 0;
    juce::TextLayout tl;
    tl.createLayout (build(), static_cast<float> (width));
    int lines = tl.getNumLines();
    if (maxLines > 0 && lines > maxLines)
    {
        float h = 0;
        for (int i = 0; i < maxLines; ++i)
            h += tl.getLine (i).getLineBoundsY().getLength();
        return static_cast<int> (std::ceil (h)) + 1;
    }
    return static_cast<int> (std::ceil (tl.getHeight())) + 1;
}

void TextBlock::paint (juce::Graphics& g)
{
    if (text.isEmpty())
        return;
    juce::TextLayout tl;
    tl.createLayout (build(), static_cast<float> (getWidth()));
    juce::Graphics::ScopedSaveState save (g);
    g.reduceClipRegion (getLocalBounds());
    tl.draw (g, getLocalBounds().toFloat());
}

//==============================================================================================================

HintBox::HintBox()
{
    body.setStyle (uiFont (theme::fontSmall), theme::text);
    addAndMakeVisible (body);
    setInterceptsMouseClicks (false, false);
}

void HintBox::set (const juce::String& text, Kind k)
{
    kind = k;
    body.setText (text);
    body.setColourOnly (k == Kind::Info ? theme::muted : theme::text);
    repaint();
}

int HintBox::heightFor (int width) const
{
    if (body.getText().isEmpty())
        return 0;
    return body.heightFor (width - 24) + 14;
}

void HintBox::resized()
{
    body.setBounds (getLocalBounds().reduced (12, 7));
}

void HintBox::paint (juce::Graphics& g)
{
    juce::Colour fill = theme::surface2, edge = theme::border;
    switch (kind)
    {
        case Kind::Warn: fill = theme::warnSoft; edge = theme::warn.withAlpha (0.35f); break;
        case Kind::Error: fill = theme::dangerSoft; edge = theme::danger.withAlpha (0.45f); break;
        case Kind::Meter: fill = theme::meterSoft; edge = theme::meter.withAlpha (0.35f); break;
        case Kind::Ok: fill = theme::okSoft; edge = theme::ok.withAlpha (0.35f); break;
        case Kind::Cut: fill = theme::cutSoft; edge = theme::cut.withAlpha (0.35f); break;
        case Kind::Info: break;
    }
    paintCard (g, getLocalBounds().toFloat(), fill, edge, theme::radiusSm);
}

//==============================================================================================================

Switch::Switch (juce::Colour onColour) : on (onColour)
{
    setClickingTogglesState (true);
    noClickFocus (*this);
}

void Switch::paintButton (juce::Graphics& g, bool highlighted, bool)
{
    auto b = getLocalBounds().toFloat();
    const auto track = juce::Rectangle<float> (40.0f, 23.0f).withCentre (b.getCentre());
    const bool st = getToggleState();
    const float a = isEnabled() ? 1.0f : 0.45f;
    g.setColour ((st ? on : theme::surface3).withMultipliedAlpha (a));
    g.fillRoundedRectangle (track, track.getHeight() * 0.5f);
    g.setColour ((st ? on : (highlighted ? theme::muted : theme::borderStrong)).withMultipliedAlpha (a));
    g.drawRoundedRectangle (track.reduced (0.5f), track.getHeight() * 0.5f, 1.0f);
    const float d = track.getHeight() - 5.0f;
    const float x = st ? track.getRight() - 2.5f - d : track.getX() + 2.5f;
    const auto knob = juce::Rectangle<float> (x, track.getY() + 2.5f, d, d);
    g.setColour (juce::Colours::black.withAlpha (0.35f * a));
    g.fillEllipse (knob.translated (0, 1.0f));
    g.setColour (juce::Colours::white.withMultipliedAlpha (a));
    g.fillEllipse (knob);
    if (hasKeyboardFocus (false))
        drawFocusRing (g, track, track.getHeight() * 0.5f);
}

//==============================================================================================================

Chip::Chip() : juce::Button ({})
{
    noClickFocus (*this);
}

void Chip::setContent (const juce::String& m, const juce::String& n, const juce::String& r)
{
    if (m == main && n == note && r == result)
        return;
    main = m;
    note = n;
    result = r;
    setTitle (n.isEmpty() ? m : m + " " + n);
    repaint();
}

void Chip::setAccent (juce::Colour f, juce::Colour t, juce::Colour r)
{
    fillOn = f;
    textOn = t;
    resultColour = r;
    repaint();
}

int Chip::resultWidth() const
{
    return result.isEmpty() ? 0 : textWidth (uiFont (theme::fontBody, true), result) + 8;
}

int Chip::idealWidth() const
{
    const juce::Font fm = uiFont (theme::fontSmall, true), fn = uiFont (theme::fontSmall);
    int w = textWidth (fm, main) + 22;
    if (note.isNotEmpty())
        w += textWidth (fn, " " + note);
    return w + resultWidth();
}

juce::TextLayout Chip::textLayout (int width, bool on) const
{
    const float a = isEnabled() ? 1.0f : 0.4f;
    const int avail = juce::jmax (10, width - 22 - resultWidth());
    // si una palabra sola no cabe (columna estrecha, fuente ancha), la letra se achica en vez de cortarse
    float k = 1.0f;
    for (const float scale : { 1.0f, 0.9f, 0.82f, 0.75f })
    {
        k = scale;
        int widest = 0;
        juce::StringArray words;
        words.addTokens (main + " " + note, " ", "");
        for (const auto& wd : words)
            widest = juce::jmax (widest, textWidth (uiFont (theme::fontSmall * scale, true), wd));
        if (widest <= avail)
            break;
    }
    juce::AttributedString s;
    s.setJustification (juce::Justification::centredLeft);
    s.setWordWrap (juce::AttributedString::byWord);
    s.append (main, uiFont (theme::fontSmall * k, true), (on ? textOn : theme::text).withMultipliedAlpha (a));
    if (note.isNotEmpty())
        s.append (" " + note, uiFont (theme::fontSmall * k), (on ? textOn : theme::muted).withMultipliedAlpha (a));
    juce::TextLayout tl;
    tl.createLayout (s, static_cast<float> (avail));
    return tl;
}

int Chip::heightFor (int width) const
{
    if (centred && result.isEmpty())
        return 30;
    const juce::TextLayout tl = textLayout (width, false);
    return juce::jmax (32, static_cast<int> (std::ceil (tl.getHeight())) + 12);
}

void Chip::paintButton (juce::Graphics& g, bool highlighted, bool down)
{
    auto b = getLocalBounds().toFloat().reduced (0.5f);
    const bool st = getToggleState();
    const float a = isEnabled() ? 1.0f : 0.4f;
    juce::Colour fill = st ? fillOn : (highlighted || down ? theme::surface3 : theme::surface2);
    juce::Colour edge = st ? fillOn : (highlighted ? theme::borderStrong : theme::border);
    g.setColour (fill.withMultipliedAlpha (a));
    g.fillRoundedRectangle (b, theme::radiusSm);
    g.setColour (edge.withMultipliedAlpha (a));
    g.drawRoundedRectangle (b, theme::radiusSm, 1.0f);
    if (hasKeyboardFocus (false))
        drawFocusRing (g, b, theme::radiusSm);

    if (centred && result.isEmpty())
    {
        g.setFont (uiFont (theme::fontSmall, true));
        g.setColour ((st ? textOn : theme::text).withMultipliedAlpha (a));
        g.drawText (main, getLocalBounds(), juce::Justification::centred, false);
        return;
    }
    auto r = getLocalBounds().reduced (11, 0);
    if (result.isNotEmpty())
    {
        g.setFont (uiFont (theme::fontBody, true));
        g.setColour ((st ? textOn : resultColour).withMultipliedAlpha (a));
        g.drawText (result, r.removeFromRight (resultWidth()), juce::Justification::centredRight, false);
    }
    const juce::TextLayout tl = textLayout (getWidth(), st);
    const float h = juce::jmin (tl.getHeight(), static_cast<float> (getHeight()));
    tl.draw (g, r.toFloat().withSizeKeepingCentre (static_cast<float> (r.getWidth()), h));
}

//==============================================================================================================

class Segmented::Segment final : public juce::Button
{
public:
    Segment (Segmented& o, int i, const juce::String& label) : juce::Button (label), owner (o), index (i)
    {
        noClickFocus (*this);
        onClick = [this] {
            if (owner.selected == index)
                return;
            owner.setSelected (index);
            if (owner.onChange)
                owner.onChange (index);
        };
    }

    void paintButton (juce::Graphics& g, bool highlighted, bool down) override
    {
        const bool st = owner.selected == index;
        const float a = isEnabled() ? 1.0f : 0.45f;
        auto b = getLocalBounds().toFloat().reduced (2.0f);
        if (st)
        {
            g.setColour (owner.fill.withMultipliedAlpha (a));
            g.fillRoundedRectangle (b, theme::radiusSm - 2.0f);
        }
        else if (highlighted || down)
        {
            g.setColour (theme::surface3.withMultipliedAlpha (a));
            g.fillRoundedRectangle (b, theme::radiusSm - 2.0f);
        }
        if (hasKeyboardFocus (false))
            drawFocusRing (g, b, theme::radiusSm - 2.0f);
        g.setFont (uiFont (owner.fontHeight, true));
        g.setColour ((st ? owner.textOn : theme::text).withMultipliedAlpha (st ? 1.0f : a * 0.92f));
        g.drawFittedText (getButtonText(), getLocalBounds().reduced (6, 0), juce::Justification::centred, 1, 0.85f);
    }

private:
    Segmented& owner;
    int index;
};

Segmented::Segmented (const juce::StringArray& labels)
{
    for (int i = 0; i < labels.size(); ++i)
    {
        segments.push_back (std::make_unique<Segment> (*this, i, labels[i]));
        addAndMakeVisible (*segments.back());
    }
    setFocusContainerType (FocusContainerType::none);
}

Segmented::~Segmented() = default;

void Segmented::setSelected (int index)
{
    if (index == selected)
        return;
    selected = index;
    for (auto& s : segments)
        s->repaint();
}

void Segmented::setAccent (juce::Colour f, juce::Colour t)
{
    fill = f;
    textOn = t;
    repaint();
    for (auto& s : segments)
        s->repaint();
}

void Segmented::setTooltips (const juce::StringArray& tips)
{
    for (std::size_t i = 0; i < segments.size(); ++i)
        segments[i]->setTooltip (tips[static_cast<int> (i)]);
}

void Segmented::setTooltipAll (const juce::String& tip)
{
    for (auto& s : segments)
        s->setTooltip (tip);
}

int Segmented::idealWidth() const
{
    int w = 6;
    for (auto& s : segments)
        w += textWidth (uiFont (fontHeight, true), s->getButtonText()) + 26;
    return w;
}

void Segmented::paint (juce::Graphics& g)
{
    paintCard (g, getLocalBounds().toFloat(), theme::surface2, theme::border, theme::radiusSm);
}

void Segmented::resized()
{
    if (segments.empty())
        return;
    // ancho proporcional al texto (con un mínimo igual para todos)
    auto r = getLocalBounds().reduced (1);
    std::vector<int> want;
    int total = 0;
    for (auto& s : segments)
    {
        want.push_back (textWidth (uiFont (fontHeight, true), s->getButtonText()) + 20);
        total += want.back();
    }
    const int avail = r.getWidth();
    int x = r.getX();
    for (std::size_t i = 0; i < segments.size(); ++i)
    {
        const int w = i + 1 == segments.size() ? r.getRight() - x
                                                : static_cast<int> (std::round (static_cast<double> (avail) * want[i] / juce::jmax (1, total)));
        segments[i]->setBounds (x, r.getY(), w, r.getHeight());
        x += w;
    }
}

//==============================================================================================================

IconButton::IconButton (Icon i, const juce::String& tooltip) : juce::Button (tooltip), icon (i)
{
    setTooltip (tooltip);
    setTitle (tooltip);
    noClickFocus (*this);
}

void IconButton::paintButton (juce::Graphics& g, bool highlighted, bool down)
{
    auto b = getLocalBounds().toFloat().reduced (0.5f);
    const float a = isEnabled() ? 1.0f : 0.4f;
    if (! flat || highlighted || down)
    {
        g.setColour ((highlighted || down ? theme::surface3 : theme::surface2).withMultipliedAlpha (flat ? 1.0f : a));
        g.fillRoundedRectangle (b, theme::radiusSm);
        if (! flat)
        {
            g.setColour ((highlighted ? theme::borderStrong : theme::border).withMultipliedAlpha (a));
            g.drawRoundedRectangle (b, theme::radiusSm, 1.0f);
        }
    }
    if (hasKeyboardFocus (false))
        drawFocusRing (g, b, theme::radiusSm);

    const auto c = b.getCentre();
    const float s = juce::jmin (b.getWidth(), b.getHeight()) * 0.5f;
    juce::Path p;
    const juce::Colour col = (flat ? theme::muted : theme::text).withMultipliedAlpha (a);
    g.setColour (highlighted && flat ? theme::text : col);
    switch (icon)
    {
        case Icon::Prev:
            p.addTriangle (c.x + s * 0.32f, c.y - s * 0.40f, c.x + s * 0.32f, c.y + s * 0.40f, c.x - s * 0.38f, c.y);
            g.fillPath (p);
            break;
        case Icon::Next:
            p.addTriangle (c.x - s * 0.32f, c.y - s * 0.40f, c.x - s * 0.32f, c.y + s * 0.40f, c.x + s * 0.38f, c.y);
            g.fillPath (p);
            break;
        case Icon::Minus:
            g.fillRoundedRectangle (juce::Rectangle<float> (s * 0.9f, 2.2f).withCentre (c), 1.1f);
            break;
        case Icon::Plus:
            g.fillRoundedRectangle (juce::Rectangle<float> (s * 0.9f, 2.2f).withCentre (c), 1.1f);
            g.fillRoundedRectangle (juce::Rectangle<float> (2.2f, s * 0.9f).withCentre (c), 1.1f);
            break;
        case Icon::Close:
        {
            const float k = s * 0.32f;
            g.drawLine (c.x - k, c.y - k, c.x + k, c.y + k, 1.8f);
            g.drawLine (c.x - k, c.y + k, c.x + k, c.y - k, 1.8f);
            break;
        }
        case Icon::ZoomIn:
        case Icon::ZoomOut:
        {
            const float r = s * 0.42f;
            const auto lc = c.translated (-s * 0.12f, -s * 0.12f);
            g.drawEllipse (juce::Rectangle<float> (2 * r, 2 * r).withCentre (lc), 1.7f);
            g.drawLine (lc.x + r * 0.72f, lc.y + r * 0.72f, lc.x + r * 1.6f, lc.y + r * 1.6f, 2.2f);
            g.fillRect (juce::Rectangle<float> (r * 1.05f, 1.6f).withCentre (lc));
            if (icon == Icon::ZoomIn)
                g.fillRect (juce::Rectangle<float> (1.6f, r * 1.05f).withCentre (lc));
            break;
        }
    }
}

//==============================================================================================================

Spinner::Spinner()
{
    setInterceptsMouseClicks (false, false);
}

void Spinner::setActive (bool a)
{
    if (a == active)
        return;
    active = a;
    if (a)
        startTimerHz (30);
    else
        stopTimer();
    repaint();
}

void Spinner::timerCallback()
{
    angle += 0.28f;
    if (angle > juce::MathConstants<float>::twoPi)
        angle -= juce::MathConstants<float>::twoPi;
    repaint();
}

void Spinner::paint (juce::Graphics& g)
{
    if (! active)
        return;
    const float d = static_cast<float> (juce::jmin (getWidth(), getHeight())) - 3.0f;
    const auto r = juce::Rectangle<float> (d, d).withCentre (getLocalBounds().toFloat().getCentre());
    g.setColour (theme::borderStrong);
    g.drawEllipse (r, 2.0f);
    juce::Path arc;
    arc.addCentredArc (r.getCentreX(), r.getCentreY(), d * 0.5f, d * 0.5f, angle, 0.0f, juce::MathConstants<float>::halfPi, true);
    g.setColour (theme::accent);
    g.strokePath (arc, juce::PathStrokeType (2.0f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
}

//==============================================================================================================

Pill::Pill()
{
    setInterceptsMouseClicks (false, false);
}

void Pill::set (const juce::String& t, juce::Colour f, juce::Colour b, bool p)
{
    if (t == text && f == fg && b == bg && p == pulse)
        return;
    text = t;
    fg = f;
    bg = b;
    pulse = p;
    repaint();
}

int Pill::idealWidth() const
{
    return text.isEmpty() ? 0 : textWidth (uiFont (theme::fontSmall, true), text) + 32;
}

void Pill::paint (juce::Graphics& g)
{
    if (text.isEmpty())
        return;
    auto b = getLocalBounds().toFloat();
    g.setColour (bg);
    g.fillRoundedRectangle (b, b.getHeight() * 0.5f);
    const float d = 8.0f;
    const auto dot = juce::Rectangle<float> (d, d).withCentre ({ b.getX() + 14.0f, b.getCentreY() });
    if (pulse)
    {
        g.setColour (fg.withAlpha (0.25f));
        g.fillEllipse (dot.expanded (3.0f));
    }
    g.setColour (fg);
    g.fillEllipse (dot);
    g.setFont (uiFont (theme::fontSmall, true));
    g.drawFittedText (text, getLocalBounds().withTrimmedLeft (24).withTrimmedRight (10), juce::Justification::centredLeft, 1, 0.85f);
}

//==============================================================================================================

void noClickFocus (juce::Component& c)
{
    c.setMouseClickGrabsKeyboardFocus (false);
    c.setWantsKeyboardFocus (true);
}

void styleButton (juce::TextButton& b, const juce::String& tooltip)
{
    noClickFocus (b);
    if (tooltip.isNotEmpty())
        b.setTooltip (tooltip);
}

void stylePrimary (juce::TextButton& b)
{
    b.setColour (juce::TextButton::buttonColourId, theme::primary);
    b.setColour (juce::TextButton::textColourOffId, juce::Colours::white);
}

void styleGhost (juce::TextButton& b)
{
    b.setColour (juce::TextButton::buttonColourId, juce::Colours::transparentBlack);
}

} // namespace djec::ui
