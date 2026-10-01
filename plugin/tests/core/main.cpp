// Runner de doctest para djec_core_tests. Los tests van en plugin/tests/core/*_test.cpp (entran solos
// por GLOB). Macros disponibles (rutas absolutas con '/'):
//   DJEC_GOLDEN_DIR         <build>/golden: salida de plugin/tools/golden-*.mjs (puede no existir)
//   DJEC_GOLDEN_ENABLED     1 si el build genera los golden (hay Node), 0 si no
//   DJEC_PLUGIN_SOURCE_DIR  plugin/
//   DJEC_REPO_ROOT          raíz del repo
// Un test que necesite un archivo golden que no existe debe saltarse (MESSAGE + return), no fallar.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest.h>
