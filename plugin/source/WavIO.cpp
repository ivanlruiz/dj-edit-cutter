#include "WavIO.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <cmath>
#include <cstring>

namespace djec::plugin::wav
{

namespace
{
constexpr std::uint32_t kDitherSeed = 0x9e3779b9u;

void put16(juce::MemoryOutputStream& o, std::uint32_t v)
{
    o.writeByte(static_cast<char>(v & 0xff));
    o.writeByte(static_cast<char>((v >> 8) & 0xff));
}
void put32(juce::MemoryOutputStream& o, std::uint32_t v)
{
    put16(o, v & 0xffff);
    put16(o, v >> 16);
}

std::uint32_t xorshift(std::uint32_t s)
{
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

// writePcm16 de la web: y = x·32768 + r1 − r2, recorte, NaN → 0, redondeo al más cercano (mitades lejos del 0)
std::int32_t pcm16(float x, std::uint32_t& s)
{
    if (std::fpclassify(x) == FP_ZERO)   // el silencio digital queda en 0 (sin dither), como la web
        return 0;
    s = xorshift(s);
    const double r1 = static_cast<double>(s) / 4294967296.0;
    s = xorshift(s);
    const double r2 = static_cast<double>(s) / 4294967296.0;
    double y = static_cast<double>(x) * 32768 + r1 - r2;
    if (y > 32767)
        y = 32767;
    else if (y < -32768)
        y = -32768;
    else if (std::isnan(y))
        y = 0;
    return y >= 0 ? static_cast<std::int32_t>(y + 0.5) : -static_cast<std::int32_t>(0.5 - y);
}

std::int32_t pcm24(float x)
{
    double y = static_cast<double>(x) * 8388608;
    if (y > 8388607)
        y = 8388607;
    else if (y < -8388608)
        y = -8388608;
    else if (std::isnan(y))
        y = 0;
    return y >= 0 ? static_cast<std::int32_t>(y + 0.5) : -static_cast<std::int32_t>(0.5 - y);
}
} // namespace

juce::Result write(const juce::File& file, const float* const* channels, int numChannels, std::int64_t frames,
                   double sampleRate, Format format)
{
    if (numChannels <= 0 || channels == nullptr)
        return juce::Result::fail("No hay audio para guardar.");
    const auto sr = static_cast<std::uint32_t>(std::llround(sampleRate));
    if (!(sampleRate > 0) || sr == 0)
        return juce::Result::fail(juce::String::fromUTF8("Frecuencia de muestreo no válida."));
    frames = std::max<std::int64_t>(0, frames);
    const int bits = format == Format::Pcm16 ? 16 : format == Format::Pcm24 ? 24 : 32;
    const std::uint32_t bytesPerSample = static_cast<std::uint32_t>(bits / 8);
    const std::uint32_t blockAlign = static_cast<std::uint32_t>(numChannels) * bytesPerSample;
    const std::uint64_t dataBytes = static_cast<std::uint64_t>(frames) * blockAlign;
    const std::uint64_t total = 12 + 8 + 16 + 8 + dataBytes + (dataBytes & 1);
    if (total - 8 > 0xffffffffull)
        return juce::Result::fail(juce::String::fromUTF8("El archivo WAV superaría el límite de 4 GB."));

    if (!file.getParentDirectory().createDirectory())
        return juce::Result::fail(juce::String::fromUTF8("No pude crear la carpeta ") +
                                  file.getParentDirectory().getFullPathName());

    juce::TemporaryFile temp(file);
    {
        juce::FileOutputStream out(temp.getFile());
        if (!out.openedOk())
            return juce::Result::fail(juce::String::fromUTF8("No pude escribir ") + file.getFullPathName());
        juce::MemoryOutputStream h;
        h.write("RIFF", 4);
        put32(h, static_cast<std::uint32_t>(total - 8));
        h.write("WAVE", 4);
        h.write("fmt ", 4);
        put32(h, 16);
        put16(h, format == Format::Float32 ? 3u : 1u);
        put16(h, static_cast<std::uint32_t>(numChannels));
        put32(h, sr);
        put32(h, sr * blockAlign);
        put16(h, blockAlign);
        put16(h, static_cast<std::uint32_t>(bits));
        h.write("data", 4);
        put32(h, static_cast<std::uint32_t>(dataBytes));
        out.write(h.getData(), h.getDataSize());

        constexpr std::int64_t kBlock = 1 << 15;
        std::vector<std::uint8_t> buf(static_cast<std::size_t>(kBlock * blockAlign));
        std::uint32_t rng = kDitherSeed;
        for (std::int64_t a = 0; a < frames; a += kBlock)
        {
            const std::int64_t b = std::min(frames, a + kBlock);
            std::uint8_t* d = buf.data();
            for (std::int64_t i = a; i < b; ++i)
                for (int c = 0; c < numChannels; ++c)
                {
                    const float x = channels[c][i];
                    if (format == Format::Pcm16)
                    {
                        const std::int32_t v = pcm16(x, rng);
                        d[0] = static_cast<std::uint8_t>(v & 0xff);
                        d[1] = static_cast<std::uint8_t>((v >> 8) & 0xff);
                        d += 2;
                    }
                    else if (format == Format::Pcm24)
                    {
                        const std::int32_t v = pcm24(x);
                        d[0] = static_cast<std::uint8_t>(v & 0xff);
                        d[1] = static_cast<std::uint8_t>((v >> 8) & 0xff);
                        d[2] = static_cast<std::uint8_t>((v >> 16) & 0xff);
                        d += 3;
                    }
                    else
                    {
                        std::uint32_t u;
                        std::memcpy(&u, &x, 4);
                        d[0] = static_cast<std::uint8_t>(u & 0xff);
                        d[1] = static_cast<std::uint8_t>((u >> 8) & 0xff);
                        d[2] = static_cast<std::uint8_t>((u >> 16) & 0xff);
                        d[3] = static_cast<std::uint8_t>((u >> 24) & 0xff);
                        d += 4;
                    }
                }
            if (!out.write(buf.data(), static_cast<std::size_t>(d - buf.data())))
                return juce::Result::fail(juce::String::fromUTF8("No pude escribir ") + file.getFullPathName() +
                                          juce::String::fromUTF8(" (¿disco lleno?)"));
        }
        if (dataBytes & 1)
            out.writeByte(0);
        out.flush();
        if (out.getStatus().failed())
            return juce::Result::fail(juce::String::fromUTF8("No pude escribir ") + file.getFullPathName() + ": " +
                                      out.getStatus().getErrorMessage());
    }
    if (!temp.overwriteTargetFileWithTemporary())
        return juce::Result::fail(juce::String::fromUTF8("No pude guardar ") + file.getFullPathName());
    return juce::Result::ok();
}

juce::Result read(const juce::File& file, Audio& out)
{
    out = Audio{};
    if (!file.existsAsFile())
        return juce::Result::fail(juce::String::fromUTF8("No encontré ") + file.getFullPathName());
    juce::WavAudioFormat fmt;
    auto stream = std::make_unique<juce::FileInputStream>(file);
    if (!stream->openedOk())
        return juce::Result::fail(juce::String::fromUTF8("No pude abrir ") + file.getFullPathName());
    std::unique_ptr<juce::AudioFormatReader> reader(fmt.createReaderFor(stream.release(), true));
    if (reader == nullptr)
        return juce::Result::fail(file.getFileName() + juce::String::fromUTF8(" no es un WAV válido."));
    const auto n = static_cast<std::int64_t>(reader->lengthInSamples);
    const int nCh = static_cast<int>(reader->numChannels);
    if (nCh <= 0)
        return juce::Result::fail(file.getFileName() + juce::String::fromUTF8(" no tiene audio."));
    out.sampleRate = reader->sampleRate;
    out.channels.assign(static_cast<std::size_t>(nCh), std::vector<float>(static_cast<std::size_t>(n)));
    std::vector<float*> ptrs;
    for (auto& c : out.channels)
        ptrs.push_back(c.data());
    constexpr std::int64_t kBlock = 1 << 18;
    for (std::int64_t a = 0; a < n; a += kBlock)
    {
        const int len = static_cast<int>(std::min(kBlock, n - a));
        std::vector<float*> dst;
        for (auto* p : ptrs)
            dst.push_back(p + a);
        if (!reader->read(dst.data(), nCh, a, len))
            return juce::Result::fail(juce::String::fromUTF8("No pude leer ") + file.getFullPathName());
    }
    return juce::Result::ok();
}

std::uint64_t hashAudio(const float* const* channels, int numChannels, std::int64_t frames)
{
    std::uint64_t h = 1469598103934665603ull;
    for (int c = 0; c < numChannels; ++c)
    {
        const float* x = channels[c];
        for (std::int64_t i = 0; i < frames; ++i)
        {
            std::uint32_t u;
            std::memcpy(&u, x + i, 4);
            h ^= u;
            h *= 1099511628211ull;
        }
        h ^= static_cast<std::uint64_t>(c + 1) * static_cast<std::uint64_t>(0x9e3779b97f4a7c15ull);
    }
    h ^= static_cast<std::uint64_t>(frames);
    return h;
}

} // namespace djec::plugin::wav
