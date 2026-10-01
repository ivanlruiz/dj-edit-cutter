#include "PluginProcessor.h"
#include "PluginEditor.h"

#include "FileDrop.h"
#include "Paths.h"
#include "WavIO.h"

#include "djec/meter.h"

#include <cmath>

using namespace djec::plugin;

namespace
{
constexpr int kStateVersion = 1;
constexpr double kAlignListenSeconds = 16;   // búfer para ubicar un archivo (se reinicia al llenarse)

juce::String u8 (const char* s) { return juce::String::fromUTF8 (s); }

const char* gridModeId (GridMode m) { return m == GridMode::Detect ? "detect" : "fl"; }
const char* sourceId (TakeSource s) { return s == TakeSource::File ? "file" : s == TakeSource::Playback ? "playback" : "none"; }
const char* alignId (AlignState a)
{
    switch (a)
    {
        case AlignState::Found: return "found";
        case AlignState::Manual: return "manual";
        case AlignState::WaitingForPlay: return "waiting";
        case AlignState::Searching: return "searching";
        case AlignState::NotFound: return "notfound";
        case AlignState::None: break;
    }
    return "none";
}
AlignState alignFrom (const juce::String& s)
{
    if (s == "found") return AlignState::Found;
    if (s == "manual") return AlignState::Manual;
    if (s == "waiting" || s == "searching" || s == "notfound") return AlignState::WaitingForPlay;
    return AlignState::None;
}

juce::String encodeAnchors (const std::vector<AnchorEntry>& anchors)
{
    juce::MemoryOutputStream o;
    for (const auto& a : anchors)
    {
        o.writeInt64 (a.offset);
        o.writeInt64 (a.info.hostSample);
        o.writeDouble (a.info.ppq);
        o.writeDouble (a.info.bpm);
        o.writeInt (a.info.tsNum);
        o.writeInt (a.info.tsDen);
        o.writeDouble (a.info.lastBarStartPpq);
        o.writeBool (a.info.ppqValid);
        o.writeBool (a.info.barValid);
    }
    return o.getMemoryBlock().toBase64Encoding();
}

std::vector<AnchorEntry> decodeAnchors (const juce::String& s)
{
    std::vector<AnchorEntry> out;
    juce::MemoryBlock mb;
    if (s.isEmpty() || ! mb.fromBase64Encoding (s))
        return out;
    juce::MemoryInputStream in (mb, false);
    constexpr int kRecord = 8 + 8 + 8 + 8 + 4 + 4 + 8 + 1 + 1;
    while (in.getNumBytesRemaining() >= kRecord)
    {
        AnchorEntry a;
        a.offset = in.readInt64();
        a.info.hostSample = in.readInt64();
        a.info.ppq = in.readDouble();
        a.info.bpm = in.readDouble();
        a.info.tsNum = in.readInt();
        a.info.tsDen = in.readInt();
        a.info.lastBarStartPpq = in.readDouble();
        a.info.ppqValid = in.readBool();
        a.info.barValid = in.readBool();
        out.push_back (a);
    }
    return out;
}
} // namespace

//==============================================================================================================

DjecAudioProcessor::DjecAudioProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Entrada", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Salida", juce::AudioChannelSet::stereo(), true)),
      hub (std::make_unique<Hub>()),
      engine (*hub),
      worker (*hub)
{
    worker.start();
}

DjecAudioProcessor::~DjecAudioProcessor()
{
    exportPool.removeAllJobs (false, 30000);
    worker.stop();
    hub->pool.stop();
    engine.destroySnapshots();
    delete hub->pending.exchange (nullptr);
    PlaybackSnapshot* s = nullptr;
    while (hub->retired.pop (s))
        delete s;
    for (auto& r : hub->recorders)
        for (auto*& c : r.chunks)
        {
            delete c;
            c = nullptr;
        }
}

void DjecAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    hub->sampleRate.store (sampleRate);
    engine.prepare (sampleRate, samplesPerBlock);
    {
        // búfer para ubicar archivos (el worker lo lee bajo este mismo mutex)
        const std::lock_guard<std::mutex> lock (hub->alignResize);
        AlignBuffer& a = hub->align;
        a.gen.fetch_add (1);
        a.listening.store (false);
        a.count.store (0);
        a.numAnchors.store (0);
        a.mono.assign (static_cast<std::size_t> (kAlignListenSeconds * sampleRate), 0.0f);
        a.anchors.assign (512, AnchorEntry {});
        a.gen.fetch_add (1);
    }
    preparedRate = sampleRate;
    setTakePoolSeconds (poolSeconds);
    hub->pool.start();
    setLatencySamples (0);
    worker.hostPrepared (sampleRate);
}

void DjecAudioProcessor::releaseResources()
{
    engine.release();
}

bool DjecAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    // Mono o estéreo, con la misma disposición a la entrada y a la salida.
    const auto out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

BlockPosition DjecAudioProcessor::readPosition() const noexcept
{
    BlockPosition bp;
    if (auto* ph = getPlayHead())
    {
        if (const auto pos = ph->getPosition())
        {
            bp.hasInfo = true;
            bp.playing = pos->getIsPlaying();
            if (const auto t = pos->getTimeInSamples())
            {
                bp.hasTime = true;
                bp.timeInSamples = *t;
                bp.info.hostSample = *t;
            }
            if (const auto ppq = pos->getPpqPosition())
            {
                bp.info.ppq = *ppq;
                bp.info.ppqValid = true;
            }
            if (const auto bpm = pos->getBpm())
                bp.info.bpm = *bpm;
            if (const auto ts = pos->getTimeSignature())
            {
                bp.info.tsNum = ts->numerator;
                bp.info.tsDen = ts->denominator;
            }
            if (const auto bar = pos->getPpqPositionOfLastBarStart())
            {
                bp.info.lastBarStartPpq = *bar;
                bp.info.barValid = true;
            }
        }
    }
    return bp;
}

void DjecAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    const int numIn = juce::jmin (getTotalNumInputChannels(), buffer.getNumChannels());
    const int numOut = juce::jmin (getTotalNumOutputChannels(), buffer.getNumChannels());
    for (int ch = numIn; ch < numOut; ++ch)
        buffer.clear (ch, 0, n);
    const BlockPosition bp = readPosition();
    engine.process (buffer.getArrayOfWritePointers(), numIn, numOut, n, bp, isNonRealtime());
}

void DjecAudioProcessor::processBlockBypassed (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    const int n = buffer.getNumSamples();
    const int numIn = juce::jmin (getTotalNumInputChannels(), buffer.getNumChannels());
    const int numOut = juce::jmin (getTotalNumOutputChannels(), buffer.getNumChannels());
    for (int ch = numIn; ch < numOut; ++ch)
        buffer.clear (ch, 0, n);
    engine.processBypassed (n, readPosition());
}

juce::AudioProcessorEditor* DjecAudioProcessor::createEditor()
{
    return new DjecAudioProcessorEditor (*this);
}

//==============================================================================================================
// Estado

void DjecAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    const PersistedState ps = worker.persisted();
    juce::ValueTree state ("DJEditCutter");
    state.setProperty ("version", JucePlugin_VersionString, nullptr);
    state.setProperty ("stateVersion", kStateVersion, nullptr);

    juce::ValueTree s ("Settings");
    s.setProperty ("trimEachBar", ps.settings.trimEachBar, nullptr);
    s.setProperty ("amount", juce::String (ps.settings.amount), nullptr);
    s.setProperty ("otherNum", ps.settings.otherNum, nullptr);
    s.setProperty ("otherDen", ps.settings.otherDen, nullptr);
    s.setProperty ("crossfadeSec", ps.settings.crossfadeSec, nullptr);
    s.setProperty ("removeEnd", ps.settings.removeEnd, nullptr);
    s.setProperty ("barsToRemove", ps.settings.barsToRemove, nullptr);
    s.setProperty ("fadeBeats", ps.settings.fadeBeats, nullptr);
    s.setProperty ("curve", juce::String (ps.settings.curve), nullptr);
    s.setProperty ("gridMode", gridModeId (ps.gridMode), nullptr);
    s.setProperty ("barOffset", ps.barOffsetBeats, nullptr);
    s.setProperty ("listenOriginal", ps.listenOriginal, nullptr);
    state.addChild (s, -1, nullptr);

    juce::ValueTree d ("Detect");
    d.setProperty ("bpmHint", ps.detect.bpmHint, nullptr);
    d.setProperty ("strict", ps.detect.strict, nullptr);
    d.setProperty ("meterChoice", ps.detect.meterChoice, nullptr);
    d.setProperty ("tempoChanged", ps.detect.tempoChanged, nullptr);
    juce::StringArray forced;
    for (int i : ps.detect.forced)
        forced.add (juce::String (i));
    d.setProperty ("forced", forced.joinIntoString (" "), nullptr);
    state.addChild (d, -1, nullptr);

    juce::ValueTree t ("Take");
    t.setProperty ("source", sourceId (ps.source), nullptr);
    t.setProperty ("path", ps.takeFile.getFullPathName(), nullptr);
    t.setProperty ("size", ps.fileSize, nullptr);
    t.setProperty ("modified", ps.fileModified, nullptr);
    t.setProperty ("hash", juce::String::toHexString ((juce::int64) ps.hash), nullptr);
    t.setProperty ("sampleRate", ps.sampleRate, nullptr);
    t.setProperty ("hostStart", (juce::int64) ps.hostStart, nullptr);
    t.setProperty ("numSamples", (juce::int64) ps.numSamples, nullptr);
    t.setProperty ("numChannels", ps.numChannels, nullptr);
    t.setProperty ("align", alignId (ps.align), nullptr);
    t.setProperty ("fileStartBar", ps.fileStartBar, nullptr);
    t.setProperty ("trackName", ps.trackName, nullptr);
    t.setProperty ("anchors", encodeAnchors (ps.anchors), nullptr);
    state.addChild (t, -1, nullptr);

    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, destData);
}

void DjecAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary (data, sizeInBytes);
    if (xml == nullptr)
        return;
    const juce::ValueTree state = juce::ValueTree::fromXml (*xml);
    if (! state.hasType ("DJEditCutter"))
        return;

    PersistedState ps;
    const auto s = state.getChildWithName ("Settings");
    if (s.isValid())
    {
        ps.settings.trimEachBar = s.getProperty ("trimEachBar", true);
        ps.settings.amount = s.getProperty ("amount", "eighth").toString().toStdString();
        ps.settings.otherNum = s.getProperty ("otherNum", 7);
        ps.settings.otherDen = s.getProperty ("otherDen", 8);
        ps.settings.crossfadeSec = s.getProperty ("crossfadeSec", 0.010);
        ps.settings.removeEnd = s.getProperty ("removeEnd", false);
        ps.settings.barsToRemove = s.getProperty ("barsToRemove", 1);
        ps.settings.fadeBeats = s.getProperty ("fadeBeats", 0.0);
        ps.settings.curve = s.getProperty ("curve", "smooth").toString().toStdString();
        ps.gridMode = s.getProperty ("gridMode", "fl").toString() == "detect" ? GridMode::Detect : GridMode::Host;
        ps.barOffsetBeats = s.getProperty ("barOffset", 0);
        ps.listenOriginal = s.getProperty ("listenOriginal", false);
    }
    const auto d = state.getChildWithName ("Detect");
    if (d.isValid())
    {
        ps.detect.bpmHint = d.getProperty ("bpmHint", 0.0);
        ps.detect.strict = d.getProperty ("strict", false);
        ps.detect.meterChoice = d.getProperty ("meterChoice", 0);
        ps.detect.tempoChanged = d.getProperty ("tempoChanged", false);
        juce::StringArray forced;
        forced.addTokens (d.getProperty ("forced", "").toString(), " ", "");
        for (const auto& f : forced)
            if (f.isNotEmpty())
                ps.detect.forced.push_back (f.getIntValue());
    }
    const auto t = state.getChildWithName ("Take");
    if (t.isValid())
    {
        const juce::String src = t.getProperty ("source", "none").toString();
        ps.source = src == "file" ? TakeSource::File : src == "playback" ? TakeSource::Playback : TakeSource::None;
        const juce::String path = t.getProperty ("path", "").toString();
        if (path.isNotEmpty() && juce::File::isAbsolutePath (path))
            ps.takeFile = juce::File (path);
        else
            ps.source = TakeSource::None;
        ps.fileSize = static_cast<juce::int64> (t.getProperty ("size", 0));
        ps.fileModified = static_cast<juce::int64> (t.getProperty ("modified", 0));
        ps.hash = static_cast<std::uint64_t> (t.getProperty ("hash", "0").toString().getHexValue64());
        ps.sampleRate = t.getProperty ("sampleRate", 0.0);
        ps.hostStart = static_cast<juce::int64> (t.getProperty ("hostStart", 0));
        ps.numSamples = static_cast<juce::int64> (t.getProperty ("numSamples", 0));
        ps.numChannels = t.getProperty ("numChannels", 0);
        ps.align = alignFrom (t.getProperty ("align", "none").toString());
        ps.fileStartBar = t.getProperty ("fileStartBar", 0);
        ps.trackName = t.getProperty ("trackName", "").toString();
        ps.anchors = decodeAnchors (t.getProperty ("anchors", "").toString());
    }
    worker.restore (ps);
}

void DjecAudioProcessor::updateTrackProperties (const TrackProperties& properties)
{
    if (properties.name.has_value())
        worker.setTrackName (*properties.name);
}

//==============================================================================================================
// API para la interfaz

ViewState DjecAudioProcessor::getViewState() const
{
    ViewState vs;
    vs.session = worker.view();
    const SessionView& s = *vs.session;
    const LiveAtomics& L = hub->live;
    LiveView& v = vs.live;
    v.playing = L.playing.load (std::memory_order_relaxed);
    v.positionKnown = L.positionKnown.load (std::memory_order_relaxed);
    v.hostSample = L.hostSample.load (std::memory_order_relaxed);
    v.ppq = L.ppq.load (std::memory_order_relaxed);
    v.hostBpm = L.bpm.load (std::memory_order_relaxed);
    v.tsNum = L.tsNum.load (std::memory_order_relaxed);
    v.tsDen = L.tsDen.load (std::memory_order_relaxed);
    v.recKind = L.recKind.load (std::memory_order_relaxed);
    v.listenOriginal = hub->listenOriginal.load (std::memory_order_relaxed) != 0;
    v.outputEdited = L.outputEdited.load (std::memory_order_relaxed);
    v.outsideNotTaken = L.outsideNotTaken.load (std::memory_order_relaxed);
    const double sr = hub->sampleRate.load (std::memory_order_relaxed);
    if (v.recKind >= 0 && sr > 0)
    {
        v.recSeconds = static_cast<double> (L.recFrames.load (std::memory_order_relaxed)) / sr;
        if (v.recKind <= 2 && L.recPpqValid.load (std::memory_order_relaxed) && v.tsNum > 0 && v.tsDen > 0)
        {
            const double barLen = v.tsNum * 4.0 / v.tsDen;
            const double ref = L.lastBarPpq.load (std::memory_order_relaxed);
            const double p0 = L.recPpqStart.load (std::memory_order_relaxed);
            const double bars = std::floor ((v.ppq - ref) / barLen + 1e-6) - std::floor ((p0 - ref) / barLen + 1e-6);
            v.recBars = static_cast<int> (juce::jmax (0.0, bars));
        }
    }
    const bool rangeValid = L.rangeValid.load (std::memory_order_relaxed);
    const std::int64_t rA = L.rangeA.load (std::memory_order_relaxed);
    const std::int64_t rE = L.rangeE.load (std::memory_order_relaxed);
    v.insideTake = rangeValid && v.hostSample >= rA && v.hostSample < rE;
    if (s.hasTake && s.placed && s.sampleRate > 0)
        v.takeSec = static_cast<double> (v.hostSample - s.hostStart) / s.sampleRate;
    if (v.outputEdited && s.hasPlan && s.sampleRate > 0)
    {
        const double tOut = static_cast<double> (v.hostSample - L.playingSnapshotA.load (std::memory_order_relaxed))
                            / s.sampleRate;
        v.sourceSec = djec::outputToSourceTime (s.plan.segments, tOut);
    }
    juce::String stage;
    double frac = 0;
    worker.analysisProgress (stage, frac);
    v.analysisStage = stageLabel (stage);
    v.analysisFraction = frac;

    // ---- línea de estado ----
    auto status = [&] (Phase p, const juce::String& text, bool warning = false) {
        vs.phase = p;
        vs.statusText = text;
        vs.statusIsWarning = warning;
    };
    const juce::String name = u8 ("«") + s.displayName + u8 ("»");
    const bool workerBehind = rangeValid
                              && (! s.hasTake || ! s.placed || s.takeId != L.rangeTakeId.load (std::memory_order_relaxed)
                                  || s.hostStart != rA || s.hostStart + s.numSamples != rE);
    if (v.recKind == 0)
    {
        juce::String t = u8 ("Tomando el audio… ") + formatClock (v.recSeconds);
        if (L.recPpqValid.load (std::memory_order_relaxed))
            t << u8 (" · ") << formatBars (v.recBars);
        t << u8 (" (escuchas el original)");
        status (Phase::Taking, t);
    }
    else if (v.recKind == 1 || v.recKind == 2)
        // detrás de la toma puede seguir sonando lo editado si dura más que ella («Alargar»)
        status (Phase::TakingMore, u8 ("Tomando lo que faltaba… ") + formatClock (v.recSeconds)
                                       + (v.outputEdited ? u8 (" (suena lo editado)") : u8 (" (escuchas el original)")));
    else if (s.loadingFile)
        status (Phase::LoadingFile, u8 ("Leyendo el archivo…"));
    else if (v.recKind == 3)
    {
        if (s.align == AlignState::NotFound)
            status (Phase::FileNotFound, u8 ("No encuentro este audio en el canal. ¿Pusiste el plugin en el canal correcto?"), true);
        else
            status (Phase::SearchingFile, u8 ("Buscando ") + name + u8 (" en el canal… (escuchas el original)"));
    }
    else if (s.busy || workerBehind)
    {
        juce::String t = s.busy && s.busyText.isNotEmpty() ? s.busyText : u8 ("Procesando…");
        if (v.analysisStage.isNotEmpty())
            t = v.analysisStage + u8 ("… ") + juce::String (juce::roundToInt (frac * 100)) + " %";
        status (Phase::Processing, t);
    }
    else if (s.hasTake && s.source == TakeSource::File && ! s.placed)
    {
        if (s.align == AlignState::NotFound)
            status (Phase::FileNotFound, u8 ("No encuentro este audio en el canal. ¿Pusiste el plugin en el canal correcto?"), true);
        else
            status (Phase::WaitingForFilePlay, u8 ("Dale Play en FL: busco dónde suena ") + name + u8 (" en el canal."));
    }
    else if (! s.hasTake)
        status (Phase::WaitingForPlay, u8 ("Dale Play en FL: el plugin toma el audio del canal."));
    else if (v.playing && v.outsideNotTaken)
        status (Phase::OutsideTake, u8 ("Esta parte todavía no fue tomada: dale Play desde el principio."), true);
    else if (v.playing && v.outputEdited)
        status (Phase::PlayingEdited, u8 ("Suena recortado."));
    else if (v.playing && v.insideTake && v.listenOriginal)
        status (Phase::PlayingOriginal, u8 ("Suena el original (A/B)."));
    else if (! s.hasRender)
        status (Phase::NothingToEdit, u8 ("Audio tomado. ") + s.blockerText, s.blockerText.isNotEmpty());
    else
        status (Phase::Ready, u8 ("Listo: desde el próximo Play suena recortado."));
    return vs;
}

void DjecAudioProcessor::clearTake() { worker.clearTake(); }

bool DjecAudioProcessor::loadDroppedFile (const juce::File& file)
{
    if (! file.existsAsFile())
        return false;
    worker.loadFile (file);
    return true;
}

bool DjecAudioProcessor::isSupportedAudioFile (const juce::File& file)
{
    const juce::String ext = file.getFileExtension().trimCharactersAtStart (".").toLowerCase();
    // M4A/AAC se acepta para poder explicar por qué no se puede leer
    return filedrop::isSupported (file) || ext == "m4a" || ext == "aac";
}

juce::StringArray DjecAudioProcessor::supportedAudioExtensions() { return filedrop::supportedExtensions(); }

void DjecAudioProcessor::fileStartsAtBarOne() { worker.fileStartsAtBarOne(); }

void DjecAudioProcessor::setGridMode (GridMode mode) { worker.setGridMode (mode); }

GridMode DjecAudioProcessor::getGridMode() const { return worker.view()->gridMode; }

void DjecAudioProcessor::setBarOffset (int beats) { worker.setBarOffset (beats); }

void DjecAudioProcessor::retrack (double bpmHint, bool strict) { worker.retrack (bpmHint, strict); }

void DjecAudioProcessor::relabel (int beatsPerBar, const std::vector<int>& forcedDownbeats)
{
    worker.relabel (beatsPerBar, forcedDownbeats);
}

void DjecAudioProcessor::resetDetection() { worker.resetDetection(); }

void DjecAudioProcessor::moveDownbeat (int delta, double refTimeSec) { worker.moveDownbeat (delta, refTimeSec); }

void DjecAudioProcessor::beatIsOne (double timeSec) { worker.beatIsOne (timeSec); }

void DjecAudioProcessor::setEditSettings (const djec::EditSettings& settings) { worker.setSettings (settings); }

djec::EditSettings DjecAudioProcessor::getEditSettings() const { return worker.settings(); }

void DjecAudioProcessor::setListenOriginal (bool original) { worker.setListenOriginal (original); }

bool DjecAudioProcessor::isListeningOriginal() const { return hub->listenOriginal.load() != 0; }

void DjecAudioProcessor::dismissNotice (std::uint64_t id) { worker.dismissNotice (id); }

juce::Result DjecAudioProcessor::exportWav (const juce::File& file, int bitDepth) const
{
    const ExportData d = worker.exportData();
    if (d.render == nullptr || d.render->length <= 0)
        return juce::Result::fail (u8 ("Todavía no hay audio editado para guardar."));
    if (bitDepth != 16 && bitDepth != 24)
        return juce::Result::fail (u8 ("Profundidad de bits no soportada (usa 16 o 24 bits)."));
    std::vector<const float*> ptrs;
    for (const auto& c : d.render->channels)
        ptrs.push_back (c.data());
    return wav::write (file, ptrs.data(), static_cast<int> (ptrs.size()), d.render->length, d.render->sampleRate,
                       bitDepth == 24 ? wav::Format::Pcm24 : wav::Format::Pcm16);
}

void DjecAudioProcessor::exportWavAsync (const juce::File& file, int bitDepth, std::function<void (juce::Result)> onDone)
{
    exportPool.addJob ([this, file, bitDepth, onDone] {
        const juce::Result r = exportWav (file, bitDepth);
        if (onDone)
            juce::MessageManager::callAsync ([onDone, r] { onDone (r); });
    });
}

juce::String DjecAudioProcessor::suggestedFileName() const
{
    const ExportData d = worker.exportData();
    return suggestFileName (d.baseName.isNotEmpty() ? d.baseName : juce::String ("Toma"), d.plan, d.meterChanges);
}

void DjecAudioProcessor::writeDragFileAsync (std::function<void (juce::File, juce::String)> onDone)
{
    exportPool.addJob ([this, onDone] {
        juce::String err;
        const juce::File f = writeDragFile (&err);
        if (onDone)
            juce::MessageManager::callAsync ([onDone, f, err] { onDone (f, err); });
    });
}

juce::File DjecAudioProcessor::writeDragFile (juce::String* error)
{
    const ExportData d = worker.exportData();
    if (d.render == nullptr || d.render->length <= 0)
    {
        if (error != nullptr)
            *error = u8 ("Todavía no hay audio editado: dale Play en FL para que el plugin tome el audio.");
        return {};
    }
    const std::lock_guard<std::mutex> lock (dragMutex);
    if (dragRenderId == d.render->renderId && dragFile.existsAsFile())
        return dragFile;
    const juce::String name = suggestFileName (d.baseName.isNotEmpty() ? d.baseName : juce::String ("Toma"), d.plan, d.meterChanges);
    const juce::File dir = paths::exportsDir();
    juce::File file = dir.getChildFile (name);
    // nunca se pisa un archivo que FL ya pueda estar usando en el Playlist
    if (file.exists())
        file = dir.getNonexistentChildFile (file.getFileNameWithoutExtension(), ".wav", true);
    std::vector<const float*> ptrs;
    for (const auto& c : d.render->channels)
        ptrs.push_back (c.data());
    const juce::Result r = wav::write (file, ptrs.data(), static_cast<int> (ptrs.size()), d.render->length,
                                       d.render->sampleRate, wav::Format::Pcm24);
    if (r.failed())
    {
        if (error != nullptr)
            *error = r.getErrorMessage();
        return {};
    }
    dragRenderId = d.render->renderId;
    dragFile = file;
    return file;
}

bool DjecAudioProcessor::waitForWorker (int timeoutMs) { return worker.waitIdle (timeoutMs); }

void DjecAudioProcessor::setTakePoolSeconds (double seconds)
{
    poolSeconds = juce::jmax (1.0, seconds);
    if (preparedRate > 0)
    {
        const double chunks = std::ceil (poolSeconds * preparedRate / kChunkFrames) + 2;
        hub->pool.setTarget (static_cast<std::size_t> (chunks));
        hub->pool.fillNow();
    }
}

//==============================================================================================================
// Punto de entrada que usan los wrappers de JUCE (VST3, Standalone) y djec_host_tests.
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new DjecAudioProcessor();
}
