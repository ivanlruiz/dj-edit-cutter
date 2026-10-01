// Cuadrícula de FL → AnalysisResult (gridFromHost). Ver djec/grid.h.
#include "djec/grid.h"

#include "djec/bars.h"

#include <algorithm>
#include <cmath>
#include <map>

namespace djec
{

namespace
{
constexpr double kEdgeTolSec = 0.005;   // un "1" hasta 5 ms fuera de la toma se pega al borde
constexpr double kIndexEps = 1e-9;      // tolerancia en "número de beat" para los bordes de cada tramo

double jsRound(double x)
{
    if (!std::isfinite(x))
        return x;
    const double f = std::floor(x);
    return (x - f >= 0.5) ? f + 1.0 : f;
}

bool validDen(int d)
{
    return d == 2 || d == 4 || d == 8 || d == 16;
}

struct Anchor
{
    double off;        // muestra de la toma
    double ppq;
    double bpm;        // negras por minuto (> 0)
    int num, den;
    double barStart;   // ppq del inicio de compás
    bool bpmKnown;
};

struct RawBeat
{
    double t;          // s
    int pos;
    int num;
    double beatSec;    // duración de un beat en ese tramo
};

double percentile(std::vector<double> v, double q)
{
    if (v.empty())
        return 0;
    std::sort(v.begin(), v.end());
    const double idx = q * static_cast<double>(v.size() - 1);
    const std::size_t i = static_cast<std::size_t>(std::floor(idx));
    const std::size_t j = std::min(v.size() - 1, i + 1);
    const double f = idx - static_cast<double>(i);
    return v[i] + (v[j] - v[i]) * f;
}
} // namespace

AnalysisResult gridFromHost(const CaptureInfo& capture, int barOffsetBeats, HostGridMeta* meta)
{
    AnalysisResult res;
    HostGridMeta m;
    const double sr = capture.sampleRate;
    const bool srOk = sr > 0 && std::isfinite(sr);
    const double duration = srOk ? static_cast<double>(capture.numSamples) / sr : 0;
    res.duration = duration;
    res.musicStart = 0;
    res.musicEnd = duration;
    res.lastOnset = duration;
    res.meterAuto = false;
    res.confBeats = 1;
    res.confBars = 1;
    res.tailBeatsFrom = -1;
    res.beatsPerBar = 4;

    // ---- anclas válidas, por muestra de la toma (si se repite la muestra, vale la última) ----
    std::vector<Anchor> anchors;
    if (srOk && capture.numSamples > 0)
    {
        std::vector<std::pair<std::int64_t, HostBlockInfo>> blocks = capture.blocks;
        std::stable_sort(blocks.begin(), blocks.end(),
                         [](const auto& a, const auto& b) { return a.first < b.first; });
        for (const auto& [off, info] : blocks)
        {
            const bool bpmOk = info.bpm > 0 && std::isfinite(info.bpm);
            double ppq;
            if (info.ppqValid && std::isfinite(info.ppq))
                ppq = info.ppq;
            else if (bpmOk)
                ppq = static_cast<double>(info.hostSample) / sr * info.bpm / 60;   // tempo constante desde 0
            else
                continue;
            Anchor a;
            a.off = static_cast<double>(off);
            a.ppq = ppq;
            a.bpm = bpmOk ? info.bpm : 0;
            a.bpmKnown = bpmOk;
            a.num = info.tsNum >= 1 && info.tsNum <= 64 ? info.tsNum : 4;
            a.den = validDen(info.tsDen) ? info.tsDen : 4;
            const double barLen = a.num * 4.0 / a.den;
            if (info.barValid && std::isfinite(info.lastBarStartPpq))
                a.barStart = info.lastBarStartPpq;
            else
                a.barStart = std::floor(ppq / barLen + 1e-9) * barLen;   // compases desde ppq 0
            if (!anchors.empty() && anchors.back().off == a.off)
                anchors.back() = a;
            else
                anchors.push_back(a);
        }
    }
    if (anchors.empty())
    {
        if (meta)
            *meta = m;
        return res;
    }

    // Tempo desconocido en un ancla: el del ancla conocida más cercana (o 120 si no hay ninguna)
    {
        double lastKnown = 0;
        for (const Anchor& a : anchors)
            if (a.bpmKnown)
            {
                lastKnown = a.bpm;
                break;
            }
        if (!(lastKnown > 0))
            lastKnown = 120;
        for (Anchor& a : anchors)
        {
            if (a.bpmKnown)
                lastKnown = a.bpm;
            else
                a.bpm = lastKnown;
        }
    }

    // ---- mapa ppq ↔ muestra por tramos ----
    const std::size_t nA = anchors.size();
    std::vector<double> spp(nA);       // muestras por negra en el tramo i
    std::vector<double> ppqEnd(nA);    // ppq al final del tramo i (el siguiente ancla si es coherente)
    for (std::size_t i = 0; i < nA; ++i)
    {
        const Anchor& a = anchors[i];
        const double nominal = 60 * sr / a.bpm;
        spp[i] = nominal;
        ppqEnd[i] = 0;
        if (i + 1 < nA)
        {
            const Anchor& b = anchors[i + 1];
            const double dOff = b.off - a.off;
            const double predicted = dOff / nominal;
            const double actual = b.ppq - a.ppq;
            // coherente: avanzó lo que dice el tempo (±5 %); si no (salto, bucle), se extrapola con el tempo del tramo
            if (actual > 0 && std::fabs(actual - predicted) <= 0.05 * predicted + 1e-6)
            {
                spp[i] = dOff / actual;
                ppqEnd[i] = b.ppq;
            }
            else
                ppqEnd[i] = a.ppq + predicted;
        }
    }
    auto ppqAt = [&](std::size_t i, double sample) { return anchors[i].ppq + (sample - anchors[i].off) / spp[i]; };

    const double total = static_cast<double>(capture.numSamples);
    const double tolSamples = kEdgeTolSec * sr;

    // ---- beats tramo a tramo ----
    std::vector<RawBeat> raw;
    std::map<std::pair<int, int>, std::size_t> meterCount;   // (num, den) → beats (para el compás dominante)
    for (std::size_t i = 0; i < nA; ++i)
    {
        const Anchor& a = anchors[i];
        const bool first = i == 0;
        const bool last = i + 1 == nA;
        const double segStart = first ? -tolSamples : a.off;
        if (!last && anchors[i + 1].off <= -tolSamples)
            continue;   // tramo entero antes de la toma
        if (segStart > total + tolSamples)
            break;
        const double ppqLo = first ? ppqAt(i, segStart) : a.ppq;
        const double ppqHi = last ? ppqAt(i, total + tolSamples) : ppqEnd[i];
        if (!(ppqHi > ppqLo))
            continue;
        const double beatLen = 4.0 / a.den;
        const double beatSec = beatLen * spp[i] / sr;
        const long long kFirst = static_cast<long long>(std::ceil((ppqLo - a.barStart) / beatLen - kIndexEps));
        long long kEnd = static_cast<long long>(std::ceil((ppqHi - a.barStart) / beatLen - kIndexEps));   // exclusivo
        if (last)   // el borde final (total + tol) también vale
            kEnd = static_cast<long long>(std::floor((ppqHi - a.barStart) / beatLen + kIndexEps)) + 1;
        for (long long k = kFirst; k < kEnd; ++k)
        {
            const double p = a.barStart + static_cast<double>(k) * beatLen;
            const double sample = a.off + (p - a.ppq) * spp[i];
            const long long rel = k - barOffsetBeats;
            const int pos = static_cast<int>(((rel % a.num) + a.num) % a.num);
            raw.push_back(RawBeat{sample / sr, pos, a.num, beatSec});
            meterCount[{a.num, a.den}]++;
        }
    }

    // ---- limpieza: bordes, orden y duplicados (dos tramos que ven el mismo beat) ----
    for (const RawBeat& b : raw)
    {
        double t = b.t;
        // a menos de media muestra del borde = en el borde
        if (std::fabs(t) < 0.5 / sr)
            t = 0;
        else if (std::fabs(t - duration) < 0.5 / sr)
            t = duration;
        if (t < 0)
        {
            if (b.pos != 0 || t < -kEdgeTolSec - 1e-12)
                continue;
            t = 0;
        }
        else if (t > duration)
        {
            if (b.pos != 0 || t > duration + kEdgeTolSec + 1e-12)
                continue;
            t = duration;
        }
        if (!res.beats.empty())
        {
            const double prev = res.beats.back();
            if (t <= prev + 0.25 * b.beatSec)
            {
                // el mismo beat visto desde dos tramos: se queda el primero (salvo que este sea un "1")
                if (b.pos == 0 && res.positions.back() != 0 && t >= prev)
                {
                    res.beats.back() = t;
                    res.positions.back() = 0;
                }
                continue;
            }
        }
        res.beats.push_back(t);
        res.positions.push_back(b.pos);
    }

    const std::size_t nB = res.beats.size();
    res.beatStrength.assign(nB, 1.0);
    for (std::size_t i = 0; i < nB; ++i)
        if (res.positions[i] == 0)
            res.downbeats.push_back(static_cast<int>(i));

    // compás dominante
    int bestNum = anchors.front().num, bestDen = anchors.front().den;
    std::size_t bestCount = 0;
    for (const auto& [md, count] : meterCount)
        if (count > bestCount)
        {
            bestCount = count;
            bestNum = md.first;
            bestDen = md.second;
        }
    res.beatsPerBar = bestNum;

    // tempo en beats de la cuadrícula por minuto
    std::vector<double> local;
    for (std::size_t i = 1; i < nB; ++i)
    {
        const double d = res.beats[i] - res.beats[i - 1];
        if (d > 0)
            local.push_back(60 / d);
    }
    if (!local.empty())
    {
        res.bpm = jsRound(percentile(local, 0.5) * 10) / 10;
        res.bpmLo = percentile(local, 0.1);
        res.bpmHi = percentile(local, 0.9);
    }
    else
    {
        res.bpm = jsRound(anchors.front().bpm * anchors.front().den / 4 * 10) / 10;
        res.bpmLo = res.bpmHi = res.bpm;
    }

    m.valid = true;
    m.tsNum = bestNum;
    m.tsDen = bestDen;
    m.hostBpm = anchors.front().bpm;
    for (std::size_t i = 1; i < nA; ++i)
    {
        if (std::fabs(anchors[i].bpm - anchors[0].bpm) > 1e-9)
            m.tempoChanges = true;
        if (anchors[i].num != anchors[0].num || anchors[i].den != anchors[0].den)
            m.meterChanges = true;
        else
        {
            // el mismo compás pero con otra fase (un "1" corrido) también es un cambio de compás
            const double barLen = anchors[i].num * 4.0 / anchors[i].den;
            const double ph = std::fmod(anchors[i].barStart - anchors[0].barStart, barLen);
            if (std::fabs(ph) > 1e-6 && std::fabs(std::fabs(ph) - barLen) > 1e-6)
                m.meterChanges = true;
        }
    }
    // ppq al principio y al final de la toma (tramo = último ancla con off <= muestra; antes del primero, el primero)
    auto segFor = [&](double sample) {
        std::size_t i = 0;
        while (i + 1 < nA && anchors[i + 1].off <= sample)
            ++i;
        return i;
    };
    m.ppqStart = ppqAt(segFor(0), 0);
    m.ppqEnd = ppqAt(segFor(total), total);
    if (meta)
        *meta = m;
    return res;
}

void applyMusicBounds(AnalysisResult& grid, double musicStart, double musicEnd, double lastOnset)
{
    const double dur = std::isfinite(grid.duration) && grid.duration > 0 ? grid.duration : 0;
    if (!(dur > 0) || !std::isfinite(musicStart) || !std::isfinite(musicEnd) || !std::isfinite(lastOnset))
        return;
    auto clamp = [dur](double x) { return std::min(dur, std::max(0.0, x)); };
    const double ms = clamp(musicStart);
    const double me = clamp(musicEnd);
    const double lo = clamp(lastOnset);
    if (!(me > ms))
        return;   // sin música: todo sigue contando (nada que buscar)
    // duración de un beat al final (la mediana de los últimos intervalos; sin beats, nada que comparar)
    double beatSec = 0;
    {
        std::vector<double> d;
        const std::size_t n = grid.beats.size();
        for (std::size_t i = n > 9 ? n - 9 : 1; i < n; ++i)
            if (grid.beats[i] > grid.beats[i - 1])
                d.push_back(grid.beats[i] - grid.beats[i - 1]);
        if (!d.empty())
        {
            std::sort(d.begin(), d.end());
            beatSec = d[d.size() / 2];
        }
    }
    const bool continues = beatSec > 0 && me >= dur - kMusicContinuesSec && lo >= dur - beatSec - kLastBarTolerance;
    grid.musicStart = ms;
    grid.musicEnd = continues ? dur : me;
    grid.lastOnset = continues ? dur : lo;
}

} // namespace djec
