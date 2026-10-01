# Herramienta de capturas del editor: djec_ui_snapshot crea el procesador, simula a FL tomando una canción sintética,
# abre el editor y guarda PNG de cada estado (vacío, tomando, listo, archivo, detectado…) en <build>/ui-snapshots.
# También comprueba el diseño (nada se sale ni se pisa, ningún texto queda cortado); en CTest corre sin PNG.
# La incluye plugin/CMakeLists.txt solo si existe este archivo (dentro del bloque DJEC_BUILD_PLUGIN).

add_executable(djec_ui_snapshot "${CMAKE_CURRENT_LIST_DIR}/snapshot.cpp")
target_include_directories(djec_ui_snapshot PRIVATE $<TARGET_PROPERTY:DJEditCutter,INCLUDE_DIRECTORIES>)
target_link_libraries(djec_ui_snapshot PRIVATE DJEditCutter)
target_compile_options(djec_ui_snapshot PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/bigobj>)
target_compile_definitions(djec_ui_snapshot PRIVATE DJEC_UI_SNAPSHOT_DIR="${CMAKE_BINARY_DIR}/ui-snapshots")
set_target_properties(djec_ui_snapshot PROPERTIES
    VISIBILITY_INLINES_HIDDEN TRUE
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden)

if(DJEC_BUILD_TESTS)
    add_test(NAME djec_ui_layout COMMAND djec_ui_snapshot --no-png)
    set_tests_properties(djec_ui_layout PROPERTIES TIMEOUT 300)
endif()
