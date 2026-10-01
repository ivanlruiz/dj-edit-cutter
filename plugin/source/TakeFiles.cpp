#include "TakeFiles.h"

#include <algorithm>
#include <map>
#include <mutex>
#include <vector>

namespace djec::plugin::takefiles
{

namespace
{
std::mutex& registryMutex()
{
    static std::mutex m;
    return m;
}

std::map<juce::String, int>& registry()
{
    static std::map<juce::String, int> r;
    return r;
}

std::mutex& cleanupMutex()
{
    static std::mutex m;
    return m;
}

juce::String keyOf(const juce::File& f)
{
    const juce::String p = f.getFullPathName();
    return juce::File::areFileNamesCaseSensitive() ? p : p.toLowerCase();
}

bool isHex(juce::juce_wchar c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
} // namespace

bool isTakeFileName(const juce::String& name)
{
    // juce::Uuid::toDashedString(): 8-4-4-4-12 dígitos hexadecimales
    if (name.length() != 40 || !name.endsWithIgnoreCase(".wav"))
        return false;
    for (int i = 0; i < 36; ++i)
    {
        const juce::juce_wchar c = name[i];
        if (i == 8 || i == 13 || i == 18 || i == 23)
        {
            if (c != '-')
                return false;
        }
        else if (!isHex(c))
            return false;
    }
    return true;
}

void acquire(const juce::File& file)
{
    if (file == juce::File())
        return;
    const std::lock_guard<std::mutex> lock(registryMutex());
    ++registry()[keyOf(file)];
}

void release(const juce::File& file)
{
    if (file == juce::File())
        return;
    const std::lock_guard<std::mutex> lock(registryMutex());
    auto& r = registry();
    const auto it = r.find(keyOf(file));
    if (it != r.end() && --it->second <= 0)
        r.erase(it);
}

bool isInUse(const juce::File& file)
{
    if (file == juce::File())
        return false;
    const std::lock_guard<std::mutex> lock(registryMutex());
    return registry().count(keyOf(file)) > 0;
}

bool touch(const juce::File& file, juce::Time now)
{
    return file.existsAsFile() && file.setLastModificationTime(now);
}

Result cleanup(const juce::File& dir, const Policy& policy, juce::Time now, const juce::File& keep)
{
    const std::lock_guard<std::mutex> serial(cleanupMutex());
    Result res;
    if (dir == juce::File() || !dir.isDirectory())
        return res;

    struct Entry
    {
        juce::File file;
        juce::int64 size;
        juce::int64 modifiedMs;
    };
    std::vector<Entry> entries;
    for (const juce::File& f : dir.findChildFiles(juce::File::findFiles, false, "*"))
    {
        if (!isTakeFileName(f.getFileName()))
            continue;
        entries.push_back({f, f.getSize(), f.getLastModificationTime().toMilliseconds()});
        res.bytesBefore += entries.back().size;
    }
    res.scanned = static_cast<int>(entries.size());
    juce::int64 total = res.bytesBefore;

    const juce::int64 nowMs = now.toMilliseconds();
    const auto graceMs = static_cast<juce::int64>(policy.graceMinutes * 60.0 * 1000.0);
    const auto maxAgeMs = static_cast<juce::int64>(policy.maxAgeDays * 24.0 * 3600.0 * 1000.0);
    auto protectedFile = [&](const Entry& e) {
        return (keep != juce::File() && e.file == keep) || isInUse(e.file) || e.modifiedMs > nowMs - graceMs;
    };
    auto tryDelete = [&](Entry& e) {
        if (protectedFile(e) || !e.file.deleteFile())
            return false;
        total -= e.size;
        ++res.deleted;
        res.deletedNames.add(e.file.getFileName());
        e.size = -1;   // borrado
        return true;
    };

    // 1. sin usar hace más de maxAgeDays
    for (Entry& e : entries)
        if (e.modifiedMs < nowMs - maxAgeMs)
            tryDelete(e);

    // 2. la carpeta pasa del máximo: las más viejas primero
    if (total > policy.maxBytes)
    {
        std::vector<Entry*> byAge;
        for (Entry& e : entries)
            if (e.size >= 0)
                byAge.push_back(&e);
        std::sort(byAge.begin(), byAge.end(), [](const Entry* a, const Entry* b) { return a->modifiedMs < b->modifiedMs; });
        for (Entry* e : byAge)
        {
            if (total <= policy.maxBytes)
                break;
            tryDelete(*e);
        }
    }
    res.bytesAfter = total;
    return res;
}

} // namespace djec::plugin::takefiles
