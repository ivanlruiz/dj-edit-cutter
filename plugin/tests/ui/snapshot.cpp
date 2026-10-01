// Capturas del editor (djec_ui_snapshot): crea el procesador, le hace "tomar" una canción sintética simulando a FL
// (posición en muestras + ppq + tempo + compás, como tests/host), espera al worker, abre el editor y guarda PNG de
// cada estado a 1100×700 y 900×560 (y algunos al 150 %). Además comprueba el diseño: ningún componente visible se
// sale de su padre ni se pisa con un hermano, y ningún texto con ajuste de línea queda cortado.
//
// Uso: djec_ui_snapshot [carpeta de salida] [--font "Nombre"] [--only nombre] [--no-png] [--focus]
// Devuelve 0 si todas las comprobaciones pasan. Se registra en CTest (sin PNG en CI no hace falta mirarlos).
#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "Paths.h"
#include "ui/LookAndFeel.h"
#include "ui/WaveformView.h"
#include "ui/Widgets.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <functional>
#include <iostream>
#include <memory>
#include <random>
#include <thread>
#include <vector>

#ifndef DJEC_UI_SNAPSHOT_DIR
 #define DJEC_UI_SNAPSHOT_DIR "ui-snapshots"
#endif

namespace juce::detail
{
// bomba de mensajes de JUCE (para que lleguen los callAsync sin un bucle de mensajes)
bool dispatchNextMessageOnSystemQueue (bool returnIfNoPendingMessages);
} // namespace juce::detail

namespace
{
using Audio = std::vector<std::vector<float>>;

/** Atiende mensajes hasta que done() sea true o pasen ms milisegundos. */
bool pumpUntil (const std::function<bool()>& done, int ms)
{
    const auto end = juce::Time::getMillisecondCounter() + static_cast<juce::uint32> (ms);
    while (! done() && juce::Time::getMillisecondCounter() < end)
    {
        juce::detail::dispatchNextMessageOnSystemQueue (true);
        std::this_thread::sleep_for (std::chrono::milliseconds (2));
    }
    return done();
}
constexpr double kPi = 3.14159265358979323846;
constexpr double kSr = 48000;

// ---- host simulado (como FL: posición en muestras, ppq desde el principio, compás e inicio de compás) ----
class FakePlayHead final : public juce::AudioPlayHead
{
public:
    double bpm = 120;
    int num = 4, den = 4;
    bool playing = false;
    std::int64_t time = 0;

    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo p;
        p.setIsPlaying (playing);
        p.setTimeInSamples (time);
        p.setTimeInSeconds (static_cast<double> (time) / kSr);
        const double ppq = static_cast<double> (time) / kSr * bpm / 60.0;
        p.setPpqPosition (ppq);
        p.setBpm (bpm);
        p.setTimeSignature (TimeSignature { num, den });
        const double barLen = num * 4.0 / den;
        p.setPpqPositionOfLastBarStart (std::floor (ppq / barLen + 1e-9) * barLen);
        return p;
    }
};

struct Host
{
    std::unique_ptr<DjecAudioProcessor> proc = std::make_unique<DjecAudioProcessor>();
    FakePlayHead head;
    juce::AudioBuffer<float> buf { 2, 512 };
    juce::MidiBuffer midi;

    Host()
    {
        proc->setPlayHead (&head);
        proc->setRateAndBufferSizeDetails (kSr, 512);
        proc->setTakePoolSeconds (120);
        proc->prepareToPlay (kSr, 512);
    }
    ~Host() { proc->releaseResources(); }

    void block (const Audio& in, int n)
    {
        for (int c = 0; c < 2; ++c)
        {
            float* d = buf.getWritePointer (c);
            const auto* src = in.empty() ? nullptr : &in[static_cast<std::size_t> (std::min<int> (c, static_cast<int> (in.size()) - 1))];
            for (int i = 0; i < n; ++i)
            {
                const std::int64_t h = head.time + i;
                d[i] = src != nullptr && h >= 0 && h < static_cast<std::int64_t> (src->size()) ? (*src)[static_cast<std::size_t> (h)] : 0.0f;
            }
        }
        juce::AudioBuffer<float> view (buf.getArrayOfWritePointers(), 2, n);
        proc->processBlock (view, midi);
    }

    /** Suena [from, from + len) de corrido (con pausas cortas para que el worker trabaje, como en tiempo real). */
    void play (const Audio& in, std::int64_t from, std::int64_t len)
    {
        head.playing = true;
        std::int64_t done = 0, next = static_cast<std::int64_t> (0.25 * kSr);
        while (done < len)
        {
            const int n = static_cast<int> (std::min<std::int64_t> (512, len - done));
            head.time = from + done;
            block (in, n);
            done += n;
            if (done >= next)
            {
                next += static_cast<std::int64_t> (0.25 * kSr);
                std::this_thread::sleep_for (std::chrono::milliseconds (1));
            }
        }
        head.time = from + done;
    }

    void idle (int blocks = 4)
    {
        head.playing = false;
        const Audio none;
        for (int i = 0; i < blocks; ++i)
            block (none, 512);
    }

    void stopAndWait()
    {
        idle (4);
        proc->waitForWorker (60000);
        idle (2);
        proc->waitForWorker (60000);
        idle (2);
    }

    /** El transporte parado en t (FL sigue llamando a processBlock): el cabezal se ve ahí. */
    void parkAt (double seconds)
    {
        head.time = static_cast<std::int64_t> (seconds * kSr);
        idle (3);
    }
};

// ---- canción sintética con aspecto de canción (bombo, caja, hi-hat, bajo y colchón) ----
Audio makeBand (double bpm, int bars, double startSec, double tailSec, int variant = 0)
{
    const int beatsPerBar = 4;
    const double beat = 60.0 / bpm;
    const double len = startSec + bars * beatsPerBar * beat + tailSec;
    const auto n = static_cast<std::size_t> (len * kSr);
    Audio a (2, std::vector<float> (n, 0.0f));
    std::mt19937 rng (static_cast<unsigned> (1234 + variant));
    std::uniform_real_distribution<float> noise (-1.0f, 1.0f);
    auto add = [&] (std::size_t i, float l, float r) {
        if (i < n)
        {
            a[0][i] += l;
            a[1][i] += r;
        }
    };
    const double roots[4] = { 55.0, 43.65, 49.0, 41.2 };
    for (int b = 0; b < bars * beatsPerBar; ++b)
    {
        const int pos = b % beatsPerBar;
        const int bar = b / beatsPerBar;
        const double t0 = startSec + b * beat;
        const auto i0 = static_cast<std::size_t> (t0 * kSr);
        // la sección del medio más fuerte (para que la onda tenga forma)
        const float section = (bar >= bars / 3 && bar < 2 * bars / 3) ? 1.0f : 0.72f;
        if (pos == 0 || pos == 2 || (variant == 1 && pos == 3))
            for (std::size_t k = 0; k < static_cast<std::size_t> (0.35 * kSr); ++k)
            {
                const double t = static_cast<double> (k) / kSr;
                const double f = 50 + 70 * std::exp (-t * 30);
                const float v = static_cast<float> (0.85 * section * std::exp (-t * 9) * std::sin (2 * kPi * f * t));
                add (i0 + k, v, v);
            }
        if (pos == 1 || pos == 3)
            for (std::size_t k = 0; k < static_cast<std::size_t> (0.2 * kSr); ++k)
            {
                const double t = static_cast<double> (k) / kSr;
                const float env = static_cast<float> (std::exp (-t * 22));
                const float v = section * env * (0.45f * noise (rng) + 0.25f * static_cast<float> (std::sin (2 * kPi * 190 * t)));
                add (i0 + k, v, v * 0.9f);
            }
        for (int h = 0; h < 2; ++h)
        {
            const auto j0 = i0 + static_cast<std::size_t> (h * beat * 0.5 * kSr);
            for (std::size_t k = 0; k < static_cast<std::size_t> (0.05 * kSr); ++k)
            {
                const float v = 0.12f * section * static_cast<float> (std::exp (-static_cast<double> (k) / kSr * 70)) * noise (rng);
                add (j0 + k, v * 0.8f, v);
            }
        }
        // bajo
        const double root = roots[bar % 4] * (variant == 1 ? 1.12 : 1.0);
        for (std::size_t k = 0; k < static_cast<std::size_t> (beat * kSr); ++k)
        {
            const double t = static_cast<double> (k) / kSr;
            const double ph = std::fmod (root * (t0 + t), 1.0);
            const float v = static_cast<float> (0.22 * section * std::exp (-t * 3) * (2 * ph - 1));
            add (i0 + k, v, v);
        }
    }
    // colchón
    const auto s0 = static_cast<std::size_t> (startSec * kSr);
    const auto s1 = static_cast<std::size_t> ((startSec + bars * beatsPerBar * beat) * kSr);
    for (std::size_t i = s0; i < s1 && i < n; ++i)
    {
        const double t = static_cast<double> (i) / kSr - startSec;
        const int bar = static_cast<int> (t / (beat * beatsPerBar));
        const double f = roots[bar % 4] * 4 * (variant == 1 ? 1.12 : 1.0);
        const float v = static_cast<float> (0.05 * (std::sin (2 * kPi * f * t) + 0.6 * std::sin (2 * kPi * f * 1.5 * t)));
        add (i, v, v * 0.95f);
    }
    return a;
}

bool writeWav (const juce::File& f, const Audio& a)
{
    f.deleteFile();
    std::unique_ptr<juce::OutputStream> out = std::make_unique<juce::FileOutputStream> (f);
    juce::WavAudioFormat wav;
    const auto options = juce::AudioFormatWriterOptions {}.withSampleRate (kSr).withNumChannels (2).withBitsPerSample (24);
    std::unique_ptr<juce::AudioFormatWriter> w = wav.createWriterFor (out, options);
    if (w == nullptr)
        return false;
    std::vector<const float*> ptrs { a[0].data(), a[1].data() };
    return w->writeFromFloatArrays (ptrs.data(), 2, static_cast<int> (a[0].size()));
}

// ---- comprobaciones de diseño ----
int gFailures = 0;

void fail (const juce::String& where, const juce::String& what)
{
    ++gFailures;
    std::cout << "  FALLO [" << where.toStdString() << "] " << what.toStdString() << std::endl;
}

juce::String describe (const juce::Component& c)
{
    juce::String n = c.getTitle().isNotEmpty() ? c.getTitle() : c.getName();
    if (n.isEmpty())
        if (auto* b = dynamic_cast<const juce::Button*> (&c))
            n = b->getButtonText();
    if (n.isEmpty())
        if (auto* t = dynamic_cast<const djec::ui::TextBlock*> (&c))
            n = t->getText().substring (0, 40);
    return juce::String (typeid (c).name()).fromLastOccurrenceOf ("ui", false, false).substring (0, 30) + " «" + n + "» "
           + c.getBounds().toString();
}

void checkTree (const juce::Component& parent, const juce::String& where)
{
    // el contenido de un Viewport puede ser más alto que lo visible (se desplaza)
    const bool isViewport = dynamic_cast<const juce::Viewport*> (&parent) != nullptr
                            || dynamic_cast<const juce::Viewport*> (parent.getParentComponent()) != nullptr;
    std::vector<const juce::Component*> kids;
    for (auto* c : parent.getChildren())
    {
        if (! c->isVisible() || c->getBounds().isEmpty())
            continue;
        if (dynamic_cast<const juce::ResizableCornerComponent*> (c) != nullptr || dynamic_cast<const juce::TooltipWindow*> (c) != nullptr
            || dynamic_cast<const juce::ScrollBar*> (c) != nullptr)
            continue;
        kids.push_back (c);
        if (! isViewport && ! parent.getLocalBounds().contains (c->getBounds()))
            fail (where, "se sale de su padre: " + describe (*c) + " en " + parent.getLocalBounds().toString());
        if (auto* tb = dynamic_cast<const djec::ui::TextBlock*> (c))
            if (tb->heightFor (tb->getWidth()) > tb->getHeight() + 1)
                fail (where, "texto cortado: " + describe (*c) + " necesita " + juce::String (tb->heightFor (tb->getWidth())));
        if (auto* tb = dynamic_cast<const juce::TextButton*> (c))
        {
            const auto f = djec::ui::uiFont (djec::ui::theme::fontBody, true);
            if (djec::ui::textWidth (f, tb->getButtonText()) > tb->getWidth() - 10)
                fail (where, djec::ui::T ("botón estrecho: ") + describe (*c));
        }
    }
    if (! isViewport)
        for (std::size_t i = 0; i < kids.size(); ++i)
            for (std::size_t j = i + 1; j < kids.size(); ++j)
                if (kids[i]->getBounds().intersects (kids[j]->getBounds()))
                    fail (where, "se pisan: " + describe (*kids[i]) + " y " + describe (*kids[j]));
    for (auto* c : kids)
        checkTree (*c, where);
}

template <typename T>
T* findChild (juce::Component& root, const std::function<bool (T&)>& pred = {})
{
    for (auto* c : root.getChildren())
    {
        if (auto* t = dynamic_cast<T*> (c))
            if (! pred || pred (*t))
                return t;
        if (auto* r = findChild<T> (*c, pred))
            return r;
    }
    return nullptr;
}

/** Rueda, arrastre y botones de zoom sobre la forma de onda de verdad (eventos sintéticos). */
void interactWithWaveform (DjecAudioProcessorEditor& ed, const juce::String& where)
{
    auto* wave = findChild<djec::ui::WaveformView> (ed);
    if (wave == nullptr || ! wave->hasContent())
    {
        fail (where, "no hay forma de onda");
        return;
    }
    juce::MouseInputSource src = juce::Desktop::getInstance().getMainMouseSource();
    const auto now = juce::Time::getCurrentTime();
    auto ev = [&] (juce::Point<float> p, juce::Point<float> down, bool dragged, juce::ModifierKeys mods = {}) {
        return juce::MouseEvent (src, p, mods, juce::MouseInputSource::defaultPressure, 0.0f, 0.0f, 0.0f, 0.0f, wave, wave, now,
                                 down, now, 1, dragged);
    };
    const double span0 = wave->getViewEnd() - wave->getViewStart();
    juce::MouseWheelDetails w {};
    w.deltaY = 0.45f;   // una muesca de rueda hacia arriba = acercar
    const juce::Point<float> at (static_cast<float> (wave->getWidth()) * 0.6f, 120.0f);
    for (int i = 0; i < 3; ++i)
        wave->mouseWheelMove (ev (at, at, false), w);
    const double span1 = wave->getViewEnd() - wave->getViewStart();
    if (! (span1 < span0 * 0.5))
        fail (where, "la rueda no acerca: " + juce::String (span0) + " -> " + juce::String (span1));
    // arrastrar 200 px a la izquierda = la vista avanza
    const double s0 = wave->getViewStart();
    const juce::Point<float> d0 (500.0f, 120.0f), d1 (300.0f, 120.0f);
    wave->mouseDown (ev (d0, d0, false));
    wave->mouseDrag (ev (d1, d0, true));
    wave->mouseUp (ev (d1, d0, true));
    if (! (wave->getViewStart() > s0))
        fail (where, "arrastrar no desplaza la vista");
    // Mayús + rueda = desplazar sin cambiar el zoom
    const double span2 = wave->getViewEnd() - wave->getViewStart();
    const double s1 = wave->getViewStart();
    w.deltaY = -0.3f;
    wave->mouseWheelMove (ev (at, at, false, juce::ModifierKeys::shiftModifier), w);
    if (std::fabs ((wave->getViewEnd() - wave->getViewStart()) - span2) > 1e-6 || std::fabs (wave->getViewStart() - s1) < 1e-6)
        fail (where, juce::String::fromUTF8 ("Mayús + rueda no desplaza"));
    // botón «Ver todo»
    if (auto* all = findChild<juce::TextButton> (ed, [] (juce::TextButton& b) { return b.getButtonText() == juce::String::fromUTF8 ("Ver todo"); }))
    {
        all->onClick();
        if (wave->getViewStart() > 1e-6)
            fail (where, juce::String::fromUTF8 ("«Ver todo» no muestra todo"));
        // y otra vez cerca para la captura
        for (int i = 0; i < 4; ++i)
            wave->mouseWheelMove (ev (at, at, false), [] { juce::MouseWheelDetails d {}; d.deltaY = 0.45f; return d; }());
    }
    else
        fail (where, juce::String::fromUTF8 ("no está el botón «Ver todo»"));
}

/** «Arrastrar a FL» (pulsar = escribe el WAV en segundo plano) y «Exportar WAV…» asíncrono, de punta a punta. */
void checkDragAndExport (DjecAudioProcessor& proc, const juce::File& dataDir)
{
    const juce::String where ("arrastrar/exportar");
    std::unique_ptr<juce::AudioProcessorEditor> base (proc.createEditor());
    auto& ed = dynamic_cast<DjecAudioProcessorEditor&> (*base);
    ed.setSize (1100, 700);
    ed.refreshNow();
    auto* handle = findChild<juce::Component> (ed, [] (juce::Component& c) { return c.getTitle() == juce::String::fromUTF8 ("Arrastrar a FL"); });
    if (handle == nullptr)
    {
        fail (where, "no está el asa «Arrastrar a FL»");
        return;
    }
    const juce::File exports = djec::plugin::paths::exportsDir();
    const int before = exports.getNumberOfChildFiles (juce::File::findFiles, "*.wav");
    juce::MouseInputSource src = juce::Desktop::getInstance().getMainMouseSource();
    const auto now = juce::Time::getCurrentTime();
    const juce::Point<float> p (20.0f, 20.0f);
    handle->mouseDown (juce::MouseEvent (src, p, {}, juce::MouseInputSource::defaultPressure, 0, 0, 0, 0, handle, handle, now, p, now, 1, false));
    const auto t0 = std::chrono::steady_clock::now();
    const bool wrote = pumpUntil ([&] { return exports.getNumberOfChildFiles (juce::File::findFiles, "*.wav") > before; }, 20000);
    pumpUntil ([] { return false; }, 100);   // que llegue el aviso de «listo»
    const double ms = std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now() - t0).count();
    if (! wrote)
        fail (where, "pulsar «Arrastrar a FL» no escribió el WAV");
    else
        std::cout << "  arrastrar: WAV listo en " << juce::roundToInt (ms) << " ms ("
                  << exports.findChildFiles (juce::File::findFiles, false, "*.wav")[0].getFileName().toStdString() << ")" << std::endl;
    // exportar en segundo plano: el resultado llega al hilo de mensajes
    const juce::File out = dataDir.getChildFile ("exportado.wav");
    bool done = false, ok = false;
    proc.exportWavAsync (out, 16, [&] (juce::Result r) {
        done = true;
        ok = r.wasOk();
    });
    if (! pumpUntil ([&] { return done; }, 20000) || ! ok || out.getSize() < 1000)
        fail (where, "exportWavAsync no terminó bien");
    else
        std::cout << "  exportar: " << out.getFileName().toStdString() << " " << out.getSize() << " bytes" << std::endl;
    base.reset();
}

struct Options
{
    juce::File outDir;
    juce::String only;
    bool png = true;
    bool focusOrder = false;
};

void snapshot (Host& host, const juce::String& name, const Options& opt, const std::function<void (DjecAudioProcessorEditor&)>& before = {},
               std::initializer_list<float> scales = { 1.0f })
{
    if (opt.only.isNotEmpty() && ! name.contains (opt.only))
        return;
    for (auto size : { juce::Point<int> (1100, 700), juce::Point<int> (900, 560) })
    {
        std::unique_ptr<juce::AudioProcessorEditor> base (host.proc->createEditor());
        auto& ed = dynamic_cast<DjecAudioProcessorEditor&> (*base);
        ed.setSize (size.x, size.y);
        ed.refreshNow();
        if (before)
            before (ed);
        ed.refreshNow();
        ed.refreshNow();
        const juce::String tag = name + "_" + juce::String (size.x) + "x" + juce::String (size.y);
        checkTree (ed, tag);
        if (opt.focusOrder && size.x == 1100)
        {
            // orden del tabulador: lo que se recorre con Tab, en orden
            std::unique_ptr<juce::ComponentTraverser> tr (ed.createKeyboardFocusTraverser());
            juce::StringArray names;
            auto visibleIn = [&ed] (juce::Component* c) {
                for (; c != nullptr && c != &ed; c = c->getParentComponent())
                    if (! c->isVisible())
                        return false;
                return c == &ed;
            };
            for (auto* c : tr->getAllComponents (&ed))
                if (visibleIn (c))
                    names.add (describe (*c).fromFirstOccurrenceOf ("«", false, false).upToFirstOccurrenceOf ("»", false, false));
            std::cout << "  Tab: " << names.joinIntoString (" → ").toStdString() << std::endl;
        }
        if (opt.png)
            for (float sc : scales)
            {
                const auto t0 = std::chrono::steady_clock::now();
                const juce::Image img = ed.createComponentSnapshot (ed.getLocalBounds(), true, sc);
                const double ms = std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now() - t0).count();
                const juce::File f = opt.outDir.getChildFile (tag + (sc > 1.01f ? "@" + juce::String (juce::roundToInt (sc * 100)) : juce::String()) + ".png");
                f.deleteFile();
                juce::FileOutputStream os (f);
                juce::PNGImageFormat png;
                png.writeImageToStream (img, os);
                std::cout << "  " << f.getFileName().toStdString() << "  (" << juce::String (ms, 1).toStdString() << " ms de pintura)" << std::endl;
            }
        base.reset();
    }
}

void settings (DjecAudioProcessor& p, const std::function<void (djec::EditSettings&)>& fn)
{
    auto s = p.getEditSettings();
    fn (s);
    p.setEditSettings (s);
    p.waitForWorker (60000);
}
} // namespace

int main (int argc, char** argv)
{
    const juce::ScopedJuceInitialiser_GUI juceInit;
    Options opt;
    opt.outDir = juce::File (juce::String (DJEC_UI_SNAPSHOT_DIR));
    for (int i = 1; i < argc; ++i)
    {
        const juce::String a (argv[i]);
        if (a == "--font" && i + 1 < argc)
            djec::ui::setUiTypefaceName (argv[++i]);
        else if (a == "--only" && i + 1 < argc)
            opt.only = argv[++i];
        else if (a == "--no-png")
            opt.png = false;
        else if (a == "--focus")
            opt.focusOrder = true;
        else
            opt.outDir = juce::File::getCurrentWorkingDirectory().getChildFile (a);
    }
    opt.outDir.createDirectory();
    const juce::File data = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                .getChildFile ("djec-ui-snapshot-" + juce::String (juce::Random::getSystemRandom().nextInt64()));
    data.createDirectory();
    djec::plugin::paths::setRootOverride (data);
    std::cout << "Capturas en " << opt.outDir.getFullPathName().toStdString() << " (fuente: " << djec::ui::getUiTypefaceName().toStdString() << ")" << std::endl;

    const Audio song = makeBand (120, 24, 0, 1.0);                 // 24 compases a 120 BPM desde el compás 1
    const auto songLen = static_cast<std::int64_t> (song[0].size());

    // 1) vacío: plugin recién puesto
    {
        std::cout << "vacio" << std::endl;
        Host h;
        h.idle (4);
        snapshot (h, "01-vacio", opt);
        snapshot (h, "01b-arrastrando", opt, [] (DjecAudioProcessorEditor& e) { e.setDragHoverForTesting (true, true); });
    }
    // 2) tomando: primer Play, a mitad de la canción
    {
        std::cout << "tomando" << std::endl;
        Host h;
        h.play (song, 0, static_cast<std::int64_t> (21.3 * kSr));
        snapshot (h, "02-tomando", opt);
    }
    // 3) listo con la cuadrícula de FL, 4/4 → 7/8 (lo de por defecto)
    {
        std::cout << "listo FL" << std::endl;
        Host h;
        h.play (song, 0, songLen);
        h.stopAndWait();
        h.parkAt (6.2);
        snapshot (h, "03-listo-fl-7-8", opt, {}, { 1.0f, 1.5f });
        // zoom con la rueda, arrastrar y «Ver todo» (eventos sintéticos sobre la forma de onda)
        snapshot (h, "03b-zoom-de-cerca", opt, [] (DjecAudioProcessorEditor& e) { interactWithWaveform (e, "03b-zoom-de-cerca"); });
        if (opt.only.isEmpty())
            checkDragAndExport (*h.proc, data);
        // sonando lo editado (segunda pasada), con el cabezal
        h.play (song, 0, static_cast<std::int64_t> (9.4 * kSr));
        snapshot (h, "04-sonando-editado", opt);
        h.idle (4);
        // los dos modos: recortar cada compás + quitar 2 compases con fade de 2 beats
        settings (*h.proc, [] (djec::EditSettings& s) {
            s.removeEnd = true;
            s.barsToRemove = 2;
            s.fadeBeats = 2;
        });
        h.stopAndWait();
        h.parkAt (40.0);
        snapshot (h, "05-ambos-modos", opt, [] (DjecAudioProcessorEditor&) {}, { 1.0f, 1.5f });
        // «Otro compás…» con un compás que no vale
        settings (*h.proc, [] (djec::EditSettings& s) {
            s.removeEnd = false;
            s.amount = "other";
            s.otherNum = 9;
            s.otherDen = 16;
        });
        h.stopAndWait();
        snapshot (h, "06-otro-compas", opt);
        // alargar (repetir el último tiempo): trozos verdes ×2
        settings (*h.proc, [] (djec::EditSettings& s) { s.amount = "extend"; });
        h.stopAndWait();
        h.parkAt (3.0);
        snapshot (h, "07-alargar", opt);
        snapshot (h, "07b-alargar-de-cerca", opt, [] (DjecAudioProcessorEditor& e) { interactWithWaveform (e, "07b-alargar-de-cerca"); });
        // fuera de la toma
        settings (*h.proc, [] (djec::EditSettings& s) { s.amount = "eighth"; });
        h.stopAndWait();
        h.play (song, songLen + static_cast<std::int64_t> (30 * kSr), static_cast<std::int64_t> (1.0 * kSr));
        snapshot (h, "08-fuera-de-la-toma", opt);
        h.idle (4);
    }
    // 3b) cambió el audio del canal (otro clip en el mismo sitio) y cambió el tempo del proyecto
    {
        std::cout << "cambios" << std::endl;
        Host h;
        h.play (song, 0, songLen);
        h.stopAndWait();
        const Audio other = makeBand (120, 24, 0, 1.0, 1);
        h.play (other, 0, static_cast<std::int64_t> (2.5 * kSr));
        h.proc->waitForWorker (60000);
        h.play (other, static_cast<std::int64_t> (2.5 * kSr), static_cast<std::int64_t> (3.0 * kSr));
        snapshot (h, "08b-audio-cambio", opt);
        h.idle (4);
        Host h2;
        h2.play (song, 0, songLen);
        h2.stopAndWait();
        h2.parkAt (10.0);
        h2.head.bpm = 128;   // el usuario cambia el tempo del proyecto con FL parado (cabezal dentro de la toma)
        h2.idle (8);
        h2.proc->waitForWorker (60000);
        h2.idle (2);
        snapshot (h2, "08c-tempo-cambio", opt);
    }
    // 4a) detectando (toma larga: la captura llega mientras analiza; si llega tarde, se ve el resultado)
    {
        std::cout << "detectando" << std::endl;
        Host h;
        const Audio longSong = makeBand (123, 90, 0.37, 1.0);
        h.head.bpm = 120;
        h.play (longSong, 0, static_cast<std::int64_t> (longSong[0].size()));
        h.stopAndWait();
        h.proc->setGridMode (djec::plugin::GridMode::Detect);
        std::this_thread::sleep_for (std::chrono::milliseconds (40));
        snapshot (h, "09a-detectando", opt);
        h.proc->waitForWorker (60000);
        h.idle (4);
    }
    // 4) detectado del audio, con un aviso
    {
        std::cout << "detectado" << std::endl;
        Host h;
        const Audio live = makeBand (123, 20, 0.37, 1.5);
        h.head.bpm = 120;   // la canción no sigue la cuadrícula del proyecto
        h.play (live, 0, static_cast<std::int64_t> (live[0].size()));
        h.stopAndWait();
        h.proc->setGridMode (djec::plugin::GridMode::Detect);
        h.proc->waitForWorker (60000);
        h.stopAndWait();
        h.proc->retrack (37, true);   // ... (sigue abajo)   // un tempo que no está: el procesador avisa
        h.proc->waitForWorker (60000);
        h.stopAndWait();
        h.parkAt (5.0);
        snapshot (h, "09-detectado-aviso", opt);
        h.proc->resetDetection();
        h.proc->waitForWorker (60000);
        h.stopAndWait();
        h.parkAt (5.0);
        snapshot (h, "10-detectado", opt);
    }
    // 5) archivo soltado: buscando dónde está, no encontrado, ubicado
    {
        std::cout << "archivo" << std::endl;
        const juce::File wav = data.getChildFile ("Mi tema.wav");
        writeWav (wav, song);
        Host h;
        h.idle (2);
        h.proc->loadDroppedFile (wav);
        h.proc->waitForWorker (60000);
        h.idle (2);
        h.proc->waitForWorker (60000);
        snapshot (h, "11-archivo-listo-para-ubicar", opt);
        // en el canal suena el archivo desde el compás 5 (8 s); se le da Play desde el compás 1
        Audio channel (2, std::vector<float> (static_cast<std::size_t> (8 * kSr), 0.0f));
        for (int c = 0; c < 2; ++c)
            channel[static_cast<std::size_t> (c)].insert (channel[static_cast<std::size_t> (c)].end(), song[static_cast<std::size_t> (c)].begin(),
                                                          song[static_cast<std::size_t> (c)].end());
        h.play (channel, 0, static_cast<std::int64_t> (9.0 * kSr));
        snapshot (h, "12-archivo-buscando", opt);
        h.idle (4);
        // otro audio en el canal: no lo encuentra
        Host h2;
        h2.idle (2);
        h2.proc->loadDroppedFile (wav);
        h2.proc->waitForWorker (60000);
        h2.idle (2);
        const Audio other = makeBand (97, 12, 0, 0, 1);
        h2.play (other, 0, static_cast<std::int64_t> (11 * kSr));
        h2.proc->waitForWorker (60000);
        h2.play (other, static_cast<std::int64_t> (11 * kSr), static_cast<std::int64_t> (0.5 * kSr));
        snapshot (h2, "13-archivo-no-encontrado", opt);
        h2.idle (4);
        // ubicado
        h.play (channel, static_cast<std::int64_t> (9.0 * kSr), static_cast<std::int64_t> (6 * kSr));
        h.proc->waitForWorker (60000);
        h.stopAndWait();
        h.parkAt (12.0);
        snapshot (h, "14-archivo-ubicado", opt);
    }

    djec::plugin::paths::setRootOverride ({});
    data.deleteRecursively();
    if (gFailures == 0)
        std::cout << "OK: el diseño pasa todas las comprobaciones" << std::endl;
    else
        std::cout << "FALLOS: " << gFailures << std::endl;
    return gFailures == 0 ? 0 : 1;
}
