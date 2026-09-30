# Target 'golden': ejecuta con Node cada plugin/tools/golden-*.mjs y deja la salida en
# ${DJEC_GOLDEN_DIR} (= <build>/golden). Cada script recibe el directorio de salida como argv[2]:
#     node plugin/tools/golden-xxx.mjs <build>/golden
# (directorio de trabajo: la raíz del repo). Un script solo se vuelve a ejecutar si cambió él
# mismo, algo en plugin/tools/, js/ o tests/synth/, o si falta su sello en <build>/golden/.stamps.
# Si un script falla, el build falla. Sin Node (o con -DDJEC_GOLDEN=OFF) el target existe pero no
# hace nada y los tests que necesitan golden se saltan.

set(DJEC_GOLDEN_STATUS "off")

if(DJEC_GOLDEN)
    find_program(DJEC_NODE_EXECUTABLE NAMES node nodejs DOC "Node.js para generar los datos golden")
endif()

if(DJEC_GOLDEN AND DJEC_NODE_EXECUTABLE)
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
    add_custom_target(golden
        COMMAND "${CMAKE_COMMAND}" -E echo "golden: ${_djec_golden_count} script(s) -> ${DJEC_GOLDEN_DIR}"
        DEPENDS ${_djec_golden_stamps}
        VERBATIM)
    # Marcador: los targets de test dependen de 'golden' solo si existe este target.
    add_custom_target(djec_golden_data)
    add_dependencies(djec_golden_data golden)
    set(DJEC_GOLDEN_STATUS "node (${_djec_golden_count} scripts)")
else()
    if(DJEC_GOLDEN)
        set(_djec_reason "Node no encontrado")
    else()
        set(_djec_reason "DJEC_GOLDEN=OFF")
    endif()
    add_custom_target(golden
        COMMAND "${CMAKE_COMMAND}" -E echo "golden: ${_djec_reason}; los tests de paridad se saltan."
        VERBATIM)
    set(DJEC_GOLDEN_STATUS "off (${_djec_reason})")
endif()
