#include "PluginEditor.h"

#include "ui/Strings.h"
#include "ui/Theme.h"

#include <algorithm>

using namespace djec::ui;
using djec::plugin::Notice;
using djec::plugin::NoticeKind;

namespace
{
constexpr int kGap = theme::gap;
constexpr juce::int64 kInfoNoticeMs = 15000;     // los avisos informativos se ocultan solos
constexpr juce::int64 kWarningNoticeMs = 90000;  // las advertencias, más tarde; los errores se cierran a mano
constexpr std::uint64_t kLocalNoticeBase = 1ULL << 62;

// tamaño de la ventana mientras dure el proceso (FL cierra y abre el editor a menudo)
juce::Point<int>& rememberedSize()
{
    static juce::Point<int> size { DjecAudioProcessorEditor::kDefaultWidth, DjecAudioProcessorEditor::kDefaultHeight };
    return size;
}
} // namespace

DjecAudioProcessorEditor::DjecAudioProcessorEditor (DjecAudioProcessor& p)
    : AudioProcessorEditor (p), djecProcessor (p), ctx (p)
{
    setLookAndFeel (&lnf);
    ctx.message = [this] (const juce::String& text, NoticeKind kind) { addLocalNotice (text, kind); };
    ctx.referenceTime = [this] { return waveCard.referenceTime(); };
    ctx.relayout = [this] { layoutPending = true; };

    statusCard.onDismiss = [this] (std::uint64_t id) { dismissNotice (id); };

    addAndMakeVisible (header);
    addAndMakeVisible (statusCard);
    addAndMakeVisible (waveCard);
    for (juce::Component* c : std::initializer_list<juce::Component*> { &gridPanel, &trimPanel, &resultPanel, &endPanel })
        panelsArea.addAndMakeVisible (*c);
    panelsArea.setFocusContainerType (juce::Component::FocusContainerType::focusContainer);
    viewport.setViewedComponent (&panelsArea, false);
    viewport.setScrollBarsShown (true, false);
    viewport.setScrollBarThickness (10);
    viewport.setWantsKeyboardFocus (false);
    addAndMakeVisible (viewport);
    juce::Desktop::getInstance().addFocusChangeListener (this);

    setResizable (true, true);
    setResizeLimits (kMinWidth, kMinHeight, 2400, 1600);
    const auto sz = rememberedSize();
    setSize (juce::jlimit (kMinWidth, 2400, sz.x), juce::jlimit (kMinHeight, 1600, sz.y));
    refreshNow();
    startTimerHz (30);
}

DjecAudioProcessorEditor::~DjecAudioProcessorEditor()
{
    juce::Desktop::getInstance().removeFocusChangeListener (this);
    stopTimer();
    setLookAndFeel (nullptr);
}

void DjecAudioProcessorEditor::refreshNow()
{
    timerCallback();
    if (layoutPending)
        resized();
}

void DjecAudioProcessorEditor::timerCallback()
{
    const djec::plugin::ViewState vs = djecProcessor.getViewState();
    const bool sessionChanged = firstUpdate || vs.session->version != shownVersion;
    shownVersion = vs.session->version;
    firstUpdate = false;

    header.update (vs);
    const bool statusChanged = statusCard.update (vs, currentNotice (vs));
    dropZone.update (vs);
    waveCard.update (vs, sessionChanged);
    gridPanel.update (vs, sessionChanged);
    trimPanel.update (vs, sessionChanged);
    endPanel.update (vs, sessionChanged);
    resultPanel.update (vs, sessionChanged);

    if (statusChanged && statusCard.preferredHeight (statusCard.getWidth()) != lastStatusHeight)
        layoutPending = true;
    if (layoutPending)
        resized();
}

void DjecAudioProcessorEditor::globalFocusChanged (juce::Component* focused)
{
    if (focused == nullptr || ! panelsArea.isParentOf (focused))
        return;
    const auto r = panelsArea.getLocalArea (focused->getParentComponent(), focused->getBounds());
    const auto view = viewport.getViewArea();
    if (r.getY() < view.getY())
        viewport.setViewPosition (0, juce::jmax (0, r.getY() - 10));
    else if (r.getBottom() > view.getBottom())
        viewport.setViewPosition (0, r.getBottom() - view.getHeight() + 10);
}

//==============================================================================================================
// Avisos

void DjecAudioProcessorEditor::addLocalNotice (const juce::String& text, NoticeKind kind)
{
    Notice n;
    n.id = nextLocalId++;
    n.kind = kind;
    n.key = "local";
    n.text = text;
    n.createdMs = juce::Time::currentTimeMillis();
    localNotices.push_back (n);
    if (localNotices.size() > 4)
        localNotices.erase (localNotices.begin());
    refreshNow();
}

void DjecAudioProcessorEditor::dismissNotice (std::uint64_t id)
{
    hiddenNotices.insert (id);
    if (id >= kLocalNoticeBase)
        localNotices.erase (std::remove_if (localNotices.begin(), localNotices.end(), [id] (const Notice& n) { return n.id == id; }),
                            localNotices.end());
    else
        djecProcessor.dismissNotice (id);
    refreshNow();
}

Notice DjecAudioProcessorEditor::currentNotice (const djec::plugin::ViewState& vs)
{
    // solo el aviso más nuevo; si ya caducó o dice lo mismo que la línea de estado, ninguno (los anteriores
    // quedaron viejos: mejor la ayuda de la fase)
    const juce::int64 now = juce::Time::currentTimeMillis();
    const Notice* best = nullptr;
    auto consider = [&] (const Notice& n) {
        if (hiddenNotices.count (n.id) != 0 || n.text.isEmpty())
            return;
        if (best == nullptr || n.createdMs > best->createdMs || (n.createdMs == best->createdMs && n.id > best->id))
            best = &n;
    };
    for (const auto& n : vs.session->notices)
        consider (n);
    for (const auto& n : localNotices)
        consider (n);
    if (best == nullptr)
        return {};
    const juce::int64 age = now - best->createdMs;
    if ((best->kind == NoticeKind::Info && age > kInfoNoticeMs) || (best->kind == NoticeKind::Warning && age > kWarningNoticeMs))
        return {};
    if (best->text.trimCharactersAtEnd (".") == vs.statusText.trimCharactersAtEnd ("."))
        return {};
    return *best;
}

//==============================================================================================================
// Diseño

namespace
{
// columnas de los paneles: 1 Compases | 2 Recortar cada compás (lo principal, más ancho) | Resultado + 3 Quitar…
struct Columns
{
    int w1, w2, w3;
};
Columns columnsFor (int width)
{
    const int inner = width - 2 * kGap;
    // en ventanas estrechas «Compases» necesita un poco más (título + «Restablecer», filas del modo detectado)
    const double k1 = width < 1000 ? 0.295 : 0.27;
    const int w1 = static_cast<int> (inner * k1);
    const int w2 = static_cast<int> (inner * (0.70 - k1));
    return { w1, w2, inner - w1 - w2 };
}
} // namespace

int DjecAudioProcessorEditor::panelsHeight (int width)
{
    const auto c = columnsFor (width);
    const int c1 = gridPanel.preferredHeight (c.w1);
    const int c2 = trimPanel.preferredHeight (c.w2);
    const int c3 = resultPanel.preferredHeight (c.w3) + kGap + endPanel.preferredHeight (c.w3);
    return juce::jmax (c1, c2, c3);
}

void DjecAudioProcessorEditor::layoutPanels (int width, int height)
{
    const auto c = columnsFor (width);
    panelsArea.setSize (width, height);
    auto r = panelsArea.getLocalBounds();
    gridPanel.setBounds (r.removeFromLeft (c.w1));
    r.removeFromLeft (kGap);
    trimPanel.setBounds (r.removeFromLeft (c.w2));
    r.removeFromLeft (kGap);
    // el resultado arriba (siempre a la vista); «Quitar compases del final» debajo, con el resto del alto
    resultPanel.setBounds (r.removeFromTop (resultPanel.preferredHeight (c.w3)));
    r.removeFromTop (kGap);
    endPanel.setBounds (r);
}

void DjecAudioProcessorEditor::resized()
{
    layoutPending = false;
    rememberedSize() = { getWidth(), getHeight() };
    auto r = getLocalBounds().reduced (14, 12);
    header.setBounds (r.removeFromTop (38));
    r.removeFromTop (kGap - 2);

    lastStatusHeight = statusCard.preferredHeight (r.getWidth());
    statusCard.setBounds (r.removeFromTop (juce::jmax (58, lastStatusHeight)));
    r.removeFromTop (kGap - 2);

    // la forma de onda se queda con lo que sobra (con un mínimo); los paneles se desplazan si no caben
    const int want = panelsHeight (r.getWidth());
    const int waveMin = juce::jlimit (165, 260, static_cast<int> (getHeight() * 0.28));
    const int waveH = juce::jmax (waveMin, r.getHeight() - (kGap - 2) - want);
    waveCard.setBounds (r.removeFromTop (waveH));
    r.removeFromTop (kGap - 2);
    viewport.setBounds (r);

    int width = r.getWidth();
    int need = panelsHeight (width);
    if (need > r.getHeight())
    {
        width = r.getWidth() - viewport.getScrollBarThickness() - 4;
        need = panelsHeight (width);
    }
    layoutPanels (width, juce::jmax (need, r.getHeight()));
}

//==============================================================================================================
// Pintura

void DjecAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (theme::bg);
}

void DjecAudioProcessorEditor::paintOverChildren (juce::Graphics& g)
{
    if (! dragHover)
        return;
    // como .drop-overlay de la web: se puede soltar en cualquier parte del plugin
    const auto b = getLocalBounds().toFloat().reduced (4.0f);
    g.setColour (theme::bg.withAlpha (0.55f));
    g.fillRoundedRectangle (b, theme::radius);
    juce::Path border, dashed;
    border.addRoundedRectangle (b, theme::radius);
    const float dashes[] = { 10.0f, 6.0f };
    juce::PathStrokeType (3.0f).createDashedStroke (dashed, border, dashes, 2);
    g.setColour (dragAcceptable ? theme::accent : theme::danger);
    g.fillPath (dashed);
    // el mensaje en una pastilla, para que no se mezcle con lo de debajo
    const juce::String msg = T (dragAcceptable ? str::dropHover : str::dropBad);
    const juce::Font f = uiFont (20.0f, true);
    const int tw = juce::jmin (getWidth() - 80, textWidth (f, msg) + 48);
    const auto pill = getLocalBounds().withSizeKeepingCentre (tw, 56).toFloat();
    g.setColour (theme::surface3);
    g.fillRoundedRectangle (pill, 28.0f);
    g.setColour (dragAcceptable ? theme::accent : theme::danger);
    g.drawRoundedRectangle (pill.reduced (1.0f), 27.0f, 2.0f);
    g.setColour (theme::text);
    g.setFont (f);
    g.drawFittedText (msg, pill.toNearestInt().reduced (20, 4), juce::Justification::centred, 2);
}

//==============================================================================================================
// Archivos soltados

bool DjecAudioProcessorEditor::isInterestedInFileDrag (const juce::StringArray& files)
{
    // también los que no sirven: así se puede explicar por qué
    return ! files.isEmpty();
}

void DjecAudioProcessorEditor::fileDragEnter (const juce::StringArray& files, int, int)
{
    bool ok = false;
    for (const auto& f : files)
        ok = ok || DjecAudioProcessor::isSupportedAudioFile (juce::File (f));
    setDragHoverForTesting (true, ok);
}

void DjecAudioProcessorEditor::fileDragExit (const juce::StringArray&)
{
    setDragHoverForTesting (false, true);
}

void DjecAudioProcessorEditor::setDragHoverForTesting (bool hovering, bool acceptable)
{
    dragHover = hovering;
    dragAcceptable = acceptable;
    dropZone.setDragState (hovering, acceptable);
    repaint();
}

void DjecAudioProcessorEditor::filesDropped (const juce::StringArray& files, int, int)
{
    setDragHoverForTesting (false, true);
    for (const auto& f : files)
    {
        const juce::File file (f);
        if (DjecAudioProcessor::isSupportedAudioFile (file) && djecProcessor.loadDroppedFile (file))
        {
            refreshNow();
            return;
        }
    }
    addLocalNotice (T (str::dropBad), NoticeKind::Error);
}
