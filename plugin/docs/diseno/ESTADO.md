# Estado del plugin

Primera versión completa. Todavía no se probó dentro de FL Studio ni se compiló con MSVC.

Hecho (ver SPEC-PLUGIN.md: la sección "USER DECISION v2" al principio manda sobre el resto):
- Core en C++17 sin JUCE (`plugin/core`): análisis rítmico, compases, cambio de compás, plan de edición, render de
  empalmes, cuadrícula desde el host y ubicación de un archivo. Pruebas de paridad contra la app web (datos golden
  generados con Node).
- Procesador: toma automática al darle Play, reproducción alineada con la línea de tiempo (también lo que dura de
  más con «Alargar»), agregar delante/detrás, detección de cambios en el canal y del tempo, archivo soltado que se
  ubica solo, estado en el proyecto, exportar y arrastrar a FL. `processBlock` sin reservas de memoria (comprobado en
  los tests).
- Interfaz en español (oscura, redimensionable) y herramienta de capturas (`tests/ui`).
- Tests: core (paridad + casos límite), host simulado, diseño de la interfaz; pluginval (strictness 10) en Linux.
- CI (`.github/workflows/plugin.yml`): Linux y Windows (MSVC), artefacto con el VST3 y release con un tag
  `plugin-vX.Y.Z`.
- Guía para el usuario: `plugin/README.md`.

Pendiente:
- Primera ejecución del CI en Windows y prueba real en FL Studio: continuidad de la posición del host, Smart disable,
  PDC, arrastrar al Playlist, escalado de la interfaz.
- Política para borrar tomas viejas (`%APPDATA%\DJ Edit Cutter\Tomas`).
- M4A/AAC en Windows (haría falta un lector de Media Foundation).
