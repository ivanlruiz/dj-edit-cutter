# Target 'golden': ejecuta con Node cada plugin/tools/golden-*.mjs y deja la salida en
# ${DJEC_GOLDEN_DIR} (= <build>/golden). Cada script recibe el directorio de salida como argv[2]:
#     node plugin/tools/golden-xxx.mjs <build>/golden
# (directorio de trabajo: la raíz del repo). Un script solo se vuelve a ejecutar si cambió él
# mismo, algo en plugin/tools/, js/ o tests/synth/, o si falta su sello en <build>/golden/.stamps.
# Si un script falla, el build falla. Sin Node >= 18 (o con -DDJEC_GOLDEN=OFF) el target existe
# pero no hace nada y los tests que necesitan golden se saltan.
#
# Deja definidas para plugin/CMakeLists.txt:
#   DJEC_GOLDEN_ENABLED  TRUE si se generan (los tests dependen entonces de 'golden')
#   DJEC_GOLDEN_STATUS   texto para el resumen de configuración

set(DJEC_GOLDEN_ENABLED FALSE)
set(_djec_reason "")
set(_djec_node_version "")

if(DJEC_GOLDEN)
    find_program(DJEC_NODE_EXECUTABLE NAMES node nodejs DOC "Node.js para generar los datos golden")
    if(DJEC_NODE_EXECUTABLE)
        execute_process(
            COMMAND "${DJEC_NODE_EXECUTABLE}" --version
            OUTPUT_VARIABLE _djec_node_version
            OUTPUT_STRIP_TRAILING_WHITESPACE
            RESULT_VARIABLE _djec_node_rc)
        set(_djec_node_major 0)
        if(_djec_node_version MATCHES "^v([0-9]+)\\.")
            set(_djec_node_major "${CMAKE_MATCH_1}")
        endif()
        if(_djec_node_rc EQUAL 0 AND _djec_node_major GREATER_EQUAL 18)
            set(DJEC_GOLDEN_ENABLED TRUE)
        else()
            set(_djec_reason "Node no sirve ('${_djec_node_version}'); hace falta >= 18")
        endif()
    else()
        set(_djec_reason "Node no encontrado")
    endif()
else()
    set(_djec_reason "DJEC_GOLDEN=OFF")
endif()

if(DJEC_GOLDEN_ENABLED)
    file(GLOB DJEC_GOLDEN_SCRIPTS CONFIGURE_DEPENDS "${DJEC_PLUGIN_DIR}/tools/golden-*.mjs")

    # Entradas de las que dependen los golden: la app web (referencia) y los helpers de tools/.
    file(GLOB_RECURSE DJEC_GOLDEN_INPUTS CONFIGURE_DEPENDS
        "${DJEC_REPO_ROOT}/js/*.js"
        "${DJEC_REPO_ROOT}/js/*.mjs"
        "${DJEC_REPO_ROOT}/tests/synth/*.js"
        "${DJEC_REPO_ROOT}/tests/synth/*.mjs"
        "${DJEC_PLUGIN_DIR}/tools/*.js"
        "${DJEC_PLUGIN_DIR}/tools/*.mjs"
        "${DJEC_PLUGIN_DIR}/tools/*.json")

    set(_djec_golden_stamps "")
    foreach(_script IN LISTS DJEC_GOLDEN_SCRIPTS)
        get_filename_component(_name "${_script}" NAME_WLE)
        set(_stamp "${DJEC_GOLDEN_DIR}/.stamps/${_name}.stamp")
        add_custom_command(
            OUTPUT  "${_stamp}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${DJEC_GOLDEN_DIR}/.stamps"
            COMMAND "${DJEC_NODE_EXECUTABLE}" "${_script}" "${DJEC_GOLDEN_DIR}"
            COMMAND "${CMAKE_COMMAND}" -E touch "${_stamp}"
            DEPENDS "${_script}" ${DJEC_GOLDEN_INPUTS}
            WORKING_DIRECTORY "${DJEC_REPO_ROOT}"
            COMMENT "Golden: node plugin/tools/${_name}.mjs"
            VERBATIM)
        list(APPEND _djec_golden_stamps "${_stamp}")
    endforeach()

    list(LENGTH DJEC_GOLDEN_SCRIPTS _djec_golden_count)
    # Sin COMMAND: solo agrupa los sellos (un build sin cambios no ejecuta nada).
    add_custom_target(golden DEPENDS ${_djec_golden_stamps})
    set(DJEC_GOLDEN_STATUS "node ${_djec_node_version}, ${_djec_golden_count} script(s)")
else()
    add_custom_target(golden
        COMMAND "${CMAKE_COMMAND}" -E echo "golden: ${_djec_reason}; los tests de paridad se saltan."
        VERBATIM)
    set(DJEC_GOLDEN_STATUS "off (${_djec_reason})")
endif()
