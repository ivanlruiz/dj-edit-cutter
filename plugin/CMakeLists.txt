# DJ Edit Cutter — plugin de efecto para el Mixer de FL Studio (VST3).
#
# Desde la raíz del repo:
#   cmake -S plugin -B plugin/build -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build plugin/build -j4
#   ctest --test-dir plugin/build --output-on-failure
# Ver plugin/README-dev.md.

cmake_minimum_required(VERSION 3.22)

# Versión del plugin (x.y.z). El workflow de CI la pasa desde el tag plugin-vX.Y.Z.
set(DJEC_VERSION "0.1.0" CACHE STRING "Versión del plugin (x.y.z)")

project(DJEditCutter VERSION ${DJEC_VERSION} LANGUAGES C CXX)

option(DJEC_BUILD_PLUGIN     "Compilar el plugin JUCE (VST3) y djec_host_tests (descarga JUCE)" ON)
option(DJEC_BUILD_TESTS      "Compilar los tests (doctest) y registrarlos en CTest" ON)
option(DJEC_BUILD_STANDALONE "Añadir el formato Standalone del plugin (para probar a mano)" ON)
option(DJEC_GOLDEN           "Generar los datos golden con Node (tools/golden-*.mjs) antes de los tests" ON)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

set(DJEC_PLUGIN_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
get_filename_component(DJEC_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(DJEC_GOLDEN_DIR "${CMAKE_BINARY_DIR}/golden")

include(DjecSettings)   # C++17, runtime estático en MSVC, /utf-8, PIC, flags del core

# ==================================================================================================
# djec_core: C++17 puro (sin JUCE). Toma solo los .cpp que existan en core/src (recursivo).
# ==================================================================================================
file(GLOB_RECURSE DJEC_CORE_SOURCES CONFIGURE_DEPENDS
    "${DJEC_PLUGIN_DIR}/core/src/*.cpp")
file(GLOB_RECURSE DJEC_CORE_HEADERS CONFIGURE_DEPENDS
    "${DJEC_PLUGIN_DIR}/core/include/*.h"
    "${DJEC_PLUGIN_DIR}/core/src/*.h")

# djec_core_anchor.cpp evita una librería sin fuentes mientras core/src está vacío.
add_library(djec_core STATIC
    "${DJEC_PLUGIN_DIR}/cmake/djec_core_anchor.cpp"
    ${DJEC_CORE_SOURCES}
    ${DJEC_CORE_HEADERS})
add_library(djec::core ALIAS djec_core)

target_include_directories(djec_core
    PUBLIC  "${DJEC_PLUGIN_DIR}/core/include"
    PRIVATE "${DJEC_PLUGIN_DIR}/core/src")
target_compile_features(djec_core PUBLIC cxx_std_17)
target_compile_options(djec_core PRIVATE ${DJEC_CORE_WARNING_FLAGS} ${DJEC_STRICT_FP_FLAGS})

find_package(Threads REQUIRED)
target_link_libraries(djec_core PUBLIC Threads::Threads)

# ==================================================================================================
# Datos golden (Node) + djec_core_tests (doctest)
# ==================================================================================================
include(DjecGolden)     # define el target 'golden'

if(DJEC_BUILD_TESTS)
    enable_testing()

    file(GLOB DJEC_CORE_TEST_SOURCES CONFIGURE_DEPENDS "${DJEC_PLUGIN_DIR}/tests/core/*_test.cpp")
    file(GLOB DJEC_CORE_TEST_HEADERS CONFIGURE_DEPENDS "${DJEC_PLUGIN_DIR}/tests/core/*.h")

    add_executable(djec_core_tests
        "${DJEC_PLUGIN_DIR}/tests/core/main.cpp"
        ${DJEC_CORE_TEST_SOURCES}
        ${DJEC_CORE_TEST_HEADERS})
    target_link_libraries(djec_core_tests PRIVATE djec_core)
    target_include_directories(djec_core_tests PRIVATE
        "${DJEC_PLUGIN_DIR}/tests/third_party"
        "${DJEC_PLUGIN_DIR}/tests/core"
        "${DJEC_PLUGIN_DIR}/core/src")
    target_compile_options(djec_core_tests PRIVATE ${DJEC_CORE_WARNING_FLAGS} ${DJEC_STRICT_FP_FLAGS})
    target_compile_definitions(djec_core_tests PRIVATE
        DJEC_GOLDEN_DIR="${DJEC_GOLDEN_DIR}"
        DJEC_PLUGIN_SOURCE_DIR="${DJEC_PLUGIN_DIR}"
        DJEC_REPO_ROOT="${DJEC_REPO_ROOT}")

    if(TARGET djec_golden_data)
        add_dependencies(djec_core_tests golden)
    endif()

    add_test(NAME djec_core_tests COMMAND djec_core_tests)
    set_tests_properties(djec_core_tests PROPERTIES TIMEOUT 900)
endif()

# ==================================================================================================
# Plugin JUCE
# ==================================================================================================
if(DJEC_BUILD_PLUGIN)
    include(FetchContent)
    # Para compilar sin red: -DFETCHCONTENT_SOURCE_DIR_JUCE=/ruta/a/JUCE (clon del tag 8.0.15).
    FetchContent_Declare(juce
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG        8.0.15
        GIT_SHALLOW    ON
        GIT_PROGRESS   ON)
    FetchContent_MakeAvailable(juce)

    set(DJEC_PLUGIN_FORMATS VST3)
    if(DJEC_BUILD_STANDALONE)
        list(APPEND DJEC_PLUGIN_FORMATS Standalone)
    endif()

    juce_add_plugin(DJEditCutter
        VERSION                  ${PROJECT_VERSION}
        COMPANY_NAME             "ivanlruiz"
        COMPANY_WEBSITE          "https://ivanlruiz.github.io/dj-edit-cutter/"
        BUNDLE_ID                "com.ivanlruiz.djeditcutter"
        PRODUCT_NAME             "DJ Edit Cutter"
        PLUGIN_NAME              "DJ Edit Cutter"
        DESCRIPTION              "Recorta cada compás y quita compases del final"
        PLUGIN_MANUFACTURER_CODE Ivlr
        PLUGIN_CODE              Djec
        FORMATS                  ${DJEC_PLUGIN_FORMATS}
        IS_SYNTH                 FALSE
        NEEDS_MIDI_INPUT         FALSE
        NEEDS_MIDI_OUTPUT        FALSE
        IS_MIDI_EFFECT           FALSE
        VST3_CATEGORIES          Fx
        COPY_PLUGIN_AFTER_BUILD  FALSE)

    juce_generate_juce_header(DJEditCutter)

    # Fuentes del plugin: cualquier .cpp nuevo en source/ o source/ui/ entra solo (reconfigura al compilar).
    file(GLOB DJEC_PLUGIN_SOURCES CONFIGURE_DEPENDS
        "${DJEC_PLUGIN_DIR}/source/*.cpp"
        "${DJEC_PLUGIN_DIR}/source/ui/*.cpp")
    file(GLOB DJEC_PLUGIN_HEADERS CONFIGURE_DEPENDS
        "${DJEC_PLUGIN_DIR}/source/*.h"
        "${DJEC_PLUGIN_DIR}/source/ui/*.h")
    target_sources(DJEditCutter PRIVATE ${DJEC_PLUGIN_SOURCES} ${DJEC_PLUGIN_HEADERS})
    target_include_directories(DJEditCutter PRIVATE "${DJEC_PLUGIN_DIR}/source")

    # PUBLIC: los wrappers (VST3/Standalone) y djec_host_tests tienen que ver las mismas macros.
    target_compile_definitions(DJEditCutter PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_VST3_CAN_REPLACE_VST2=0
        JUCE_DISPLAY_SPLASH_SCREEN=0
        JUCE_STRICT_REFCOUNTEDPOINTER=1)

    # Recursos opcionales (fuentes, imágenes): todo lo que haya en plugin/resources/ se embebe como
    # DjecBinaryData::<nombre> (#include "DjecBinaryData.h").
    file(GLOB_RECURSE DJEC_RESOURCE_FILES CONFIGURE_DEPENDS "${DJEC_PLUGIN_DIR}/resources/*")
    list(FILTER DJEC_RESOURCE_FILES EXCLUDE REGEX "(/\\.|README)")
    if(DJEC_RESOURCE_FILES)
        juce_add_binary_data(djec_binary_data
            HEADER_NAME DjecBinaryData.h
            NAMESPACE   DjecBinaryData
            SOURCES     ${DJEC_RESOURCE_FILES})
        target_link_libraries(DJEditCutter PRIVATE djec_binary_data)
    endif()

    target_link_libraries(DJEditCutter
        PUBLIC
            djec_core
        PRIVATE
            juce::juce_audio_utils
            juce::juce_audio_processors
            juce::juce_audio_formats
            juce::juce_dsp
            juce::juce_gui_extra
        PUBLIC
            juce::juce_recommended_config_flags
            juce::juce_recommended_warning_flags)

    # ----------------------------------------------------------------------------------------------
    # djec_host_tests: consola que enlaza el código compartido del plugin (target DJEditCutter,
    # librería estática "DJ Edit Cutter_SharedCode") y simula un host. Mismo esquema que usa JUCE
    # para los wrappers: se copian los include dirs del código compartido y se enlaza contra él.
    # ----------------------------------------------------------------------------------------------
    if(DJEC_BUILD_TESTS)
        file(GLOB DJEC_HOST_TEST_SOURCES CONFIGURE_DEPENDS "${DJEC_PLUGIN_DIR}/tests/host/*.cpp")
        file(GLOB DJEC_HOST_TEST_HEADERS CONFIGURE_DEPENDS "${DJEC_PLUGIN_DIR}/tests/host/*.h")

        add_executable(djec_host_tests ${DJEC_HOST_TEST_SOURCES} ${DJEC_HOST_TEST_HEADERS})
        target_include_directories(djec_host_tests PRIVATE
            $<TARGET_PROPERTY:DJEditCutter,INCLUDE_DIRECTORIES>
            "${DJEC_PLUGIN_DIR}/tests/third_party"
            "${DJEC_PLUGIN_DIR}/tests/host")
        target_link_libraries(djec_host_tests PRIVATE DJEditCutter)
        target_compile_definitions(djec_host_tests PRIVATE
            DJEC_GOLDEN_DIR="${DJEC_GOLDEN_DIR}"
            DJEC_PLUGIN_SOURCE_DIR="${DJEC_PLUGIN_DIR}"
            DJEC_REPO_ROOT="${DJEC_REPO_ROOT}")
        set_target_properties(djec_host_tests PROPERTIES
            VISIBILITY_INLINES_HIDDEN TRUE
            C_VISIBILITY_PRESET hidden
            CXX_VISIBILITY_PRESET hidden)

        if(TARGET djec_golden_data)
            add_dependencies(djec_host_tests golden)
        endif()

        add_test(NAME djec_host_tests COMMAND djec_host_tests)
        set_tests_properties(djec_host_tests PROPERTIES TIMEOUT 900)
    endif()
endif()

# Resumen de configuración
message(STATUS "DJ Edit Cutter ${PROJECT_VERSION}: plugin=${DJEC_BUILD_PLUGIN} tests=${DJEC_BUILD_TESTS} "
               "standalone=${DJEC_BUILD_STANDALONE} golden=${DJEC_GOLDEN_STATUS}")
