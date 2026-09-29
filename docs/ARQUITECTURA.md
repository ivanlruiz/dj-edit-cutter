# Arquitectura de DJ Edit Cutter

Cómo funciona la app por dentro, qué parámetros usa y por qué, cómo se mide la calidad del análisis y qué precisión
tiene hoy. Para usar la app, ver el [README](../README.md).

## Resumen

Todo corre en el navegador, sin servidor y sin compilación: HTML, CSS y módulos ES servidos tal cual desde GitHub
Pages (`/dj-edit-cutter/`, solo URLs relativas). La lógica pesada es **pura** (sin DOM ni Web Audio) para poder
probarla con `node --test`; la parte de navegador (decodificar, reproducir, workers, canvas) es fina.

```
archivo ─► decode.js ─► AudioBuffer (frecuencia original) ──────────────────────────────┐
              │                                                                          │
              └─► mono 22 050 Hz ─► worker de análisis                                   │
                                     características → límites y último golpe → tempo    │
                                     → beats (DP) → afinado → compases (HMM)             │
                                     = AnalysisResult                                    │
                                              │                                          │
                          bars.js (compases, último compás, corte de N compases)          │
                          meter.js (plan del cambio de compás)                            │
                                              │                                          │
                          edit-plan.js: UNA lista de segmentos de la fuente ◄──────────────┘
                                              │
                          splice.js: empalmes con crossfade + fade out final
                                  │                          │
                           player.js (vista previa      export.js → WAV (wav.js)
                           por tramos, metrónomo)                  → MP3 (workers con lamejs)
                                                                   + ID3 del original (id3.js)
```

## 1. Carga y decodificación (`js/audio/decode.js`)

- `sniffSampleRate` lee la frecuencia de muestreo de la cabecera (WAV, FLAC, MP3 saltando ID3v2, OGG Vorbis/Opus,
  M4A) y se decodifica con un `OfflineAudioContext` a esa frecuencia: la canción **no se remuestrea**. Si no se
  puede leer, se usa 44,1 kHz.
- Para el análisis se hace una mezcla mono y se remuestrea a 22 050 Hz con un FIR sinc·Kaiser de fase lineal, por
  bloques de 65 536 muestras (sin copia mono entera a la frecuencia original). No se usa el remuestreo del navegador:
  Chrome interpola linealmente sin filtro y un tono de 14 kHz reaparecía a 8 kHz.
- Si la mezcla mono queda más de 30 dB por debajo de los canales (estéreo con un canal invertido, R = −L), se
  analiza (L − R)/2 en lugar del promedio.

## 2. Análisis rítmico (`js/analysis/`)

Corre en un worker de módulo (`worker.js`, envuelto en promesas por `client.js`). Si el navegador no puede arrancar
el worker, el análisis se hace en el hilo principal. `AnalysisSession` guarda las características para que las
correcciones del usuario no recalculen el espectro:

- `retrack({ bpmHint, strict })`: rehace beats y compases (botones ×2 / ÷2, tempo manual).
- `relabel({ beatsPerBar, forcedDownbeats })`: rehace solo los compases («Tiempos por compás», «Mover el 1»,
  «Este beat es el 1»).

### 2.1 Preparación (`analyze.js`)

Copia a 22 050 Hz sin valores no finitos y sin componente continua (resta de la media y paso alto de 1 polo a
10 Hz). Con offset DC el RMS nunca baja, así que fallaban los límites y el último golpe.

### 2.2 Características (`features.js`)

| Parámetro | Valor | Por qué |
| --- | --- | --- |
| Trama / salto | 1024 / 256 muestras (46 / 11,6 ms, ≈ 86 tramas/s) | resolución suficiente para beats a ±70 ms con coste bajo |
| Banco de filtros | log-frecuencia, 24 bandas/octava, 30 Hz–11 kHz | estilo madmom; resuelve notas de piano y bajo |
| Flujo espectral | SuperFlux: máximo en frecuencia (3 bandas) sobre una referencia que es el máximo de 3 tramas | menos flujo falso en vibratos y sonidos sostenidos (cuerdas, pads) |
| Blanqueo por banda | τ = 1 s | las bandas que fluctúan siempre pesan menos |
| `onsetLow` | mismo flujo con bandas < 200 Hz | bombo y bajo: evidencia de «1» y de tempo |
| Croma | ventana 2048, salto ×4, 100–4000 Hz | cambio armónico hacia el «1» |
| `rms`, `rmsHigh` | RMS sin DC por trama; banda > 2 kHz | límites y último golpe, también en masters limitados |
| `flatness` | planitud espectral 300–5000 Hz promediada en 0,25 s | distinguir aplausos (ruido plano, ≈ 0,8–0,95) de música |

`onset` y `onsetLow` se dividen por su percentil 99 y valen 0 en las tramas cuya ventana cruza un extremo del archivo
(el relleno de ceros no es un ataque).

### 2.3 Límites y último golpe (`bounds.js`)

- **`musicStart` / `musicEnd`**: RMS en ventanas de 20 ms (salto 10 ms, sin DC) por encima de máximo − 50 dB; con
  ruido de fondo el umbral sube a ruido + 10 dB (tope −35 dB). Hace falta actividad sostenida (≥ 30 ms) para contar.
- **`lastOnset`** (el golpe final, del que cuentan los compases a quitar): el último pico de onset que (a) destaca
  ≥ 3× sobre la media del segundo anterior, (b) supera el 8 % del pico más alto de los 4 s previos (así la cola de un
  acorde que resuena no cuenta) y (c) es un ataque: sube el RMS total ≥ 1,5 dB, **o** sube ≥ 6 dB la banda > 2 kHz,
  **o** es un onset claramente fuerte. Las dos últimas vías existen porque en masters muy limitados o saturados el
  nivel total no sube en el golpe final, y en acordes de ataque lento (pad + voz) tampoco.
- **Aplausos** (`findNoiseTail`): una racha final de ruido plano (planitud ≥ 0,6), con onsets densos (≥ 5/s), sin
  pulso y al menos 4 dB más baja que la música se marca como zona de ruido; dentro de ella solo cuenta un golpe ≥ 4×
  el percentil 75 de las palmas (medido: golpes finales ≥ 5×, palmas ≤ 3,2×).
- **`refineToTransients`**: lleva un tiempo al inicio de la subida de energía más cercana (bloques de 1 ms con
  pre-énfasis, subida ≥ 6 dB). Lo usan los beats y el imán de los empalmes del cambio de compás.

### 2.4 Tempo (`tempo.js`)

Envolvente de periodicidad = onset + ½ onsetLow menos su media local (0,5 s). Tempograma de autocorrelación en
ventanas de 8 s cada 1 s. La saliencia de un retardo L es ACF(L) + 0,5·ACF(2L) + 0,25·ACF(4L), multiplicada por el
espectro de modulación en 1/L (^0,25), lo que reduce los errores de octava. Prior log-normal centrado en
115 BPM (σ = 1,2 octavas). Rango automático: 50–220 BPM. Con `strict`, el tempo queda en [0,8, 1,25] × el indicado.

### 2.5 Beats (`beats-dp.js`, elegido en `beats.js`)

Programación dinámica estilo Ellis con **tempo variable**. Se eligió frente a un tracker DBN con el benchmark:
acierta la octava en canciones lentas (rock a 76, balada a 58, donde el DBN daba ×2), sigue mejor los cambios de
tempo grandes y, con un tempo indicado, recupera material sin ataques.

1. **Camino de tempo**: Viterbi sobre log2(tempo) con un paseo aleatorio (σ = 0,05 octavas/√s) y atracción débil
   al tempo global, limitado a [−0,75, +0,5] octavas (ritardando hasta ≈ 0,6×, acelerando hasta ≈ 1,4×): sigue
   derivas y el ritardando final, pero no puede saltar a ×2 o ÷2 a mitad de canción. La observación es un peine
   métrico (L, subdivisión, 2L y compás) para que una figura 3:2 repetida no parezca un cambio de tempo. En los
   últimos 8 beats el camino se relaja (ritardando, fermata).
2. **Comprobaciones del camino**: si más de la mitad de los beats queda fuera de [0,785, 1,27] × el tempo global
   (el camino se fue a ×2/3 o ×4/3: hemiolias, 6/8), se decodifica otra vez limitado a ese núcleo. Si un tramo de
   ≥ 8 beats va por debajo de 0,71× y sus contratiempos suenan como beats, es la mitad de una sección más rápida
   (cambio de tempo brusco) y se decodifica sin ese nivel.
3. **DP**: `cum[i] = local[i] + max_j (cum[j] − α·ln²((i−j)/τ(i)))` con α = 300 y periodo local τ(t) del camino; una
   segunda pasada re-estima τ con los intervalos de la primera.
4. **Octava**: si los beats alternos son sistemáticamente flojos (paridad < 0,48) se prueba la mitad; si los
   contratiempos superan 0,50 de la fuerza de los beats, el doble. La decisión combina esa evidencia con un prior
   log-normal (115 BPM, σ = 0,8 octavas). Los umbrales pasaron de 0,45 / 0,45 a 0,48 / 0,50: en el benchmark
   corrigió 8 casos (funk y baladas masterizados) y estropeó 1 (rock a 165 con limitador).
5. **Sin pulso claro** (contraste < 2: pads, voz): rejilla de tempo constante y confianza baja.
6. **Bordes**: nada fuera de la música; el último beat decodificado cae en el golpe final (o justo antes si está
   anticipado) y luego se extrapolan como mucho 8 beats por la cola que resuena (no en silencio, no tras un corte
   seco, no sobre aplausos). Esos beats extrapolados se marcan con `tailBeatsFrom`.
7. **Afinado** (`refineBeats`): cada beat va al inicio del ataque real a ±30 ms, pero nunca más de 5 ms más tarde
   que el tracker. Para cortar es más seguro caer un poco antes del golpe que dejar que suene su principio.

### 2.6 Compases (`downbeats.js`)

- **Características por beat**: subida del onset de graves, cambio armónico hacia el beat (a 1 y 2 beats) y acento
  de nivel, normalizadas con media y desviación locales (±12 beats) para que la dinámica no pese. Pesos de la
  evidencia de «1»: graves 0,6, cambio armónico 0,5 + 0,5, acento 0,15.
- **Compás automático**: 3 o 4 según qué periodicidad explica más varianza en ventanas de 24 beats; se elige 3 solo si
  supera a 4 por más de 0,25 (casi todo el rock y el pop es 4/4). 2, 5, 6 y 7 solo si los elige el usuario.
- **HMM** sobre los beats, estado = posición en el compás. Transiciones regulares con probabilidad pequeña de compás
  irregular (un beat menos o uno más: log −5, para directos) y muy pequeña de reinicio (log −14). Tras la primera
  decodificación se aprende una plantilla por posición para esa canción (2 iteraciones de Viterbi).
- **`forcedDownbeats`** son restricciones duras; con ellas las irregularidades cuestan 3× más, así toda la rejilla se
  realinea alrededor del «1» fijado. Un «1» forzado dentro de la cola extrapolada se proyecta compases enteros hacia
  atrás.
- **Confianza**: `beats` sale del contraste de la envolvente en los beats; `bars`, de la separación de la evidencia
  de «1» frente a la mejor alternativa. La interfaz (`confidenceInfo` en `js/ui/format.js`) usa el mínimo de las
  dos (≥ 0,75 «Detección fiable», ≥ 0,5 «aceptable», si no «Revisa la cuadrícula») y además baja a «Revisa» si el
  golpe final no cae en un «1», en el último tiempo de un compás ni justo antes de un «1» (`endConsistency`).

### 2.7 AnalysisResult

Objeto JSON plano definido en el contrato del proyecto: `duration`, `musicStart`, `musicEnd`, `lastOnset`, `bpm`,
`bpmRange`, `beats`, `beatStrength`, `beatsPerBar`, `meterAuto`, `positions`, `downbeats`, `forcedDownbeats`,
`confidence { beats, bars }` y `timingsMs`. Campo añadido: `tailBeatsFrom`, índice del primer beat extrapolado por
la cola final (−1 si no hay); esos beats no cuentan para detectar el compás.

## 3. Modelo de compases (`js/core/bars.js`)

- Un compás va de un «1» al siguiente; los beats antes del primer «1» (anacrusa) no son de ningún compás. El último
  termina en el último beat + el intervalo mediano (tope `musicEnd`).
- **Último compás** = el último cuyo inicio ≤ `lastOnset` + 80 ms: el que contiene el golpe final. Es la referencia
  de «quitar N compases» y el límite del cambio de compás.
- `cutForBarsRemoved(result, n)` corta al inicio del compás (último − n + 1), dejando al menos uno.

## 4. Plan de edición (`js/ui/edit-plan.js`, `js/core/meter.js`)

Los dos modos se combinan en **una lista de segmentos de la fuente** (`buildEditPlan`), que usan igual la exportación,
«Escuchar el final» y «Escuchar con el nuevo compás».

- **Modo 1, quitar compases del final**: un segmento `[0, corte)`. El corte va `CUT_PREROLL_SEC` = **20 ms** antes
  del «1» (`js/audio/edit.js`): tras afinar los beats, el ataque real del «1» puede ir más de 10 ms antes del beat
  detectado; con 8 ms el ataque del «1» quitado se colaba en 8 de 48 cortes de la suite y con 20 ms en 3.
- **Modo 2, recortar cada compás** (`planMeterChange`): compás origen M/4 (el beat es una negra), compás destino
  n/d con d ∈ {2, 4, 8, 16}. Unidad = 1/mcm(4, d) de redonda; k = unidades por beat; S = beats del compás × k;
  T = n × (mcm/d); Δ = T − S. Si Δ < 0 se quitan las últimas |Δ| unidades de cada compás; si Δ > 0 se repiten.
  Ejemplos: 4/4 → 7/8 quita la última corchea; → 3/4 quita el último tiempo; → 5/4 repite el último tiempo;
  → 15/16 quita la última semicorchea. Cada compás usa su propio número de beats (compases irregulares de directo).
  - Los límites dentro de un beat se interpolan linealmente entre beats y después se acercan al ataque real más
    próximo (±25 ms, `refineToTransients` sobre un fragmento), porque el «y» de un shuffle no está en el punto medio.
    El «1» nunca se mueve.
  - Solo se transforman compases completos que terminan antes del límite: el inicio del último compás o, si es
    antes, el corte del modo 1. La anacrusa y el último compás (golpe final y su cola) no se tocan.
  - Cada empalme va `max(CUT_PREROLL_SEC, crossfade/2 + 15 ms)` antes de su límite musical (20 ms con el
    crossfade de 10 ms por defecto, 35 ms con 40 ms), para que el crossfade no llegue al ataque siguiente y el «1»
    suene a ganancia plena.

## 5. Render (`js/audio/splice.js`, `js/audio/edit.js`)

`renderSegments` concatena los segmentos (índice de muestra = round(t · sr); la duración de la salida es la suma de
los segmentos). En cada discontinuidad aplica un crossfade centrado en el empalme (5–40 ms, 10 ms por defecto):

- **adaptado a la correlación** de lo que se mezcla (por canal): ganancias `c·k` y `s·k` con
  k = 1/√(1 + 2ρ·c·s), que es igual potencia para material distinto (ρ = 0) e igual ganancia para material en fase
  (ρ = 1), así el nivel no sube ni baja en el empalme;
- **sin picos nuevos**: si la mezcla superara a la vez el pico de las dos señales y −1 dBFS, se acerca a igual
  ganancia (que nunca supera a ninguna de las dos) lo justo. En masters a −0,3 dBFS el crossfade de igual potencia
  recortaba al exportar.

Los segmentos contiguos se copian sin tocar (bit a bit). El fade out final usa las mismas curvas que el modo 1
(`fadeGain` de `edit.js`: lineal, suave = coseno elevado, exponencial = recta en dB hasta −60 dB) y dura como mínimo
5 ms (rampa anticlic). Con `{ from, to }` se renderiza solo un tramo de la salida, idéntico muestra a muestra al
mismo tramo del render completo: lo usan la vista previa y la exportación por tramos.

## 6. Exportación (`js/audio/export.js`, `wav.js`, `mp3-worker.js`, `id3.js`)

- La salida se lee por tramos (`segmentSource`): nunca hace falta el edit entero en memoria.
- **WAV** 16 bits (dither TPDF, determinista y en orden de muestras) o 24 bits, construido como `Blob` a partir de
  tramos de 10 s, con un chunk `id3 ` opcional.
- **MP3** con lamejs (`vendor/lame.min.js`, sin modificar) en workers clásicos: 3 en paralelo (2 si el dispositivo
  tiene ≤ 4 GB o pantalla táctil). lamejs no usa reservorio de bits, así que cada frame es independiente: cada worker
  codifica su tramo con 4 frames de calentamiento que se descartan y los tramos se unen frame a frame. Se añade una
  cabecera Info/LAME con el retardo del codificador (576) y el relleno para que los reproductores recorten el
  silencio inicial y final. El MP3 sale a 32/44,1/48 kHz (MPEG-1: 192–320 kbps no existen en MPEG-2); otras
  frecuencias se convierten.
- **ID3**: se copian las etiquetas portables (texto, URL, carátula, letra, valoración) y se descartan las que
  dependen del audio (duración, gapless de iTunes, datos de análisis de otros programas en frames binarios).
- Nombre del archivo: `Canción (7-8, edit -2 compases).mp3`, `Canción (7-8).wav` o `Canción (edit -2 compases).wav`.

## 7. Reproducción (`js/audio/player.js`)

Web Audio. Todos los tiempos públicos están en la línea de tiempo de la canción **original**. El metrónomo usa un
planificador anticipado (150 ms, tic cada 25 ms) con acento en el «1». Las vistas previas se renderizan en tramos de
20 s mientras suenan (el siguiente se prepara cuando quedan menos de 8 s; se solapan 256 muestras con fundidos
complementarios): nunca hay más de unos dos tramos en memoria. Durante «Escuchar con el nuevo compás», el cabezal se
traduce de la salida al original y el metrónomo marca la rejilla nueva.

## 8. Interfaz (`index.html`, `css/app.css`, `js/main.js`, `js/ui/`)

- `main.js` es el controlador: estado, eventos, llamadas al análisis, vista previa y exportación.
- `waveform.js`: canvas con resolución DPR, mipmap de picos (bloques de 256 muestras), cuadrícula, marcador de corte
  y trozos del cambio de compás (solo los visibles, con búsqueda binaria). Toque para ir, arrastre para desplazar,
  pellizco o rueda para el zoom; un deslizamiento vertical en el móvil desplaza la página.
- `format.js` y `edit-plan.js` son puros (textos, formatos con coma decimal, atajos, plan de edición, tap tempo).
- Preferencias (formato, fade, curva, imán, etiquetas, cuánto recortar, suavizado) en `localStorage`; los
  interruptores de los modos no se recuerdan.
- **Caché**: GitHub Pages sirve con `max-age=600`. `index.html` tiene un importmap que añade `?v=N` a todos los
  módulos del hilo principal, más `css/app.css?v=N` y `js/main.js?v=N`; el worker MP3 y lamejs heredan el `?v=` del
  módulo que los carga. Hay que subir N en cada publicación. `tests/deploy-version.test.js` comprueba que el mapa
  cubre todo el grafo de módulos y que las versiones coinciden. El grafo del worker de análisis
  (`js/analysis/worker.js` y sus imports) todavía no está versionado.

## 9. Benchmark (`tools/bench.js`)

### Qué mide

`--analyze` ejecuta el pipeline completo de la app (`analyze()` + `bars.js`) sobre canciones sintéticas con verdad de
referencia (`tests/synth/`) y, opcionalmente, clips reales:

| Columna | Qué es |
| --- | --- |
| beatF | F-measure de los beats a ±70 ms (estilo MIREX) |
| CMLt / AMLt | continuidad de los beats (AMLt acepta ×2, ÷2 y a contratiempo) |
| tempo | BPM dentro de ±4 % del real (sin errores de octava) |
| dbF | F-measure de los «1» a ±70 ms |
| compás | tiempos por compás correctos |
| último | el último compás (el del golpe final) es el correcto |
| corte | `cutForBarsRemoved(result, n)` para n = 1, 2 y 4 cae a menos de 70 ms del «1» correcto |
| onset±70 / \|err\|med | `lastOnset` a menos de 70 ms del golpe final real / error mediano |
| ms/min | milisegundos de análisis por minuto de audio (Node) |

### Conjuntos y variantes

- `--sets`: `suite` (18 casos, `tests/synth/suite.js`; `long_song_4m30` solo con `--long`), `stress` (28), `extra`
  (21: compases de 3/4 y 4/4) y `limits` (9: cambios de tempo bruscos y ritardandos muy fuertes, límites conocidos),
  en `tests/synth/sets.js`. Estilos: rock, pop, punk, funk, shuffle, balada, acústica, piano solo, vals, pad + voz;
  con deriva y jitter de directo, ruido de fondo, reverb y finales con golpe y resonancia, fade out,
  ritardando + fermata, corte seco y golpe anticipado.
- Grupos: `band` (con batería), `nodrums` (sin batería) y `hard` (pad + voz, sin ataques: fuera del objetivo de
  calidad, se informan aparte).
- `--variants`: `none`, `limit12` (limitador brick-wall a −12 dB + ganancia), `clip4` / `clip8` (recorte duro ×4 /
  ×8; `tests/synth/mastering.js`) y `applause` (aplausos tras el golpe final; `tests/synth/live.js`). La verdad
  rítmica no cambia. Con variante, los 3 fade out no cuentan para último compás, corte ni último golpe.
- `--real`: clips reales de `$REAL_AUDIO_DIR` (por defecto `tmp/real-audio/`, ignorada por git): `<nombre>.wav` y
  `<nombre>.madmom.beats.json`. La referencia es la salida de madmom, no una anotación manual, y no tiene verdad de
  último compás. Los clips no están en el repositorio.

### Cómo se ejecuta

```sh
node tools/bench.js --analyze                     # suite, sin variantes (≈ 5 s con la caché de audio)
node tools/bench.js --analyze --sets suite,stress,extra,limits \
  --variants none,limit12,clip4,clip8,applause --real --json resultados.json
node tools/bench.js --analyze --cases punk_180 --variants clip8 --detail   # un caso, una línea por caso
```

El audio sintético se guarda en caché en el directorio temporal del sistema (`--no-cache` para regenerarlo). El modo
antiguo por módulos (`--beats <módulo> [--bars <módulo>]`) sigue disponible para comparar trackers.

## 10. Precisión medida

Medido el 29-09-2026 con el código actual (91 s en total):

```sh
REAL_AUDIO_DIR=… node tools/bench.js --analyze --sets suite,stress,extra,limits \
  --variants none,limit12,clip4,clip8,applause --real
```

Agrupado por tipo de material: `band` y `nodrums` suman `suite`, `stress` y `extra` (sin la canción larga);
`limits` va aparte.

**Sin masterizar (`none`)**

| Grupo | n | beat F | Tempo | Downbeat F | Compás | Último compás | Cortes (1, 2, 4) | Golpe final ±70 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Con batería | 39 | 1.000 | 39/39 | 1.000 | 39/39 | 39/39 | 117/117 | 34/39 |
| Sin batería | 22 | 0.999 | 22/22 | 1.000 | 22/22 | 22/22 | 66/66 | 22/22 |
| Pad + voz (difíciles) | 5 | 0.369 | 0/5 | 0.268 | 3/5 | 2/5 | 2/15 | 3/5 |
| Límites conocidos | 9 | 0.986 | 9/9 | 0.976 | 9/9 | 5/9 | 22/27 | 9/9 |
| Clips reales (vs. madmom) | 5 | 0.909 | 4/5 | 0.719 | 4/5 | – | – | – |

**Con batería y sin batería, por variante**

| Variante | Grupo | beat F | Tempo | Downbeat F | Último compás | Cortes (1, 2, 4) | Golpe final ±70 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| limit12 | con batería (39) | 0.964 | 35/39 | 0.915 | 32/36 | 96/108 | 30/36 |
| limit12 | sin batería (22) | 1.000 | 22/22 | 0.999 | 22/22 | 66/66 | 22/22 |
| clip4 | con batería | 0.973 | 36/39 | 0.941 | 34/36 | 100/108 | 32/36 |
| clip4 | sin batería | 0.999 | 22/22 | 0.998 | 22/22 | 65/66 | 22/22 |
| clip8 | con batería | 0.973 | 36/39 | 0.941 | 33/36 | 99/108 | 32/36 |
| clip8 | sin batería | 0.966 | 20/22 | 0.968 | 22/22 | 62/66 | 22/22 |
| applause | con batería | 1.000 | 39/39 | 1.000 | 36/36 | 108/108 | 33/36 |
| applause | sin batería | 1.000 | 22/22 | 1.000 | 22/22 | 66/66 | 22/22 |

Clips reales por variante (beat F / downbeat F): limit12 0.877 / 0.648, clip4 0.885 / 0.672, clip8 0.844 / 0.514,
applause 0.887 / 0.669.

**Dónde falla** (mismos datos):

- Masterizados: `punk_180` y `s_punk_200` salen a la mitad del tempo con limitador y con recorte, y `s_abrupt_165`
  con limitador; `x3_funk` sale al doble. En los tres primeros la confianza de compases es 0–0,31, así que la app
  avisa. Con clip8, `s_ballad_pad_78` y `s_piano_rubato_72` salen al doble.
- Límites conocidos: los 5 cambios de tempo bruscos salen bien; los 4 ritardandos a 0,5–0,6× antes de la fermata
  fallan el corte de 1 compás (el camino de tempo sigue las corcheas mientras el tempo real cae a la mitad).
- Pad + voz sin ataques: tempo equivocado en los 5 casos.

**¿Avisa la app cuando se equivoca?** Con `confidenceInfo` (la misma regla que la insignia de la interfaz) sobre los
mismos casos y las 5 variantes (script local, no incluido en el repositorio): en `suite` + `stress` + `extra`, los
29 cortes de 1 compás incorrectos muestran «Revisa la cuadrícula» (29/29), y 19 de 289 cortes correctos también
(falsas alarmas). En `limits`, 11 de 20 cortes incorrectos salen sin aviso: todos son los ritardandos a 0,5–0,6×
salvo uno (`l_tc_acoustic_92_122_b22` con aplausos).

### Rendimiento

- Node (benchmark): mediana de 192 ms de análisis por minuto de audio.
- Chromium (`tests/analysis-worker.e2e.mjs`, canción de 4:30): 1255 ms en el worker (características 921 ms, tempo
  43 ms, beats 247 ms, compases 23 ms); el hilo principal no se bloqueó más de 11 ms.

Todo medido en una máquina de escritorio (Chromium sin interfaz); en un móvil será más lento. No se ha medido en
móviles reales.

## 11. Tests

- `npm test`: tests unitarios de Node (`tests/*.test.js`, 246 tests): análisis, compases, cambio de compás,
  empalmes, fades, WAV, ID3, exportación, decodificación, formatos de la interfaz, forma de onda y versión del
  importmap.
- `npm run e2e`: la app completa en Chromium servida bajo `/dj-edit-cutter/`: carga canciones sintéticas, corrige la
  cuadrícula, quita compases, cambia el compás, exporta WAV y MP3 y comprueba los archivos contra la verdad (duración,
  muestras, fade, nivel). `tests/e2e/meter-check.mjs` analiza el audio exportado con el propio análisis de la app para
  comprobar que tiene el compás nuevo. También móvil (360/390 px), tema claro y oscuro, errores de consola y que solo
  haya peticiones GET relativas.
- `tests/analysis-worker.e2e.mjs`: el worker desde una subruta, retrack/relabel, peticiones simultáneas, transferencia
  de muestras, progreso y rendimiento.
- `tests/audio-browser.e2e.mjs`: decodificación sin remuestreo (WAV, MP3 a 48 kHz), mono de análisis, corte,
  WAV/MP3 exportados y decodificados otra vez, etiquetas ID3 y MP3 en paralelo frente a un solo worker.
- CI: `.github/workflows/test.yml` ejecuta `npm test` y, en otra tarea, `npm run e2e:all` con Playwright 1.56.1 y
  Chromium.

## 12. Mapa de archivos

| Archivo | Qué hace |
| --- | --- |
| `index.html` | página única, importmap con `?v=N` |
| `css/app.css` | estilos, tokens claro/oscuro, móvil primero |
| `js/main.js` | controlador de la interfaz |
| `js/ui/waveform.js` | forma de onda en canvas (picos, cuadrícula, corte, trozos, gestos) |
| `js/ui/edit-plan.js` | plan combinado de los dos modos, vista previa, imán, tap tempo, textos (puro) |
| `js/ui/format.js` | formatos, textos, confianza, atajos de teclado (puro) |
| `js/audio/decode.js` | frecuencia nativa, decodificación, mono 22 050 Hz, remuestreo FIR |
| `js/audio/player.js` | reproducción, metrónomo, vistas previas por tramos |
| `js/audio/edit.js` | pre-roll del corte, curvas de fade, `renderEdit` (puro) |
| `js/audio/splice.js` | concatenación con crossfades y fade out, render por tramos (puro) |
| `js/audio/wav.js` | codificador y lector WAV (puro) |
| `js/audio/id3.js` | lectura, filtrado y escritura de ID3v2 (puro) |
| `js/audio/export.js` | exportación WAV/MP3, cabecera LAME, nombre del archivo |
| `js/audio/mp3-worker.js` | worker clásico con lamejs |
| `js/core/bars.js` | compases, último compás, corte de N compases (puro) |
| `js/core/meter.js` | plan del cambio de compás (puro) |
| `js/analysis/analyze.js` | orquestador, `AnalysisSession`, `AnalysisResult` |
| `js/analysis/features.js` | STFT, flujo SuperFlux, croma, RMS, planitud |
| `js/analysis/fft.js` | FFT real y compleja |
| `js/analysis/bounds.js` | límites, último golpe, aplausos, afinado a transitorios |
| `js/analysis/tempo.js` | tempo global y local |
| `js/analysis/beats-dp.js` | seguidor de beats por DP con tempo variable |
| `js/analysis/beats.js` | elección del seguidor y afinado de los beats |
| `js/analysis/downbeats.js` | compás automático y HMM de compases |
| `js/analysis/worker.js`, `client.js` | worker de módulo y su cliente con promesas |
| `vendor/` | lamejs 1.2.1 (LGPL) y sus licencias |
| `tests/synth/` | generador sintético, conjuntos, variantes de master y directo, métricas |
| `tools/bench.js` | benchmark; `tools/make-test-songs.js` escribe WAV de prueba para el e2e |
