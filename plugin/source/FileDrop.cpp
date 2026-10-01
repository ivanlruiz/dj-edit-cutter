#include "FileDrop.h"

#include "djec/resample.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <cmath>

namespace djec::plugin::filedrop
{

namespace
{
/**
 * Formatos que JUCE sabe leer. Uno nuevo en cada llamada (es barato): un AudioFormatManager estático se destruiría al
 * descargar el plugin después del detector de fugas de JUCE (aviso de "Leaked objects" en Debug) y lo compartirían
 * hilos distintos (la interfaz pregunta las extensiones mientras el worker decodifica).
 */
struct Formats
{
    juce::AudioFormatManager m;
    Formats() { m.registerBasicFormats(); }
};

// Más de 2 canales → estéreo (downmixToStereo de js/audio/export.js)
std::vector<std::vector<float>> toStereo(std::vector<std::vector<float>> ch)
{
    const std::size_t nCh = ch.size();
    if (nCh <= 2)
        return ch;
    const std::size_t n = ch[0].size();
    std::vector<float> L(n, 0.0f), R(n, 0.0f);
    const double s = std::sqrt(0.5);
    auto mix = [&](std::vector<float>& dst, std::initializer_list<std::pair<std::size_t, double>> terms) {
        for (const auto& [c, g] : terms)
            for (std::size_t i = 0; i < n; ++i)
                dst[i] = static_cast<float>(dst[i] + g * ch[c][i]);
    };
    if (nCh == 3)
    {
        mix(L, {{0, 1.0}, {2, s}});
        mix(R, {{1, 1.0}, {2, s}});
    }
    else if (nCh == 4)
    {
        mix(L, {{0, 0.5}, {2, 0.5}});
        mix(R, {{1, 0.5}, {3, 0.5}});
    }
    else if (nCh == 5)
    {
        mix(L, {{0, 1.0}, {2, s}, {3, s}});
        mix(R, {{1, 1.0}, {2, s}, {4, s}});
    }
    else if (nCh == 6)
    {
        mix(L, {{0, 1.0}, {2, s}, {4, s}});
        mix(R, {{1, 1.0}, {2, s}, {5, s}});
    }
    else
    {
        std::size_t ne = 0, no = 0;
        for (std::size_t c = 0; c < nCh; ++c)
            (c % 2 == 0 ? ne : no)++;
        for (std::size_t c = 0; c < nCh; ++c)
        {
            std::vector<float>& dst = c % 2 == 0 ? L : R;
            const double g = 1.0 / static_cast<double>(c % 2 == 0 ? ne : no);
            for (std::size_t i = 0; i < n; ++i)
                dst[i] = static_cast<float>(dst[i] + g * ch[c][i]);
        }
    }
    float peak = 0;
    for (std::size_t i = 0; i < n; ++i)
        peak = std::max({peak, std::fabs(L[i]), std::fabs(R[i])});
    if (peak > 1)
    {
        const float g = 1.0f / peak;
        for (std::size_t i = 0; i < n; ++i)
        {
            L[i] *= g;
            R[i] *= g;
        }
    }
    std::vector<std::vector<float>> out;
    out.push_back(std::move(L));
    out.push_back(std::move(R));
    return out;
}
} // namespace

juce::StringArray supportedExtensions()
{
    juce::StringArray exts;
    const Formats f;
    for (int i = 0; i < f.m.getNumKnownFormats(); ++i)
        for (const auto& e : f.m.getKnownFormat(i)->getFileExtensions())
            exts.addIfNotAlreadyThere(e.trimCharactersAtStart(".").toLowerCase());
    return exts;
}

bool isSupported(const juce::File& file)
{
    return supportedExtensions().contains(file.getFileExtension().trimCharactersAtStart(".").toLowerCase());
}

Decoded decode(const juce::File& file, double targetRate, double maxSeconds)
{
    Decoded d;
    const juce::String name = juce::String::fromUTF8("«") + file.getFileName() + juce::String::fromUTF8("»");
    if (!file.existsAsFile())
    {
        d.error = juce::String::fromUTF8("No encontré ") + name + ".";
        return d;
    }
    const juce::String ext = file.getFileExtension().trimCharactersAtStart(".").toLowerCase();
    Formats formats;   // vive más que el lector
    std::unique_ptr<juce::AudioFormatReader> reader(formats.m.createReaderFor(file));
    if (reader == nullptr)
    {
        // extensión rara: se prueba por el contenido
        auto stream = std::make_unique<juce::FileInputStream>(file);
        if (stream->openedOk())
            reader.reset(formats.m.createReaderFor(std::move(stream)));
    }
    if (reader == nullptr)
    {
        if (ext == "m4a" || ext == "aac" || ext == "mp4" || ext == "alac")
            d.error = juce::String::fromUTF8("No puedo leer archivos M4A/AAC: conviértelo a WAV, FLAC o MP3, o ponlo "
                                             "en el canal y dale Play para que el plugin tome el audio.");
        else
            d.error = juce::String::fromUTF8("No pude leer ") + name +
                      juce::String::fromUTF8(": el formato no es compatible. Prueba con WAV, AIFF, FLAC, OGG o MP3.");
        return d;
    }
    const double fileRate = reader->sampleRate;
    const auto n = static_cast<std::int64_t>(reader->lengthInSamples);
    const int nCh = static_cast<int>(reader->numChannels);
    if (!(fileRate > 0) || nCh <= 0 || n <= 0)
    {
        d.error = name + juce::String::fromUTF8(" no tiene audio.");
        return d;
    }
    if (static_cast<double>(n) / fileRate > maxSeconds + 0.5)
    {
        d.error = name + juce::String::fromUTF8(" dura más de 15 minutos: el plugin trabaja con hasta 15 minutos de "
                                                "audio.");
        return d;
    }
    std::vector<std::vector<float>> ch(static_cast<std::size_t>(nCh), std::vector<float>(static_cast<std::size_t>(n)));
    {
        constexpr std::int64_t kBlock = 1 << 18;
        std::vector<float*> dst(static_cast<std::size_t>(nCh));
        for (std::int64_t a = 0; a < n; a += kBlock)
        {
            const int len = static_cast<int>(std::min(kBlock, n - a));
            for (int c = 0; c < nCh; ++c)
                dst[static_cast<std::size_t>(c)] = ch[static_cast<std::size_t>(c)].data() + a;
            if (!reader->read(dst.data(), nCh, a, len))
            {
                d.error = juce::String::fromUTF8("No pude leer ") + name + ".";
                return d;
            }
        }
    }
    reader.reset();
    ch = toStereo(std::move(ch));

    d.fileRate = fileRate;
    d.sampleRate = targetRate;
    if (std::llround(fileRate) == std::llround(targetRate))
        d.channels = std::move(ch);
    else
    {
        // la calidad de exportación de la web (EXPORT_RESAMPLER: 24 cruces por cero, corte 0,95)
        const djec::ResamplerOptions opts{24, 0.95};
        try
        {
            for (auto& c : ch)
            {
                d.channels.push_back(djec::resample(c.data(), c.size(), fileRate, targetRate, opts));
                std::vector<float>().swap(c);
            }
        }
        catch (const std::exception& e)
        {
            d.channels.clear();
            d.error = juce::String::fromUTF8("No pude convertir ") + name + juce::String::fromUTF8(" a la frecuencia "
                                                                                                 "del proyecto: ") +
                      juce::String::fromUTF8(e.what());
            return d;
        }
    }
    d.length = d.channels.empty() ? 0 : static_cast<std::int64_t>(d.channels[0].size());
    return d;
}

} // namespace djec::plugin::filedrop
