# Ajustes globales de compilación para DJ Edit Cutter (incluido desde plugin/CMakeLists.txt).

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# El core se enlaza dentro de un módulo compartido (VST3 .so/.dll).
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Por defecto Release en generadores de una sola configuración (Ninja, Makefiles).
get_property(_djec_multi_config GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(NOT _djec_multi_config AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Tipo de build" FORCE)
endif()

if(MSVC)
    # Runtime estático: el usuario no necesita instalar el redistribuible de Visual C++.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    # Las fuentes están en UTF-8 (textos en castellano con tildes y eñes). Vale para todo, JUCE incluido.
    add_compile_options(/utf-8)
endif()

# Avisos para el core y sus tests (no son errores: varios ingenieros escriben código a la vez).
# El plugin y djec_host_tests usan juce::juce_recommended_warning_flags en su lugar (no se mezclan:
# MSVC avisaría de que /W3 pisa a /W4).
if(MSVC)
    set(DJEC_CORE_WARNING_FLAGS /W3 /permissive-)
else()
    set(DJEC_CORE_WARNING_FLAGS -Wall -Wextra)
endif()

# Paridad numérica con la implementación JS (dobles IEEE): sin fast-math ni contracción a FMA.
# MSVC ya usa /fp:precise sin contracción por defecto.
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    set(DJEC_STRICT_FP_FLAGS -ffp-contract=off -fno-fast-math)
else()
    set(DJEC_STRICT_FP_FLAGS "")
endif()
