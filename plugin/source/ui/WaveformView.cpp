#include "ui/WaveformView.h"

#include "ui/Format.h"
#include "ui/LookAndFeel.h"
#include "ui/Strings.h"
#include "ui/Theme.h"
#include "ui/Widgets.h"

#include "djec/fade.h"

#include <algorithm>
#include <cmath>

namespace djec::ui
{

namespace
{
constexpr double kTickSteps[] = { 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600 };

std::size_t lowerBound (const std::vector<double>& v, double t)
{
    return static_cast<std::size_t> (std::lower_bound (v.begin(), v.end(), t) - v.begin());
}

/** [i0, i1) de los trozos que se ven en [t0, t1] (ordenados por inicio, sin solaparse). */
std::pair<std::size_t, std::size_t> visibleSlices (const std::vector<djec::Segment>& s, double t0, double t1)
{
    auto it0 = std::lower_bound (s.begin(), s.end(), t0, [] (const djec::Segment& a, double t) { return a.end < t; });
    auto it1 = std::upper_bound (it0, s.end(), t1, [] (double t, const djec::Segment& a) { return t < a.start; });
    return { static_cast<std::size_t> (it0 - s.begin()), static_cast<std::size_t> (it1 - s.begin()) };
}

juce::int64 nowMs() { return juce::Time::currentTimeMillis(); }
} // namespace

WaveformView::WaveformView()
{
    setOpaque (false);
    setTooltip (T (str::waveTip));
    setRepaintsOnMouseActivity (false);
}

void WaveformView::markDirty()
{
    dirty = true;
    repaint();
}

void WaveformView::setSession (const djec::plugin::SessionView& s)
{
    const bool newTake = s.takeId != takeId || std::fabs (s.durationSec - duration) > 1e-9 || s.peaks != peaks;
    const bool hadTake = duration > 0;
    takeId = s.takeId;
    duration = s.hasTake ? s.durationSec : 0;
    sampleRate = s.sampleRate;
    if (s.peaks != peaks)
    {
        peaks = s.peaks;
        float pk = 0;
        if (peaks != nullptr && ! peaks->levels.empty())
        {
            const auto& L = peaks->levels.back();
            for (std::size_t i = 0; i < L.mins.size(); ++i)
                pk = std::max (pk, std::max (std::fabs (L.mins[i]), std::fabs (L.maxs[i])));
        }
        norm = std::min (8.0f, 0.96f / std::max (pk, 1e-3f));   // como la web: la onda llena el alto
    }
    beats = s.gridValid ? s.grid.beats : std::vector<double>();
    bars = s.gridValid ? s.bars : std::vector<djec::Bar>();
    lastBarIndex = s.lastBarIndex;

    // números de compás como en FL (cuadrícula de FL con tempo y compás fijos y sin «Mover el 1»)
    barNumberOffset = 0;
    const auto& m = s.hostMeta;
    if (s.gridMode == djec::plugin::GridMode::Host && m.valid && ! m.tempoChanges && ! m.meterChanges
        && s.barOffsetBeats == 0 && ! bars.empty() && m.hostBpm > 0 && m.tsNum > 0 && m.tsDen > 0)
    {
        const double barQ = m.tsNum * 4.0 / m.tsDen;
        const double ppq = m.ppqStart + bars.front().start * m.hostBpm / 60.0;
        const double k = ppq / barQ;
        if (std::fabs (k - std::round (k)) < 0.05 && k >= 0)
            barNumberOffset = static_cast<int> (std::llround (k)) - bars.front().index;
    }

    const bool hadCut = cutTime >= 0;
    removed.clear();
    repeated.clear();
    cutTime = -1;
    fadeSec = 0;
    if (s.hasPlan)
    {
        if (s.plan.hasMeter && s.plan.meterApplies && s.plan.meter.error.empty())
        {
            removed = s.plan.meter.removed;
            repeated = s.plan.meter.repeated;
            auto byStart = [] (const djec::Segment& a, const djec::Segment& b) { return a.start < b.start; };
            std::sort (removed.begin(), removed.end(), byStart);
            std::sort (repeated.begin(), repeated.end(), byStart);
        }
        if (s.plan.useCut && s.plan.cutTime >= 0)
        {
            cutTime = s.plan.cutTime;
            fadeSec = std::clamp (s.plan.fadeSec, 0.0, cutTime);
        }
        curve = s.plan.curve;
    }
    if (newTake || ! hadTake || ! viewInitialised)
        initialView();
    else if (! hadCut && cutTime >= 0 && (cutTime < viewStart || cutTime > viewEnd))
        showEnd();   // como la web al activar «Quitar compases del final»: que se vea el corte
    else
        setView (viewStart, viewEnd, false);
    markDirty();
}

void WaveformView::showEnd()
{
    // initialViewRange de la web: los últimos compases hasta el final, con el corte a la vista
    double start = std::max (0.0, duration - 30.0), end = duration;
    if (! bars.empty() && lastBarIndex >= 0)
    {
        const int li = std::min (lastBarIndex, static_cast<int> (bars.size()) - 1);
        const int back = getWidth() >= 900 ? 16 : 12;
        start = bars[static_cast<std::size_t> (std::max (0, li - back + 1))].start;
        end = std::max (bars[static_cast<std::size_t> (li)].end, duration);
    }
    if (cutTime >= 0 && cutTime < start)
        start = cutTime;
    const double pad = std::max (0.2, (end - start) * 0.04);
    setView (std::max (0.0, start - pad), std::min (duration, end + pad), false);
}

void WaveformView::initialView()
{
    if (duration <= 0)
    {
        viewStart = viewEnd = 0;
        viewInitialised = false;
        return;
    }
    viewInitialised = true;
    // con «Quitar compases del final», el final (como la web); si no, como startViewRange de la web: el principio
    // (anacrusa + los primeros compases), donde se ven de cerca los trozos que se quitan de cada compás
    if (cutTime >= 0)
    {
        showEnd();
        return;
    }
    if (bars.size() > 1 && (! removed.empty() || ! repeated.empty()))
    {
        const auto& first = bars.front();
        const int count = getWidth() >= 900 ? 16 : 12;
        const std::size_t k = std::min<std::size_t> (bars.size(), static_cast<std::size_t> (count)) - 1;
        const double barLen = first.end - first.start > 0 ? first.end - first.start : 2.0;
        const double start = first.start <= barLen * 2 ? 0.0 : std::max (0.0, first.start - barLen);
        double end = std::min (duration, std::max (bars[k].end, start));
        end = std::min (duration, end + std::max (0.1, (end - start) * 0.01));
        if (end - start < 0.5)
            end = std::min (duration, start + 0.5);
        setView (start, end, false);
        return;
    }
    setView (0, duration, false);
}

double WaveformView::minSpan() const
{
    const double sr = sampleRate > 0 ? sampleRate : 48000.0;
    // como mucho 4 px por pico (los picos más finos son de 64 muestras)
    const double w = std::max (100, getWidth());
    return std::min (std::max (0.25, w * 16.0 / sr), std::max (duration, 0.01));
}

void WaveformView::setView (double start, double end, bool user)
{
    if (duration <= 0)
        return;
    double span = std::clamp (end - start, minSpan(), duration);
    if (! std::isfinite (span))
        span = duration;
    start = std::clamp (start, 0.0, duration - span);
    end = start + span;
    if (user)
        lastUserMs = nowMs();
    if (std::fabs (start - viewStart) < 1e-9 && std::fabs (end - viewEnd) < 1e-9)
        return;
    viewStart = start;
    viewEnd = end;
    markDirty();
    if (onViewChanged)
        onViewChanged();
}

void WaveformView::zoomBy (double factor)
{
    double anchor = viewCentre();
    if (std::isfinite (playhead) && playhead >= viewStart && playhead <= viewEnd)
        anchor = playhead;
    const double span = (viewEnd - viewStart) * factor;
    const double k = (anchor - viewStart) / std::max (1e-9, viewEnd - viewStart);
    setView (anchor - span * k, anchor - span * k + span, true);
}

void WaveformView::showAll()
{
    setView (0, duration, true);
}

bool WaveformView::canZoomIn() const { return duration > 0 && viewEnd - viewStart > minSpan() * 1.001; }
bool WaveformView::canZoomOut() const { return duration > 0 && (viewStart > 1e-6 || viewEnd < duration - 1e-6); }

void WaveformView::setPlayhead (double t, bool edited, bool isPlaying)
{
    const double prev = playhead;
    const bool bothNan = std::isnan (prev) && std::isnan (t);
    const bool changed = ! bothNan && (std::isnan (prev) != std::isnan (t) || std::fabs (prev - t) > 1e-9);
    playheadEdited = edited;
    playing = isPlaying;
    if (! changed)
        return;
    playhead = t;
    // durante la reproducción la vista sigue al cabezal (salvo justo después de que el usuario la movió)
    if (isPlaying && std::isfinite (t) && duration > 0 && nowMs() - lastUserMs > 3000)
    {
        const double span = viewEnd - viewStart;
        if (t > viewEnd || t < viewStart)
            setView (t - span * 0.1, t - span * 0.1 + span, false);
    }
    repaint();
}

juce::Rectangle<int> WaveformView::overviewArea() const
{
    return getLocalBounds().removeFromTop (kOverviewH);
}

juce::Rectangle<int> WaveformView::mainArea() const
{
    auto r = getLocalBounds();
    r.removeFromTop (kOverviewH + 6);
    return r;
}

float WaveformView::xOf (double t, const juce::Rectangle<int>& area, double start, double end) const
{
    return static_cast<float> (area.getX() + (t - start) / std::max (1e-12, end - start) * area.getWidth());
}

double WaveformView::tOf (float x) const
{
    const auto a = mainArea();
    return viewStart + (static_cast<double> (x) - a.getX()) / std::max (1, a.getWidth()) * (viewEnd - viewStart);
}

void WaveformView::resized()
{
    if (duration > 0)
        setView (viewStart, viewEnd, false);
    markDirty();
}

//==============================================================================================================
// Dibujo

void WaveformView::columns (double t0, double t1, int n, Columns& out) const
{
    out.lo.assign (static_cast<std::size_t> (n), 0.0f);
    out.hi.assign (static_cast<std::size_t> (n), 0.0f);
    if (peaks == nullptr || sampleRate <= 0 || n <= 0)
        return;
    const double spp = (t1 - t0) * sampleRate / n;
    const auto* L = peaks->levelFor (spp);
    if (L == nullptr || L->mins.empty())
        return;
    const double B = L->samplesPerPeak;
    const auto nb = static_cast<std::int64_t> (L->mins.size());
    for (int x = 0; x < n; ++x)
    {
        const double s0 = t0 * sampleRate + x * spp;
        const double s1 = s0 + spp;
        auto b0 = static_cast<std::int64_t> (std::floor (s0 / B));
        auto b1 = static_cast<std::int64_t> (std::floor (s1 / B));
        if (b1 <= b0)
            b1 = b0 + 1;
        b0 = std::max<std::int64_t> (0, b0);
        b1 = std::min (nb, b1);
        if (b0 >= b1)
            continue;
        float lo = L->mins[static_cast<std::size_t> (b0)], hi = L->maxs[static_cast<std::size_t> (b0)];
        for (auto b = b0 + 1; b < b1; ++b)
        {
            lo = std::min (lo, L->mins[static_cast<std::size_t> (b)]);
            hi = std::max (hi, L->maxs[static_cast<std::size_t> (b)]);
        }
        out.lo[static_cast<std::size_t> (x)] = lo;
        out.hi[static_cast<std::size_t> (x)] = hi;
    }
}

void WaveformView::drawWave (juce::Graphics& g, juce::Rectangle<float> wave, float scale, double t0, double t1,
                             float amp, bool overview)
{
    const int n = std::max (1, static_cast<int> (std::lround (wave.getWidth() * scale)));
    columns (t0, t1, n, cols);
    const float colW = wave.getWidth() / static_cast<float> (n);
    const float mid = wave.getCentreY();
    const double secPerCol = (t1 - t0) / n;
    const double fadeStart = cutTime >= 0 ? cutTime - fadeSec : 0.0;
    // columna de un instante (en double antes de pasar a int: sin corte no hay instante)
    auto colOf = [&] (double t) {
        const double c = std::floor ((t - t0) / secPerCol);
        return c <= 0 ? 0 : c >= n ? n : static_cast<int> (c);
    };
    const int cFade = cutTime >= 0 ? colOf (fadeStart) : n;
    const int cCut = cutTime >= 0 ? colOf (cutTime) : n;

    // degradado vertical: centro brillante (--wf-rms) y bordes más oscuros (--wf-peak), como el pico + rms de la web
    auto gradient = [&] (juce::Colour edge, juce::Colour core) {
        juce::ColourGradient cg (edge, 0, wave.getY(), edge, 0, wave.getBottom(), false);
        cg.addColour (0.5, core);
        cg.addColour (0.32, core.interpolatedWith (edge, 0.35f));
        cg.addColour (0.68, core.interpolatedWith (edge, 0.35f));
        return cg;
    };
    auto range = [&] (int x0, int x1, auto gain) {
        for (int x = x0; x < x1; ++x)
        {
            const float gn = gain (x);
            const float top = mid - cols.hi[static_cast<std::size_t> (x)] * amp * gn;
            const float bot = mid - cols.lo[static_cast<std::size_t> (x)] * amp * gn;
            g.fillRect (wave.getX() + static_cast<float> (x) * colW, top, colW, std::max (1.0f / scale, bot - top));
        }
    };
    auto unity = [] (int) { return 1.0f; };
    g.setGradientFill (gradient (theme::wf::peak, theme::wf::core));
    range (0, std::min (cFade, n), unity);
    if (cCut > cFade && fadeSec > 0)
    {
        g.setColour (theme::wf::core.withAlpha (0.16f));   // --wf-ghost: la onda sin el fade
        range (cFade, cCut, unity);
        g.setGradientFill (gradient (theme::wf::peak, theme::wf::core));
        range (cFade, cCut, [&] (int x) {
            const double t = t0 + (x + 0.5) * secPerCol;
            const double p = std::clamp ((t - fadeStart) / std::max (1e-9, fadeSec), 0.0, 1.0);
            return std::clamp (djec::fadeGain (p, curve), 0.0f, 1.0f);
        });
    }
    g.setGradientFill (gradient (theme::wf::removed, theme::wf::removedCore));
    range (std::max (cCut, std::min (cFade, n)), n, unity);
    juce::ignoreUnused (overview);
}

int WaveformView::barLabel (const djec::Bar& b) const
{
    return b.number + barNumberOffset;
}

void WaveformView::renderStatic (juce::Graphics& g, float scale)
{
    drawOverview (g, overviewArea(), scale);
    drawMain (g, mainArea(), scale);
}

void WaveformView::drawOverview (juce::Graphics& g, juce::Rectangle<int> area, float scale)
{
    const auto a = area.toFloat();
    {
        juce::Path clip;
        clip.addRoundedRectangle (a, 6.0f);
        juce::Graphics::ScopedSaveState s (g);
        g.reduceClipRegion (clip);
        g.setColour (theme::wf::bg);
        g.fillRect (a);
        if (duration > 0 && peaks != nullptr)
        {
            const float amp = (a.getHeight() * 0.5f - 3.0f) * norm;
            drawWave (g, a, scale, 0, duration, amp, true);
            const auto k = [&] (double t) { return xOf (t, area, 0, duration); };
            if (cutTime >= 0)
            {
                g.setColour (theme::wf::dim);
                g.fillRect (juce::Rectangle<float>::leftTopRightBottom (k (cutTime), a.getY(), a.getRight(), a.getBottom()));
            }
            // marcas finas de lo que se quita / repite en cada compás
            for (auto* list : { &removed, &repeated })
            {
                if (list->empty())
                    continue;
                g.setColour (list == &removed ? theme::wf::meterHatch : theme::wf::meterRepeatEdge);
                juce::RectangleList<float> rl;
                for (const auto& sl : *list)
                    rl.addWithoutMerging ({ k (sl.start), a.getBottom() - 6.0f, std::max (1.0f / scale, k (sl.end) - k (sl.start)), 5.0f });
                g.fillRectList (rl);
            }
            // ventana visible
            const float vx0 = k (viewStart), vx1 = std::max (vx0 + 3.0f, k (viewEnd));
            g.setColour (theme::wf::window);
            g.fillRect (juce::Rectangle<float>::leftTopRightBottom (vx0, a.getY(), vx1, a.getBottom()));
            g.setColour (theme::wf::windowBorder);
            g.drawRect (juce::Rectangle<float>::leftTopRightBottom (vx0, a.getY(), vx1, a.getBottom()).reduced (0.75f), 1.5f);
            if (cutTime >= 0)
            {
                g.setColour (theme::wf::cutLine);
                g.fillRect (juce::Rectangle<float> (k (cutTime) - 1.0f, a.getY(), 2.0f, a.getHeight()));
            }
        }
    }
    g.setColour (theme::border);
    g.drawRoundedRectangle (a.reduced (0.5f), 6.0f, 1.0f);
}

void WaveformView::drawMain (juce::Graphics& g, juce::Rectangle<int> area, float scale)
{
    const auto a = area.toFloat();
    juce::Path clip;
    clip.addRoundedRectangle (a, 6.0f);
    {
        juce::Graphics::ScopedSaveState save (g);
        g.reduceClipRegion (clip);
        g.setColour (theme::wf::bg);
        g.fillRect (a);
        g.setColour (theme::wf::ruler);
        g.fillRect (a.withHeight (static_cast<float> (kRulerH)));
        g.fillRect (a.withTrimmedTop (a.getHeight() - static_cast<float> (kTimeH)));
        if (duration <= 0 || peaks == nullptr || viewEnd <= viewStart)
            return;

        const double start = viewStart, end = viewEnd;
        const double pxPerSec = a.getWidth() / (end - start);
        const float waveTop = a.getY() + static_cast<float> (kRulerH) + 2.0f;
        const float waveBot = a.getBottom() - static_cast<float> (kTimeH) - 2.0f;
        const auto wave = juce::Rectangle<float>::leftTopRightBottom (a.getX(), waveTop, a.getRight(), waveBot);
        const float amp = wave.getHeight() * 0.5f * norm;
        auto X = [&] (double t) { return xOf (t, area, start, end); };

        // línea central
        g.setColour (theme::wf::centre);
        g.fillRect (juce::Rectangle<float> (a.getX(), std::round (wave.getCentreY()), a.getWidth(), 1.0f));

        drawWave (g, wave, scale, start, end, amp, false);

        // beats finos
        if (beats.size() > 1)
        {
            const double ibi = (beats.back() - beats.front()) / static_cast<double> (beats.size() - 1);
            if (ibi * pxPerSec >= 5)
            {
                for (std::size_t i = lowerBound (beats, start); i < beats.size() && beats[i] <= end; ++i)
                {
                    const bool gone = cutTime >= 0 && beats[i] >= cutTime;
                    g.setColour (theme::wf::beat.withMultipliedAlpha (gone ? 0.5f : 1.0f));
                    g.fillRect (juce::Rectangle<float> (std::round (X (beats[i])), waveTop, 1.0f, waveBot - waveTop));
                }
            }
        }

        // zona del corte (para no pisar la etiqueta CORTE con números de compás)
        const float pillW = 50.0f;
        float pillX0 = 1e9f, pillX1 = -1e9f;
        if (cutTime >= 0 && cutTime >= start && cutTime <= end)
        {
            const float xc = std::round (X (cutTime));
            const float px = xc + pillW <= a.getRight() ? std::max (a.getX(), xc - 1) : std::max (a.getX(), xc - pillW + 1);
            pillX0 = px >= xc - 1 ? px : px - 3;
            pillX1 = px + pillW + 1;
        }

        // "1" de cada compás y números
        if (! bars.empty())
        {
            const double barLen = bars.size() > 1 ? (bars.back().start - bars.front().start) / static_cast<double> (bars.size() - 1)
                                                  : end - start;
            const double pxPerBar = barLen * pxPerSec;
            int every = 1;
            const juce::Font f = uiFont (theme::fontTiny, true);
            const int labelW = textWidth (f, juce::String (barLabel (bars.back())));
            while (pxPerBar * every < std::max (26, labelW + 10) && every < 4096)
                every *= 2;
            const int lineStep = pxPerBar >= 3 ? 1 : every;
            g.setFont (f);
            auto first = std::lower_bound (bars.begin(), bars.end(), start, [] (const djec::Bar& b, double t) { return b.start < t; });
            if (first != bars.begin())
                --first;
            for (auto it = first; it != bars.end(); ++it)
            {
                const auto& b = *it;
                if (b.start > end)
                    break;
                const bool gone = cutTime >= 0 && b.start >= cutTime - 1e-6;
                const float x = std::round (X (b.start));
                if ((b.number - 1) % lineStep == 0)
                {
                    g.setColour (theme::wf::downbeat.withMultipliedAlpha (gone ? 0.45f : 1.0f));
                    g.fillRect (juce::Rectangle<float> (x - 0.5f, a.getY() + kRulerH - 6.0f, 1.5f, waveBot - (a.getY() + kRulerH - 6.0f)));
                }
                const bool counted = lastBarIndex < 0 || b.index <= lastBarIndex;
                if (counted && (b.number - 1) % every == 0 && x >= a.getX() - 2 && x < a.getRight() - 8)
                {
                    const juce::String label (barLabel (b));
                    const float lw = static_cast<float> (textWidth (f, label));
                    float lx = x + 3.0f;
                    if (lx < pillX0 && lx + lw >= pillX0 && pillX0 - lw - 1 >= x + 1)
                        lx = pillX0 - lw - 1;
                    if (lx + lw < pillX0 || lx > pillX1)
                    {
                        g.setColour (theme::wf::barNum.withMultipliedAlpha (gone ? 0.5f : 1.0f));
                        g.drawText (label, juce::Rectangle<float> (lx, a.getY(), lw + 2, static_cast<float> (kRulerH)),
                                    juce::Justification::centredLeft, false);
                    }
                }
            }
        }

        // cambio de compás: trozos que se quitan (rojo rayado) o se repiten (verde, ×2)
        if (! removed.empty())
        {
            const auto [i0, i1] = visibleSlices (removed, start, end);
            for (std::size_t i = i0; i < i1; ++i)
            {
                const float x0 = X (removed[i].start);
                const float w = std::max (1.0f, X (removed[i].end) - x0);
                const juce::Rectangle<float> r (x0, waveTop, w, waveBot - waveTop);
                g.setColour (theme::wf::meterRemoved);
                g.fillRect (r);
                paintHatch (g, r, theme::wf::meterHatch, 6.0f, 1.1f);
            }
        }
        if (! repeated.empty())
        {
            const auto [i0, i1] = visibleSlices (repeated, start, end);
            g.setFont (uiFont (theme::fontTiny, true));
            for (std::size_t i = i0; i < i1; ++i)
            {
                const float x0 = X (repeated[i].start), x1 = X (repeated[i].end);
                const float w = std::max (1.0f, x1 - x0);
                g.setColour (theme::wf::meterRepeat);
                g.fillRect (juce::Rectangle<float> (x0, waveTop, w, waveBot - waveTop));
                g.setColour (theme::wf::meterRepeatEdge);
                g.fillRect (juce::Rectangle<float> (std::round (x0), waveTop, 1.0f, 4.0f));
                g.fillRect (juce::Rectangle<float> (std::round (x0), waveTop, w, 2.0f));
                if (w >= 24)
                    g.drawText (T (str::repeatMark), juce::Rectangle<float> (x0, waveTop + 3, w, 14), juce::Justification::centred, false);
            }
        }

        // cola que quita «Quitar compases del final»
        if (cutTime >= 0 && cutTime < end)
        {
            const float x0 = std::max (a.getX(), X (cutTime));
            g.setColour (theme::wf::dim);
            g.fillRect (juce::Rectangle<float>::leftTopRightBottom (x0, a.getY(), a.getRight(), a.getBottom() - kTimeH));
            paintHatch (g, juce::Rectangle<float>::leftTopRightBottom (x0, waveTop, a.getRight(), waveBot), theme::wf::hatch, 10.0f, 1.2f);
            const float wReg = a.getRight() - x0;
            if (wReg > 70)
            {
                const juce::Font f = uiFont (theme::fontSmall, true);
                const juce::String label = T (str::removedLabel);
                const float tw = static_cast<float> (textWidth (f, label)) + 16.0f;
                const float lx = x0 + std::min (wReg * 0.5f, 80.0f);
                const juce::Rectangle<float> pill (lx - tw * 0.5f, waveTop + 8, tw, 22);
                g.setColour (theme::wf::bg.withAlpha (0.85f));
                g.fillRoundedRectangle (pill, 11.0f);
                g.setColour (theme::text);
                g.setFont (f);
                g.drawText (label, pill, juce::Justification::centred, false);
            }
        }
        // fade: degradado + curva de ganancia
        if (cutTime >= 0 && fadeSec > 0 && cutTime > start && cutTime - fadeSec < end)
        {
            const float x0 = X (cutTime - fadeSec), x1 = X (cutTime);
            if (x1 - x0 > 1)
            {
                g.setGradientFill (juce::ColourGradient (theme::wf::fade.withAlpha (0.0f), x0, 0, theme::wf::fade, x1, 0, false));
                g.fillRect (juce::Rectangle<float>::leftTopRightBottom (x0, waveTop, x1, waveBot));
                juce::Path p;
                const int steps = std::clamp (static_cast<int> (x1 - x0), 8, 200);
                for (int k = 0; k <= steps; ++k)
                {
                    const double pr = static_cast<double> (k) / steps;
                    const float gn = std::clamp (djec::fadeGain (pr, curve), 0.0f, 1.0f);
                    const float x = x0 + (x1 - x0) * static_cast<float> (pr);
                    const float y = waveTop + 4 + (1 - gn) * (waveBot - waveTop - 8);
                    if (k == 0)
                        p.startNewSubPath (x, y);
                    else
                        p.lineTo (x, y);
                }
                g.setColour (theme::wf::cutLine);
                g.strokePath (p, juce::PathStrokeType (1.5f));
            }
        }

        // tiempos abajo
        {
            double step = kTickSteps[std::size (kTickSteps) - 1];
            for (double s : kTickSteps)
                if (s * pxPerSec >= 80)
                {
                    step = s;
                    break;
                }
            const int dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
            g.setFont (uiFont (theme::fontTiny));
            g.setColour (theme::wf::text);
            const double firstT = std::ceil (start / step - 1e-9) * step;
            for (double t = firstT; t <= end + 1e-9; t += step)
            {
                const float x = std::round (X (t));
                g.fillRect (juce::Rectangle<float> (x, a.getBottom() - kTimeH, 1.0f, 4.0f));
                if (x < a.getRight() - 34)
                    g.drawText (fmt::time (t, dec), juce::Rectangle<float> (x + 3, a.getBottom() - kTimeH, 70, static_cast<float> (kTimeH)),
                                juce::Justification::centredLeft, false);
            }
        }

        // marcador del corte
        if (cutTime >= 0 && cutTime >= start && cutTime <= end)
        {
            const float x = std::round (X (cutTime));
            g.setColour (theme::wf::cutLine);
            g.fillRect (juce::Rectangle<float> (x - 1.0f, a.getY(), 2.0f, a.getHeight() - kTimeH));
            const float px = x + pillW <= a.getRight() ? std::max (a.getX(), x - 1) : std::max (a.getX(), x - pillW + 1);
            g.fillRoundedRectangle (juce::Rectangle<float> (px, a.getY() + 1, pillW, kRulerH - 2.0f), 6.0f);
            g.setColour (theme::wf::cutText);
            g.setFont (uiFont (theme::fontTiny, true));
            g.drawText (T (str::cutPill), juce::Rectangle<float> (px, a.getY() + 1, pillW, kRulerH - 2.0f), juce::Justification::centred, false);
        }
    }
    g.setColour (theme::border);
    g.drawRoundedRectangle (a.reduced (0.5f), 6.0f, 1.0f);
}

void WaveformView::drawPlayhead (juce::Graphics& g)
{
    if (! std::isfinite (playhead) || duration <= 0)
        return;
    const juce::Colour c = playheadEdited ? theme::meter : theme::wf::playhead;
    const auto ov = overviewArea();
    g.setColour (c);
    g.fillRect (juce::Rectangle<float> (std::round (xOf (playhead, ov, 0, duration)), static_cast<float> (ov.getY()) + 1, 1.0f,
                                        static_cast<float> (ov.getHeight()) - 2));
    if (playhead < viewStart || playhead > viewEnd)
        return;
    const auto a = mainArea();
    const float x = std::round (xOf (playhead, a, viewStart, viewEnd));
    const float top = static_cast<float> (a.getY() + kRulerH);
    g.fillRect (juce::Rectangle<float> (x - 0.75f, top, 1.5f, static_cast<float> (a.getBottom() - kTimeH) - top));
    juce::Path tri;
    tri.addTriangle (x - 5, top, x + 5, top, x, top + 6);
    g.fillPath (tri);
}

void WaveformView::paint (juce::Graphics& g)
{
    const float scale = juce::jmax (1.0f, g.getInternalContext().getPhysicalPixelScaleFactor());
    const int w = juce::jmax (1, juce::roundToInt (static_cast<float> (getWidth()) * scale));
    const int h = juce::jmax (1, juce::roundToInt (static_cast<float> (getHeight()) * scale));
    if (dirty || cache.isNull() || cache.getWidth() != w || cache.getHeight() != h || std::fabs (cacheScale - scale) > 1e-3f)
    {
        cache = juce::Image (juce::Image::ARGB, w, h, true);
        juce::Graphics ig (cache);
        ig.addTransform (juce::AffineTransform::scale (scale));
        renderStatic (ig, scale);
        cacheScale = scale;
        dirty = false;
    }
    g.drawImageTransformed (cache, juce::AffineTransform::scale (1.0f / scale));
    drawPlayhead (g);
}

//==============================================================================================================
// Ratón

void WaveformView::mouseMove (const juce::MouseEvent& e)
{
    setMouseCursor (hasContent() && e.y < kOverviewH ? juce::MouseCursor::PointingHandCursor
                                                      : hasContent() ? juce::MouseCursor::DraggingHandCursor
                                                                     : juce::MouseCursor::NormalCursor);
}

void WaveformView::mouseDown (const juce::MouseEvent& e)
{
    if (! hasContent())
        return;
    lastUserMs = nowMs();
    if (e.y < kOverviewH + 3)
    {
        drag = Drag::Overview;
        mouseDrag (e);
        return;
    }
    drag = Drag::Pan;
    dragStartView = viewStart;
    dragStartViewEnd = viewEnd;
}

void WaveformView::mouseDrag (const juce::MouseEvent& e)
{
    if (! hasContent())
        return;
    if (drag == Drag::Overview)
    {
        const auto ov = overviewArea();
        const double t = (static_cast<double> (e.x) - ov.getX()) / std::max (1, ov.getWidth()) * duration;
        const double span = viewEnd - viewStart;
        setView (t - span * 0.5, t + span * 0.5, true);
    }
    else if (drag == Drag::Pan)
    {
        const double span = dragStartViewEnd - dragStartView;
        const double dt = -static_cast<double> (e.getDistanceFromDragStartX()) / std::max (1, mainArea().getWidth()) * span;
        setView (dragStartView + dt, dragStartView + dt + span, true);
    }
}

void WaveformView::mouseUp (const juce::MouseEvent&)
{
    drag = Drag::None;
}

void WaveformView::mouseDoubleClick (const juce::MouseEvent& e)
{
    if (hasContent() && e.y >= kOverviewH)
        showAll();
}

void WaveformView::mouseWheelMove (const juce::MouseEvent& e, const juce::MouseWheelDetails& w)
{
    if (! hasContent())
        return;
    float dx = w.deltaX, dy = w.deltaY;
    if (w.isReversed)
        dx = -dx, dy = -dy;
    if (e.mods.isShiftDown() && std::fabs (dx) < 1e-6f)
        std::swap (dx, dy);
    const double span = viewEnd - viewStart;
    if (std::fabs (dx) > std::fabs (dy))
    {
        const double dt = -static_cast<double> (dx) * span * 0.5;
        setView (viewStart + dt, viewEnd + dt, true);
        return;
    }
    if (std::fabs (dy) < 1e-6f)
        return;
    // rueda hacia arriba = acercar, alrededor del puntero
    const double factor = std::exp (-std::clamp (static_cast<double> (dy), -2.0, 2.0) * 0.9);
    const double anchor = std::clamp (tOf (static_cast<float> (e.x)), viewStart, viewEnd);
    const double k = (anchor - viewStart) / std::max (1e-9, span);
    const double ns = span * factor;
    setView (anchor - ns * k, anchor - ns * k + ns, true);
}

} // namespace djec::ui
