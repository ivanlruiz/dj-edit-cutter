// Paridad del port C++ del análisis con la implementación web (js/analysis/*, js/audio/decode.js).
// Datos: plugin/tools/golden-analysis.mjs → <DJEC_GOLDEN_DIR>/analysis/ (variable de entorno o definición de
// compilación). Si no están, los tests se saltan con un mensaje.
#include "doctest.h"

#include "djec/analysis.h"
#include "djec/resample.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace
{

// ------------------------------------------------------------------------------------------ JSON mínimo

struct Json
{
    enum class T
    {
        Null,
        Bool,
        Num,
        Str,
        Arr,
        Obj
    } t = T::Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Json> a;
    std::map<std::string, Json> o;

    const Json& operator[](const std::string& k) const
    {
        static const Json null;
        auto it = o.find(k);
        return it == o.end() ? null : it->second;
    }
    bool has(const std::string& k) const { return o.count(k) != 0; }
    double num() const { return t == T::Num ? n : std::nan(""); }
    int i() const { return static_cast<int>(std::lround(n)); }
    std::vector<double> nums() const
    {
        std::vector<double> v;
        for (const auto& e : a)
            v.push_back(e.num());
        return v;
    }
    std::vector<int> ints() const
    {
        std::vector<int> v;
        for (const auto& e : a)
            v.push_back(e.i());
        return v;
    }
};

class JsonParser
{
public:
    explicit JsonParser(const std::string& text) : s_(text) {}
    Json parse()
    {
        Json v = value();
        ws();
        return v;
    }

private:
    void ws()
    {
        while (p_ < s_.size() && (s_[p_] == ' ' || s_[p_] == '\n' || s_[p_] == '\r' || s_[p_] == '\t'))
            ++p_;
    }
    Json value()
    {
        ws();
        Json v;
        if (p_ >= s_.size())
            return v;
        const char c = s_[p_];
        if (c == '{')
        {
            v.t = Json::T::Obj;
            ++p_;
            ws();
            if (s_[p_] == '}')
            {
                ++p_;
                return v;
            }
            for (;;)
            {
                ws();
                const std::string k = str();
                ws();
                ++p_; // ':'
                v.o[k] = value();
                ws();
                if (s_[p_] == ',')
                {
                    ++p_;
                    continue;
                }
                ++p_; // '}'
                break;
            }
        }
        else if (c == '[')
        {
            v.t = Json::T::Arr;
            ++p_;
            ws();
            if (s_[p_] == ']')
            {
                ++p_;
                return v;
            }
            for (;;)
            {
                v.a.push_back(value());
                ws();
                if (s_[p_] == ',')
                {
                    ++p_;
                    continue;
                }
                ++p_; // ']'
                break;
            }
        }
        else if (c == '"')
        {
            v.t = Json::T::Str;
            v.s = str();
        }
        else if (s_.compare(p_, 4, "true") == 0)
        {
            v.t = Json::T::Bool;
            v.b = true;
            p_ += 4;
        }
        else if (s_.compare(p_, 5, "false") == 0)
        {
            v.t = Json::T::Bool;
            p_ += 5;
        }
        else if (s_.compare(p_, 4, "null") == 0)
            p_ += 4;
        else
        {
            v.t = Json::T::Num;
            const char* begin = s_.c_str() + p_;
            char* end = nullptr;
            v.n = std::strtod(begin, &end);
            p_ += static_cast<std::size_t>(end - begin);
        }
        return v;
    }
    std::string str()
    {
        std::string out;
        ++p_; // '"'
        while (p_ < s_.size() && s_[p_] != '"')
        {
            if (s_[p_] == '\\' && p_ + 1 < s_.size())
            {
                ++p_;
                const char e = s_[p_];
                if (e == 'u')
                {
                    out += '?';
                    p_ += 4;
                }
                else
                    out += (e == 'n' ? '\n' : e == 't' ? '\t' : e);
            }
            else
                out += s_[p_];
            ++p_;
        }
        ++p_;
        return out;
    }
    const std::string& s_;
    std::size_t p_ = 0;
};

// ------------------------------------------------------------------------------------------ datos golden

std::string envVar(const char* name)
{
#ifdef _MSC_VER
    char* buf = nullptr;
    std::size_t len = 0;
    std::string v;
    if (_dupenv_s(&buf, &len, name) == 0 && buf)
        v = buf;
    std::free(buf);
    return v;
#else
    const char* v = std::getenv(name);
    return v ? v : "";
#endif
}

std::string goldenRoot()
{
    const std::string env = envVar("DJEC_GOLDEN_DIR");
    if (!env.empty())
        return env;
#ifdef DJEC_GOLDEN_DIR
    return DJEC_GOLDEN_DIR;
#else
    return "";
#endif
}

std::string analysisDir() { return goldenRoot() + "/analysis"; }

bool readText(const std::string& path, std::string& out)
{
    std::ifstream f(path, std::ios::binary);
    if (!f)
        return false;
    std::stringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

Json loadJson(const std::string& name)
{
    std::string text;
    REQUIRE_MESSAGE(readText(analysisDir() + "/" + name, text), "no se pudo leer " << name);
    return JsonParser(text).parse();
}

std::vector<float> loadF32(const std::string& name)
{
    std::ifstream f(analysisDir() + "/" + name, std::ios::binary | std::ios::ate);
    REQUIRE_MESSAGE(bool(f), "no se pudo leer " << name);
    const std::streamsize bytes = f.tellg();
    f.seekg(0);
    std::vector<float> v(static_cast<std::size_t>(bytes) / sizeof(float));
    if (bytes > 0)
        f.read(reinterpret_cast<char*>(v.data()), bytes);
    return v;
}

/** ¿Hay datos golden? Si no, avisa y el test se salta. */
bool haveGolden()
{
    std::string text;
    if (goldenRoot().empty())
    {
        MESSAGE("SKIP: paridad del análisis sin datos golden (define DJEC_GOLDEN_DIR y genera con: "
                "node plugin/tools/golden-analysis.mjs <build>/golden)");
        return false;
    }
    if (!readText(analysisDir() + "/index.json", text))
    {
        MESSAGE("SKIP: no hay datos golden del análisis en '" << analysisDir()
                                                               << "' (genera con: node plugin/tools/golden-analysis.mjs <build>/golden)");
        return false;
    }
    return true;
}

// ------------------------------------------------------------------------------------------ comparación

struct Stats
{
    double maxBeatErr = 0;    // s
    double maxStrengthErr = 0;
    double maxBoundErr = 0;   // s (musicStart/musicEnd/lastOnset)
    double maxConfErr = 0;
    double maxBpmErr = 0;
    bool exactBeats = true;
    int cases = 0;
};

void compareResult(const Json& js, const djec::AnalysisResult& r, const std::string& label, Stats& st)
{
    INFO("caso: " << label);
    st.cases++;
    const std::vector<double> beats = js["beats"].nums();
    CHECK_MESSAGE(r.beats.size() == beats.size(), label << ": beats C++ " << r.beats.size() << " vs JS " << beats.size());
    double maxErr = 0;
    if (r.beats.size() == beats.size())
        for (std::size_t i = 0; i < beats.size(); ++i)
        {
            const double e = std::fabs(r.beats[i] - beats[i]);
            maxErr = std::max(maxErr, e);
            if (r.beats[i] != beats[i])
                st.exactBeats = false;
        }
    else
        st.exactBeats = false;
    CHECK_MESSAGE(maxErr <= 0.001, label << ": error máximo de beat " << maxErr * 1000 << " ms");
    st.maxBeatErr = std::max(st.maxBeatErr, maxErr);

    const std::vector<double> strength = js["beatStrength"].nums();
    if (strength.size() == r.beatStrength.size())
        for (std::size_t i = 0; i < strength.size(); ++i)
            st.maxStrengthErr = std::max(st.maxStrengthErr, std::fabs(strength[i] - r.beatStrength[i]));

    CHECK(r.downbeats == js["downbeats"].ints());
    CHECK(r.positions == js["positions"].ints());
    CHECK(r.beatsPerBar == js["beatsPerBar"].i());
    CHECK(r.meterAuto == js["meterAuto"].b);
    CHECK(r.forcedDownbeats == js["forcedDownbeats"].ints());
    CHECK(r.tailBeatsFrom == js["tailBeatsFrom"].i());

    const double bpmErr = std::max({std::fabs(r.bpm - js["bpm"].num()), std::fabs(r.bpmLo - js["bpmRange"].a[0].num()),
                                    std::fabs(r.bpmHi - js["bpmRange"].a[1].num())});
    CHECK_MESSAGE(bpmErr <= 0.05, label << ": bpm C++ " << r.bpm << " [" << r.bpmLo << ", " << r.bpmHi << "] vs JS "
                                        << js["bpm"].num());
    st.maxBpmErr = std::max(st.maxBpmErr, bpmErr);

    CHECK(std::fabs(r.duration - js["duration"].num()) <= 1e-9);
    const double boundErr = std::max({std::fabs(r.musicStart - js["musicStart"].num()), std::fabs(r.musicEnd - js["musicEnd"].num()),
                                      std::fabs(r.lastOnset - js["lastOnset"].num())});
    CHECK_MESSAGE(boundErr <= 0.005, label << ": musicStart/musicEnd/lastOnset difieren " << boundErr * 1000 << " ms");
    st.maxBoundErr = std::max(st.maxBoundErr, boundErr);

    const double confErr = std::max(std::fabs(r.confBeats - js["confidence"]["beats"].num()),
                                    std::fabs(r.confBars - js["confidence"]["bars"].num()));
    CHECK_MESSAGE(confErr <= 0.02, label << ": confianza C++ " << r.confBeats << "/" << r.confBars << " vs JS "
                                         << js["confidence"]["beats"].num() << "/" << js["confidence"]["bars"].num());
    st.maxConfErr = std::max(st.maxConfErr, confErr);
}

std::string fmtStats(const Stats& s)
{
    char buf[400];
    std::snprintf(buf, sizeof buf,
                  "%d resultados: beats %s (error máx. %.3g ms), fuerza máx. %.3g, bpm máx. %.3g, límites máx. %.3g ms, "
                  "confianza máx. %.3g",
                  s.cases, s.exactBeats ? "idénticos bit a bit" : "no idénticos", s.maxBeatErr * 1000, s.maxStrengthErr, s.maxBpmErr,
                  s.maxBoundErr * 1000, s.maxConfErr);
    return buf;
}

double seconds(std::chrono::steady_clock::time_point a, std::chrono::steady_clock::time_point b)
{
    return std::chrono::duration<double>(b - a).count();
}

} // namespace

TEST_CASE("analysis parity: analyze() da lo mismo que la web en la suite sintética, variantes y bordes")
{
    if (!haveGolden())
        return;
    const Json index = loadJson("index.json");
    Stats st;
    for (const Json& c : index["cases"].a)
    {
        const std::string name = c["name"].s;
        const std::vector<float> x = loadF32(c["file"].s);
        REQUIRE(x.size() == static_cast<std::size_t>(c["n"].num()));
        const Json g = loadJson(c["json"].s);
        djec::Analyzer an;
        const auto t0 = std::chrono::steady_clock::now();
        const djec::AnalysisResult r = an.analyze(x.data(), x.size(), c["sampleRate"].num());
        const auto t1 = std::chrono::steady_clock::now();
        compareResult(g["result"], r, name, st);
        MESSAGE(name << ": " << r.beats.size() << " beats, " << r.bpm << " BPM, " << r.beatsPerBar << "/4, C++ "
                     << int(seconds(t0, t1) * 1000) << " ms (JS " << g["jsMs"].num() << " ms)");
    }
    MESSAGE("analyze(): " << fmtStats(st));
}

TEST_CASE("analysis parity: retrack (×2, ÷2, tempo manual, restablecer) y relabel (compás, \"1\" forzado)")
{
    if (!haveGolden())
        return;
    const Json index = loadJson("index.json");
    Stats st;
    for (const Json& s : index["sessions"].a)
    {
        const Json g = loadJson(s["json"].s);
        const std::vector<float> x = loadF32(s["file"].s);
        djec::Analyzer an;
        compareResult(g["first"], an.analyze(x.data(), x.size(), 22050), s["name"].s + " (análisis)", st);
        int k = 0;
        for (const Json& step : g["steps"].a)
        {
            djec::AnalysisResult r;
            std::string label = s["name"].s + " paso " + std::to_string(++k) + " " + step["op"].s;
            if (step["op"].s == "retrack")
            {
                const double hint = step["bpmHint"].num();
                label += " bpmHint=" + std::to_string(hint) + (step["strict"].b ? " strict" : "");
                r = an.retrack(hint > 0 ? hint : 0, step["strict"].b);
            }
            else
            {
                label += " compás=" + std::to_string(step["beatsPerBar"].i());
                r = an.relabel(step["beatsPerBar"].i(), step["forced"].ints());
            }
            compareResult(step["result"], r, label, st);
        }
    }
    MESSAGE("retrack/relabel: " << fmtStats(st));
}

TEST_CASE("analysis parity: toAnalysisMono (remuestreo sinc·Kaiser + mezcla) igual que la web")
{
    if (!haveGolden())
        return;
    const Json index = loadJson("index.json");
    double worst = 0;
    for (const Json& c : index["resample"].a)
    {
        const std::vector<float> in = loadF32(c["input"].s);
        const std::vector<float> expect = loadF32(c["output"].s);
        const int nCh = c["channels"].i();
        const std::size_t n = static_cast<std::size_t>(c["n"].num());
        REQUIRE(in.size() == n * static_cast<std::size_t>(nCh));
        std::vector<const float*> ch;
        for (int i = 0; i < nCh; ++i)
            ch.push_back(in.data() + static_cast<std::size_t>(i) * n);
        const std::vector<float> out = djec::toAnalysisMono(ch.data(), nCh, n, c["rate"].num());
        REQUIRE(out.size() == expect.size());
        double maxDiff = 0;
        std::size_t exact = 0;
        for (std::size_t i = 0; i < out.size(); ++i)
        {
            maxDiff = std::max(maxDiff, double(std::fabs(out[i] - expect[i])));
            exact += out[i] == expect[i];
        }
        CHECK_MESSAGE(maxDiff < 1e-4, c["name"].s << ": diferencia máxima " << maxDiff);
        MESSAGE("toAnalysisMono " << c["name"].s << " (" << nCh << " canales, " << c["rate"].num() << " Hz → 22050): "
                                  << out.size() << " muestras, diferencia máx. " << maxDiff << ", idénticas " << exact << "/"
                                  << out.size());
        worst = std::max(worst, maxDiff);
    }
    MESSAGE("toAnalysisMono: diferencia máxima en todos los casos " << worst);
}

TEST_CASE("analysis parity: cadena del plugin (estéreo 44.1/48 kHz → toAnalysisMono → analyze)")
{
    if (!haveGolden())
        return;
    const Json index = loadJson("index.json");
    Stats st;
    for (const Json& c : index["pipeline"].a)
    {
        const std::vector<float> in = loadF32(c["input"].s);
        const std::vector<float> monoJs = loadF32(c["mono"].s);
        const std::size_t n = static_cast<std::size_t>(c["n"].num());
        REQUIRE(in.size() == 2 * n);
        const float* ch[2] = {in.data(), in.data() + n};
        const std::vector<float> mono = djec::toAnalysisMono(ch, 2, n, c["rate"].num());
        REQUIRE(mono.size() == monoJs.size());
        double maxDiff = 0;
        for (std::size_t i = 0; i < mono.size(); ++i)
            maxDiff = std::max(maxDiff, double(std::fabs(mono[i] - monoJs[i])));
        CHECK(maxDiff < 1e-4);
        const Json g = loadJson(c["json"].s);
        djec::Analyzer an;
        compareResult(g["result"], an.analyze(mono.data(), mono.size(), 22050), c["name"].s, st);
        MESSAGE(c["name"].s << ": mono diferencia máx. " << maxDiff);
    }
    MESSAGE("cadena: " << fmtStats(st));
}

TEST_CASE("analysis performance: canción de 4:30 (long_song_4m30)")
{
    if (!haveGolden())
        return;
    const std::vector<float> x = loadF32("long_song_4m30.f32");
    djec::Analyzer an;
    double best = 1e9;
    for (int rep = 0; rep < 2; ++rep)
    {
        const auto t0 = std::chrono::steady_clock::now();
        an.analyze(x.data(), x.size(), 22050);
        best = std::min(best, seconds(t0, std::chrono::steady_clock::now()));
    }
    const auto& tm = an.lastTimings();
    MESSAGE("4:36 de audio analizado en " << best << " s (características " << tm.features << " ms, tempo " << tm.tempo
                                          << " ms, beats " << tm.beats << " ms, compases " << tm.bars << " ms)");
#ifdef NDEBUG
    CHECK(best < 2.0);
#endif
}
