// Colores y medidas de la interfaz: los tokens del tema oscuro de la app web (css/app.css, prefers-color-scheme: dark)
// y de su forma de onda (--wf-*). Un solo lugar para que el plugin se vea como la web.
#pragma once

#include <juce_graphics/juce_graphics.h>

namespace djec::ui::theme
{

// ---- superficie y texto ----
inline const juce::Colour bg { 0xff080c11 };
inline const juce::Colour surface { 0xff10161e };
inline const juce::Colour surface2 { 0xff151d27 };
inline const juce::Colour surface3 { 0xff1b2531 };
inline const juce::Colour border { 0xff232f3d };
inline const juce::Colour borderStrong { 0xff33424f };
inline const juce::Colour text { 0xffe8eef5 };
inline const juce::Colour muted { 0xff96a5b6 };

// ---- acentos ----
inline const juce::Colour accent { 0xff22c7ee };      // cian (toma, interruptores)
inline const juce::Colour accent2 { 0xff3b9bff };
inline const juce::Colour accentSoft { 0xff10283a };
inline const juce::Colour onAccent { 0xff04121a };
inline const juce::Colour primary { 0xff1f6fd6 };     // botón principal (exportar)
inline const juce::Colour cut { 0xffff6a3d };         // naranja: quitar compases del final
inline const juce::Colour cutSoft { 0xff3a1a10 };
inline const juce::Colour onCut { 0xff1a0903 };
inline const juce::Colour ok { 0xff3ddc97 };
inline const juce::Colour okSoft { 0xff0e2a20 };
inline const juce::Colour warn { 0xfffbbf24 };
inline const juce::Colour warnSoft { 0xff2d2208 };
inline const juce::Colour danger { 0xffff8a80 };
inline const juce::Colour dangerSoft { 0xff34120f };
inline const juce::Colour meter { 0xffa78bfa };       // violeta: recortar cada compás
inline const juce::Colour meterSoft { 0xff211a3a };
inline const juce::Colour onMeter { 0xff12092b };
inline const juce::Colour focus { 0xff62e3ff };

// ---- forma de onda ----
namespace wf
{
inline const juce::Colour bg { 0xff06090d };
inline const juce::Colour ruler { 0xff0c131b };
inline const juce::Colour peak { 0xff1c7fe6 };
inline const juce::Colour core { 0xff62e3ff };                       // --wf-rms (centro brillante)
inline const juce::Colour removed { 0xff2c3642 };                    // audio que se quita (modo 1)
inline const juce::Colour removedCore { 0xff45515e };
inline const juce::Colour dim = juce::Colour (6, 9, 13).withAlpha (0.40f);
inline const juce::Colour hatch = juce::Colours::white.withAlpha (0.05f);
inline const juce::Colour beat = juce::Colours::white.withAlpha (0.15f);
inline const juce::Colour downbeat = juce::Colours::white.withAlpha (0.60f);
inline const juce::Colour barNum { 0xffd8e7f6 };
inline const juce::Colour text { 0xff7f91a5 };
inline const juce::Colour cutLine { 0xffff6a3d };
inline const juce::Colour cutText { 0xff1a0903 };
inline const juce::Colour fade = juce::Colour (255, 106, 61).withAlpha (0.28f);
inline const juce::Colour playhead { 0xffffffff };
inline const juce::Colour window = juce::Colour (98, 227, 255).withAlpha (0.13f);
inline const juce::Colour windowBorder { 0xff62e3ff };
inline const juce::Colour centre = juce::Colours::white.withAlpha (0.07f);
inline const juce::Colour meterRemoved = juce::Colour (255, 77, 77).withAlpha (0.24f);
inline const juce::Colour meterHatch = juce::Colour (255, 120, 120).withAlpha (0.80f);
inline const juce::Colour meterRepeat = juce::Colour (61, 220, 151).withAlpha (0.20f);
inline const juce::Colour meterRepeatEdge { 0xff3ddc97 };
} // namespace wf

// ---- medidas (px lógicos; JUCE escala todo con el factor de pantalla del host) ----
constexpr float radius = 12.0f;      // tarjetas (la web usa 16 px en móvil; más compacto en un plugin)
constexpr float radiusSm = 8.0f;     // botones, entradas
constexpr int gap = 10;              // entre tarjetas
constexpr int pad = 12;              // dentro de una tarjeta
constexpr int controlH = 30;         // botones, entradas, chips
constexpr int rowGap = 8;

// ---- tipografía (tamaños en px de JUCE, alto de la fuente) ----
constexpr float fontBody = 14.5f;
constexpr float fontSmall = 13.0f;
constexpr float fontTiny = 11.5f;
constexpr float fontTitle = 15.5f;   // títulos de panel
constexpr float fontStatus = 17.0f;  // línea de estado
constexpr float fontBrand = 20.0f;

} // namespace djec::ui::theme
