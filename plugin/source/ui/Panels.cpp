#include "ui/Panels.h"

#include "ui/Format.h"
#include "ui/LookAndFeel.h"

#include "djec/edit_plan.h"
#include "djec/meter.h"

#include <algorithm>
#include <cmath>

namespace djec::ui
{

using djec::plugin::GridMode;
using djec::plugin::NoticeKind;

namespace
{
constexpr int kRowH = theme::controlH;
constexpr int kGap = 7;

template <typename Fn>
void editSettings (UiContext& ctx, Fn&& fn)
{
    djec::EditSettings s = ctx.processor.getEditSettings();
    fn (s);
    ctx.processor.setEditSettings (s);
}

void setVisibleIf (juce::Component& c, bool v)
{
    if (c.isVisible() != v)
        c.setVisible (v);
}

void styleEditor (juce::TextEditor& e, const juce::String& placeholder, const juce::String& allowed, int maxLen)
{
    e.setFont (uiFont (theme::fontBody, true));
    e.setJustification (juce::Justification::centred);
    e.setInputRestrictions (maxLen, allowed);
    e.setTextToShowWhenEmpty (placeholder, theme::muted);
    e.setIndents (6, 0);
    e.setSelectAllWhenFocused (true);
}

void styleCombo (juce::ComboBox& c, const juce::String& tooltip)
{
    c.setTooltip (tooltip);
    c.setMouseClickGrabsKeyboardFocus (false);
    c.setWantsKeyboardFocus (true);
}

int fadeIndexFor (double beats)
{
    int best = 0;
    for (int i = 0; i < 7; ++i)
        if (std::fabs (djec::kFadeBeatSteps[i] - beats) < std::fabs (djec::kFadeBeatSteps[best] - beats))
            best = i;
    return best;
}

juce::int64 nowMs() { return juce::Time::currentTimeMillis(); }

// «Compás original» (cuadrícula de FL): Auto + los compases más comunes (id = 1000 + num · 100 + den)
constexpr int kSourceAutoId = 1;
constexpr int kSourceMeters[][2] = { { 2, 4 }, { 3, 4 }, { 4, 4 }, { 5, 4 }, { 6, 4 }, { 7, 4 },
                                     { 3, 8 }, { 5, 8 }, { 6, 8 }, { 7, 8 }, { 9, 8 }, { 12, 8 } };
int sourceMeterId (int num, int den) { return num > 0 && den > 0 ? 1000 + num * 100 + den : kSourceAutoId; }
} // namespace

bool sameSettings (const djec::EditSettings& a, const djec::EditSettings& b)
{
    return a.trimEachBar == b.trimEachBar && a.amount == b.amount && a.otherNum == b.otherNum && a.otherDen == b.otherDen
           && std::fabs (a.crossfadeSec - b.crossfadeSec) < 1e-9 && a.removeEnd == b.removeEnd
           && a.barsToRemove == b.barsToRemove && std::fabs (a.fadeBeats - b.fadeBeats) < 1e-9 && a.curve == b.curve;
}

//==============================================================================================================
// RowLabel

RowLabel::RowLabel (const juce::String& t, bool b) : text (t), bold (b)
{
    setInterceptsMouseClicks (false, false);
}

void RowLabel::setText (const juce::String& t)
{
    if (t == text)
        return;
    text = t;
    repaint();
}

void RowLabel::setColour (juce::Colour c)
{
    if (c == colour)
        return;
    colour = c;
    repaint();
}

void RowLabel::setFontHeight (float h)
{
    height = h;
    repaint();
}

int RowLabel::idealWidth() const { return textWidth (uiFont (height, bold), text) + 2; }

void RowLabel::paint (juce::Graphics& g)
{
    g.setFont (uiFont (height, bold));
    g.setColour (isEnabled() ? colour : colour.withMultipliedAlpha (0.5f));
    g.drawFittedText (text, getLocalBounds(), juce::Justification::centredLeft, 1, 0.9f);
}

//==============================================================================================================
// Panel

Panel::Panel (UiContext& c, int s, const juce::String& t, const juce::String& sub, bool withSwitch, juce::Colour swc)
    : ctx (c), step (s), title (t), subtitle (sub)
{
    if (withSwitch)
    {
        sw = std::make_unique<Switch> (swc);
        sw->setTitle (t);
        addAndMakeVisible (*sw);
    }
    setFocusContainerType (FocusContainerType::focusContainer);
}

bool Panel::extraInHeader (int width) const
{
    if (extra == nullptr)
        return false;
    const int avail = width - 2 * theme::pad - 33 - (sw != nullptr ? 52 : 0) - extraWidth - 8;
    return textWidth (uiFont (theme::fontTitle, true), title) <= avail;
}

int Panel::titleWidth (int width) const
{
    return width - 2 * theme::pad - 33 - (sw != nullptr ? 52 : 0) - (extraInHeader (width) ? extraWidth + 8 : 0);
}

bool Panel::titleFits (int width) const
{
    return textWidth (uiFont (theme::fontTitle, true), title) <= titleWidth (width);
}

bool Panel::subtitleInline (int width) const
{
    return textWidth (uiFont (theme::fontTitle, true), title) + 10 + textWidth (uiFont (theme::fontSmall), subtitle) <= titleWidth (width);
}

int Panel::headerHeight (int width) const
{
    if (! titleFits (width))
        return 44 + (subtitle.isNotEmpty() ? 16 : 0);
    return subtitle.isEmpty() || subtitleInline (width) ? 26 : 40;
}

void Panel::setHeaderExtra (juce::Component* c, int width)
{
    extra = c;
    extraWidth = width;
    if (c != nullptr && c->getParentComponent() != this)
        addAndMakeVisible (*c);
}

int Panel::preferredHeight (int width)
{
    const int inner = juce::jmax (40, width - 2 * theme::pad);
    const int body = layoutBody ({ 0, 0, inner, 100000 }, false);
    return theme::pad + headerHeight (width) + (body > 0 ? 10 + body : 0) + theme::pad;
}

void Panel::bodyChanged()
{
    const int h = preferredHeight (getWidth());
    if (h != lastPreferred)
    {
        lastPreferred = h;
        if (ctx.relayout)
            ctx.relayout();
    }
    resized();
}

void Panel::setStepActive (bool active, juce::Colour colour, juce::Colour textColour)
{
    if (active == stepActive && colour == stepColour && textColour == stepText)
        return;
    stepActive = active;
    stepColour = colour;
    stepText = textColour;
    repaint();
}

void Panel::paint (juce::Graphics& g)
{
    paintCard (g, getLocalBounds().toFloat());
    auto r = getLocalBounds().reduced (theme::pad).removeFromTop (headerHeight (getWidth()));
    if (sw != nullptr)
        r.removeFromRight (52);
    if (extraInHeader (getWidth()))
        r.removeFromRight (extraWidth + 8);
    // número de paso (o el ícono del resultado)
    const auto circle = juce::Rectangle<float> (23.0f, 23.0f).withPosition (static_cast<float> (r.getX()), static_cast<float> (r.getY()) + 1.0f);
    g.setColour (stepActive ? stepColour : theme::surface3);
    g.fillEllipse (circle);
    g.setColour (stepActive ? stepText : theme::muted);
    if (step > 0)
    {
        g.setFont (uiFont (theme::fontSmall, true));
        g.drawText (juce::String (step), circle, juce::Justification::centred, false);
    }
    else
    {
        const auto c = circle.getCentre();
        juce::Path arrow;
        arrow.startNewSubPath (c.x, c.y - 5.5f);
        arrow.lineTo (c.x, c.y + 2.5f);
        arrow.startNewSubPath (c.x - 3.5f, c.y - 1.0f);
        arrow.lineTo (c.x, c.y + 2.5f);
        arrow.lineTo (c.x + 3.5f, c.y - 1.0f);
        arrow.startNewSubPath (c.x - 5.0f, c.y + 5.5f);
        arrow.lineTo (c.x + 5.0f, c.y + 5.5f);
        g.strokePath (arrow, juce::PathStrokeType (1.7f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }
    r.removeFromLeft (33);
    const juce::Font tf = uiFont (theme::fontTitle, true);
    g.setColour (theme::text);
    g.setFont (tf);
    auto line = r.removeFromTop (25);
    if (subtitle.isNotEmpty() && subtitleInline (getWidth()))
    {
        const int tw = textWidth (tf, title);
        g.drawText (title, line.removeFromLeft (tw + 2), juce::Justification::centredLeft, false);
        line.removeFromLeft (8);
        g.setColour (theme::muted);
        g.setFont (uiFont (theme::fontSmall));
        g.drawText (subtitle, line.translated (0, 1), juce::Justification::centredLeft, true);
        return;
    }
    if (! titleFits (getWidth()))
    {
        // título largo en una columna estrecha: dos líneas
        g.drawFittedText (title, line.withHeight (44), juce::Justification::centredLeft, 2, 1.0f);
        r.removeFromTop (19);
    }
    else
        g.drawFittedText (title, line, juce::Justification::centredLeft, 1, 0.85f);
    if (subtitle.isNotEmpty())
    {
        g.setColour (theme::muted);
        g.setFont (uiFont (theme::fontSmall));
        g.drawFittedText (subtitle, r.removeFromTop (16), juce::Justification::centredLeft, 1, 0.85f);
    }
}

void Panel::resized()
{
    auto r = getLocalBounds().reduced (theme::pad);
    auto head = r.removeFromTop (headerHeight (getWidth()));
    auto top = head.withHeight (26);
    if (sw != nullptr)
        sw->setBounds (top.removeFromRight (48).withSizeKeepingCentre (48, 28));
    if (extraInHeader (getWidth()))
    {
        if (sw != nullptr)
            top.removeFromRight (8);
        extra->setBounds (top.removeFromRight (extraWidth).withSizeKeepingCentre (extraWidth, 28));
    }
    r.removeFromTop (10);
    layoutBody (r, true);
}

//==============================================================================================================
// 1 · Compases

GridPanel::GridPanel (UiContext& c) : Panel (c, 1, T (str::gridTitle))
{
    mode.setTooltips ({ T (str::gridHostTip), T (str::gridDetectTip) });
    mode.setAccent (theme::accent, theme::onAccent);
    mode.onChange = [this] (int i) {
        pendingMode = i;
        pendingSince = nowMs();
        ctx.processor.setGridMode (i == 1 ? GridMode::Detect : GridMode::Host);
        bodyChanged();
    };
    addAndMakeVisible (mode);

    info.setStyle (uiFont (theme::fontBody, true), theme::text);
    addAndMakeVisible (info);
    addChildComponent (confidence);
    help.setStyle (uiFont (theme::fontSmall), theme::muted);
    addAndMakeVisible (help);

    for (auto* l : { &manualLabel, &meterLabel, &oneLabel })
        addAndMakeVisible (*l);

    styleButton (tempoDouble, T (str::tempoDoubleTip));
    styleButton (tempoHalf, T (str::tempoHalfTip));
    tempoDouble.onClick = [this] { changeTempo (2.0); };
    tempoHalf.onClick = [this] { changeTempo (0.5); };
    addAndMakeVisible (tempoDouble);
    addAndMakeVisible (tempoHalf);

    styleEditor (bpm, T (str::bpmPlaceholder), "0123456789,.", 6);
    bpm.setTitle (T (str::tempoManual));
    bpm.onReturnKey = [this] { applyManualTempo(); };
    bpm.onTextChange = [this] { applyBpm.setEnabled (hasTake && ! busy && fmt::parseBpm (bpm.getText()).has_value()); };
    addAndMakeVisible (bpm);
    styleButton (applyBpm, T (str::applyTip));
    applyBpm.onClick = [this] { applyManualTempo(); };
    addAndMakeVisible (applyBpm);

    styleButton (tapButton, T (str::tapTip));
    tapButton.setTriggeredOnMouseDown (true);   // el toque cuenta al bajar el dedo (menos retardo, como la web)
    tapButton.onClick = [this] { tap(); };
    addAndMakeVisible (tapButton);
    tapValue.setStyle (uiFont (theme::fontSmall, true), theme::muted, juce::Justification::centredLeft);
    tapValue.setMaxLines (2);
    tapValue.setText (T (str::tapIdle));
    addAndMakeVisible (tapValue);

    meterBox.addItem (T (str::beatsPerBarAuto), 1);
    for (int n = 2; n <= 7; ++n)
        meterBox.addItem (juce::String (n), n);
    meterBox.setSelectedId (1, juce::dontSendNotification);
    styleCombo (meterBox, T (str::beatsPerBar));
    meterBox.setTitle (T (str::beatsPerBar));
    meterBox.onChange = [this] {
        const int id = meterBox.getSelectedId();
        const int n = id <= 1 ? 0 : id;
        pendingMeter = n;
        ctx.processor.relabel (n, {});
    };
    addAndMakeVisible (meterBox);

    sourceBox.addItem (T (str::sourceMeterAuto), kSourceAutoId);
    for (const auto& m : kSourceMeters)
        sourceBox.addItem (juce::String (m[0]) + "/" + juce::String (m[1]), sourceMeterId (m[0], m[1]));
    sourceBox.setSelectedId (kSourceAutoId, juce::dontSendNotification);
    styleCombo (sourceBox, T (str::sourceMeterTip));
    sourceBox.setTitle (T (str::sourceMeter));
    sourceBox.onChange = [this] {
        const int id = sourceBox.getSelectedId();
        pendingSource = id;
        pendingSourceSince = nowMs();
        if (id <= kSourceAutoId)
            ctx.processor.setSourceMeter (0, 0);
        else
            ctx.processor.setSourceMeter ((id - 1000) / 100, (id - 1000) % 100);
    };
    addChildComponent (sourceBox);
    addChildComponent (sourceLabel);

    onePrev.onClick = [this] { ctx.processor.moveDownbeat (-1, ctx.referenceTime ? ctx.referenceTime() : 0.0); };
    oneNext.onClick = [this] { ctx.processor.moveDownbeat (1, ctx.referenceTime ? ctx.referenceTime() : 0.0); };
    addAndMakeVisible (onePrev);
    addAndMakeVisible (oneNext);

    styleButton (thisOne, T (str::thisBeatIsOneTip));
    thisOne.onClick = [this] { ctx.processor.beatIsOne (ctx.referenceTime ? ctx.referenceTime() : 0.0); };
    addAndMakeVisible (thisOne);
    styleButton (resetButton);
    styleGhost (resetButton);
    setHeaderExtra (&resetButton, textWidth (uiFont (theme::fontBody, true), resetButton.getButtonText()) + 26);
    resetButton.onClick = [this] {
        if (shownMode() == GridMode::Host)
        {
            ctx.processor.setBarOffset (0);
            return;
        }
        bpm.clear();
        taps.clear();
        tapValue.setText (T (str::tapIdle));
        meterBox.setSelectedId (1, juce::dontSendNotification);
        pendingMeter = 0;
        ctx.processor.resetDetection();
    };

    addChildComponent (spinner);
    addChildComponent (lowConf);
}

void GridPanel::syncSourceBox (int num, int den)
{
    const int id = sourceMeterId (num, den);
    if (pendingSource >= 0 && (pendingSource == id || nowMs() - pendingSourceSince > 2500))
        pendingSource = -1;
    if (pendingSource >= 0 || sourceBox.isPopupActive())
        return;
    if (id != kSourceAutoId && sourceBox.indexOfItemId (id) < 0)   // un compás de un estado guardado que no está en la lista
        sourceBox.addItem (juce::String (num) + "/" + juce::String (den), id);
    sourceBox.setSelectedId (id, juce::dontSendNotification);
}

GridMode GridPanel::shownMode() const
{
    if (pendingMode >= 0)
        return pendingMode == 1 ? GridMode::Detect : GridMode::Host;
    return session != nullptr ? session->gridMode : GridMode::Host;
}

void GridPanel::changeTempo (double factor)
{
    if (session == nullptr || ! (session->grid.bpm > 0))
        return;
    const double hint = session->grid.bpm * factor;
    if (hint < fmt::kRetrackBpmMin || hint > fmt::kRetrackBpmMax)
    {
        if (ctx.message)
            ctx.message (T (str::tempoOutOfRange), NoticeKind::Error);
        return;
    }
    ctx.processor.retrack (hint, true);
}

void GridPanel::applyManualTempo()
{
    if (! hasTake || busy)
        return;
    const auto v = fmt::parseBpm (bpm.getText());
    if (! v)
    {
        if (ctx.message)
            ctx.message (text::bpmRange (fmt::kManualBpmMin, fmt::kManualBpmMax), NoticeKind::Error);
        return;
    }
    ctx.processor.retrack (*v, true);
}

void GridPanel::tap()
{
    const auto r = fmt::tapTempo (taps, juce::Time::getMillisecondCounterHiRes());
    taps = r.taps;
    if (! r.bpm)
    {
        tapValue.setText (T (str::tapMore));
        return;
    }
    const double v = std::clamp (*r.bpm, fmt::kManualBpmMin, fmt::kManualBpmMax);
    tapValue.setText (text::tapValue (v));
    bpm.setText (fmt::number (v, 1), juce::sendNotification);
}

void GridPanel::update (const djec::plugin::ViewState& vs, bool sessionChanged)
{
    if (! sessionChanged && session != nullptr)
        return;
    session = vs.session;
    const auto& s = *session;
    if (pendingMode >= 0 && ((pendingMode == 1) == (s.gridMode == GridMode::Detect) || nowMs() - pendingSince > 2500))
        pendingMode = -1;
    const GridMode m = shownMode();
    detect = m == GridMode::Detect;
    hasTake = s.hasTake;
    // el «Procesando…» de cada cambio de ajustes dura milisegundos: solo cuenta el trabajo de la detección
    busy = s.busy && s.busyText.isNotEmpty() && s.busyText != T (str::processingTitle);
    mode.setSelected (detect ? 1 : 0);

    const bool analyzed = detect && s.detect.analyzed && s.gridValid && s.gridMode == GridMode::Detect;
    // información
    if (! hasTake)
        info.setText ({});
    else if (! detect && s.source == djec::plugin::TakeSource::File && ! s.placed)
        info.setText (T (str::gridFilePending));
    else if (! detect)
        info.setText (s.hostMeta.valid ? text::hostInfo (s.displayBpm, s.hostMeta.tsNum, s.hostMeta.tsDen, s.meterOrigin)
                                       : T (str::hostNoInfo));
    else if (analyzed)
        info.setText (text::detectInfo (s.grid.bpm, s.grid.beatsPerBar));
    else
        info.setText (busy ? s.busyText : text::detectInfo (0, 0));
    if (detect && busy && analyzed)
        info.setText (s.busyText);
    if (analyzed && s.confidenceLabel.isNotEmpty())
    {
        juce::Colour fg = theme::ok, bg = theme::okSoft;
        if (! s.detect.forced.empty() && s.confidenceLabel == T (str::confManual))
            fg = theme::muted, bg = theme::surface3;
        else if (s.lowConfidence)
            fg = theme::warn, bg = theme::warnSoft;
        else if (s.confidenceLabel == T (str::confMedium))
            fg = theme::accent2, bg = theme::accentSoft;
        confidence.set (s.confidenceLabel, fg, bg);
        confidence.setVisible (true);
    }
    else
        confidence.setVisible (false);
    const bool filePending = s.source == djec::plugin::TakeSource::File && ! s.placed;
    help.setText (! hasTake ? T (str::gridNoTake) : ! detect && ! filePending ? T (str::gridHostHelp) : juce::String());

    // controles
    const bool canCorrect = hasTake && ! busy;
    for (juce::Component* c : std::initializer_list<juce::Component*> { &tempoDouble, &tempoHalf,
                                &manualLabel, &bpm, &applyBpm,
                                &tapButton, &tapValue, &meterLabel,
                                &meterBox, &thisOne })
        setVisibleIf (*c, detect);
    tempoDouble.setEnabled (canCorrect && analyzed);
    tempoHalf.setEnabled (canCorrect && analyzed);
    bpm.setEnabled (canCorrect);
    bpm.setTextToShowWhenEmpty (analyzed ? fmt::number (s.grid.bpm, 1) : T (str::bpmPlaceholder), theme::muted);
    applyBpm.setEnabled (canCorrect && fmt::parseBpm (bpm.getText()).has_value());
    tapButton.setEnabled (canCorrect);
    tapValue.setEnabled (canCorrect);
    meterBox.setEnabled (canCorrect && analyzed);
    meterLabel.setEnabled (canCorrect && analyzed);
    if (pendingMeter >= 0 && (pendingMeter == s.detect.meterChoice || ! s.busy))
        pendingMeter = -1;
    if (pendingMeter < 0 && ! meterBox.isPopupActive())
        meterBox.setSelectedId (s.detect.meterChoice >= 2 ? s.detect.meterChoice : 1, juce::dontSendNotification);
    // «Compás original» (solo cuadrícula de FL, con la toma en la línea de tiempo)
    const bool showSource = ! detect && hasTake && ! filePending;
    setVisibleIf (sourceBox, showSource);
    setVisibleIf (sourceLabel, showSource);
    sourceBox.setEnabled (canCorrect);
    sourceLabel.setEnabled (canCorrect);
    syncSourceBox (s.sourceMeterNum, s.sourceMeterDen);
    const bool canMove = canCorrect && (detect ? analyzed : s.gridValid);
    onePrev.setEnabled (canMove);
    oneNext.setEnabled (canMove);
    oneLabel.setEnabled (canMove);
    thisOne.setEnabled (canCorrect && analyzed);
    resetButton.setEnabled (canCorrect && (detect ? s.detect.analyzed : s.barOffsetBeats != 0));
    resetButton.setTooltip (T (detect ? str::resetDetectTip : str::resetHostTip));

    // detectando o recalculando: indicador en la misma línea de la información (sin mover nada)
    const bool showBusy = detect && busy;
    spinner.setVisible (showBusy);
    spinner.setActive (showBusy);
    if (showBusy)
        confidence.setVisible (false);
    const bool low = analyzed && s.lowConfidence && s.detect.forced.empty();
    lowConf.set (low ? T (str::lowConfidence) : juce::String(), HintBox::Kind::Warn);
    lowConf.setVisible (low);
    setStepActive (hasTake, theme::accent, theme::onAccent);
    bodyChanged();
}

int GridPanel::layoutBody (juce::Rectangle<int> area, bool apply)
{
    Stack st (area, apply);
    const int w = area.getWidth();
    st.place (mode, kRowH + 2);
    // información (+ insignia en la misma fila si cabe; + indicador de actividad a la izquierda)
    if (info.getText().isNotEmpty())
    {
        st.gap (kGap + 2);
        const int sp = spinner.isVisible() ? 24 : 0;
        const int iw = textWidth (uiFont (theme::fontBody, true), info.getText());
        const bool pill = confidence.isVisible();
        const int pw = pill ? confidence.idealWidth() : 0;
        if (pill && sp + iw + 10 + pw <= w)
        {
            auto row = st.take (24);
            if (apply)
            {
                confidence.setBounds (row.removeFromRight (pw));
                info.setBounds (row.withTrimmedRight (8).withSizeKeepingCentre (row.getWidth() - 8, info.heightFor (row.getWidth() - 8)));
            }
        }
        else
        {
            const int ih = juce::jmax (sp > 0 ? 20 : 0, info.heightFor (w - sp));
            auto row = st.take (ih);
            if (apply)
            {
                if (sp > 0)
                    spinner.setBounds (row.removeFromLeft (sp).removeFromTop (20).withSizeKeepingCentre (16, 16));
                info.setBounds (row);
            }
            if (pill)
            {
                st.gap (5);
                auto prow = st.take (24);
                if (apply)
                    confidence.setBounds (prow.removeFromLeft (pw));
            }
        }
    }
    if (help.getText().isNotEmpty())
    {
        st.gap (kGap - 2);
        st.place (help, help.heightFor (w));
    }
    if (detect && hasTake)
    {
        st.gap (kGap + 3);
        {
            auto row = st.take (kRowH);
            if (apply)
            {
                const int bw = (row.getWidth() - 6) / 2;
                tempoDouble.setBounds (row.removeFromLeft (bw));
                tempoHalf.setBounds (row.removeFromRight (bw));
            }
        }
        st.gap (kGap);
        {
            // «Tempo manual» [BPM] [Aplicar]; en una columna estrecha la etiqueta va encima
            const int aw = juce::jmax (64, textWidth (uiFont (theme::fontBody, true), applyBpm.getButtonText()) + 20);
            const bool stack = manualLabel.idealWidth() + 8 + 62 + 6 + aw > w;
            if (stack)
            {
                st.place (manualLabel, 20);
                st.gap (4);
            }
            auto row = st.take (kRowH);
            if (apply)
            {
                applyBpm.setBounds (row.removeFromRight (aw));
                row.removeFromRight (6);
                if (stack)
                    bpm.setBounds (row);
                else
                {
                    bpm.setBounds (row.removeFromRight (62));
                    row.removeFromRight (8);
                    manualLabel.setBounds (row);
                }
            }
        }
        st.gap (kGap);
        {
            auto row = st.take (kRowH);
            if (apply)
            {
                tapButton.setBounds (row.removeFromLeft (textWidth (uiFont (theme::fontBody, true), tapButton.getButtonText()) + 24));
                row.removeFromLeft (10);
                tapValue.setBounds (row);
            }
        }
        st.gap (kGap);
        {
            const bool stack = meterLabel.idealWidth() + 8 + 84 > w;
            if (stack)
            {
                st.place (meterLabel, 20);
                st.gap (4);
            }
            auto row = st.take (kRowH);
            if (apply)
            {
                meterBox.setBounds (stack ? row.withWidth (juce::jmin (row.getWidth(), 120)) : row.removeFromRight (84));
                if (! stack)
                {
                    row.removeFromRight (8);
                    meterLabel.setBounds (row);
                }
            }
        }
    }
    if (sourceBox.isVisible())
    {
        // «Compás original» [Auto (de FL) ▾]; en una columna estrecha la etiqueta va encima
        const int bw = juce::jmax (textWidth (uiFont (theme::fontBody, true), T (str::sourceMeterAuto)) + 44, 120);
        const bool stack = sourceLabel.idealWidth() + 8 + bw > w;
        st.gap (kGap + 3);
        if (stack)
        {
            st.place (sourceLabel, 20);
            st.gap (4);
        }
        auto row = st.take (kRowH);
        if (apply)
        {
            sourceBox.setBounds (stack ? row.withWidth (juce::jmin (row.getWidth(), bw)) : row.removeFromRight (bw));
            if (! stack)
            {
                row.removeFromRight (8);
                sourceLabel.setBounds (row);
            }
        }
    }
    if (hasTake)
    {
        st.gap (kGap + (detect ? 0 : 3));
        auto row = st.take (kRowH);
        if (apply)
        {
            oneNext.setBounds (row.removeFromRight (kRowH + 6));
            row.removeFromRight (5);
            onePrev.setBounds (row.removeFromRight (kRowH + 6));
            row.removeFromRight (8);
            oneLabel.setBounds (row);
        }
        if (detect)
        {
            st.gap (kGap);
            st.place (thisOne, kRowH);
        }
        if (! extraInHeader (w + 2 * theme::pad))
        {
            st.gap (kGap);
            auto resetRow = st.take (kRowH);
            if (apply)
                resetButton.setBounds (resetRow.removeFromRight (
                    juce::jmin (resetRow.getWidth(), textWidth (uiFont (theme::fontBody, true), resetButton.getButtonText()) + 26)));
        }
    }
    setVisibleIf (oneLabel, hasTake);
    setVisibleIf (onePrev, hasTake);
    setVisibleIf (oneNext, hasTake);
    setVisibleIf (resetButton, hasTake);
    if (lowConf.isVisible())
    {
        st.gap (kGap + 1);
        st.place (lowConf, lowConf.heightFor (w));
    }
    return st.used();
}

//==============================================================================================================
// 2 · Recortar cada compás

TrimPanel::Summary::Summary()
{
    change.setStyle (uiFont (theme::fontBody + 0.5f, true), theme::text);
    desc.setStyle (uiFont (theme::fontSmall), theme::text);
    stats.setStyle (uiFont (theme::fontSmall, true), theme::text);
    hint.setStyle (uiFont (theme::fontSmall, true), theme::meter);
    addAndMakeVisible (change);
    addAndMakeVisible (desc);
    addAndMakeVisible (stats);
    addAndMakeVisible (hint);
    setInterceptsMouseClicks (false, false);
}

int TrimPanel::Summary::heightFor (int w) const
{
    const int iw = w - 24;
    int h = 14 + change.heightFor (iw);
    if (desc.getText().isNotEmpty())
        h += 3 + desc.heightFor (iw);
    if (stats.getText().isNotEmpty())
        h += 3 + stats.heightFor (iw);
    if (hint.getText().isNotEmpty())
        h += 6 + hint.heightFor (iw);
    return h;
}

void TrimPanel::Summary::resized()
{
    auto r = getLocalBounds().reduced (12, 7);
    change.setBounds (r.removeFromTop (change.heightFor (r.getWidth())));
    if (desc.getText().isNotEmpty())
    {
        r.removeFromTop (3);
        desc.setBounds (r.removeFromTop (desc.heightFor (r.getWidth())));
    }
    if (stats.getText().isNotEmpty())
    {
        r.removeFromTop (3);
        stats.setBounds (r.removeFromTop (stats.heightFor (r.getWidth())));
    }
    if (hint.getText().isNotEmpty())
    {
        r.removeFromTop (6);
        hint.setBounds (r.removeFromTop (hint.heightFor (r.getWidth())));
    }
}

void TrimPanel::Summary::paint (juce::Graphics& g)
{
    paintCard (g, getLocalBounds().toFloat(), theme::meterSoft, theme::meter.withAlpha (0.25f), theme::radiusSm);
}

TrimPanel::TrimPanel (UiContext& c) : Panel (c, 2, T (str::trimTitle), T (str::trimSub), true, theme::meter)
{
    headerSwitch()->setTooltip (T (str::trimSwitchTip));
    headerSwitch()->onClick = [this] {
        const bool v = headerSwitch()->getToggleState();
        editSettings (ctx, [v] (djec::EditSettings& s) { s.trimEachBar = v; });
        refreshControls();
        bodyChanged();
    };
    offNote.setStyle (uiFont (theme::fontSmall), theme::muted);
    offNote.setText (T (str::trimOff));
    addChildComponent (offNote);
    amountLabel.setStyle (uiFont (theme::fontBody, true), theme::text);
    amountLabel.setText (T (str::trimAmount));
    addAndMakeVisible (amountLabel);

    addChildComponent (otherLabel);
    slash.setColour (theme::muted);
    slash.setFontHeight (18.0f);
    addChildComponent (slash);
    styleEditor (otherNum, "7", "0123456789", 2);
    otherNum.setTooltip (T (str::otherNumTip));
    otherNum.setTitle (T (str::otherNumTip));
    otherNum.onTextChange = [this] { otherChanged(); };
    addChildComponent (otherNum);
    for (int d : { 2, 4, 8, 16 })
        otherDen.addItem (juce::String (d), d);
    styleCombo (otherDen, T (str::otherDenTip));
    otherDen.setTitle (T (str::otherDenTip));
    otherDen.onChange = [this] { otherChanged(); };
    addChildComponent (otherDen);

    addAndMakeVisible (summary);
    addChildComponent (meterMsg);

    addAndMakeVisible (xfadeLabel);
    xfadeValue.setColour (theme::meter);
    addAndMakeVisible (xfadeValue);
    xfade.setRange (djec::kCrossfadeMinMs, djec::kCrossfadeMaxMs, 1.0);
    xfade.setColour (juce::Slider::trackColourId, theme::meter);
    xfade.setTooltip (T (str::crossfadeNote));
    xfade.setTitle (T (str::crossfade));
    xfade.setMouseClickGrabsKeyboardFocus (false);
    xfade.setDoubleClickReturnValue (true, djec::kCrossfadeDefMs);
    xfade.onValueChange = [this] {
        const double ms = std::round (xfade.getValue());
        xfadeValue.setText (text::milliseconds (ms));
        editSettings (ctx, [ms] (djec::EditSettings& s) { s.crossfadeSec = ms / 1000.0; });
    };
    addAndMakeVisible (xfade);
    refreshControls();
}

void TrimPanel::rebuildChips (const std::vector<djec::MeterAmountChip>& sessionChips)
{
    // antes de la primera sesión del worker: los botones de un 4/4
    const std::vector<djec::MeterAmountChip> data = sessionChips.empty() ? djec::meterAmountChips (4, 4) : sessionChips;
    bool same = data.size() == chipData.size();
    for (std::size_t i = 0; same && i < data.size(); ++i)
        same = data[i].id == chipData[i].id && data[i].result == chipData[i].result && data[i].main == chipData[i].main
               && data[i].note == chipData[i].note;
    if (same)
        return;
    chipData = data;
    chips.clear();
    for (const auto& d : chipData)
    {
        auto ch = std::make_unique<Chip>();
        ch->setContent (T (d.main.c_str()), T (d.note.c_str()), text::chipResult (d.result));
        ch->setAccent (theme::meter, theme::onMeter, theme::meter);
        ch->setTooltip (d.result.empty() ? text::chipName (d.main, d.note) : text::chipName (d.main, d.note) + " " + text::chipResult (d.result));
        const std::string id = d.id;
        ch->onClick = [this, id] { chooseAmount (id); };
        addAndMakeVisible (*ch);
        chips.push_back (std::move (ch));
    }
}

void TrimPanel::chooseAmount (const std::string& id)
{
    const djec::EditSettings cur = ctx.processor.getEditSettings();
    if (id == "other" && cur.amount != "other" && session != nullptr)
    {
        // «Otro compás» arranca con el compás que se estaba usando
        const int bpb = session->gridValid ? session->grid.beatsPerBar : 4;
        const auto tm = djec::targetMeter (cur.amount, cur.otherNum, cur.otherDen, bpb, session->sourceDen);
        editSettings (ctx, [&] (djec::EditSettings& s) {
            s.amount = id;
            if (tm.num > 0 && tm.den > 0)
            {
                s.otherNum = tm.num;
                s.otherDen = tm.den;
            }
        });
    }
    else
        editSettings (ctx, [&] (djec::EditSettings& s) { s.amount = id; });
    refreshControls();
    bodyChanged();
    if (id == "other")
        otherNum.grabKeyboardFocus();
}

void TrimPanel::otherChanged()
{
    const auto n = fmt::parseInt (otherNum.getText());
    const int den = otherDen.getSelectedId();
    editSettings (ctx, [&] (djec::EditSettings& s) {
        s.otherNum = n ? *n : 999;   // > 32: el plan dice "El numerador…" (como el NaN de la web)
        if (den > 0)
            s.otherDen = den;
    });
}

void TrimPanel::refreshControls()
{
    const djec::EditSettings s = ctx.processor.getEditSettings();
    on = s.trimEachBar;
    headerSwitch()->setToggleState (on, juce::dontSendNotification);
    setStepActive (on, theme::meter, theme::onMeter);
    if (! xfade.isMouseButtonDown())
        xfade.setValue (std::round (s.crossfadeSec * 1000.0), juce::dontSendNotification);
    xfadeValue.setText (text::milliseconds (std::round (xfade.getValue())));
    const int bpb = session != nullptr && session->gridValid ? session->grid.beatsPerBar : 4;
    const int den = session != nullptr ? session->sourceDen : 4;
    const auto tm = djec::targetMeter (s.amount, s.otherNum, s.otherDen, bpb, den);
    showOther = tm.amount == "other";
    const bool otherError = session != nullptr && session->hasPlan && session->plan.hasMeter && ! session->plan.meter.error.empty();
    for (std::size_t i = 0; i < chips.size(); ++i)
    {
        chips[i]->setToggleState (chipData[i].id == tm.amount, juce::dontSendNotification);
        if (chipData[i].id == "other")
            chips[i]->setContent (T (chipData[i].main.c_str()), T (chipData[i].note.c_str()),
                                  showOther && ! otherError && tm.num > 0 && tm.den > 0
                                      ? text::chipResult ((juce::String (tm.num) + "/" + juce::String (tm.den)).toStdString())
                                      : juce::String());
    }
    if (! otherNum.hasKeyboardFocus (true))
        otherNum.setText (s.otherNum >= 1 && s.otherNum <= 32 ? juce::String (s.otherNum) : juce::String(), juce::dontSendNotification);
    otherDen.setSelectedId (s.otherDen, juce::dontSendNotification);
    otherNum.getProperties().set ("invalid", showOther && otherError);
    otherNum.repaint();

    // resumen
    const bool grid = session != nullptr && session->gridValid;
    const auto& plan = session != nullptr ? session->plan : djec::EditPlan {};
    const bool applies = session != nullptr && session->hasPlan && plan.hasMeter && plan.meterApplies;
    if (on && grid)
    {
        summary.change.setText (text::meterChange (bpb, den, tm.num, tm.den));
        const auto d = djec::describeMeterChange (bpb, tm.num, tm.den, den);
        summary.desc.setText (d.error.empty() && d.delta != 0 ? T (d.text.c_str()) : juce::String());
        if (applies)
        {
            const double before = plan.useCut && plan.cutTime >= 0 ? plan.cutTime : session->durationSec;
            summary.stats.setText (text::meterStats (plan.meter.barsChanged, before, plan.outputDuration));
        }
        else
            summary.stats.setText ({});
    }
    juce::String msg;
    HintBox::Kind kind = HintBox::Kind::Info;
    if (on && session != nullptr && session->hasTake && session->hasPlan && plan.hasMeter)
    {
        const bool noGrid = plan.meter.error == djec::kMeterMsgNoBeats || plan.meter.error == djec::kMeterMsgNoBars;
        // sin cuadrícula todavía (archivo sin ubicar, FL sin tempo): eso lo explica el estado, no es un error del compás
        const bool explainElsewhere = noGrid && ! (session->gridMode == GridMode::Detect && session->detect.analyzed);
        if (! plan.meter.error.empty() && ! explainElsewhere)
        {
            msg = T (plan.meter.error.c_str());
            kind = HintBox::Kind::Error;
        }
        else if (! applies && ! plan.meter.info.empty())
            msg = T (plan.meter.info.c_str());
    }
    meterMsg.set (msg, kind);
    summary.hint.setText (on && grid && session->meterHint.isNotEmpty() ? text::flMeterHint (session->meterHint) : juce::String());

    setVisibleIf (offNote, ! on);
    for (juce::Component* c : std::initializer_list<juce::Component*> { &amountLabel, &xfadeLabel, &xfadeValue, &xfade })
        setVisibleIf (*c, on);
    for (auto& ch : chips)
        setVisibleIf (*ch, on);
    for (juce::Component* c : std::initializer_list<juce::Component*> { &otherLabel, &slash, &otherNum,
                                &otherDen })
        setVisibleIf (*c, on && showOther);
    setVisibleIf (summary, on && grid);
    setVisibleIf (meterMsg, msg.isNotEmpty());
}

void TrimPanel::update (const djec::plugin::ViewState& vs, bool sessionChanged)
{
    // los ajustes pueden cambiar sin sesión nueva (otro editor, restaurar estado): se comparan siempre
    const djec::EditSettings s = ctx.processor.getEditSettings();
    if (! sessionChanged && session != nullptr && sameSettings (s, shownSettings))
        return;
    shownSettings = s;
    session = vs.session;
    rebuildChips (session->chips);
    refreshControls();
    bodyChanged();
}

int TrimPanel::layoutBody (juce::Rectangle<int> area, bool apply)
{
    Stack st (area, apply);
    const int w = area.getWidth();
    if (! on)
    {
        st.place (offNote, offNote.heightFor (w));
        return st.used();
    }
    st.place (amountLabel, amountLabel.heightFor (w));
    st.gap (6);
    // botones en 2 columnas; cada fila tan alta como su texto más largo (2 o 3 líneas si no cabe)
    const int colW = (w - 6) / 2;
    const int rows = static_cast<int> ((chips.size() + 1) / 2);
    for (int r = 0; r < rows; ++r)
    {
        int rowH = 32;
        for (int c = 0; c < 2; ++c)
        {
            const auto idx = static_cast<std::size_t> (r * 2 + c);
            if (idx < chips.size())
                rowH = juce::jmax (rowH, chips[idx]->heightFor (colW));
        }
        auto row = st.take (rowH);
        if (apply)
            for (int c = 0; c < 2; ++c)
            {
                const auto idx = static_cast<std::size_t> (r * 2 + c);
                if (idx < chips.size())
                    chips[idx]->setBounds (c == 0 ? row.withWidth (colW) : row.withTrimmedLeft (colW + 6));
            }
        if (r + 1 < rows)
            st.gap (6);
    }
    if (showOther)
    {
        st.gap (kGap + 1);
        auto row = st.take (kRowH);
        if (apply)
        {
            otherDen.setBounds (row.removeFromRight (70));
            row.removeFromRight (4);
            slash.setBounds (row.removeFromRight (12));
            row.removeFromRight (4);
            otherNum.setBounds (row.removeFromRight (52));
            row.removeFromRight (8);
            otherLabel.setBounds (row);
        }
    }
    if (summary.isVisible())
    {
        st.gap (kGap + 3);
        st.place (summary, summary.heightFor (w));
        if (apply)
            summary.resized();
    }
    if (meterMsg.isVisible())
    {
        st.gap (kGap);
        st.place (meterMsg, meterMsg.heightFor (w));
    }
    st.gap (kGap + 3);
    {
        // «Suavizado de empalmes  [——o——]  10 ms» en una fila si al deslizador le quedan 120 px; si no, en dos
        const int lw = xfadeLabel.idealWidth(), vw = textWidth (uiFont (theme::fontBody, true), text::milliseconds (40)) + 4;
        if (lw + 10 + 120 + 10 + vw <= w)
        {
            auto row = st.take (28);
            if (apply)
            {
                xfadeLabel.setBounds (row.removeFromLeft (lw));
                row.removeFromLeft (10);
                xfadeValue.setBounds (row.removeFromRight (vw));
                row.removeFromRight (8);
                xfade.setBounds (row);
            }
        }
        else
        {
            auto row = st.take (20);
            if (apply)
            {
                xfadeValue.setBounds (row.removeFromRight (vw));
                xfadeLabel.setBounds (row);
            }
            st.gap (2);
            st.place (xfade, 24);
        }
    }
    return st.used();
}

//==============================================================================================================
// 3 · Quitar compases del final

void EndPanel::Ticks::paint (juce::Graphics& g)
{
    // las marcas siguen el recorrido del pulgar del deslizador (radio 8 px)
    const float x0 = 8.0f, x1 = static_cast<float> (getWidth()) - 8.0f;
    g.setFont (uiFont (theme::fontTiny));
    g.setColour (isEnabled() ? theme::muted : theme::muted.withAlpha (0.5f));
    for (int i = 0; i < 7; ++i)
    {
        const float x = x0 + (x1 - x0) * static_cast<float> (i) / 6.0f;
        g.drawText (text::fadeTick (djec::kFadeBeatSteps[i]), juce::Rectangle<float> (x - 15, 0, 30, static_cast<float> (getHeight())),
                    juce::Justification::centred, false);
    }
}

EndPanel::EndPanel (UiContext& c) : Panel (c, 3, T (str::endTitle), {}, true, theme::accent)
{
    headerSwitch()->setTooltip (T (str::endSwitchTip));
    headerSwitch()->onClick = [this] {
        const bool v = headerSwitch()->getToggleState();
        editSettings (ctx, [v] (djec::EditSettings& s) { s.removeEnd = v; });
        refreshControls();
        bodyChanged();
    };
    offNote.setStyle (uiFont (theme::fontSmall), theme::muted);
    offNote.setText (T (str::endOff));
    addChildComponent (offNote);

    addAndMakeVisible (barsLabel);
    barsValue.setColour (theme::cut);
    barsValue.setFontHeight (22.0f);
    addAndMakeVisible (barsValue);
    minus.onClick = [this] { setBars (ctx.processor.getEditSettings().barsToRemove - 1); };
    plus.onClick = [this] { setBars (ctx.processor.getEditSettings().barsToRemove + 1); };
    addAndMakeVisible (minus);
    addAndMakeVisible (plus);
    for (int n : { 1, 2, 4, 8, 16, 32 })
    {
        auto ch = std::make_unique<Chip>();
        ch->setContent (juce::String (n), {}, {});
        ch->setCentred (true);
        ch->setAccent (theme::cut, theme::onCut, theme::cut);
        ch->setTooltip (text::removeBarsTip (n));
        ch->onClick = [this, n] { setBars (n); };
        addAndMakeVisible (*ch);
        chips.push_back (std::move (ch));
    }
    addAndMakeVisible (readout);

    addAndMakeVisible (fadeLabel);
    fadeValue.setColour (theme::cut);
    addAndMakeVisible (fadeValue);
    fade.setRange (0, 6, 1);
    fade.setColour (juce::Slider::trackColourId, theme::cut);
    fade.setTooltip (T (str::fadeNote));
    fade.setTitle (T (str::fadeOut));
    fade.setMouseClickGrabsKeyboardFocus (false);
    fade.onValueChange = [this] {
        const int i = std::clamp (static_cast<int> (std::lround (fade.getValue())), 0, 6);
        editSettings (ctx, [i] (djec::EditSettings& s) { s.fadeBeats = djec::kFadeBeatSteps[i]; });
        refreshControls();
    };
    addAndMakeVisible (fade);
    addAndMakeVisible (ticks);
    addAndMakeVisible (curveLabel);
    curve.addItem (T (str::curveLinear), 1);
    curve.addItem (T (str::curveSmooth), 2);
    curve.addItem (T (str::curveExp), 3);
    styleCombo (curve, T (str::fadeCurve));
    curve.setTitle (T (str::fadeCurve));
    curve.onChange = [this] {
        const int id = curve.getSelectedId();
        const std::string v = id == 1 ? "linear" : id == 3 ? "exp" : "smooth";
        editSettings (ctx, [&v] (djec::EditSettings& s) { s.curve = v; });
    };
    addAndMakeVisible (curve);
    refreshControls();
}

void EndPanel::setBars (int n)
{
    // sin toma todavía no se sabe cuántos compases hay: se puede dejar elegido hasta 32
    const bool known = session != nullptr && session->hasTake;
    const int hi = known ? juce::jmax (1, maxBars) : 32;
    n = std::clamp (n, 1, hi);
    editSettings (ctx, [n] (djec::EditSettings& s) { s.barsToRemove = n; });
    refreshControls();
}

void EndPanel::refreshControls()
{
    const djec::EditSettings s = ctx.processor.getEditSettings();
    on = s.removeEnd;
    headerSwitch()->setToggleState (on, juce::dontSendNotification);
    setStepActive (on, theme::accent, theme::onAccent);
    maxBars = session != nullptr && session->gridValid ? juce::jmax (0, session->lastBarIndex) : 0;
    const bool hasBars = maxBars >= 1;
    const bool known = session != nullptr && session->hasTake;
    const djec::EditPlan* plan = session != nullptr && session->hasPlan ? &session->plan : nullptr;
    int shown = s.barsToRemove;
    if (plan != nullptr && plan->useCut && plan->cutFromBars)
        shown = plan->barsRemoved;
    else if (known && hasBars)
        shown = std::clamp (shown, 1, maxBars);
    barsValue.setText (known && ! hasBars ? juce::String::fromUTF8 ("–") : juce::String (shown));
    minus.setEnabled (known ? (hasBars && shown > 1) : shown > 1);
    plus.setEnabled (known ? (hasBars && shown < maxBars) : shown < 32);
    for (std::size_t i = 0; i < chips.size(); ++i)
    {
        const int n = 1 << static_cast<int> (i);
        chips[i]->setEnabled (! known || n <= maxBars);
        chips[i]->setToggleState (shown == n, juce::dontSendNotification);
    }
    juce::String ro;
    if (plan != nullptr && plan->useCut && plan->cutTime >= 0)
        ro = text::cutReadout (plan->cutTime, session->durationSec, plan->outputDuration,
                               s.trimEachBar && plan->hasMeter && plan->meterApplies);
    else if (known && ! hasBars)
        ro = T (str::endNoBars);
    readout.set (ro, known && ! hasBars ? HintBox::Kind::Info : HintBox::Kind::Cut);

    const int fi = fadeIndexFor (s.fadeBeats);
    if (! fade.isMouseButtonDown())
        fade.setValue (fi, juce::dontSendNotification);
    const double fadeSec = plan != nullptr && plan->useCut ? plan->fadeSec : 0.0;
    fadeValue.setText (text::fade (djec::kFadeBeatSteps[fi], fadeSec));
    curve.setSelectedId (s.curve == "linear" ? 1 : s.curve == "exp" ? 3 : 2, juce::dontSendNotification);

    setVisibleIf (offNote, ! on);
    for (juce::Component* c : std::initializer_list<juce::Component*> { &barsLabel, &barsValue, &minus,
                                &plus, &fadeLabel, &fadeValue,
                                &fade, &ticks,
                                &curveLabel, &curve })
        setVisibleIf (*c, on);
    for (auto& ch : chips)
        setVisibleIf (*ch, on);
    setVisibleIf (readout, on && ro.isNotEmpty());
}

void EndPanel::update (const djec::plugin::ViewState& vs, bool sessionChanged)
{
    const djec::EditSettings s = ctx.processor.getEditSettings();
    if (! sessionChanged && session != nullptr && sameSettings (s, shownSettings))
        return;
    shownSettings = s;
    session = vs.session;
    refreshControls();
    bodyChanged();
}

int EndPanel::layoutBody (juce::Rectangle<int> area, bool apply)
{
    Stack st (area, apply);
    const int w = area.getWidth();
    if (! on)
    {
        st.place (offNote, offNote.heightFor (w));
        return st.used();
    }
    {
        auto row = st.take (34);
        if (apply)
        {
            plus.setBounds (row.removeFromRight (36).withSizeKeepingCentre (36, 32));
            row.removeFromRight (4);
            barsValue.setBounds (row.removeFromRight (44));
            row.removeFromRight (4);
            minus.setBounds (row.removeFromRight (36).withSizeKeepingCentre (36, 32));
            row.removeFromRight (8);
            barsLabel.setBounds (row);
        }
    }
    st.gap (kGap);
    {
        auto row = st.take (28);
        if (apply)
        {
            const int n = static_cast<int> (chips.size());
            const int cw = (row.getWidth() - (n - 1) * 5) / n;
            for (int i = 0; i < n; ++i)
            {
                chips[static_cast<std::size_t> (i)]->setBounds (i + 1 == n ? row : row.removeFromLeft (cw));
                if (i + 1 < n)
                    row.removeFromLeft (5);
            }
        }
    }
    if (readout.isVisible())
    {
        st.gap (kGap);
        st.place (readout, readout.heightFor (w));
    }
    st.gap (kGap + 3);
    {
        auto row = st.take (20);
        if (apply)
        {
            fadeValue.setBounds (row.removeFromRight (juce::jmin (row.getWidth() / 2 + 40, fadeValue.idealWidth() + 4)));
            fadeLabel.setBounds (row);
        }
    }
    st.gap (2);
    st.place (fade, 24);
    st.place (ticks, 14);
    st.gap (kGap + 2);
    {
        auto row = st.take (kRowH);
        if (apply)
        {
            curve.setBounds (row.removeFromRight (juce::jmin (150, row.getWidth() / 2)));
            row.removeFromRight (8);
            curveLabel.setBounds (row);
        }
    }
    return st.used();
}

//==============================================================================================================
// 4 · Resultado

/**
 * «Arrastrar a FL»: al pulsar escribe el WAV de lo editado en segundo plano (writeDragFile; con una toma larga tarda) y,
 * en cuanto está y el ratón se mueve con el botón pulsado, empieza un arrastre de archivo externo hacia FL.
 */
class ResultPanel::DragHandle final : public juce::Component, public juce::SettableTooltipClient
{
public:
    explicit DragHandle (ResultPanel& p) : owner (p)
    {
        setTooltip (T (str::dragTip));
        setTitle (T (str::dragToFl));
        setMouseCursor (juce::MouseCursor::DraggingHandCursor);
        setWantsKeyboardFocus (false);
    }

    void paint (juce::Graphics& g) override
    {
        const bool en = isEnabled();
        const bool hover = en && isMouseOver (true);
        auto b = getLocalBounds().toFloat().reduced (0.5f);
        const juce::Colour fill = en ? (hover ? theme::accent.brighter (0.12f) : theme::accent) : theme::surface2;
        g.setColour (fill);
        g.fillRoundedRectangle (b, theme::radiusSm + 2.0f);
        if (! en)
        {
            g.setColour (theme::border);
            g.drawRoundedRectangle (b, theme::radiusSm + 2.0f, 1.0f);
        }
        const juce::Colour ink = en ? theme::onAccent : theme::muted.withAlpha (0.6f);
        // asa de puntos
        auto r = getLocalBounds().reduced (14, 0);
        auto grip = r.removeFromLeft (14).toFloat();
        g.setColour (ink.withMultipliedAlpha (0.8f));
        for (int row = 0; row < 3; ++row)
            for (int col = 0; col < 2; ++col)
                g.fillEllipse (grip.getX() + 2.0f + static_cast<float> (col) * 6.0f,
                               grip.getCentreY() - 7.0f + static_cast<float> (row) * 6.0f, 3.2f, 3.2f);
        r.removeFromLeft (10);
        g.setColour (ink);
        const int h = getHeight();
        const juce::String main = preparing ? T (str::dragPreparing) : T (str::dragToFl);
        g.setFont (uiFont (theme::fontBody + 1.0f, true));
        g.drawText (main, r.withTrimmedBottom (h / 2 - 2).withTrimmedTop (2), juce::Justification::bottomLeft, true);
        g.setFont (uiFont (theme::fontSmall));
        g.setColour (ink.withMultipliedAlpha (0.8f));
        g.drawText (T (str::dragSub), r.withTrimmedTop (h / 2 + 1), juce::Justification::topLeft, true);
    }

    void mouseEnter (const juce::MouseEvent&) override { repaint(); }
    void mouseExit (const juce::MouseEvent&) override { repaint(); }

    void mouseDown (const juce::MouseEvent&) override
    {
        started = false;
        if (! isEnabled() || preparing || isReady())
            return;
        preparing = true;
        repaint();
        const std::uint64_t id = currentRender();
        juce::Component::SafePointer<DragHandle> safe (this);
        owner.ctx.processor.writeDragFileAsync ([safe, id] (juce::File f, juce::String err) {
            if (auto* h = safe.getComponent())
                h->fileReady (f, err, id);
        });
    }

    void mouseDrag (const juce::MouseEvent& e) override
    {
        if (started || ! isEnabled() || e.getDistanceFromDragStart() < 6 || ! isReady())
            return;
        started = true;
        juce::DragAndDropContainer::performExternalDragDropOfFiles ({ readyFile.getFullPathName() }, false, this);
    }

private:
    std::uint64_t currentRender() const { return owner.session != nullptr ? owner.session->renderId : 0; }
    bool isReady() const { return readyId == currentRender() && readyFile.existsAsFile(); }

    void fileReady (const juce::File& f, const juce::String& err, std::uint64_t id)
    {
        preparing = false;
        repaint();
        if (! f.existsAsFile())
        {
            if (owner.ctx.message)
                owner.ctx.message (err.isNotEmpty() ? err : T (str::noRender), NoticeKind::Error);
            return;
        }
        readyFile = f;
        readyId = id;
    }

    ResultPanel& owner;
    bool started = false, preparing = false;
    juce::File readyFile;
    std::uint64_t readyId = ~std::uint64_t (0);
};

ResultPanel::ResultPanel (UiContext& c) : Panel (c, 0, T (str::resultTitle))
{
    summary.setStyle (uiFont (theme::fontBody, true), theme::text);
    addAndMakeVisible (summary);
    handle = std::make_unique<DragHandle> (*this);
    addAndMakeVisible (*handle);
    bits.setSelected (1);
    bits.setAccent (theme::accentSoft.brighter (0.25f), theme::text);
    bits.setTooltipAll (T (str::bitsTip));
    addAndMakeVisible (bits);
    styleButton (exportButton, T (str::exportTip));
    stylePrimary (exportButton);
    exportButton.onClick = [this] { startExport(); };
    addAndMakeVisible (exportButton);
    fileName.setStyle (uiFont (theme::fontSmall), theme::muted);
    addAndMakeVisible (fileName);
    addChildComponent (status);
}

ResultPanel::~ResultPanel() = default;

void ResultPanel::startExport()
{
    if (exporting || session == nullptr || ! session->hasRender)
        return;
    const int bitDepth = bits.getSelected() == 0 ? 16 : 24;
    juce::File dir = juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile ("DJ Edit Cutter");
    if (! dir.isDirectory())
        dir = juce::File::getSpecialLocation (juce::File::userDocumentsDirectory);
    const juce::File initial = dir.getChildFile (ctx.processor.suggestedFileName());
    chooser = std::make_unique<juce::FileChooser> (T (str::exportChooserTitle), initial, "*.wav");
    const auto chooserFlags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles
                       | juce::FileBrowserComponent::warnAboutOverwriting;
    juce::Component::SafePointer<ResultPanel> safe (this);
    chooser->launchAsync (chooserFlags, [safe, bitDepth] (const juce::FileChooser& fc) {
        if (safe == nullptr)
            return;
        juce::File f = fc.getResult();
        if (f == juce::File())
            return;
        if (! f.hasFileExtension ("wav"))
            f = f.withFileExtension ("wav");
        safe->exporting = true;
        safe->exportMessage = {};
        safe->exportRenderId = safe->session != nullptr ? safe->session->renderId : 0;
        safe->update ({ safe->session, {}, {}, {}, false }, true);
        safe->ctx.processor.exportWavAsync (f, bitDepth, [safe, f] (juce::Result r) {
            if (safe != nullptr)
                safe->exportFinished (r, f);
        });
    });
}

void ResultPanel::exportFinished (const juce::Result& r, const juce::File& file)
{
    exporting = false;
    exportFailed = r.failed();
    exportMessage = r.wasOk() ? text::exported (file.getFileName()) : text::exportError (r.getErrorMessage());
    if (ctx.message)
        ctx.message (exportMessage, r.wasOk() ? NoticeKind::Info : NoticeKind::Error);
    update ({ session, {}, {}, {}, false }, true);
}

void ResultPanel::update (const djec::plugin::ViewState& vs, bool sessionChanged)
{
    if (! sessionChanged && session != nullptr)
        return;
    if (vs.session != nullptr)
        session = vs.session;
    if (session == nullptr)
        return;
    const auto& s = *session;
    const bool has = s.hasRender && s.editedLength > 0;
    // el mensaje de la última exportación vale mientras no cambie el resultado
    if (! exporting && exportMessage.isNotEmpty() && s.renderId != exportRenderId)
        exportMessage = {};
    if (has)
    {
        const auto& p = s.plan;
        const bool meterOn = p.hasMeter && p.meterApplies;
        summary.setText (text::resultSummary (meterOn, p.target.num, p.target.den, p.useCut, p.cutFromBars ? p.barsRemoved : 0,
                                              s.durationSec, s.editedDurationSec));
        fileName.setText (text::saveAs (ctx.processor.suggestedFileName()));
    }
    else
    {
        summary.setText ({});
        fileName.setText ({});
    }
    handle->setEnabled (has);
    bits.setEnabled (has);
    exportButton.setEnabled (has && ! exporting);
    exportButton.setButtonText (exporting ? T (str::exporting) : T (str::exportWav));

    juce::String st;
    HintBox::Kind kind = HintBox::Kind::Info;
    if (exporting)
        st = T (str::exporting);
    else if (exportMessage.isNotEmpty())
    {
        st = exportMessage;
        kind = exportFailed ? HintBox::Kind::Error : HintBox::Kind::Ok;
    }
    else if (! has && s.hasTake && s.hasPlan && s.blockerText.isNotEmpty())
    {
        st = s.blockerText;
        kind = HintBox::Kind::Warn;
    }
    else if (! has)
        st = T (str::noRender);
    status.set (st, kind);
    status.setVisible (st.isNotEmpty());
    setStepActive (has, theme::primary, juce::Colours::white);
    bodyChanged();
}

int ResultPanel::layoutBody (juce::Rectangle<int> area, bool apply)
{
    Stack st (area, apply);
    const int w = area.getWidth();
    if (summary.getText().isNotEmpty())
    {
        st.place (summary, summary.heightFor (w));
        st.gap (kGap + 1);
    }
    st.place (*handle, 46);
    st.gap (kGap + 1);
    {
        // [16 bits | 24 bits] [Exportar WAV…] en una fila si caben; si no, uno encima del otro
        const int bw = bits.idealWidth();
        const int ew = textWidth (uiFont (theme::fontBody, true), T (str::exportWav)) + 24;
        if (bw + 8 + ew <= w)
        {
            auto row = st.take (kRowH);
            if (apply)
            {
                bits.setBounds (row.removeFromLeft (bw));
                row.removeFromLeft (8);
                exportButton.setBounds (row);
            }
        }
        else
        {
            st.place (bits, kRowH);
            st.gap (6);
            st.place (exportButton, kRowH);
        }
    }
    if (fileName.getText().isNotEmpty())
    {
        st.gap (6);
        st.place (fileName, fileName.heightFor (w));
    }
    if (status.isVisible())
    {
        st.gap (kGap);
        st.place (status, status.heightFor (w));
    }
    return st.used();
}

} // namespace djec::ui
