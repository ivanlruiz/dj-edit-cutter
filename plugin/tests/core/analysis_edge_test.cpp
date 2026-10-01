// Tests del port C++ del análisis que no necesitan datos golden: bordes (silencio, 1 s, DC, recorte, NaN),
// errores en español, progreso, determinismo entre hilos, remuestreo y rendimiento con una señal sintética.
#include "doctest.h"

#include "djec/analysis.h"
#include "djec/analysis/analyze_util.h"
#include "djec/resample.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace
{

constexpr double SR = 22050;
constexpr double kPi = 3.141592653589793;

/** LCG determinista en [-1, 1). */
struct Lcg
{
    uint32_t s;
    explicit Lcg(uint32_t seed) : s(seed) {}
    double next()
    {
        s = s * 1103515245u + 12345u;
        return (s / 4294967296.0) * 2 - 1;
    }
};

struct Song
{
    std::vector<float> x;
    std::vector<double> beats; // verdad
    std::vector<double> downbeats;
};

/**
 * Banda sintética en 4/4: bombo en 1 y 3 (más fuerte en el 1), caja en 2 y 4, charles en corcheas, bajo + acorde
 * que cambian en cada compás, final con golpe y resonancia. tempo en BPM, bars compases.
 */
Song bandSong(double bpm, int bars, double lead = 0.5, uint32_t seed = 1)
{
    const double period = 60 / bpm;
    const double end = lead + bars * 4 * period;
    const std::size_t n = static_cast<std::size_t>((end + 3.0) * SR);
    Song s;
    s.x.assign(n, 0.0f);
    Lcg rng(seed);
    auto add = [&](double t0, double dur, auto fn) {
        const std::size_t a = static_cast<std::size_t>(t0 * SR);
        const std::size_t len = static_cast<std::size_t>(dur * SR);
        for (std::size_t i = 0; i < len && a + i < n; ++i)
            s.x[a + i] += static_cast<float>(fn(double(i) / SR));
    };
    const double roots[4] = {110.0, 146.83, 164.81, 98.0};
    for (int b = 0; b < bars; ++b)
    {
        const double bar0 = lead + b * 4 * period;
        s.downbeats.push_back(bar0);
        const double f = roots[b % 4];
        add(bar0, 4 * period, [&](double t) {
            return 0.08 * (std::sin(2 * kPi * f * t) + 0.5 * std::sin(2 * kPi * f * 1.25 * 2 * t) + 0.5 * std::sin(2 * kPi * f * 1.5 * 2 * t)) *
                   std::exp(-t * 0.8);
        });
        for (int k = 0; k < 4; ++k)
        {
            const double t0 = bar0 + k * period;
            s.beats.push_back(t0);
            if (k == 0 || k == 2)
            {
                const double vel = k == 0 ? 0.9 : 0.6;
                add(t0, 0.35, [&](double t) { return vel * std::sin(2 * kPi * (50 + 100 * std::exp(-t * 30)) * t) * std::exp(-t * 9); });
            }
            else
                add(t0, 0.2, [&](double t) { return 0.45 * rng.next() * std::exp(-t * 18); });
            for (int h = 0; h < 2; ++h)
                add(t0 + h * period / 2, 0.05, [&](double t) {
                    const double w = rng.next();
                    return 0.12 * (w - 0.5 * rng.next()) * std::exp(-t * 80);
                });
        }
    }
    // golpe final y resonancia
    s.beats.push_back(end);
    s.downbeats.push_back(end);
    add(end, 2.5, [&](double t) {
        return (0.9 * std::sin(2 * kPi * 55 * t) + 0.2 * std::sin(2 * kPi * 220 * t)) * std::exp(-t * 2) + 0.3 * rng.next() * std::exp(-t * 6);
    });
    return s;
}

/** Fracción de beats verdaderos (en [from, to]) con un beat detectado a menos de tol. */
double beatRecall(const std::vector<double>& det, const std::vector<double>& truth, double tol = 0.07)
{
    if (truth.empty())
        return 1;
    int hit = 0;
    for (double t : truth)
    {
        double best = 1e9;
        for (double d : det)
            best = std::min(best, std::fabs(d - t));
        hit += best <= tol;
    }
    return double(hit) / double(truth.size());
}

/** Forma y coherencia del AnalysisResult (checkShape de tests/analysis.test.js). */
void checkShape(const djec::AnalysisResult& r)
{
    for (double v : {r.duration, r.musicStart, r.musicEnd, r.lastOnset, r.bpm})
        CHECK((std::isfinite(v) && v >= 0));
    CHECK(r.musicStart <= r.musicEnd);
    CHECK(r.musicEnd <= r.duration + 1e-6);
    CHECK(std::fabs(r.bpm - std::round(r.bpm * 10) / 10) < 1e-9);
    CHECK(r.bpmLo <= r.bpmHi);
    if (r.beats.size() >= 2)
    {
        CHECK(r.bpmLo <= r.bpm + 1e-9);
        CHECK(r.bpm <= r.bpmHi + 1e-9);
    }
    const std::size_t n = r.beats.size();
    REQUIRE(r.beatStrength.size() == n);
    REQUIRE(r.positions.size() == n);
    for (std::size_t i = 0; i < n; ++i)
    {
        CHECK(std::isfinite(r.beats[i]));
        if (i)
            CHECK(r.beats[i] > r.beats[i - 1]);
        CHECK((r.beatStrength[i] >= 0 && r.beatStrength[i] <= 1));
        CHECK((r.positions[i] >= 0 && r.positions[i] <= r.beatsPerBar));
    }
    if (n)
    {
        CHECK(r.beats.front() >= r.musicStart - 1e-9);
        CHECK(r.beats.back() <= r.musicEnd + 1e-9);
    }
    CHECK((r.beatsPerBar >= 2 && r.beatsPerBar <= 7));
    std::vector<int> db;
    for (std::size_t i = 0; i < n; ++i)
        if (r.positions[i] == 0)
            db.push_back(static_cast<int>(i));
    CHECK(r.downbeats == db);
    for (int f : r.forcedDownbeats)
        CHECK(std::find(r.downbeats.begin(), r.downbeats.end(), f) != r.downbeats.end());
    CHECK((r.confBeats >= 0 && r.confBeats <= 1 && r.confBars >= 0 && r.confBars <= 1));
    CHECK((r.tailBeatsFrom == -1 || (r.tailBeatsFrom >= 1 && r.tailBeatsFrom < static_cast<int>(n))));
    if (r.tailBeatsFrom > 0)
        for (std::size_t i = static_cast<std::size_t>(r.tailBeatsFrom); i < n; ++i)
        {
            const int p = r.positions[i - 1];
            const bool forced = std::find(r.forcedDownbeats.begin(), r.forcedDownbeats.end(), int(i)) != r.forcedDownbeats.end();
            CHECK(r.positions[i] == ((forced || p + 1 >= r.beatsPerBar) ? 0 : p + 1));
        }
}

djec::AnalysisResult analyzeVec(const std::vector<float>& x, double sr = SR)
{
    djec::Analyzer an;
    return an.analyze(x.data(), x.size(), sr);
}

template <typename Ex, typename Fn>
std::string thrownMessage(Fn fn)
{
    try
    {
        fn();
    }
    catch (const Ex& e)
    {
        return e.what();
    }
    catch (...)
    {
        return "<otra excepción>";
    }
    return "<sin excepción>";
}

} // namespace

TEST_CASE("analysis: banda sintética a 120 BPM — beats, tempo, compás 4/4 y su '1'")
{
    const Song s = bandSong(120, 24);
    const djec::AnalysisResult r = analyzeVec(s.x);
    checkShape(r);
    CHECK(std::fabs(r.bpm - 120) < 1.0);
    CHECK(beatRecall(r.beats, s.beats) >= 0.95);
    CHECK(r.beatsPerBar == 4);
    std::vector<double> dbTimes;
    for (int i : r.downbeats)
        dbTimes.push_back(r.beats[static_cast<std::size_t>(i)]);
    CHECK(beatRecall(dbTimes, std::vector<double>(s.downbeats.begin(), s.downbeats.end() - 1)) >= 0.9);
    CHECK(std::fabs(r.lastOnset - s.beats.back()) < 0.05);
    CHECK(r.confBeats >= 0.5);
}

TEST_CASE("analysis: analyzeBounds da los mismos límites que analyze() (sin tempo, beats ni compases)")
{
    Song s = bandSong(120, 12);
    const std::size_t music = s.x.size();
    s.x.resize(music + static_cast<std::size_t>(4 * SR), 0.0f);   // 4 s de silencio al final
    djec::Analyzer an;
    const djec::AnalysisResult r = an.analyze(s.x.data(), s.x.size(), SR);
    const djec::MusicBoundsResult b = djec::analyzeBounds(s.x.data(), s.x.size(), SR);
    CHECK(b.duration == r.duration);
    CHECK(b.musicStart == r.musicStart);
    CHECK(b.musicEnd == r.musicEnd);
    CHECK(b.lastOnset == r.lastOnset);
    CHECK(b.musicEnd < static_cast<double>(music) / SR + 0.5);
    CHECK(std::fabs(b.lastOnset - s.beats.back()) < 0.05);
    // a otra frecuencia (remuestreo de respaldo) también coincide
    const std::vector<float> x16 = djec::resample(s.x.data(), s.x.size(), SR, 16000);
    const djec::AnalysisResult r16 = an.analyze(x16.data(), x16.size(), 16000);
    const djec::MusicBoundsResult b16 = djec::analyzeBounds(x16.data(), x16.size(), 16000);
    CHECK(b16.musicEnd == r16.musicEnd);
    CHECK(b16.lastOnset == r16.lastOnset);
    // silencio y vacío: límites en 0; errores como analyze()
    const std::vector<float> silence(static_cast<std::size_t>(3 * SR), 0.0f);
    const djec::MusicBoundsResult z = djec::analyzeBounds(silence.data(), silence.size(), SR);
    CHECK(z.musicEnd == 0);
    CHECK(z.lastOnset == 0);
    CHECK(djec::analyzeBounds(nullptr, 0, SR).duration == 0);
    CHECK_THROWS_AS(djec::analyzeBounds(silence.data(), silence.size(), 100), std::invalid_argument);
}

TEST_CASE("analysis: silencio, audio vacío y 10 muestras dan un resultado vacío válido con confianza 0")
{
    djec::Analyzer an;
    const std::vector<float> silence(static_cast<std::size_t>(5 * SR), 0.0f);
    const std::vector<float> tiny(10, 0.1f);
    for (const auto* x : {&silence, &tiny})
    {
        const djec::AnalysisResult r = an.analyze(x->data(), x->size(), SR);
        checkShape(r);
        CHECK(r.beats.empty());
        CHECK(r.bpm == 0);
        CHECK(r.bpmLo == 0);
        CHECK(r.bpmHi == 0);
        CHECK(r.confBeats == 0);
        CHECK(r.confBars == 0);
        CHECK(r.tailBeatsFrom == -1);
    }
    const djec::AnalysisResult e = an.analyze(nullptr, 0, SR);
    checkShape(e);
    CHECK(e.duration == 0);
    CHECK(e.beats.empty());
    // retrack / relabel sobre un análisis vacío no fallan
    checkShape(an.retrack(120, true));
    checkShape(an.relabel(3, {0, 5}));
}

TEST_CASE("analysis: 1 s y 2.5 s de audio no fallan y el resultado es coherente")
{
    const Song s = bandSong(118, 8);
    for (double sec : {1.0, 2.5})
    {
        const std::vector<float> part(s.x.begin() + static_cast<std::ptrdiff_t>(2 * SR), s.x.begin() + static_cast<std::ptrdiff_t>((2 + sec) * SR));
        const djec::AnalysisResult r = analyzeVec(part);
        checkShape(r);
        CHECK(std::fabs(r.duration - sec) < 1e-3);
    }
}

TEST_CASE("analysis: offset DC (y cola sólo DC) da el mismo resultado que sin él")
{
    const Song s = bandSong(118, 12, 0.7, 3);
    const djec::AnalysisResult clean = analyzeVec(s.x);
    std::vector<float> x(s.x.size() + static_cast<std::size_t>(6 * SR), 0.0f);
    std::copy(s.x.begin(), s.x.end(), x.begin());
    for (float& v : x)
        v += 0.3f;
    const djec::AnalysisResult r = analyzeVec(x);
    checkShape(r);
    REQUIRE(r.beats.size() == clean.beats.size());
    for (std::size_t i = 0; i < r.beats.size(); ++i)
        CHECK(std::fabs(r.beats[i] - clean.beats[i]) < 0.002);
    CHECK(std::fabs(r.musicEnd - clean.musicEnd) < 0.05);
    CHECK(std::fabs(r.lastOnset - clean.lastOnset) < 0.005);
    CHECK(r.downbeats == clean.downbeats);
    // sólo DC: nada que analizar
    const djec::AnalysisResult dc = analyzeVec(std::vector<float>(static_cast<std::size_t>(10 * SR), 0.5f));
    checkShape(dc);
    CHECK(dc.beats.empty());
}

TEST_CASE("analysis: audio saturado (recorte ×4), muy bajo (−60 dB) y con NaN/Inf: beats correctos")
{
    const Song s = bandSong(118, 12, 0.6, 5);
    float peak = 0;
    for (float v : s.x)
        peak = std::max(peak, std::fabs(v));
    std::vector<float> clip(s.x.size()), quiet(s.x.size());
    for (std::size_t i = 0; i < s.x.size(); ++i)
    {
        clip[i] = std::max(-1.0f, std::min(1.0f, 4 * s.x[i] / peak));
        quiet[i] = s.x[i] * 0.001f;
    }
    std::vector<float> bad(s.x);
    bad[1000] = std::numeric_limits<float>::quiet_NaN();
    bad[5000] = std::numeric_limits<float>::infinity();
    bad[9000] = -std::numeric_limits<float>::infinity();
    for (const auto* x : {&clip, &quiet, &bad})
    {
        const djec::AnalysisResult r = analyzeVec(*x);
        checkShape(r);
        CHECK(beatRecall(r.beats, s.beats) >= 0.95);
        CHECK(std::fabs(r.bpm - 118) < 1.5);
    }
}

TEST_CASE("analysis: ruido blanco no da una cuadrícula fiable")
{
    Lcg rng(7);
    std::vector<float> x(static_cast<std::size_t>(10 * SR));
    for (float& v : x)
        v = static_cast<float>(0.3 * rng.next());
    const djec::AnalysisResult r = analyzeVec(x);
    checkShape(r);
    CHECK(std::min(r.confBeats, r.confBars) < 0.5);
}

TEST_CASE("analysis: otras frecuencias de entrada (44.1 kHz y 16 kHz con el remuestreo de respaldo)")
{
    const Song s = bandSong(118, 12, 0.6, 9);
    std::vector<float> up(s.x.size() * 2);
    for (std::size_t i = 0; i < up.size(); ++i)
        up[i] = s.x[std::min(s.x.size() - 1, i >> 1)];
    std::vector<float> down(static_cast<std::size_t>(std::floor(double(s.x.size()) * 16000 / SR)));
    for (std::size_t i = 0; i < down.size(); ++i)
        down[i] = s.x[static_cast<std::size_t>(std::floor(double(i) * SR / 16000))];
    for (const auto& pr : {std::make_pair(&up, 44100.0), std::make_pair(&down, 16000.0)})
    {
        const djec::AnalysisResult r = analyzeVec(*pr.first, pr.second);
        checkShape(r);
        CHECK(std::fabs(r.duration - double(s.x.size()) / SR) < 0.01);
        CHECK(std::fabs(r.bpm - 118) < 1.5);
        CHECK(beatRecall(r.beats, s.beats) >= 0.95);
    }
}

TEST_CASE("analysis: errores con el mensaje en español de la web")
{
    djec::Analyzer an;
    const std::vector<float> x(100, 0.0f);
    for (double sr : {0.0, -1.0, 1e7, std::nan(""), 2999.0})
        CHECK(thrownMessage<std::invalid_argument>([&] { an.analyze(x.data(), x.size(), sr); }) == "frecuencia de muestreo no válida");
    CHECK(thrownMessage<std::invalid_argument>([&] { an.analyze(nullptr, 100, SR); }) == "no hay muestras de audio");
    CHECK_FALSE(an.hasAnalysis());
    CHECK(thrownMessage<std::logic_error>([&] { an.retrack(0, false); }) == "primero hay que analizar una canción");
    CHECK(thrownMessage<std::logic_error>([&] { an.relabel(0, {}); }) == "primero hay que analizar una canción");
    CHECK(thrownMessage<std::logic_error>([&] { an.result(); }) == "primero hay que analizar una canción");
    an.analyze(x.data(), x.size(), SR);
    CHECK(an.hasAnalysis());
    for (double hint : {10.0, 500.0, -5.0, std::nan("")})
        CHECK(thrownMessage<std::invalid_argument>([&] { an.retrack(hint, true); }) == "tempo fuera de rango (20–400 BPM)");
    an.reset();
    CHECK_FALSE(an.hasAnalysis());
}

TEST_CASE("analysis: opciones (minBpm/maxBpm fuera de rango, compás fijo desde el principio)")
{
    const Song s = bandSong(120, 12, 0.5, 11);
    djec::Analyzer an;
    djec::AnalyzeOptions o;
    o.minBpm = 5;    // fuera de rango → 50
    o.maxBpm = 1000; // → 220
    o.beatsPerBar = 3;
    const djec::AnalysisResult r = an.analyze(s.x.data(), s.x.size(), SR, o);
    checkShape(r);
    CHECK(r.beatsPerBar == 3);
    CHECK_FALSE(r.meterAuto);
    o.beatsPerBar = 9; // no válido → automático
    const djec::AnalysisResult a = an.analyze(s.x.data(), s.x.size(), SR, o);
    CHECK(a.meterAuto);
    CHECK(a.beatsPerBar == 4);
}

TEST_CASE("analysis: retrack ×2 / ÷2 y relabel con un '1' forzado")
{
    const Song s = bandSong(120, 16, 0.5, 13);
    djec::Analyzer an;
    const djec::AnalysisResult first = an.analyze(s.x.data(), s.x.size(), SR);
    REQUIRE(first.downbeats.size() > 4);
    const int d = first.downbeats[first.downbeats.size() / 2];
    const double forcedTime = first.beats[static_cast<std::size_t>(d + 1)];
    const djec::AnalysisResult shifted = an.relabel(0, {d + 1});
    checkShape(shifted);
    CHECK(shifted.forcedDownbeats == std::vector<int>{d + 1});
    CHECK(shifted.confBars >= 0.75);
    const djec::AnalysisResult dbl = an.retrack(first.bpm * 2, true);
    checkShape(dbl);
    CHECK(std::fabs(dbl.bpm / (first.bpm * 2) - 1) < 0.05);
    REQUIRE(dbl.forcedDownbeats.size() == 1);
    CHECK(std::fabs(dbl.beats[static_cast<std::size_t>(dbl.forcedDownbeats[0])] - forcedTime) < 0.02);
    const djec::AnalysisResult half = an.retrack(first.bpm / 2, true);
    checkShape(half);
    CHECK(std::fabs(half.bpm / (first.bpm / 2) - 1) < 0.05);
    const djec::AnalysisResult back = an.retrack(0, false);
    checkShape(back);
    const djec::AnalysisResult reset = an.relabel(0, {});
    CHECK(reset.beats == first.beats);
    CHECK(reset.downbeats == first.downbeats);
    // forzados fuera de rango o repetidos se ignoran
    const djec::AnalysisResult odd = an.relabel(0, {-3, 100000, d, d});
    CHECK(odd.forcedDownbeats == std::vector<int>{d});
}

TEST_CASE("analysis: progreso por etapas en orden, de 0 a 1; un callback que lanza no rompe el análisis")
{
    const Song s = bandSong(120, 40, 0.5, 15);
    djec::Analyzer an;
    std::vector<std::pair<std::string, double>> ev;
    an.analyze(s.x.data(), s.x.size(), SR, {}, [&](const char* st, double f) { ev.emplace_back(st, f); });
    const std::vector<std::string> stages = {"features", "tempo", "beats", "bars"};
    std::vector<std::string> seen;
    for (const auto& e : ev)
        if (seen.empty() || seen.back() != e.first)
            seen.push_back(e.first);
    CHECK(seen == stages);
    for (const auto& st : stages)
    {
        std::vector<double> fr;
        for (const auto& e : ev)
            if (e.first == st)
                fr.push_back(e.second);
        REQUIRE(fr.size() >= 2);
        CHECK(fr.front() == 0);
        CHECK(fr.back() == 1);
        for (std::size_t i = 1; i < fr.size(); ++i)
            CHECK((fr[i] > fr[i - 1] && fr[i] <= 1));
    }
    const djec::AnalysisResult r = an.analyze(s.x.data(), s.x.size(), SR, {}, [](const char*, double) { throw std::runtime_error("ui"); });
    checkShape(r);
    CHECK(!r.beats.empty());
    std::vector<std::string> rt;
    an.retrack(0, false, [&](const char* st, double) { rt.emplace_back(st); });
    CHECK(rt == std::vector<std::string>{"beats", "beats", "bars", "bars"});
}

TEST_CASE("analysis: determinista y sin estado compartido (dos hilos a la vez dan lo mismo)")
{
    const Song a = bandSong(124, 16, 0.4, 17);
    const Song b = bandSong(96, 12, 0.9, 19);
    const djec::AnalysisResult ra = analyzeVec(a.x);
    const djec::AnalysisResult rb = analyzeVec(b.x);
    djec::AnalysisResult ta, tb;
    std::thread t1([&] { ta = analyzeVec(a.x); });
    std::thread t2([&] { tb = analyzeVec(b.x); });
    t1.join();
    t2.join();
    CHECK(ta.beats == ra.beats);
    CHECK(ta.positions == ra.positions);
    CHECK(tb.beats == rb.beats);
    CHECK(tb.positions == rb.positions);
    // mover el Analyzer conserva la sesión
    djec::Analyzer an;
    an.analyze(a.x.data(), a.x.size(), SR);
    djec::Analyzer moved(std::move(an));
    CHECK(moved.hasAnalysis());
    CHECK(moved.result().beats == ra.beats);
    // el objeto movido no tiene sesión: errores claros, sin fallos de memoria, y se puede volver a usar
    CHECK_FALSE(an.hasAnalysis());
    CHECK_THROWS_AS(an.retrack(0, false), std::logic_error);
    CHECK_THROWS_AS(an.result(), std::logic_error);
    CHECK(an.lastTimings().total == 0);
    CHECK(an.analyze(b.x.data(), b.x.size(), SR).beats == rb.beats);
}

TEST_CASE("analysis: piezas puras de analyze.js (sanitizeForced, remapForced, extendPositions, tempoSummary)")
{
    using namespace djec::analysis;
    CHECK(sanitizeForced({5, 3, 3, -1, 7, 10}, 8) == std::vector<int>{3, 5, 7});
    CHECK(remapForced({1.02, 2.5, std::nan("")}, {0.0, 0.5, 1.0, 1.5, 2.0}) == std::vector<int>{2});
    CHECK(remapForced({1.0}, {}).empty());
    std::vector<int> pos = {0, 1, 2};
    extendPositions(pos, 9, 4, {5});
    CHECK(pos == std::vector<int>{0, 1, 2, 3, 0, 0, 1, 2, 3});
    const TempoSummary ts = tempoSummary({0, 0.5, 1.0, 1.5, 2.0});
    CHECK(ts.bpm == 120);
    CHECK(ts.bpmLo == 120);
    CHECK(ts.bpmHi == 120);
    CHECK(tempoSummary({1.0}).bpm == 0);
    const std::vector<float> prep = prepareSamples(std::vector<float>(1000, 0.25f).data(), 1000, SR);
    double mx = 0;
    for (float v : prep)
        mx = std::max(mx, double(std::fabs(v)));
    CHECK(mx < 1e-6); // sólo DC → 0
}

TEST_CASE("resample: toAnalysisMono deja pasar 1 kHz, quita lo que pasa de 11 kHz y respeta los bordes")
{
    const double rate = 48000;
    const std::size_t n = static_cast<std::size_t>(rate * 2);
    auto tone = [&](double f, double a) {
        std::vector<float> x(n);
        for (std::size_t i = 0; i < n; ++i)
            x[i] = static_cast<float>(a * std::sin(2 * kPi * f * double(i) / rate));
        return x;
    };
    auto rmsMid = [](const std::vector<float>& y) {
        double s = 0;
        const std::size_t a = y.size() / 4, b = 3 * y.size() / 4;
        for (std::size_t i = a; i < b; ++i)
            s += double(y[i]) * y[i];
        return std::sqrt(s / double(b - a));
    };
    const std::vector<float> lo = tone(1000, 0.5), hi = tone(15000, 0.5);
    const float* chLo[2] = {lo.data(), lo.data()};
    const std::vector<float> outLo = djec::toAnalysisMono(chLo, 2, n, rate);
    CHECK(outLo.size() == static_cast<std::size_t>(std::ceil(n * 22050.0 / rate)));
    CHECK(std::fabs(20 * std::log10(rmsMid(outLo) / (0.5 / std::sqrt(2.0)))) < 0.1);
    const float* chHi[1] = {hi.data()};
    const std::vector<float> outHi = djec::toAnalysisMono(chHi, 1, n, rate);
    CHECK(20 * std::log10(rmsMid(outHi) / (0.5 / std::sqrt(2.0)) + 1e-12) < -60);
    // contrafase: la mezcla promedio se anularía; se usa (L − R)/2
    std::vector<float> inv(lo);
    for (float& v : inv)
        v = -v;
    const float* chAnti[2] = {lo.data(), inv.data()};
    const std::vector<float> outAnti = djec::toAnalysisMono(chAnti, 2, n, rate);
    CHECK(std::fabs(rmsMid(outAnti) - rmsMid(outLo)) < 1e-3);
    CHECK(djec::analysisMixWeights(chAnti, 2, n) == std::vector<double>{0.5, -0.5});
    // bordes
    CHECK(djec::toAnalysisMono(nullptr, 0, 100, rate).empty());
    CHECK(djec::toAnalysisMono(chLo, 2, 0, rate).empty());
    const std::vector<float> same = djec::toAnalysisMono(chHi, 1, n, 22050);
    CHECK(same == hi);
    CHECK_THROWS_AS(djec::toAnalysisMono(chHi, 1, n, 0), std::invalid_argument);
    CHECK_THROWS_AS(djec::Resampler(44100, -1), std::invalid_argument);
    // remuestreo general (12 cruces por cero): 44.1 kHz → 48 kHz conserva un tono de 1 kHz
    const std::vector<float> t44 = [&] {
        std::vector<float> x(44100);
        for (std::size_t i = 0; i < x.size(); ++i)
            x[i] = static_cast<float>(0.5 * std::sin(2 * kPi * 1000 * double(i) / 44100.0));
        return x;
    }();
    const std::vector<float> t48 = djec::resample(t44.data(), t44.size(), 44100, 48000);
    CHECK(t48.size() == 48000);
    double maxErr = 0;
    for (std::size_t i = 2000; i < 46000; ++i)
        maxErr = std::max(maxErr, std::fabs(t48[i] - 0.5 * std::sin(2 * kPi * 1000 * double(i) / 48000.0)));
    CHECK(maxErr < 1e-3);
}

TEST_CASE("analysis performance: 4:30 de banda sintética")
{
    const Song s = bandSong(122, 137, 1.0, 21);
    djec::Analyzer an;
    const auto t0 = std::chrono::steady_clock::now();
    const djec::AnalysisResult r = an.analyze(s.x.data(), s.x.size(), SR);
    const double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    checkShape(r);
    MESSAGE("banda sintética de " << double(s.x.size()) / SR << " s analizada en " << sec << " s");
    CHECK(beatRecall(r.beats, s.beats) >= 0.95);
#ifdef NDEBUG
    CHECK(sec < 2.0);
#endif
}
