// Contador de reservas de memoria para comprobar que processBlock no reserva ni libera nada (requisito de tiempo
// real). Reemplaza el operator new/delete global de TODO el binario djec_host_tests; solo cuenta en el hilo que
// tiene armado el contador (el que llama a processBlock en los tests), así el worker y el resto no molestan.
#include "HostSim.h"

#include <cstdlib>
#include <new>
#if defined(_MSC_VER)
 #include <malloc.h>
#endif

namespace djec_test
{
std::atomic<long long> gAudioAllocs { 0 };
std::atomic<long long> gAudioFrees { 0 };
thread_local bool gAudioArmed = false;
} // namespace djec_test

namespace
{
inline void countAlloc() noexcept
{
    if (djec_test::gAudioArmed)
        djec_test::gAudioAllocs.fetch_add (1, std::memory_order_relaxed);
}
inline void countFree (void* p) noexcept
{
    if (p != nullptr && djec_test::gAudioArmed)
        djec_test::gAudioFrees.fetch_add (1, std::memory_order_relaxed);
}

void* allocOrThrow (std::size_t n)
{
    countAlloc();
    if (void* p = std::malloc (n != 0 ? n : 1))
        return p;
    throw std::bad_alloc();
}

void* alignedAlloc (std::size_t n, std::size_t al)
{
    countAlloc();
    if (n == 0)
        n = 1;
#if defined(_MSC_VER)
    return _aligned_malloc (n, al);
#else
    void* p = nullptr;
    if (posix_memalign (&p, al < sizeof (void*) ? sizeof (void*) : al, n) != 0)
        return nullptr;
    return p;
#endif
}

void alignedFree (void* p) noexcept
{
    countFree (p);
#if defined(_MSC_VER)
    _aligned_free (p);
#else
    std::free (p);
#endif
}
} // namespace

void* operator new (std::size_t n) { return allocOrThrow (n); }
void* operator new[] (std::size_t n) { return allocOrThrow (n); }
void* operator new (std::size_t n, const std::nothrow_t&) noexcept
{
    countAlloc();
    return std::malloc (n != 0 ? n : 1);
}
void* operator new[] (std::size_t n, const std::nothrow_t&) noexcept
{
    countAlloc();
    return std::malloc (n != 0 ? n : 1);
}
void operator delete (void* p) noexcept
{
    countFree (p);
    std::free (p);
}
void operator delete[] (void* p) noexcept
{
    countFree (p);
    std::free (p);
}
void operator delete (void* p, std::size_t) noexcept
{
    countFree (p);
    std::free (p);
}
void operator delete[] (void* p, std::size_t) noexcept
{
    countFree (p);
    std::free (p);
}
void operator delete (void* p, const std::nothrow_t&) noexcept
{
    countFree (p);
    std::free (p);
}
void operator delete[] (void* p, const std::nothrow_t&) noexcept
{
    countFree (p);
    std::free (p);
}

void* operator new (std::size_t n, std::align_val_t al)
{
    if (void* p = alignedAlloc (n, static_cast<std::size_t> (al)))
        return p;
    throw std::bad_alloc();
}
void* operator new[] (std::size_t n, std::align_val_t al)
{
    if (void* p = alignedAlloc (n, static_cast<std::size_t> (al)))
        return p;
    throw std::bad_alloc();
}
void* operator new (std::size_t n, std::align_val_t al, const std::nothrow_t&) noexcept
{
    return alignedAlloc (n, static_cast<std::size_t> (al));
}
void* operator new[] (std::size_t n, std::align_val_t al, const std::nothrow_t&) noexcept
{
    return alignedAlloc (n, static_cast<std::size_t> (al));
}
void operator delete (void* p, std::align_val_t) noexcept { alignedFree (p); }
void operator delete[] (void* p, std::align_val_t) noexcept { alignedFree (p); }
void operator delete (void* p, std::size_t, std::align_val_t) noexcept { alignedFree (p); }
void operator delete[] (void* p, std::size_t, std::align_val_t) noexcept { alignedFree (p); }
void operator delete (void* p, std::align_val_t, const std::nothrow_t&) noexcept { alignedFree (p); }
void operator delete[] (void* p, std::align_val_t, const std::nothrow_t&) noexcept { alignedFree (p); }
