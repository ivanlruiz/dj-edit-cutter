# Estado del plugin (pausado)

Trabajo en curso, pausado a pedido del usuario. Todavía no compila un plugin funcional.

Hecho:
- Decisiones de diseño con el usuario: efecto VST3 para el Mixer de FL Studio (Windows), toma el audio automáticamente
  al darle Play (como Edison, sin botón), opción de soltar un archivo que se ubica solo en la línea de tiempo, compases
  de la cuadrícula de FL o detectados del audio, recorte de cada compás (½ tiempo → 7/8 por defecto) y quitar compases
  del final, vuelve a tomar el audio si cambia el tempo o el audio del canal. Ver SPEC-PLUGIN.md (la sección
  "USER DECISION v2" al principio manda sobre el resto).
- Inicio del proyecto CMake con JUCE 8.0.15 (plugin/CMakeLists.txt, plugin/cmake/*) y doctest vendorizado.

Pendiente (en este orden): esqueleto del plugin + CI de Windows, traducción a C++ del análisis y del motor de recorte
con pruebas de paridad contra la web, procesador (toma automática, reproducción sincronizada, estado), interfaz en
español, pruebas que simulan un host, pluginval, README para el usuario.
