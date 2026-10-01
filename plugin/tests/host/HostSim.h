// Simulación de host para los tests del procesador: un FakePlayHead que se comporta como FL (posición en muestras,
// ppq, tempo, compás, inicio de compás), un "Host" que llama a processBlock con bloques de cualquier tamaño, señales
// sintéticas (clics distintos en cada tiempo del compás + un colchón armónico continuo) y el render esperado
// calculado con el core (gridFromHost → buildEditPlan → renderSegments).
#pragma once

#include <doctest.h>

#include "PluginProcessor.h"
#include "WavIO.h"

#include "djec/analysis.h"
#include "djec/edit_plan.h"
#include "djec/grid.h"
#include "djec/resample.h"
#include "djec/splice.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <random>
#include <thread>
#include <vector>

namespace djec_test
{

// ---- contador de reservas en el hilo de audio (alloc_tracker.cpp) ----
extern std::atomic<long long> gAudioAllocs;
extern std::atomic<long long> gAudioFrees;
extern thread_local bool gAudioArmed;

using Audio = std::vector<std::vector<float>>;
constexpr double kPi = 3.14159265358979323846;

inline std::int64_t frames (const Audio& a) { return a.empty() ? 0 : static_cast<std::int64_t> (a[0].size()); }

/** Como FL: posición en muestras + ppq (tempo constante desde el inicio del proyecto), compás e inicio de compás. */
class FakePlayHead final : public juce::AudioPlayHead
{
public:
    double sampleRate = 48000;
    double bpm = 120;
    int num = 4, den = 4;
    bool playing = false;
    std::int64_t time = 0;
    bool provideInfo = true;

    double ppqAt (std::int64_t t) const { return static_cast<double> (t) / sampleRate * bpm / 60.0; }

    juce::Optional<PositionInfo> getPosition() const override
    {
        if (! provideInfo)
            return {};
        PositionInfo p;
        p.setIsPlaying (playing);
        p.setTimeInSamples (time);
        p.setTimeInSeconds (static_cast<double> (time) / sampleRate);
        const double ppq = ppqAt (time);
        p.setPpqPosition (ppq);
        p.setBpm (bpm);
        p.setTimeSignature (TimeSignature { num, den });
        const double barLen = num * 4.0 / den;
        p.setPpqPositionOfLastBarStart (std::floor (ppq / barLen + 1e-9) * barLen);
        return p;
    }
};

/** Tamaños de bloque: fijo o aleatorio en [lo, hi] (semilla fija). */
struct BlockSizes
{
    int fixed = 512;
    int lo = 0, hi = 0;
    std::mt19937 rng { 1234 };

    static BlockSizes constant (int n) { BlockSizes b; b.fixed = n; return b; }
    static BlockSizes random (int lo, int hi, unsigned seed = 1234)
    {
        BlockSizes b;
        b.fixed = 0;
        b.lo = lo;
        b.hi = hi;
        b.rng.seed (seed);
        return b;
    }
    int next()
    {
        if (fixed > 0)
            return fixed;
        std::uniform_int_distribution<int> d (lo, hi);
        return d (rng);
    }
};

/** Audio de la "pista" del host: hostAudio[c][h] es lo que entra al plugin en la muestra h del host. */
struct Host
{
    static constexpr int kMaxBlock = 4096;

    std::unique_ptr<DjecAudioProcessor> proc;
    FakePlayHead head;
    double sr;
    int numCh;
    juce::AudioBuffer<float> buf;
    juce::MidiBuffer midi;
    bool trackAllocs = true;
    bool bypassed = false;
    int sleepMs = 2;   // pausa cada ~0,1 s de audio cuando play() tiene `every` (deja trabajar al worker)
    // tiempo dentro de processBlock (para el test de rendimiento)
    double blockMicros = 0, maxBlockMicros = 0;
    long long blockCount = 0;
    void resetTiming() { blockMicros = maxBlockMicros = 0; blockCount = 0; }

    explicit Host (double sampleRate = 48000, int channels = 2, double poolSeconds = 120, bool prepareNow = true)
        : sr (sampleRate), numCh (channels)
    {
        proc = std::make_unique<DjecAudioProcessor>();
        juce::AudioProcessor::BusesLayout layout;
        const auto set = channels == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo();
        layout.inputBuses.add (set);
        layout.outputBuses.add (set);
        REQUIRE (proc->setBusesLayout (layout));
        head.sampleRate = sr;
        proc->setPlayHead (&head);
        proc->setRateAndBufferSizeDetails (sr, kMaxBlock);
        proc->setTakePoolSeconds (poolSeconds);
        buf.setSize (numCh, kMaxBlock);
        if (prepareNow)
            prepare();
    }

    void prepare() { proc->prepareToPlay (sr, kMaxBlock); }

    ~Host()
    {
        if (proc != nullptr)
            proc->releaseResources();
    }

    /** Un bloque de n muestras en la posición actual del cabezal (entrada desde `input`, salida a `out`). */
    void block (const Audio& input, int n, Audio* out, std::int64_t outOffset)
    {
        for (int c = 0; c < numCh; ++c)
        {
            float* d = buf.getWritePointer (c);
            const std::vector<float>* src = input.empty() ? nullptr
                                                          : &input[static_cast<std::size_t> (std::min<int> (c, static_cast<int> (input.size()) - 1))];
            const std::int64_t size = src != nullptr ? static_cast<std::int64_t> (src->size()) : 0;
            for (int i = 0; i < n; ++i)
            {
                const std::int64_t h = head.time + i;
                d[i] = (h >= 0 && h < size) ? (*src)[static_cast<std::size_t> (h)] : 0.0f;
            }
        }
        juce::AudioBuffer<float> view (buf.getArrayOfWritePointers(), numCh, n);
        const auto t0 = std::chrono::steady_clock::now();
        if (trackAllocs)
            gAudioArmed = true;
        if (bypassed)
            proc->processBlockBypassed (view, midi);
        else
            proc->processBlock (view, midi);
        gAudioArmed = false;
        const double us = std::chrono::duration<double, std::micro> (std::chrono::steady_clock::now() - t0).count();
        blockMicros += us;
        maxBlockMicros = std::max (maxBlockMicros, us);
        ++blockCount;
        if (out != nullptr)
            for (int c = 0; c < numCh; ++c)
            {
                auto& dst = (*out)[static_cast<std::size_t> (c)];
                for (int i = 0; i < n; ++i)
                    dst[static_cast<std::size_t> (outOffset + i)] = view.getSample (c, i);
            }
    }

    /**
     * Suena [from, from + len) del host de corrido. Devuelve la salida (len muestras por canal). Si `every` está,
     * se llama cada ~0,1 s de audio (con una pausa breve para el worker); si devuelve true, se para antes.
     */
    Audio play (const Audio& input, std::int64_t from, std::int64_t len, BlockSizes bs = BlockSizes::constant (512),
                const std::function<bool (std::int64_t)>& every = {})
    {
        Audio out (static_cast<std::size_t> (numCh), std::vector<float> (static_cast<std::size_t> (len), 0.0f));
        head.playing = true;
        std::int64_t done = 0, nextCheck = static_cast<std::int64_t> (0.1 * sr);
        while (done < len)
        {
            const int n = static_cast<int> (std::min<std::int64_t> ({ static_cast<std::int64_t> (bs.next()), len - done, kMaxBlock }));
            head.time = from + done;
            block (input, n, &out, done);
            done += n;
            if (every && done >= nextCheck)
            {
                nextCheck += static_cast<std::int64_t> (0.1 * sr);
                std::this_thread::sleep_for (std::chrono::milliseconds (sleepMs));
                if (every (from + done))
                {
                    for (auto& c : out)
                        c.resize (static_cast<std::size_t> (done));
                    break;
                }
            }
        }
        head.time = from + done;
        return out;
    }

    /** Transporte parado (FL sigue llamando a processBlock con silencio). */
    void idle (int blocks = 4, int n = 512)
    {
        head.playing = false;
        const Audio none;
        for (int i = 0; i < blocks; ++i)
            block (none, n, nullptr, 0);
    }

    /** Para, espera al worker y deja que el audio adopte lo publicado. */
    void stopAndWait (int timeoutMs = 60000)
    {
        idle (4);
        REQUIRE (proc->waitForWorker (timeoutMs));
        idle (2);
    }

    djec::plugin::ViewState view() const { return proc->getViewState(); }
};

// ---- señales -----------------------------------------------------------------------------------------------------

struct SongSpec
{
    double sr = 48000;
    double bpm = 120;
    int beatsPerBar = 4;
    int bars = 16;
    double startSec = 0;       // dónde empieza la canción en la pista del host
    double tailSec = 0;        // silencio después
    bool pad = true;           // colchón armónico continuo (las ventanas de 200 ms nunca están en silencio)
    double gain = 1;
    int variant = 0;           // otra "canción": otras frecuencias
    int numCh = 2;
};

inline double songSeconds (const SongSpec& s) { return s.bars * s.beatsPerBar * 60.0 / s.bpm; }

/** Clics distintos en cada tiempo (el "1" con su propia frecuencia), un clic en cada "y" y un colchón por compás. */
inline Audio makeSong (const SongSpec& s)
{
    const double len = s.startSec + songSeconds (s) + s.tailSec;
    const auto n = static_cast<std::size_t> (std::llround (len * s.sr));
    Audio a (static_cast<std::size_t> (s.numCh), std::vector<float> (n, 0.0f));
    const double beat = 60.0 / s.bpm;
    const double f0[4] = { 2000, 800, 1000, 1200 };
    const double f1[4] = { 3100, 1700, 1900, 2300 };
    const double padRoots[4] = { 110, 137.5, 165, 146.8 };
    const int nBeats = s.bars * s.beatsPerBar;
    auto addClick = [&] (double t0, double f, double amp, double dur, double decay) {
        const auto i0 = static_cast<std::int64_t> (std::llround (t0 * s.sr));
        const auto m = static_cast<std::int64_t> (dur * s.sr);
        for (std::int64_t k = 0; k < m; ++k)
        {
            const std::int64_t i = i0 + k;
            if (i < 0 || i >= static_cast<std::int64_t> (n))
                continue;
            const double t = static_cast<double> (k) / s.sr;
            const double env = std::exp (-t / decay);
            for (int c = 0; c < s.numCh; ++c)
            {
                const double fc = c == 0 ? f : f * 1.1;
                a[static_cast<std::size_t> (c)][static_cast<std::size_t> (i)] += static_cast<float> (s.gain * amp * env * std::sin (2 * kPi * fc * t));
            }
        }
    };
    for (int b = 0; b < nBeats; ++b)
    {
        const int pos = b % s.beatsPerBar;
        const double t0 = s.startSec + b * beat;
        const double f = (s.variant == 0 ? f0 : f1)[pos % 4];
        addClick (t0, f, pos == 0 ? 0.8 : 0.5, 0.03, 0.008);
        addClick (t0 + beat / 2, s.variant == 0 ? 5000 : 4300, 0.25, 0.015, 0.004);   // la "y"
    }
    if (s.pad)
    {
        const auto i0 = static_cast<std::int64_t> (std::llround (s.startSec * s.sr));
        const auto i1 = static_cast<std::int64_t> (std::llround ((s.startSec + songSeconds (s)) * s.sr));
        for (std::int64_t i = i0; i < i1; ++i)
        {
            const double t = static_cast<double> (i) / s.sr - s.startSec;
            const int bar = static_cast<int> (t / (beat * s.beatsPerBar));
            const double root = padRoots[bar % 4] * (s.variant == 0 ? 1.0 : 1.19);
            const double v = 0.05 * (std::sin (2 * kPi * root * t) + 0.5 * std::sin (2 * kPi * 1.5 * root * t + 0.3));
            for (int c = 0; c < s.numCh; ++c)
                a[static_cast<std::size_t> (c)][static_cast<std::size_t> (i)] += static_cast<float> (s.gain * v * (c == 0 ? 1.0 : 0.9));
        }
    }
    return a;
}

/** Un tramo [i0, i1) de una señal. */
inline Audio slice (const Audio& a, std::int64_t i0, std::int64_t i1)
{
    Audio out;
    for (const auto& c : a)
        out.emplace_back (c.begin() + i0, c.begin() + i1);
    return out;
}

/** Render esperado de una toma [A, A + n) con la cuadrícula de un host de tempo constante. */
inline Audio expectedHostEdit (const Audio& take, double sr, std::int64_t A, double bpm, int num, int den,
                               const djec::EditSettings& s, djec::EditPlan* planOut = nullptr)
{
    djec::CaptureInfo cap;
    cap.sampleRate = sr;
    cap.hostStartSample = A;
    cap.numSamples = static_cast<std::size_t> (frames (take));
    djec::HostBlockInfo i;
    i.hostSample = A;
    i.ppq = static_cast<double> (A) / sr * bpm / 60.0;
    i.bpm = bpm;
    i.tsNum = num;
    i.tsDen = den;
    const double barLen = num * 4.0 / den;
    i.lastBarStartPpq = std::floor (i.ppq / barLen + 1e-9) * barLen;
    i.ppqValid = i.barValid = true;
    cap.blocks.emplace_back (0, i);
    djec::HostGridMeta meta;
    const djec::AnalysisResult grid = djec::gridFromHost (cap, 0, &meta);
    const djec::EditPlan plan = djec::buildEditPlan (grid, meta.tsDen, s);
    if (planOut != nullptr)
        *planOut = plan;
    Audio out;
    std::vector<const float*> ptrs;
    for (const auto& c : take)
        ptrs.push_back (c.data());
    djec::renderSegments (ptrs.data(), static_cast<int> (ptrs.size()), static_cast<std::size_t> (frames (take)), sr,
                          plan.segments, plan.crossfadeSec, plan.fadeOutSec, plan.curve, out);
    return out;
}

/** Máxima diferencia absoluta entre out[off + i] y ref[i] (i < len), en todos los canales. */
inline double maxDiff (const Audio& out, std::int64_t off, const Audio& ref, std::int64_t refOff, std::int64_t len)
{
    double m = 0;
    for (std::size_t c = 0; c < out.size(); ++c)
    {
        const auto& r = ref[std::min (c, ref.size() - 1)];
        for (std::int64_t i = 0; i < len; ++i)
            m = std::max (m, std::fabs (static_cast<double> (out[c][static_cast<std::size_t> (off + i)]) - r[static_cast<std::size_t> (refOff + i)]));
    }
    return m;
}

inline double maxAbs (const Audio& out, std::int64_t off, std::int64_t len)
{
    double m = 0;
    for (const auto& c : out)
        for (std::int64_t i = 0; i < len; ++i)
            m = std::max (m, std::fabs (static_cast<double> (c[static_cast<std::size_t> (off + i)])));
    return m;
}

inline bool hasNotice (const djec::plugin::ViewState& v, const char* key)
{
    for (const auto& n : v.session->notices)
        if (n.key == key)
            return true;
    return false;
}

/** Carpeta temporal de los tests (main.cpp redirige ahí las carpetas del plugin). */
juce::File testDataDir();

} // namespace djec_test
