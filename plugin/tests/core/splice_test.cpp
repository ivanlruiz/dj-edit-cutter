// Tests de djec/splice.h y djec/fade.h (port de tests/splice.test.js). La paridad muestra a muestra con la web
// (renders de golden-edit.mjs) está en edit_plan_test.cpp.
#include <doctest.h>

#include "djec/fade.h"
#include "djec/splice.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>

using namespace djec;

namespace
{
constexpr double SR = 44100;
constexpr double kPi = 3.141592653589793;

std::vector<float> noise(std::size_t n, std::uint32_t seed)
{
    std::vector<float> a(n);
    std::uint32_t s = seed ? seed : 1;
    for (std::size_t i = 0; i < n; ++i)
    {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        a[i] = static_cast<float>((static_cast<double>(s) / 4294967295.0) * 2 - 1);
    }
    return a;
}

std::vector<float> sine(double seconds, double freq, double amp = 1, double phase = 0, double sr = SR)
{
    const std::size_t n = static_cast<std::size_t>(std::lround(seconds * sr));
    std::vector<float> a(n);
    for (std::size_t i = 0; i < n; ++i)
        a[i] = static_cast<float>(amp * std::sin(2 * kPi * freq * static_cast<double>(i) / sr + phase));
    return a;
}

std::int64_t expectedLength(const std::vector<Segment>& segs, double sr = SR)
{
    std::int64_t total = 0;
    for (const Segment& s : segs)
    {
        const double a = std::floor(s.start * sr + 0.5), b = std::floor(s.end * sr + 0.5);
        if (b > a)
            total += static_cast<std::int64_t>(b - a);
    }
    return total;
}

std::vector<std::vector<float>> render(const std::vector<std::vector<float>>& src, const std::vector<Segment>& segs,
                                       double xf = 0.010, double fo = 0, const std::string& curve = "smooth",
                                       double sr = SR)
{
    std::vector<const float*> ptrs;
    std::size_t n = src.empty() ? 0 : src[0].size();
    for (const auto& c : src)
    {
        ptrs.push_back(c.data());
        n = std::min(n, c.size());
    }
    std::vector<std::vector<float>> out;
    renderSegments(ptrs.data(), static_cast<int>(ptrs.size()), n, sr, segs, xf, fo, curve, out);
    return out;
}

double maxAbs(const std::vector<float>& a, std::size_t from = 0, std::size_t to = SIZE_MAX)
{
    double m = 0;
    for (std::size_t i = from; i < std::min(to, a.size()); ++i)
        m = std::max(m, static_cast<double>(std::fabs(a[i])));
    return m;
}

double maxJump(const std::vector<float>& a, std::size_t from, std::size_t to)
{
    double m = 0;
    for (std::size_t i = std::max<std::size_t>(1, from); i < std::min(to, a.size()); ++i)
        m = std::max(m, static_cast<double>(std::fabs(a[i] - a[i - 1])));
    return m;
}
} // namespace

TEST_SUITE("splice")
{
TEST_CASE("fadeGain: extremos, monotonía y curvas")
{
    for (const char* c : {"linear", "smooth", "exp", "otra"})
    {
        CHECK(fadeGain(0, c) == 1);
        CHECK(fadeGain(-1, c) == 1);
        CHECK(fadeGain(std::nan(""), c) == 1);
        CHECK(fadeGain(1, c) == 0);
        CHECK(fadeGain(2, c) == 0);
        float prev = 1;
        for (int k = 1; k <= 100; ++k)
        {
            const float g = fadeGain(k / 100.0, c);
            CHECK(g <= prev);
            prev = g;
        }
    }
    CHECK(fadeGain(0.25, "linear") == 0.75f);
    CHECK(fadeGain(0.5, "smooth") == doctest::Approx(0.5));
    CHECK(fadeGain(0.5, "exp") == doctest::Approx((std::pow(10.0, -1.5) - 0.001) / 0.999));
    const auto g = fadeOutGains(4, "linear");
    REQUIRE(g.size() == 4);
    CHECK(g[0] == 0.75f);
    CHECK(g[3] == 0.0f);
    CHECK(fadeOutGains(10, "linear", 8, 20).size() == 2);
    CHECK(fadeOutGains(10, "linear", 12, 20).empty());
}

TEST_CASE("longitud exacta: Σ round(end·sr) − round(start·sr)")
{
    const std::vector<std::vector<float>> src = {noise(static_cast<std::size_t>(SR * 4), 7)};
    std::uint32_t seed = 12345;
    auto rnd = [&]() {
        seed = static_cast<std::uint32_t>((static_cast<std::uint64_t>(seed) * 1103515245u + 12345u) % 2147483648u);
        return seed / 2147483648.0;
    };
    for (int trial = 0; trial < 50; ++trial)
    {
        std::vector<Segment> segs;
        const int n = 1 + static_cast<int>(rnd() * 12);
        for (int i = 0; i < n; ++i)
        {
            const double start = rnd() * 4.5 - 0.2;
            segs.push_back({start, start + rnd() * 0.8 - 0.05});
        }
        const auto out = render(src, segs, rnd() * 0.04);
        CHECK(static_cast<std::int64_t>(out[0].size()) == expectedLength(segs));
        CHECK(renderedLength(segs, SR) == expectedLength(segs));
        CHECK(std::all_of(out[0].begin(), out[0].end(), [](float v) { return std::isfinite(v); }));
    }
}

TEST_CASE("copia bit a bit en segmentos contiguos y lejos de los empalmes")
{
    const auto a = noise(static_cast<std::size_t>(SR * 3), 3);
    const std::vector<Segment> contiguous = {{0, 1}, {1, 2}, {2, 2.5}};
    const auto out = render({a}, contiguous, 0.03, 0);
    const std::size_t F = static_cast<std::size_t>(std::lround(kAntiClickSec * SR));
    REQUIRE(out[0].size() == static_cast<std::size_t>(2.5 * SR));
    for (std::size_t i = 0; i + F < out[0].size(); ++i)
        if (out[0][i] != a[i])
        {
            FAIL("no es bit a bit en " << i);
            break;
        }
    // con un empalme: igual lejos de la ventana
    const std::vector<Segment> jump = {{0, 1}, {1.5, 2.5}};
    const auto o2 = render({a}, jump, 0.02, 0);
    std::size_t diff = 0;
    for (std::size_t i = 0; i < static_cast<std::size_t>(SR - 0.011 * SR); ++i)
        diff += o2[0][i] != a[i];
    for (std::size_t i = static_cast<std::size_t>(SR + 0.011 * SR); i < static_cast<std::size_t>(1.9 * SR); ++i)
        diff += o2[0][i] != a[i + static_cast<std::size_t>(0.5 * SR)];
    CHECK(diff == 0);
}

TEST_CASE("crossfade: empalme fuera de fase sin clic; silencio → señal es una rampa suave")
{
    const auto s = sine(2, 100);
    // de una cresta a un valle: sin crossfade salta casi 2
    const std::vector<Segment> segs = {{0, 0.0025}, {0.0075, 1}};
    const auto hard = render({s}, segs, 0);
    const auto soft = render({s}, segs, 0.01);
    const std::size_t at = static_cast<std::size_t>(std::lround(0.0025 * SR));
    CHECK(maxJump(hard[0], at - 2, at + 3) > 1.5);
    CHECK(maxJump(soft[0], 0, soft[0].size() - 300) < 0.05);

    std::vector<float> sil(static_cast<std::size_t>(SR), 0.0f);
    auto tone = sine(1, 440, 0.8);
    sil.insert(sil.end(), tone.begin(), tone.end());
    const auto ramp = render({sil}, {{0, 0.5}, {1.0, 1.5}}, 0.02);
    CHECK(maxJump(ramp[0], 0, ramp[0].size() - 300) < 0.08);
}

TEST_CASE("crossfade sobre audio correlacionado y a tope: nunca supera el pico de la fuente")
{
    const std::size_t n = static_cast<std::size_t>(SR * 4);
    const auto nz = noise(n, 77);
    std::vector<float> src(n);
    for (std::size_t i = 0; i < n; ++i)
    {
        const double ph = 2 * kPi * static_cast<double>(i) / 441;
        const double v = 1.3 * (std::sin(ph) + 0.4 * std::sin(3 * ph + 0.7)) + 0.08 * nz[i];
        src[i] = static_cast<float>(std::max(-0.97, std::min(0.97, v)));
    }
    std::vector<Segment> segs;
    for (int k = 0; k < 12; ++k)
        segs.push_back({0.1 + k * 0.3, 0.1 + k * 0.3 + 0.25});
    for (double xf : {0.005, 0.01, 0.04})
        CHECK(maxAbs(render({src}, segs, xf)[0]) <= 0.97 + 1e-6);
}

TEST_CASE("mixCrossfade: igual potencia sin correlación, igual ganancia en fase")
{
    const std::size_t L = 441;
    std::vector<double> c(L), s(L), y(L);
    for (std::size_t j = 0; j < L; ++j)
    {
        c[j] = std::cos(((j + 0.5) / L) * kPi / 2);
        s[j] = std::sin(((j + 0.5) / L) * kPi / 2);
    }
    auto rms = [](const std::vector<double>& x, std::size_t a, std::size_t b) {
        double e = 0;
        for (std::size_t i = a; i < b; ++i)
            e += x[i] * x[i];
        return std::sqrt(e / static_cast<double>(b - a));
    };
    double lvl = 0;
    for (int t = 0; t < 40; ++t)
    {
        const auto na = noise(L, 100 + t), nb = noise(L, 500 + t);
        std::vector<double> a(L), b(L);
        for (std::size_t j = 0; j < L; ++j)
        {
            a[j] = na[j] * 0.4;
            b[j] = nb[j] * 0.4;
        }
        mixCrossfade(a.data(), b.data(), L, c.data(), s.data(), y.data());
        lvl += 20 * std::log10(rms(y, 110, 331) / rms(a, 110, 331));
    }
    CHECK(std::fabs(lvl / 40) < 0.5);
    for (int t = 0; t < 40; ++t)
    {
        const auto na = noise(L, 900 + t), nb = noise(L, 1300 + t);
        std::vector<double> a(na.begin(), na.end()), b(nb.begin(), nb.end());
        mixCrossfade(a.data(), b.data(), L, c.data(), s.data(), y.data());
        double peak = 0;
        for (std::size_t j = 0; j < L; ++j)
            peak = std::max({peak, std::fabs(a[j]), std::fabs(b[j])});
        for (std::size_t j = 0; j < L; ++j)
            REQUIRE(std::fabs(y[j]) <= std::max(peak, kSpliceCeiling) * (1 + 1e-6));
    }
    const auto sn = sine(0.01, 300, 0.8);
    std::vector<double> a(sn.begin(), sn.begin() + static_cast<std::ptrdiff_t>(L));
    mixCrossfade(a.data(), a.data(), L, c.data(), s.data(), y.data());
    for (std::size_t j = 0; j < L; ++j)
        REQUIRE(std::fabs(y[j] - a[j]) < 1e-9);
    std::vector<double> z(L, 0.0);
    mixCrossfade(z.data(), z.data(), L, c.data(), s.data(), y.data());
    for (std::size_t j = 0; j < L; ++j)
        REQUIRE(y[j] == 0);
}

TEST_CASE("fade-out final, multicanal, entradas vacías")
{
    const auto a = noise(static_cast<std::size_t>(SR * 2), 5);
    const auto b = sine(2, 220, 0.5);
    const auto out = render({a, b}, {{0, 1.5}}, 0.01, 0.5, "linear");
    REQUIRE(out.size() == 2);
    CHECK(out[0].back() == 0.0f);
    CHECK(out[1].back() == 0.0f);
    const auto l = render({a}, {{0, 1.5}}, 0.01, 0.5, "linear");
    CHECK(l[0] == out[0]);
    // sin fade pedido: igual hay anti-clic
    const auto ac = render({a}, {{0, 1}}, 0.01, 0);
    CHECK(ac[0].back() == 0.0f);
    CHECK(ac[0][ac[0].size() - static_cast<std::size_t>(std::lround(kAntiClickSec * SR)) - 1] ==
          a[ac[0].size() - static_cast<std::size_t>(std::lround(kAntiClickSec * SR)) - 1]);

    CHECK(render({}, {{0, 1}}).empty());
    CHECK(render({a}, {}).at(0).empty());
    CHECK(render({a}, {{0, 1}}, 0.01, 0, "smooth", 0).at(0).empty());
    CHECK(render({a}, {{1, 0.5}}).at(0).empty());
    // fuera de la fuente: silencio
    const auto past = render({a}, {{3, 3.5}}, 0.01, 0);
    CHECK(maxAbs(past[0]) == 0);
}

TEST_CASE("rendimiento: 5 min estéreo 48 kHz con ~150 empalmes")
{
    const double sr = 48000;
    const std::size_t n = static_cast<std::size_t>(sr * 300);
    const auto left = noise(n, 11);
    const auto right = noise(n, 12);
    std::vector<Segment> segs;
    double cursor = 0;
    for (int bar = 0; bar < 150; ++bar)
    {
        const double barEnd = 0.5 + (bar + 1) * 2 - 0.02;
        segs.push_back({cursor, barEnd - 0.25});
        cursor = barEnd;
    }
    segs.push_back({cursor, 300});
    const float* ptrs[2] = {left.data(), right.data()};
    std::vector<std::vector<float>> out;
    renderSegments(ptrs, 2, n, sr, {{0, 1}, {2, 3}}, 0.01, 0, "smooth", out);   // calentamiento
    double best = 1e9;
    for (int rep = 0; rep < 3; ++rep)
    {
        const auto t0 = std::chrono::steady_clock::now();
        renderSegments(ptrs, 2, n, sr, segs, 0.01, 4, "smooth", out);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        best = std::min(best, ms);
    }
    MESSAGE("renderSegments 5 min estéreo 48 kHz, 150 empalmes: " << best << " ms (mejor de 3)");
    CHECK(static_cast<std::int64_t>(out[0].size()) == expectedLength(segs, sr));
#ifdef NDEBUG
    CHECK(best < 250);   // objetivo < 100 ms; margen para máquinas de CI cargadas
#endif
}
}
