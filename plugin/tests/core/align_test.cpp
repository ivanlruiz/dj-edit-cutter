// Tests de djec/align.h (ubicar un archivo soltado en la línea de tiempo) con música sintética: el mismo audio
// (exacto, −6 dB, con EQ, remuestreado con otro algoritmo), solapes parciales, otro archivo, música que se repite,
// silencio y el tiempo con un archivo de 6 minutos.
#include <doctest.h>

#include "djec/align.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <vector>

using namespace djec;

namespace
{
constexpr double kPi = 3.141592653589793;

struct Rng
{
    std::uint32_t s;
    explicit Rng(std::uint32_t seed) : s(seed ? seed : 1) {}
    std::uint32_t next()
    {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return s;
    }
    double uni() { return next() / 4294967296.0; }          // [0, 1)
    double sym() { return uni() * 2 - 1; }                   // [−1, 1)
    int pick(int n) { return static_cast<int>(uni() * n); }
};

struct SongParams
{
    std::uint32_t seed = 1;
    double bpm = 120;
    double sr = 48000;
    double seconds = 60;
    bool loop = false;   // la misma frase de 4 compases una y otra vez (idéntica a la muestra)
};

double midiHz(double m)
{
    return 440.0 * std::pow(2.0, (m - 69) / 12);
}

// Canción sintética: bombo, caja, hi-hat, bajo, acordes y melodía, con variación por compás (o en bucle).
std::vector<float> makeSong(const SongParams& p)
{
    const double sr = p.sr;
    const std::size_t n = static_cast<std::size_t>(p.seconds * sr);
    std::vector<float> out(n, 0.0f);
    const double beat = 60.0 / p.bpm;
    const double bar = 4 * beat;
    const int nBars = static_cast<int>(std::ceil(p.seconds / bar)) + 1;
    Rng song(p.seed * 7919u + 17u);
    const double kickHz = 45 + song.uni() * 15;
    const int key = 36 + song.pick(12);
    const int scale[7] = {0, 2, 3, 5, 7, 8, 10};
    auto add = [&](double t0, double dur, auto&& fn) {
        const long long i0 = static_cast<long long>(std::ceil(t0 * sr));
        const long long i1 = std::min<long long>(static_cast<long long>(n), static_cast<long long>((t0 + dur) * sr));
        for (long long i = std::max<long long>(0, i0); i < i1; ++i)
        {
            const double t = static_cast<double>(i) / sr - t0;
            out[static_cast<std::size_t>(i)] += static_cast<float>(fn(t));
        }
    };
    for (int b = 0; b < nBars; ++b)
    {
        const double tb = b * bar;
        // en bucle: el mismo azar en cada frase de 4 compases
        Rng r(p.loop ? static_cast<std::uint32_t>(p.seed * 31u + static_cast<std::uint32_t>(b % 4) * 101u + 5u)
                     : static_cast<std::uint32_t>(p.seed * 1000003u + static_cast<std::uint32_t>(b) * 7919u + 3u));
        const int chordDeg = r.pick(7);
        const int root = key + scale[chordDeg];
        // bombo (1 y 3 + alguna corchea)
        for (int e = 0; e < 8; ++e)
        {
            const bool hit = e == 0 || e == 4 || (r.uni() < 0.2);
            if (!hit)
                continue;
            const double amp = 0.55 + 0.1 * r.uni();
            add(tb + e * beat / 2, 0.35, [&](double t) {
                const double ph = 2 * kPi * (kickHz * t + (110.0 / 30) * (1 - std::exp(-30 * t)));
                return amp * std::exp(-9 * t) * std::sin(ph);
            });
        }
        // caja (2 y 4): ruido + tono
        for (int e : {1, 3})
        {
            Rng nz(r.next());
            double lp = 0;
            add(tb + e * beat, 0.25, [&](double t) {
                const double w = nz.sym();
                lp += 0.35 * (w - lp);
                return 0.35 * std::exp(-14 * t) * (w - lp) + 0.15 * std::exp(-20 * t) * std::sin(2 * kPi * 185 * t);
            });
        }
        // hi-hat (corcheas)
        for (int e = 0; e < 8; ++e)
        {
            Rng nz(r.next());
            double prev = 0;
            const double amp = 0.08 + 0.06 * r.uni();
            add(tb + e * beat / 2, 0.06, [&](double t) {
                const double w = nz.sym();
                const double hp = w - prev;
                prev = w;
                return amp * std::exp(-70 * t) * hp;
            });
        }
        // bajo (corcheas, raíz o quinta)
        for (int e = 0; e < 8; ++e)
        {
            const int note = root + (r.uni() < 0.3 ? 7 : 0) + (r.uni() < 0.15 ? 12 : 0);
            const double f = midiHz(note);
            double lp = 0;
            add(tb + e * beat / 2, beat / 2, [&](double t) {
                const double saw = 2 * (f * t - std::floor(f * t + 0.5));
                lp += 0.08 * (saw - lp);
                return 0.3 * std::exp(-3 * t) * lp;
            });
        }
        // acorde del compás
        {
            const double f0 = midiHz(root + 24), f1 = midiHz(key + scale[(chordDeg + 2) % 7] + 24),
                         f2 = midiHz(key + scale[(chordDeg + 4) % 7] + 24);
            add(tb, bar, [&](double t) {
                const double env = std::min(1.0, t * 20) * std::exp(-0.6 * t);
                return 0.07 * env * (std::sin(2 * kPi * f0 * t) + std::sin(2 * kPi * f1 * t) + std::sin(2 * kPi * f2 * t));
            });
        }
        // melodía
        for (int e = 0; e < 8; ++e)
        {
            if (r.uni() < 0.4)
                continue;
            const double f = midiHz(key + 36 + scale[r.pick(7)] + (r.uni() < 0.3 ? 12 : 0));
            const double amp = 0.08 + 0.05 * r.uni();
            add(tb + e * beat / 2, beat * 0.8, [&](double t) {
                return amp * std::exp(-5 * t) * (std::sin(2 * kPi * f * t) + 0.3 * std::sin(4 * kPi * f * t));
            });
        }
    }
    return out;
}

// Biquad RBJ (en double)
struct Biquad
{
    double b0, b1, b2, a1, a2, z1 = 0, z2 = 0;
    static Biquad peaking(double sr, double f, double q, double db)
    {
        const double A = std::pow(10.0, db / 40), w = 2 * kPi * f / sr, al = std::sin(w) / (2 * q);
        const double a0 = 1 + al / A;
        return {(1 + al * A) / a0, -2 * std::cos(w) / a0, (1 - al * A) / a0, -2 * std::cos(w) / a0, (1 - al / A) / a0};
    }
    static Biquad shelf(double sr, double f, double db, bool high)
    {
        const double A = std::pow(10.0, db / 40), w = 2 * kPi * f / sr, cs = std::cos(w);
        const double al = std::sin(w) / 2 * std::sqrt(2.0), sq = 2 * std::sqrt(A) * al;
        double b0, b1, b2, a0, a1, a2;
        if (!high)
        {
            b0 = A * ((A + 1) - (A - 1) * cs + sq);
            b1 = 2 * A * ((A - 1) - (A + 1) * cs);
            b2 = A * ((A + 1) - (A - 1) * cs - sq);
            a0 = (A + 1) + (A - 1) * cs + sq;
            a1 = -2 * ((A - 1) + (A + 1) * cs);
            a2 = (A + 1) + (A - 1) * cs - sq;
        }
        else
        {
            b0 = A * ((A + 1) + (A - 1) * cs + sq);
            b1 = -2 * A * ((A - 1) + (A + 1) * cs);
            b2 = A * ((A + 1) + (A - 1) * cs - sq);
            a0 = (A + 1) - (A - 1) * cs + sq;
            a1 = 2 * ((A - 1) - (A + 1) * cs);
            a2 = (A + 1) - (A - 1) * cs - sq;
        }
        return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
    }
    double operator()(double x)
    {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

// Lo que llega al plugin: un trozo del archivo con ganancia y (opcional) EQ suave aplicada al audio entero
std::vector<float> channelAudio(const std::vector<float>& song, double sr, double gain, bool eq)
{
    std::vector<float> y(song.size());
    Biquad lo = Biquad::shelf(sr, 150, 4, false), mid = Biquad::peaking(sr, 2000, 1.0, -5),
           hi = Biquad::shelf(sr, 8000, -6, true);
    for (std::size_t i = 0; i < song.size(); ++i)
    {
        double v = song[i] * gain;
        if (eq)
            v = hi(mid(lo(v)));
        y[i] = static_cast<float>(v);
    }
    return y;
}

std::vector<float> slice(const std::vector<float>& x, long long from, std::size_t len)
{
    std::vector<float> s(len, 0.0f);
    for (std::size_t j = 0; j < len; ++j)
    {
        const long long i = from + static_cast<long long>(j);
        if (i >= 0 && i < static_cast<long long>(x.size()))
            s[j] = x[static_cast<std::size_t>(i)];
    }
    return s;
}

// Remuestreo de calidad (sinc con ventana de Blackman, 32 lóbulos) y uno pobre (lineal): dos algoritmos distintos
std::vector<float> resampleSinc(const std::vector<float>& x, double from, double to)
{
    const std::size_t n = static_cast<std::size_t>(std::floor(static_cast<double>(x.size()) * to / from));
    std::vector<float> y(n);
    const double ratio = from / to, fc = std::min(1.0, to / from) * 0.97;
    const int half = 32;
    for (std::size_t i = 0; i < n; ++i)
    {
        const double pos = static_cast<double>(i) * ratio;
        const long long c = static_cast<long long>(std::floor(pos));
        double acc = 0, wsum = 0;
        for (long long k = c - half + 1; k <= c + half; ++k)
        {
            const double d = pos - static_cast<double>(k);
            const double wnd = 0.42 + 0.5 * std::cos(kPi * d / half) + 0.08 * std::cos(2 * kPi * d / half);
            const double s = d == 0 ? fc : std::sin(kPi * fc * d) / (kPi * d);
            const double w = s * wnd;
            if (k >= 0 && k < static_cast<long long>(x.size()))
                acc += w * x[static_cast<std::size_t>(k)];
            wsum += w;
        }
        y[i] = static_cast<float>(acc / wsum);
    }
    return y;
}

std::vector<float> resampleLinear(const std::vector<float>& x, double from, double to)
{
    const std::size_t n = static_cast<std::size_t>(std::floor(static_cast<double>(x.size()) * to / from));
    std::vector<float> y(n);
    for (std::size_t i = 0; i < n; ++i)
    {
        const double pos = static_cast<double>(i) * from / to;
        const std::size_t k = static_cast<std::size_t>(pos);
        const double f = pos - static_cast<double>(k);
        const float a = x[std::min(k, x.size() - 1)], b = x[std::min(k + 1, x.size() - 1)];
        y[i] = static_cast<float>(a + (b - a) * f);
    }
    return y;
}
} // namespace

TEST_SUITE("align")
{
TEST_CASE("el mismo audio: posición exacta en varios puntos (y a −6 dB)")
{
    const double sr = 48000;
    const auto song = makeSong({11, 120, sr, 60});
    Aligner al;
    al.prepare(song.data(), song.size(), sr);
    REQUIRE(al.prepared());
    for (double gain : {1.0, 0.5})
    {
        const auto ch = channelAudio(song, sr, gain, false);
        for (double at : {0.0, 3.21, 17.5, 41.123, 53.9})
        {
            const long long off = static_cast<long long>(at * sr) + 7;
            const auto in = slice(ch, off, static_cast<std::size_t>(5 * sr));
            const AlignResult r = al.find(in.data(), in.size());
            INFO("ganancia " << gain << ", en " << at << " s: conf " << r.confidence << ", 2ª " << r.secondConfidence);
            CHECK(r.found);
            CHECK(r.fileOffsetOfInputStart == off);
            CHECK(r.confidence > 0.99);
            CHECK_FALSE(r.ambiguous);
        }
    }
}

TEST_CASE("−6 dB con EQ suave (estantes y campana): ubicado a pocas muestras")
{
    const double sr = 48000;
    const auto song = makeSong({23, 126, sr, 90});
    const auto ch = channelAudio(song, sr, 0.5, true);
    Aligner al;
    al.prepare(song.data(), song.size(), sr);
    for (double at : {2.0, 30.4, 77.7})
    {
        const long long off = static_cast<long long>(at * sr);
        for (double secs : {4.0, 8.0})
        {
            const auto in = slice(ch, off, static_cast<std::size_t>(secs * sr));
            const AlignResult r = al.find(in.data(), in.size());
            MESSAGE("EQ, en " << at << " s, trozo de " << secs << " s: error " << (r.fileOffsetOfInputStart - off)
                              << " muestras, conf " << r.confidence << ", gruesa " << r.coarseScore << ", 2ª "
                              << r.secondConfidence << ", " << r.elapsedMs << " ms");
            CHECK(r.found);
            // lo que queda es el retardo de grupo de la EQ (los estantes atrasan los graves unas muestras)
            CHECK(std::llabs(r.fileOffsetOfInputStart - off) <= 16);
        }
    }
}

TEST_CASE("archivo de 44,1 kHz en un proyecto de 48 kHz (dos remuestreadores distintos)")
{
    const auto song44 = makeSong({31, 118, 44100, 45});
    const auto host = resampleSinc(song44, 44100, 48000);     // lo que reproduce FL
    const auto file = resampleLinear(song44, 44100, 48000);   // lo que remuestrea el plugin (otro algoritmo)
    Aligner al;
    al.prepare(file.data(), file.size(), 48000);
    for (double at : {5.0, 22.2})
    {
        const long long off = static_cast<long long>(at * 48000);
        const auto in = slice(channelAudio(host, 48000, 0.7, false), off, 6 * 48000);
        const AlignResult r = al.find(in.data(), in.size());
        MESSAGE("44,1 → 48 kHz en " << at << " s: error " << (r.fileOffsetOfInputStart - off) << " muestras, conf "
                                     << r.confidence);
        CHECK(r.found);
        CHECK(std::llabs(r.fileOffsetOfInputStart - off) <= 1);
    }
}

TEST_CASE("el archivo empieza después del principio del trozo (solape parcial)")
{
    const double sr = 44100;
    const auto song = makeSong({5, 100, sr, 40});
    Aligner al;
    al.prepare(song.data(), song.size(), sr);
    // 2 s de silencio y después el principio del archivo
    const auto in = slice(song, static_cast<long long>(-2 * sr), static_cast<std::size_t>(6 * sr));
    const AlignResult r = al.find(in.data(), in.size());
    CHECK(r.found);
    CHECK(r.fileOffsetOfInputStart == static_cast<long long>(-2 * sr));
    // 2 s de otra canción y después el archivo
    const auto other = makeSong({77, 100, sr, 3});
    auto mixed = slice(song, static_cast<long long>(-2 * sr), static_cast<std::size_t>(6 * sr));
    for (std::size_t i = 0; i < static_cast<std::size_t>(2 * sr); ++i)
        mixed[i] = other[i];
    const AlignResult r2 = al.find(mixed.data(), mixed.size());
    MESSAGE("con otra canción antes: conf " << r2.confidence << ", posición " << r2.fileOffsetOfInputStart);
    CHECK(r2.fileOffsetOfInputStart == static_cast<long long>(-2 * sr));
}

TEST_CASE("otro archivo: no se ubica")
{
    const double sr = 48000;
    const auto song = makeSong({11, 120, sr, 60});
    Aligner al;
    al.prepare(song.data(), song.size(), sr);
    double worst = -1;
    for (SongParams p : {SongParams{12, 120, sr, 20}, SongParams{99, 120, sr, 20}, SongParams{4, 128, sr, 20},
                         SongParams{8, 90, sr, 20}})
    {
        const auto wrong = makeSong(p);
        for (double secs : {4.0, 8.0})
        {
            const auto in = slice(channelAudio(wrong, sr, 0.5, true), static_cast<long long>(3 * sr),
                                  static_cast<std::size_t>(secs * sr));
            const AlignResult r = al.find(in.data(), in.size());
            MESSAGE("otra canción (semilla " << p.seed << ", " << p.bpm << " BPM, " << secs << " s): conf " << r.confidence
                                             << ", gruesa " << r.coarseScore);
            CHECK_FALSE(r.found);
            worst = std::max(worst, r.confidence);
        }
    }
    MESSAGE("peor confianza con otro archivo: " << worst << " (umbral " << AlignOptions{}.minConfidence << ")");
}

TEST_CASE("música en bucle: ambiguo dentro de la repetición, ubicado si el trozo toca algo único")
{
    const double sr = 48000;
    auto song = makeSong({3, 120, sr, 48, true});   // frases de 4 compases (8 s) idénticas
    // un corte (break) único en 30–31 s
    for (std::size_t i = static_cast<std::size_t>(30 * sr); i < static_cast<std::size_t>(31 * sr); ++i)
        song[i] *= 0.1f;
    Aligner al;
    al.prepare(song.data(), song.size(), sr);
    const auto in = slice(song, static_cast<long long>(9 * sr), static_cast<std::size_t>(6 * sr));
    const AlignResult r = al.find(in.data(), in.size());
    MESSAGE("bucle: conf " << r.confidence << ", 2ª " << r.secondConfidence << " en " << r.secondOffset);
    CHECK(r.ambiguous);
    CHECK_FALSE(r.found);
    const auto in2 = slice(song, static_cast<long long>(27 * sr), static_cast<std::size_t>(6 * sr));
    const AlignResult r2 = al.find(in2.data(), in2.size());
    CHECK(r2.found);
    CHECK(r2.fileOffsetOfInputStart == static_cast<long long>(27 * sr));
}

TEST_CASE("silencio, trozos cortos, límites de posición y estéreo")
{
    const double sr = 48000;
    const auto song = makeSong({11, 120, sr, 30});
    Aligner al;
    al.prepare(song.data(), song.size(), sr);
    const std::vector<float> silence(static_cast<std::size_t>(4 * sr), 0.0f);
    const AlignResult q = al.find(silence.data(), silence.size());
    CHECK(q.tooQuiet);
    CHECK_FALSE(q.found);
    CHECK_FALSE(al.find(song.data(), 3).found);
    CHECK_FALSE(Aligner().find(song.data(), song.size()).found);

    const long long off = static_cast<long long>(12 * sr);
    const auto in = slice(song, off, static_cast<std::size_t>(5 * sr));
    AlignOptions o;
    o.maxFileOffset = off - static_cast<long long>(sr);   // el archivo no puede empezar donde de verdad está
    Aligner limited;
    limited.prepare(song.data(), song.size(), sr, o);
    CHECK(limited.find(in.data(), in.size()).fileOffsetOfInputStart <= o.maxFileOffset);
    CHECK_FALSE(limited.find(in.data(), in.size()).found);

    // archivo estéreo (L, R distintos): se ubica con la mezcla mono
    std::vector<float> right(song.size());
    for (std::size_t i = 0; i < song.size(); ++i)
        right[i] = 0.5f * song[i] + 0.1f * song[(i + 480) % song.size()];
    const float* chs[2] = {song.data(), right.data()};
    Aligner st;
    st.prepare(chs, 2, song.size(), sr);
    std::vector<float> monoIn(in.size());
    for (std::size_t j = 0; j < in.size(); ++j)
        monoIn[j] = 0.5f * (in[j] + right[static_cast<std::size_t>(off) + j]);
    const AlignResult rs = st.find(monoIn.data(), monoIn.size());
    CHECK(rs.found);
    CHECK(rs.fileOffsetOfInputStart == off);
}

TEST_CASE("tiempo: archivo de 6 minutos a 48 kHz, trozos de 4 y 8 s")
{
    const double sr = 48000;
    const auto song = makeSong({42, 124, sr, 360});
    const auto ch = channelAudio(song, sr, 0.5, true);
    Aligner al;
    const auto t0 = std::chrono::steady_clock::now();
    al.prepare(song.data(), song.size(), sr);
    const double prepMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    for (double secs : {4.0, 8.0})
    {
        const long long off = static_cast<long long>(201.3 * sr);
        const auto in = slice(ch, off, static_cast<std::size_t>(secs * sr));
        double best = 1e9;
        AlignResult r;
        for (int rep = 0; rep < 3; ++rep)
        {
            r = al.find(in.data(), in.size());
            best = std::min(best, r.elapsedMs);
        }
        MESSAGE("6 min @ 48 kHz: prepare " << prepMs << " ms, find (" << secs << " s) " << best
                                            << " ms; error " << (r.fileOffsetOfInputStart - off) << " muestras, conf "
                                            << r.confidence);
        CHECK(r.found);
        CHECK(std::llabs(r.fileOffsetOfInputStart - off) <= 16);   // con EQ (ver arriba)
    }
    const auto in = slice(ch, static_cast<long long>(100 * sr), static_cast<std::size_t>(6 * sr));
    const AlignResult once = findAlignment(song.data(), song.size(), in.data(), in.size(), sr);
    MESSAGE("findAlignment (prepare + find) 6 min, trozo de 6 s: " << once.elapsedMs << " ms");
    CHECK(once.found);
#ifdef NDEBUG
    CHECK(once.elapsedMs < 1000);
#endif
}
}
