#include "ui/EditorParts.h"

#include "ui/Format.h"
#include "ui/LookAndFeel.h"

#include "djec/meter.h"

#include <cmath>

namespace djec::ui
{

using djec::plugin::AlignState;
using djec::plugin::NoticeKind;
using djec::plugin::Phase;

void paintLogo (juce::Graphics& g, juce::Rectangle<float> area)
{
    // mismo dibujo que el ícono de la web (viewBox 64×64)
    const float k = juce::jmin (area.getWidth(), area.getHeight()) / 64.0f;
    const auto o = area.getTopLeft();
    auto R = [&] (float x, float y, float w, float h) { return juce::Rectangle<float> (o.x + x * k, o.y + y * k, w * k, h * k); };
    g.setColour (juce::Colour (0xff0a0e13));
    g.fillRoundedRectangle (R (0, 0, 64, 64), 14 * k);
    g.setColour (juce::Colour (0xff22c7ee));
    for (auto r : { R (8, 27, 5, 10), R (16, 18, 5, 28), R (24, 23, 5, 18), R (32, 13, 5, 38) })
        g.fillRoundedRectangle (r, 2.5f * k);
    g.setColour (juce::Colour (0xff3a4757));
    g.fillRoundedRectangle (R (46, 24, 5, 16), 2.5f * k);
    g.fillRoundedRectangle (R (54, 28, 4, 8), 2.0f * k);
    g.setColour (juce::Colour (0xffff6a3d));
    g.fillRoundedRectangle (R (40, 7, 3.5f, 50), 1.75f * k);
    g.setColour (theme::border);
    g.drawRoundedRectangle (R (0, 0, 64, 64).reduced (0.5f), 14 * k, 1.0f);
}

//==============================================================================================================
// Cabecera

HeaderBar::HeaderBar (UiContext& c, juce::Component& dropZone) : ctx (c), drop (dropZone)
{
    addAndMakeVisible (pill);
    addAndMakeVisible (drop);
    ab.setAccent (theme::meter, theme::onMeter);
    ab.setFontHeight (theme::fontBody);
    ab.setTooltipAll (T (str::abTip));
    ab.setSelected (1);
    ab.onChange = [this] (int i) { ctx.processor.setListenOriginal (i == 0); };
    addAndMakeVisible (ab);
    setFocusContainerType (FocusContainerType::focusContainer);
}

void HeaderBar::update (const djec::plugin::ViewState& vs)
{
    const auto& s = *vs.session;
    const char* label = str::pillWaiting;
    juce::Colour fg = theme::muted, bg = theme::surface3;
    bool pulse = false;
    const juce::Colour rec (0xffff5c5c);
    switch (vs.phase)
    {
        case Phase::WaitingForPlay: break;
        case Phase::Taking: label = str::pillTaking; fg = rec; bg = theme::dangerSoft; pulse = true; break;
        case Phase::TakingMore: label = str::pillTakingMore; fg = rec; bg = theme::dangerSoft; pulse = true; break;
        case Phase::LoadingFile: label = str::pillLoading; fg = theme::accent; bg = theme::accentSoft; break;
        case Phase::WaitingForFilePlay: label = str::pillWaitingFile; fg = theme::accent; bg = theme::accentSoft; break;
        case Phase::SearchingFile: label = str::pillSearching; fg = theme::accent; bg = theme::accentSoft; pulse = true; break;
        case Phase::FileNotFound: label = str::pillNotFound; fg = theme::warn; bg = theme::warnSoft; break;
        case Phase::Processing: label = str::pillProcessing; fg = theme::accent2; bg = theme::accentSoft; pulse = true; break;
        case Phase::Ready: label = str::pillReady; fg = theme::ok; bg = theme::okSoft; break;
        case Phase::PlayingEdited: label = str::pillPlayingEdited; fg = theme::meter; bg = theme::meterSoft; pulse = true; break;
        case Phase::PlayingOriginal: label = str::pillPlayingOriginal; fg = theme::text; bg = theme::surface3; break;
        case Phase::OutsideTake: label = str::pillOutside; fg = theme::warn; bg = theme::warnSoft; break;
        case Phase::NothingToEdit: label = str::pillNothing; fg = theme::warn; bg = theme::warnSoft; break;
    }
    const int before = pill.idealWidth();
    pill.set (T (label), fg, bg, pulse);
    hasRender = s.hasRender;
    ab.setEnabled (hasRender);
    ab.setTooltipAll (T (hasRender ? str::abTip : str::abDisabledTip));
    ab.setSelected (vs.live.listenOriginal || ctx.processor.isListeningOriginal() ? 0 : 1);
    if (pill.idealWidth() != before)
        resized();
}

void HeaderBar::paint (juce::Graphics& g)
{
    auto r = getLocalBounds();
    paintLogo (g, r.removeFromLeft (34).withSizeKeepingCentre (34, 34).toFloat());
    r.removeFromLeft (10);
    g.setColour (theme::text);
    const juce::Font f = uiFont (theme::fontBrand, true);
    g.setFont (f);
    g.drawText (T (str::appName), r.removeFromLeft (textWidth (f, T (str::appName)) + 4), juce::Justification::centredLeft, false);
}

void HeaderBar::resized()
{
    auto r = getLocalBounds();
    r.removeFromLeft (34 + 10 + textWidth (uiFont (theme::fontBrand, true), T (str::appName)) + 4 + 14);
    const int pw = pill.idealWidth();
    pill.setBounds (r.removeFromLeft (pw).withSizeKeepingCentre (pw, 26));
    r.removeFromLeft (16);
    const int abW = juce::jmax (200, ab.idealWidth());
    ab.setBounds (r.removeFromRight (abW).withSizeKeepingCentre (abW, 34));
    r.removeFromRight (12);
    const int w = juce::jmin (r.getWidth(), 440);
    drop.setBounds (r.removeFromRight (w).withSizeKeepingCentre (w, juce::jmin (40, getHeight())));
}

//==============================================================================================================
// Tarjeta de estado

StatusCard::StatusCard (UiContext& c) : ctx (c)
{
    status.setStyle (uiFont (theme::fontStatus, true), theme::text);
    status.setMaxLines (2);
    addAndMakeVisible (status);
    secondary.setStyle (uiFont (theme::fontSmall), theme::muted);
    secondary.setMaxLines (3);
    addAndMakeVisible (secondary);
    close.setFlat (true);
    close.onClick = [this] {
        if (notice.id != 0 && onDismiss)
            onDismiss (notice.id);
    };
    addChildComponent (close);
    styleButton (barOne, T (str::barOneTip));
    barOne.onClick = [this] { ctx.processor.fileStartsAtBarOne(); };
    addChildComponent (barOne);
    styleButton (retake, T (str::retakeTip));
    retake.onClick = [this] { ctx.processor.clearTake(); };
    addAndMakeVisible (retake);
    setFocusContainerType (FocusContainerType::focusContainer);
}

bool StatusCard::update (const djec::plugin::ViewState& vs, const djec::plugin::Notice& n)
{
    const auto& s = *vs.session;
    juce::String second;
    juce::Colour secondColour = theme::muted;
    if (n.id != 0)
    {
        second = n.text;
        secondColour = n.kind == NoticeKind::Error ? theme::danger : n.kind == NoticeKind::Warning ? theme::warn : theme::text;
    }
    else
    {
        const char* help = "";
        switch (vs.phase)
        {
            case Phase::WaitingForPlay: help = str::helpWaiting; break;
            case Phase::Taking: help = str::helpTaking; break;
            case Phase::TakingMore: help = str::helpTakingMore; break;
            case Phase::LoadingFile: help = str::helpLoading; break;
            case Phase::WaitingForFilePlay:
            case Phase::SearchingFile: help = str::helpWaitingFile; break;
            case Phase::FileNotFound: help = str::helpNotFound; break;
            case Phase::Processing: help = str::helpProcessing; break;
            case Phase::Ready: help = str::helpReady; break;
            case Phase::PlayingEdited: help = str::helpPlayingEdited; break;
            case Phase::PlayingOriginal: help = str::helpPlayingOriginal; break;
            case Phase::OutsideTake: help = str::helpOutside; break;
            case Phase::NothingToEdit: help = str::helpNothing; break;
        }
        second = T (help);
    }
    // plan B del archivo soltado: destacado si no se encontró
    const bool showBarOne = s.canUseBarOneFallback && ! s.loadingFile && s.align != AlignState::Found;
    const bool barOneHot = s.align == AlignState::NotFound;
    const bool canRetake = s.hasTake || vs.live.recKind >= 0;
    const bool changed = vs.statusText != status.getText() || warning != vs.statusIsWarning || n.id != notice.id
                         || second != secondary.getText() || showBarOne != barOne.isVisible()
                         || barOneHot != barOne.getProperties().getWithDefault ("hot", false).operator bool()
                         || canRetake != retake.isEnabled();
    if (! changed)
        return false;
    status.setText (vs.statusText);
    warning = vs.statusIsWarning;
    status.setColourOnly (warning ? theme::warn : theme::text);
    notice = n;
    secondary.setText (second);
    secondary.setColourOnly (secondColour);
    close.setVisible (n.id != 0);
    barOne.setVisible (showBarOne);
    barOne.getProperties().set ("hot", barOneHot);
    if (barOneHot)
        stylePrimary (barOne);
    else
    {
        barOne.setColour (juce::TextButton::buttonColourId, theme::surface2);
        barOne.setColour (juce::TextButton::textColourOffId, theme::text);
    }
    retake.setEnabled (canRetake);
    resized();
    repaint();
    return true;
}

int StatusCard::buttonsWidth() const
{
    const juce::Font f = uiFont (theme::fontBody, true);
    int w = juce::jmax (180, textWidth (f, retake.getButtonText()) + 28);
    if (barOne.isVisible())
        w += 10 + textWidth (f, barOne.getButtonText()) + 28;
    return w;
}

juce::Rectangle<int> StatusCard::textArea (juce::Rectangle<int> r) const
{
    r = r.reduced (16, 10);
    r.removeFromRight (buttonsWidth() + 16);
    r.removeFromLeft (12);   // barra de color
    return r;
}

int StatusCard::preferredHeight (int width) const
{
    const auto t = textArea ({ 0, 0, width, 1000 });
    const int w = t.getWidth() - (notice.id != 0 ? 30 : 0);
    return 20 + status.heightFor (t.getWidth()) + 3 + juce::jmax (17, secondary.heightFor (w));
}

void StatusCard::paint (juce::Graphics& g)
{
    paintCard (g, getLocalBounds().toFloat());
    // barra de color según el estado
    const auto bar = juce::Rectangle<float> (14.0f, 11.0f, 4.0f, static_cast<float> (getHeight()) - 22.0f);
    g.setColour (warning ? theme::warn : notice.id != 0 && notice.kind == NoticeKind::Error ? theme::danger : theme::accent);
    g.fillRoundedRectangle (bar, 2.0f);
}

void StatusCard::resized()
{
    auto full = getLocalBounds();
    auto t = textArea (full);
    const juce::Font f = uiFont (theme::fontBody, true);
    auto buttons = full.reduced (16, 0).removeFromRight (buttonsWidth());
    const int rw = juce::jmax (180, textWidth (f, retake.getButtonText()) + 28);
    retake.setBounds (buttons.removeFromRight (rw).withSizeKeepingCentre (rw, theme::controlH + 2));
    if (barOne.isVisible())
    {
        buttons.removeFromRight (10);
        barOne.setBounds (buttons.withSizeKeepingCentre (buttons.getWidth(), theme::controlH + 2));
    }
    status.setBounds (t.removeFromTop (status.heightFor (t.getWidth())));
    t.removeFromTop (3);
    if (close.isVisible())
    {
        close.setBounds (t.removeFromRight (26).removeFromTop (22));
        t.removeFromRight (4);
    }
    secondary.setBounds (t);
}

//==============================================================================================================
// Soltar un archivo

DropZone::DropZone (UiContext& c)
{
    juce::ignoreUnused (c);
    setTooltip (T (str::dropTip));
    setInterceptsMouseClicks (true, false);
}

void DropZone::update (const djec::plugin::ViewState& vs)
{
    const auto& s = *vs.session;
    const bool file = s.source == djec::plugin::TakeSource::File && s.hasTake;
    const bool prevShow = showFile;
    const juce::String prevA = alignLine, prevF = fileLine;
    showFile = file || s.loadingFile;
    warn = found = false;
    if (showFile)
    {
        fileLine = T ("«") + s.displayName + T ("»");
        if (s.loadingFile)
            alignLine = T (str::alignLoading);
        else
            switch (s.align)
            {
                case AlignState::WaitingForPlay: alignLine = T (vs.live.recKind == 3 ? str::alignSearching : str::alignWaiting); break;
                case AlignState::Searching: alignLine = T (str::alignSearching); break;
                case AlignState::Found: alignLine = text::alignFound (s.fileStartBar); found = true; break;
                case AlignState::NotFound: alignLine = T (str::alignNotFound); warn = true; break;
                case AlignState::Manual: alignLine = T (str::alignManual); found = true; break;
                case AlignState::None: alignLine = {}; break;
            }
    }
    if (prevShow != showFile || prevA != alignLine || prevF != fileLine)
        repaint();
}

void DropZone::setDragState (bool h, bool a)
{
    if (h == hover && a == acceptable)
        return;
    hover = h;
    acceptable = a;
    repaint();
}

void DropZone::paint (juce::Graphics& g)
{
    auto b = getLocalBounds().toFloat().reduced (1.0f);
    const juce::Colour edge = hover ? (acceptable ? theme::accent : theme::danger) : warn ? theme::warn.withAlpha (0.7f) : theme::borderStrong;
    g.setColour (hover ? (acceptable ? theme::accentSoft : theme::dangerSoft) : theme::surface);
    g.fillRoundedRectangle (b, theme::radiusSm + 2.0f);
    juce::Path border, dashed;
    border.addRoundedRectangle (b, theme::radiusSm + 2.0f);
    const float dashes[] = { 5.0f, 4.0f };
    juce::PathStrokeType (hover ? 2.0f : 1.3f).createDashedStroke (dashed, border, dashes, 2);
    g.setColour (edge);
    g.fillPath (dashed);

    auto r = getLocalBounds().reduced (10, 4);
    // ícono: flecha hacia una bandeja
    auto icon = r.removeFromLeft (26).withSizeKeepingCentre (26, 26).toFloat();
    g.setColour (hover && ! acceptable ? theme::danger : warn ? theme::warn : found ? theme::ok : theme::accent);
    g.fillEllipse (icon);
    {
        const auto c = icon.getCentre();
        juce::Path p;
        p.startNewSubPath (c.x, c.y - 6.5f);
        p.lineTo (c.x, c.y + 2.0f);
        p.startNewSubPath (c.x - 3.5f, c.y - 1.5f);
        p.lineTo (c.x, c.y + 2.0f);
        p.lineTo (c.x + 3.5f, c.y - 1.5f);
        p.startNewSubPath (c.x - 5.5f, c.y + 2.5f);
        p.lineTo (c.x - 5.5f, c.y + 5.5f);
        p.lineTo (c.x + 5.5f, c.y + 5.5f);
        p.lineTo (c.x + 5.5f, c.y + 2.5f);
        g.setColour (theme::onAccent);
        g.strokePath (p, juce::PathStrokeType (1.6f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }
    r.removeFromLeft (9);
    juce::String l1, l2;
    juce::Colour c2 = theme::muted;
    if (hover)
        l1 = acceptable ? T (str::dropHover) : T (str::dropBad);
    else if (showFile)
    {
        l1 = fileLine;
        l2 = alignLine;
        c2 = warn ? theme::warn : found ? theme::ok : theme::text;
    }
    else
    {
        l1 = T (str::dropTitle);
        l2 = T (str::dropSub);
    }
    const juce::Font f1 = uiFont (theme::fontSmall, true), f2 = uiFont (theme::fontTiny + 0.5f, showFile);
    if (l2.isEmpty())
    {
        g.setColour (theme::text);
        g.setFont (f1);
        g.drawFittedText (l1, r, juce::Justification::centredLeft, 2, 0.9f);
        return;
    }
    auto top = r.withHeight (r.getHeight() / 2).withTrimmedTop (1);
    auto bottom = r.withTrimmedTop (r.getHeight() / 2);
    g.setColour (theme::text);
    g.setFont (f1);
    g.drawFittedText (l1, top, juce::Justification::bottomLeft, 1, 0.85f);
    g.setColour (c2);
    g.setFont (f2);
    g.drawFittedText (l2, bottom.translated (0, 1), juce::Justification::topLeft, 1, 0.85f);
}

//==============================================================================================================
// Tarjeta de la forma de onda

WaveCard::WaveCard (UiContext& c)
{
    juce::ignoreUnused (c);
    addAndMakeVisible (wave);
    wave.onViewChanged = [this] { updateZoomButtons(); };
    zoomOut.onClick = [this] { wave.zoomBy (2.0); };
    zoomIn.onClick = [this] { wave.zoomBy (0.5); };
    styleButton (zoomAll, T (str::zoomAllTip));
    zoomAll.onClick = [this] { wave.showAll(); };
    for (auto* b : std::initializer_list<juce::Component*> { &zoomOut, &zoomIn, &zoomAll })
        addAndMakeVisible (*b);
    addChildComponent (spinner);
    setFocusContainerType (FocusContainerType::focusContainer);
}

void WaveCard::updateZoomButtons()
{
    zoomIn.setEnabled (wave.canZoomIn());
    zoomOut.setEnabled (wave.canZoomOut());
    zoomAll.setEnabled (wave.canZoomOut());
}

double WaveCard::referenceTime() const
{
    if (std::isfinite (playheadSec))
        return playheadSec;
    return wave.viewCentre();
}

void WaveCard::update (const djec::plugin::ViewState& vs, bool sessionChanged)
{
    const auto& s = *vs.session;
    const auto& L = vs.live;
    if (sessionChanged)
    {
        wave.setSession (s);
        const bool file = s.source == djec::plugin::TakeSource::File;
        // sin nombre de pista el procesador dice "Toma": "Toma del canal" se lee mejor que "Toma «Toma»"
        title = ! s.hasTake ? juce::String()
                : (! file && s.displayName == T (str::takeLabel)) ? T (str::takeFromChannel)
                                                                  : text::takeTitle (file, s.displayName);
        meta = s.hasTake ? text::takeMeta (s.durationSec, s.sampleRate, s.numChannels) : juce::String();
        legendText = {};
        const auto& p = s.plan;
        if (s.hasPlan && p.hasMeter && p.meterApplies && s.gridValid)
        {
            const auto d = djec::describeMeterChange (s.grid.beatsPerBar, p.target.num, p.target.den, s.sourceDen);
            if (d.error.empty() && ! d.text.empty())
            {
                legendRepeated = p.meter.delta > 0;
                legendText = text::legend (legendRepeated, T (d.text.c_str()));
            }
        }
        updateZoomButtons();
    }
    // cabezal: lo que suena (editado → instante de la toma que suena; si no, la posición en la toma)
    double ph = std::numeric_limits<double>::quiet_NaN();
    if (s.hasTake && s.placed && L.positionKnown)
    {
        if (L.outputEdited)
            ph = L.sourceSec;
        else if (L.insideTake)
            ph = L.takeSec;
    }
    playheadSec = ph;
    wave.setPlayhead (ph, L.outputEdited, L.playing);

    Placeholder p = Placeholder::None;
    if (L.recKind == 0 && ! s.hasTake)
        p = Placeholder::Taking;
    else if (s.loadingFile)
        p = Placeholder::Loading;
    else if (! s.hasTake)
        p = Placeholder::Empty;
    else if (s.peaks == nullptr)
        p = s.source == djec::plugin::TakeSource::File && ! s.placed ? Placeholder::FilePending : Placeholder::Processing;
    const juce::String line = p == Placeholder::Taking ? text::takingProgress (L.recSeconds, L.recBars, L.recBars > 0 || L.recSeconds > 2)
                                                       : juce::String();
    if (p != placeholder || line != takingLine || sessionChanged)
    {
        placeholder = p;
        takingLine = line;
        wave.setVisible (p == Placeholder::None);
        const bool spin = p == Placeholder::Loading || p == Placeholder::Processing;
        spinner.setVisible (spin);
        spinner.setActive (spin);
        for (auto* b : std::initializer_list<juce::Component*> { &zoomOut, &zoomIn, &zoomAll })
            b->setVisible (p == Placeholder::None);
        resized();
        repaint();
    }
}

void WaveCard::layoutToolbar (juce::Rectangle<int> bar)
{
    if (placeholder == Placeholder::None)
    {
        zoomAll.setBounds (bar.removeFromRight (juce::jmax (84, textWidth (uiFont (theme::fontBody, true), zoomAll.getButtonText()) + 24)));
        bar.removeFromRight (6);
        zoomIn.setBounds (bar.removeFromRight (32));
        bar.removeFromRight (4);
        zoomOut.setBounds (bar.removeFromRight (32));
        bar.removeFromRight (16);
    }
    const juce::Font tf = uiFont (theme::fontBody, true), mf = uiFont (theme::fontSmall);
    const int tw = textWidth (tf, title) + (meta.isNotEmpty() ? 12 + textWidth (mf, meta) : 0);
    titleArea = bar.removeFromLeft (juce::jmin (bar.getWidth(), tw + 4));
    bar.removeFromLeft (20);
    const int lw = textWidth (uiFont (theme::fontSmall, true), legendText) + 26;
    legendArea = legendText.isNotEmpty() && lw <= bar.getWidth() ? bar.removeFromRight (lw) : juce::Rectangle<int>();
}

void WaveCard::resized()
{
    auto r = getLocalBounds().reduced (10);
    layoutToolbar (r.removeFromTop (30));
    r.removeFromTop (8);
    wave.setBounds (r);
    spinner.setBounds (r.withSizeKeepingCentre (26, 26).translated (0, -24));
}

void WaveCard::paint (juce::Graphics& g)
{
    paintCard (g, getLocalBounds().toFloat());
    // título de la toma
    if (title.isNotEmpty())
    {
        auto t = titleArea;
        const juce::Font tf = uiFont (theme::fontBody, true);
        g.setColour (theme::text);
        g.setFont (tf);
        const int tw = juce::jmin (t.getWidth(), textWidth (tf, title) + 2);
        g.drawText (title, t.removeFromLeft (tw), juce::Justification::centredLeft, true);
        if (meta.isNotEmpty() && t.getWidth() > 30)
        {
            t.removeFromLeft (10);
            g.setColour (theme::muted);
            g.setFont (uiFont (theme::fontSmall));
            g.drawText (meta, t, juce::Justification::centredLeft, true);
        }
    }
    // leyenda: qué es el rojo / verde de cada compás
    if (! legendArea.isEmpty())
    {
        auto l = legendArea;
        const auto sw = l.removeFromLeft (16).withSizeKeepingCentre (16, 16).toFloat();
        if (legendRepeated)
        {
            g.setColour (theme::wf::meterRepeat);
            g.fillRoundedRectangle (sw, 4.0f);
            g.setColour (theme::wf::meterRepeatEdge);
            g.drawRoundedRectangle (sw.reduced (0.5f), 4.0f, 1.0f);
            g.fillRect (sw.withWidth (2.0f).reduced (0, 2.0f));
        }
        else
        {
            g.setColour (theme::wf::meterRemoved);
            g.fillRoundedRectangle (sw, 4.0f);
            paintHatch (g, sw.reduced (1.0f), theme::wf::meterHatch, 4.0f, 1.1f);
            g.setColour (theme::wf::meterHatch);
            g.drawRoundedRectangle (sw.reduced (0.5f), 4.0f, 1.0f);
        }
        l.removeFromLeft (8);
        g.setColour (theme::text);
        g.setFont (uiFont (theme::fontSmall, true));
        g.drawText (legendText, l, juce::Justification::centredLeft, true);
    }

    if (placeholder == Placeholder::None)
        return;
    // estados sin forma de onda
    auto area = getLocalBounds().reduced (10);
    if (title.isNotEmpty())
        area.removeFromTop (38);
    paintCard (g, area.toFloat(), theme::wf::bg, theme::border, 6.0f);
    auto c = area.reduced (24, 16);
    juce::AttributedString s;
    s.setJustification (juce::Justification::centred);
    s.setWordWrap (juce::AttributedString::byWord);
    switch (placeholder)
    {
        case Placeholder::Empty:
        {
            juce::AttributedString t;
            t.setJustification (juce::Justification::topLeft);
            t.setWordWrap (juce::AttributedString::byWord);
            t.setLineSpacing (5.0f);
            t.append (T (str::emptyTitle) + "\n", uiFont (theme::fontTitle + 3.0f, true), theme::text);
            const char* steps[] = { str::emptyStep1, str::emptyStep2, str::emptyStep3 };
            for (int i = 0; i < 3; ++i)
            {
                t.append (juce::String (i + 1) + "    ", uiFont (theme::fontBody + 1.0f, true), theme::accent);
                t.append (T (steps[i]) + "\n", uiFont (theme::fontBody + 0.5f), theme::muted);
            }
            t.append (T (str::emptyDrop), uiFont (theme::fontSmall), theme::muted.withAlpha (0.8f));
            juce::TextLayout tl;
            const float w = juce::jmin (600.0f, static_cast<float> (c.getWidth()));
            tl.createLayout (t, w);
            tl.draw (g, c.toFloat().withSizeKeepingCentre (w, juce::jmin (tl.getHeight(), static_cast<float> (c.getHeight()))));
            return;
        }
        case Placeholder::Taking:
        {
            // punto de grabación
            const auto dot = juce::Rectangle<float> (14, 14).withCentre ({ static_cast<float> (c.getCentreX()), static_cast<float> (c.getCentreY()) - 36.0f });
            g.setColour (juce::Colour (0xffff5c5c).withAlpha (0.25f));
            g.fillEllipse (dot.expanded (6));
            g.setColour (juce::Colour (0xffff5c5c));
            g.fillEllipse (dot);
            s.append (T (str::takingTitle) + "\n", uiFont (theme::fontTitle + 2.0f, true), theme::text);
            if (takingLine.isNotEmpty())
                s.append (takingLine + "\n", uiFont (theme::fontStatus, true), theme::accent);
            s.append (T (str::takingSub), uiFont (theme::fontBody), theme::muted);
            break;
        }
        case Placeholder::Loading: s.append (T (str::alignLoading), uiFont (theme::fontBody, true), theme::muted); break;
        case Placeholder::Processing: s.append (T (str::processingTitle), uiFont (theme::fontBody, true), theme::muted); break;
        case Placeholder::FilePending:
            s.append (T (str::filePendingTitle) + "\n", uiFont (theme::fontTitle, true), theme::text);
            s.append (T (str::filePendingSub), uiFont (theme::fontBody), theme::muted);
            break;
        case Placeholder::None: break;
    }
    juce::TextLayout tl;
    tl.createLayout (s, static_cast<float> (c.getWidth()));
    auto box = c.toFloat();
    if (placeholder == Placeholder::Loading || placeholder == Placeholder::Processing)
        box = box.withTrimmedTop (40);
    else if (placeholder == Placeholder::Taking)
        box = box.withTrimmedTop (20);
    tl.draw (g, box.withSizeKeepingCentre (box.getWidth(), juce::jmin (tl.getHeight(), box.getHeight())));
}

} // namespace djec::ui
