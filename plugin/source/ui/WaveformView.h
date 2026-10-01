// Forma de onda de la toma (port del dibujo de js/ui/waveform.js): tira de resumen arriba y vista con zoom debajo,
// con beats finos, "1" marcados y numerados, trozos que se quitan (rojo rayado) o se repiten (verde, ×2) en cada
// compás, la cola que quita «Quitar compases del final» (atenuada, con el fade en degradado y la curva de ganancia),
// tiempos abajo y el cabezal de FL. Rueda = zoom alrededor del puntero (Mayús + rueda o rueda horizontal = desplazar),
// arrastrar = desplazar, doble clic = ver todo, clic en el resumen = ir ahí.
//
// La capa estática se dibuja en una imagen a la resolución física (nítida al 150 %) y solo se rehace si cambia la
// sesión, la vista o el tamaño; el cabezal se pinta encima en cada refresco.
#pragma once

#include "PluginState.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace djec::ui
{

class WaveformView final : public juce::Component, public juce::SettableTooltipClient
{
public:
    WaveformView();

    /** Datos de la sesión (llamar cuando cambie session->version). */
    void setSession (const djec::plugin::SessionView& session);
    /** Cabezal en segundos de la toma (NaN = no se muestra). edited = suena lo editado (color del compás nuevo). */
    void setPlayhead (double takeSec, bool edited, bool playing);

    void zoomBy (double factor);
    void showAll();
    /** Los últimos compases, con el corte del final a la vista. */
    void showEnd();
    bool canZoomIn() const;
    bool canZoomOut() const;
    bool hasContent() const noexcept { return duration > 0 && peaks != nullptr; }
    /** Centro de la vista (segundos de la toma): referencia para «Mover el 1» si el cabezal no está en la toma. */
    double viewCentre() const noexcept { return 0.5 * (viewStart + viewEnd); }
    double getViewStart() const noexcept { return viewStart; }
    double getViewEnd() const noexcept { return viewEnd; }
    std::function<void()> onViewChanged;

    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    void mouseWheelMove (const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    void mouseMove (const juce::MouseEvent&) override;

    static constexpr int kOverviewH = 30;
    static constexpr int kRulerH = 18;
    static constexpr int kTimeH = 16;

private:
    struct Columns
    {
        std::vector<float> lo, hi;
    };

    void setView (double start, double end, bool user);
    void initialView();
    double minSpan() const;
    juce::Rectangle<int> overviewArea() const;
    juce::Rectangle<int> mainArea() const;
    float xOf (double t, const juce::Rectangle<int>& area, double start, double end) const;
    double tOf (float x) const;
    void columns (double t0, double t1, int cols, Columns& out) const;
    void renderStatic (juce::Graphics&, float scale);
    void drawMain (juce::Graphics&, juce::Rectangle<int> area, float scale);
    void drawOverview (juce::Graphics&, juce::Rectangle<int> area, float scale);
    void drawWave (juce::Graphics&, juce::Rectangle<float> wave, float scale, double t0, double t1, float amp,
                   bool overview);
    void drawPlayhead (juce::Graphics&);
    int barLabel (const djec::Bar& b) const;
    void markDirty();

    // ---- datos de la sesión ----
    std::shared_ptr<const djec::plugin::WaveformPeaks> peaks;
    float norm = 1.0f;
    double duration = 0, sampleRate = 0;
    std::uint32_t takeId = 0;
    std::vector<double> beats;
    std::vector<djec::Bar> bars;
    int lastBarIndex = -1;
    int barNumberOffset = 0;            // compás de FL del primer "1" − 1 (cuadrícula de FL sin cambios)
    std::vector<djec::Segment> removed, repeated;
    double cutTime = -1, fadeSec = 0;
    std::string curve = "smooth";
    bool viewInitialised = false;

    // ---- vista ----
    double viewStart = 0, viewEnd = 0;
    double playhead = std::numeric_limits<double>::quiet_NaN();
    bool playheadEdited = false, playing = false;
    juce::int64 lastUserMs = 0;

    // ---- arrastre ----
    enum class Drag
    {
        None,
        Pan,
        Overview
    };
    Drag drag = Drag::None;
    double dragStartView = 0, dragStartViewEnd = 0;

    // ---- capa estática ----
    juce::Image cache;
    bool dirty = true;
    float cacheScale = 0;
    mutable Columns cols;
};

} // namespace djec::ui
