# DJ Edit Cutter para FL Studio (plugin VST3)

El mismo DJ Edit Cutter de la [app web](https://ivanlruiz.github.io/dj-edit-cutter/), pero dentro de FL Studio: un
efecto que pones en un canal del **Mixer**. Hace las dos cosas de la web, por separado o juntas:

1. **Recortar cada compás** (cambiar el compás). Quita un trozo del final de *cada* compás, o lo repite: de 4/4 a 7/8,
   3/4, 2/4, 15/16, 5/4 o el compás que quieras. No estira el tiempo: corta trozos de audio y los empalma con
   crossfades cortos, como los edits de «canción X pero en 7/8».
2. **Quitar compases del final**. Corta unos compases antes del final, con un fade out ajustable.

Funciona como Edison: la primera vez que le das Play, el plugin **toma el audio** del canal (mientras tanto escuchas
el original). Cuando paras, prepara el recorte, y desde el siguiente Play el canal **suena recortado**, alineado con
la línea de tiempo de FL. Después puedes arrastrar el resultado al Playlist o exportarlo como WAV.

Todo se procesa en tu ordenador: el plugin no se conecta a internet.

> **Estado:** el plugin pasa sus pruebas automáticas en Linux y se compila y se prueba automáticamente en Windows,
> pero **todavía no se ha probado dentro de FL Studio**. Si algo no funciona como se describe aquí, avisa (ver
> [Si algo falla](#si-algo-falla)).

## Requisitos

- Windows 10 u 11 de 64 bits.
- FL Studio 20 o más nuevo, de 64 bits (el plugin es VST3).

## Instalación

1. **Descarga el .zip.**
   - Versiones publicadas: en [Releases](https://github.com/ivanlruiz/dj-edit-cutter/releases), el archivo
     `DJ-Edit-Cutter-X.Y.Z-VST3-Windows.zip`.
   - Última versión en desarrollo: en [Actions](https://github.com/ivanlruiz/dj-edit-cutter/actions), entra en la
     última ejecución en verde de «Plugin VST3» y descarga el artefacto `DJ-Edit-Cutter-VST3-Windows` (hace falta
     iniciar sesión en GitHub, y los artefactos se borran pasado un tiempo: 90 días si no se cambió).
2. Si Windows bloqueó el .zip descargado: clic derecho en el .zip › **Propiedades** › marca **Desbloquear** ›
   **Aceptar**.
3. **Descomprímelo.** Dentro hay una carpeta `DJ Edit Cutter.vst3` y un `LEEME.txt`.
4. **Copia la carpeta `DJ Edit Cutter.vst3` entera** en `C:\Program Files\Common Files\VST3`. Windows te pedirá
   permiso de administrador: acéptalo. (Copia la carpeta tal cual: no saques nada de dentro.)
5. En FL Studio ve a **Options › Manage plugins** y pulsa el botón que busca plugins nuevos (**Find plugins**, **Find
   installed plugins** o **Start scan**, según la versión de FL). Espera a que termine: «DJ Edit Cutter» aparece en la
   lista de efectos (fabricante: ivanlruiz).

Para actualizar, cierra FL Studio y reemplaza la carpeta por la nueva.

## Cómo se usa

### 1. Pon el plugin en el canal

1. Pon tu audio en el Playlist y mándalo a un canal del **Mixer** (una pista de guitarra, de piano…, o el Master con
   la canción entera).
2. En ese canal, haz clic en un slot vacío y elige **DJ Edit Cutter**. Lo que haya en los slots de arriba (EQ,
   compresor…) entra en la toma; lo que pongas debajo procesa el audio ya recortado.
3. Usa FL en modo **Song** (no Pattern), para que FL avance por la línea de tiempo sin volver atrás.

### 2. Dale Play: el plugin toma el audio

Dale Play en FL desde donde empieza lo que quieres editar (normalmente, desde el principio de la canción) y deja que
suene **de corrido hasta el final**. Mientras tanto escuchas el original y el plugin dice, por ejemplo,
«Tomando el audio… 0:42 · 21 compases (escuchas el original)».

- Si saltas a otra parte o haces un bucle, la toma se queda con lo que sonó hasta el salto.
- Una toma dura como máximo **15 minutos**.

### 3. Para FL

Al parar, el plugin dice «Procesando…» y enseguida «Listo: desde el próximo Play suena recortado.». Verás la forma
de onda con la cuadrícula: líneas finas en cada tiempo y números en cada «1» (inicio de compás).

### 4. Elige el recorte

- Panel **2 · Recortar cada compás** (activado por defecto): elige cuánto quitar de cada compás. Cada botón dice el
  compás que resulta (los ejemplos son para 4/4): **½ tiempo (corchea) → 7/8** (por defecto), **1 tiempo → 3/4**,
  **2 tiempos → 2/4**, **¼ tiempo (semicorchea) → 15/16**, **Alargar: repetir el último tiempo → 5/4** y
  **Otro compás…**. En la onda, lo que se quita se ve en **rojo** y lo que se repite en **verde** («×2»).
  **Suavizado de empalmes** (5–40 ms, por defecto 10 ms) es el crossfade de cada empalme: si oyes clics, súbelo.
- Panel **3 · Quitar compases del final** (desactivado por defecto): elige cuántos compases quitar, el **Fade out**
  (en beats) y la **Curva del fade** (Lineal, Suave o Exponencial).

Como en la web, siempre se quita o se repite el **final** de cada compás: el «1» queda entero.

### 5. Pon el compás del proyecto de FL

El plugin te dice qué compás poner, por ejemplo «Pon el compás del proyecto de FL en 7/8 para que la cuadrícula
coincida». Cámbialo en FL (en **Options › Project general settings**, el compás del proyecto, *Time signature*): así
los compases del Playlist coinciden con el audio recortado. Cambiar el compás de FL no borra la toma.

### 6. Dale Play otra vez: suena recortado

Dentro de lo tomado, el canal suena recortado y alineado con FL («Suena recortado.»). Como el audio recortado dura
menos, al final de la toma queda un silencio. Con **Alargar** pasa lo contrario: el audio editado dura más que la
toma y sigue sonando después de su final.

Con **Original / Editado** (arriba a la derecha) comparas al instante: «Original» deja pasar el audio del canal tal
cual.

### 7. Llévate el resultado

- **Arrastrar a FL**: pulsa el botón y, sin soltar, arrástralo al Playlist (o a un canal). El plugin guarda un WAV
  de 24 bits en `Documentos\DJ Edit Cutter` y FL lo importa. Cada recorte nuevo crea un archivo nuevo: nunca se
  pisa uno que FL ya esté usando.
- **Exportar WAV…**: elige 16 o 24 bits y dónde guardarlo. El nombre sugerido incluye el compás y el corte, por
  ejemplo `Guitarra (7-8, edit -2 compases).wav`.
- **Exportar desde FL** (File › Export › Wave file…) también incluye el audio recortado: el plugin lo reproduce
  durante la exportación.

Si pones el audio recortado en el Playlist **en el mismo canal**, quita el plugin de ese canal (o desactívalo): si no,
el plugin oye un audio distinto del que tomó y lo vuelve a tomar.

### Suelta un archivo (opcional)

En vez de dejar sonar toda la canción, puedes **soltar el archivo** sobre el plugin (desde el Explorador de Windows o
desde el Browser de FL): WAV, AIFF, FLAC, OGG, MP3 o WMA. El plugin lo tiene entero al instante; solo falta saber
dónde está en la línea de tiempo:

1. Suelta el archivo. El plugin dice «Dale Play en FL: busco dónde suena «…» en el canal.».
2. Dale Play donde suena esa canción en el canal. En unos segundos la encuentra: «Ubicado: el archivo empieza en el
   compás 5». Desde el siguiente Play suena recortado.
3. Si no la encuentra en unos 8 segundos, avisa: «No encuentro este audio en el canal. ¿Pusiste el plugin en el canal
   correcto?». Si el archivo empieza al principio del proyecto, pulsa **El archivo empieza en el compás 1**.

Con un archivo, el plugin reproduce el archivo: lo que haya en los slots de arriba no se aplica a lo recortado. M4A/AAC
no se puede leer: conviértelo a WAV, FLAC o MP3, o deja que el plugin tome el audio del canal. El archivo se guarda en
el proyecto por su ruta: si lo mueves o lo borras, el plugin vuelve a tomar el audio del canal.

### El plugin vuelve a tomar el audio solo

- **Si cambia el audio del canal** (otro clip, el fader o un efecto antes del plugin), lo nota en más o menos un
  segundo mientras suena: avisa «El audio del canal cambió: lo vuelvo a tomar» y vuelve a tomar desde ahí.
- **Si cambias el tempo del proyecto**, vuelve a tomar el audio: desde ahí si FL está sonando, o en el siguiente Play
  si está parado (no estira el tiempo para adaptarlo). Lo mismo si cambias la frecuencia de muestreo.
- **Si das Play antes del principio de la toma** y llega de corrido hasta ella, añade lo que faltaba delante; si
  sigue sonando después del final, añade lo de detrás («Tomando lo que faltaba…»).
- **Volver a tomar el audio** borra la toma a mano: desde el siguiente Play la toma de nuevo.

El silencio no cuenta como cambio: si silencias el canal o borras el clip, la toma se queda. En ese caso pulsa
**Volver a tomar el audio**.

### Al abrir el proyecto otra vez

El plugin guarda sus ajustes en el proyecto de FL y la toma como WAV en `%APPDATA%\DJ Edit Cutter\Tomas`. Al abrir el
proyecto vuelve a preparar el recorte solo. Si ese WAV ya no está, te pide que le des Play para volver a tomarlo.

## Los compases: de FL o detectados

Panel **1 · Compases**:

- **Cuadrícula de FL** (por defecto): los compases salen del proyecto de FL (tempo, compás e inicio de compás). Es lo
  mejor para audio grabado a tempo con el proyecto. Si el «1» no cae donde debe (por ejemplo, una anacrusa), usa
  **Mover el 1** ◀ ▶ para moverlo un tiempo.
- **Detectar del audio**: el plugin busca los beats y los compases en el audio tomado, como la app web. Úsalo para
  grabaciones en vivo o canciones importadas que no siguen el tempo de FL. Las correcciones son las de la web:

| Problema | Qué hacer |
| --- | --- |
| La cuadrícula va al doble o a la mitad del ritmo | **Tempo ×2** o **Tempo ÷2** |
| Va a otro ritmo | Escribe el tempo en **Tempo manual** (o márcalo con **Marcar tempo**) y pulsa **Aplicar** |
| La canción es de 3 (vals) o de otro compás | **Tiempos por compás**: Auto, 2, 3, 4, 5, 6 o 7 |
| El «1» está corrido | **Mover el 1** ◀ ▶, o pon el cabezal de FL sobre un «1» de verdad y pulsa **Este beat es el 1** |
| Quieres volver a empezar | **Restablecer** |

Escucha siempre el resultado (con el metrónomo de FL si hace falta) antes de exportar, sobre todo si ves
«Revisa la cuadrícula».

## Limitaciones

- **No estira el tiempo.** Quita o repite trozos de audio, así que las voces y las notas largas se cortan en cada
  empalme. Es el sonido típico de estos edits; un suavizado más largo lo disimula, pero no lo evita.
- **Tiene que escuchar la canción una vez.** Un efecto del Mixer solo recibe el audio mientras FL lo reproduce (el
  plugin no usa ARA), así que la primera pasada es en tiempo real. Para no esperar, suelta el archivo.
- **15 minutos como máximo** por toma o por archivo.
- **Fuera de lo tomado suena el original.** Si das Play en una parte que no se tomó, el plugin avisa: «Esta parte
  todavía no fue tomada: dale Play desde el principio.».
- Con **Cuadrícula de FL**, el audio tiene que seguir el tempo del proyecto. Si no, usa **Detectar del audio**.
- **Las tomas ocupan espacio en disco** (un WAV de 32 bits: unos 115 MB por cada 5 minutos en estéreo a 48 kHz) y el
  plugin no las borra cuando un proyecto las usa. Si necesitas espacio, borra las viejas de
  `%APPDATA%\DJ Edit Cutter\Tomas` (los proyectos que las usaban te pedirán volver a tomar el audio). Lo mismo con
  los WAV de **Arrastrar a FL** en `Documentos\DJ Edit Cutter`.
- **Probado en Linux y compilado y probado automáticamente en Windows, pero no dentro de FL Studio todavía.**

## Si algo falla

| Qué pasa | Qué hacer |
| --- | --- |
| FL no encuentra el plugin | Comprueba que existe `C:\Program Files\Common Files\VST3\DJ Edit Cutter.vst3\Contents\x86_64-win\DJ Edit Cutter.vst3`. Desbloquea el .zip (paso 2 de la instalación), vuelve a copiar la carpeta y vuelve a buscar plugins en **Options › Manage plugins**. Hace falta FL de 64 bits. |
| Le doy Play y sigue diciendo «Dale Play en FL…» | El plugin tiene que estar en el canal del Mixer por el que sale tu audio. Revisa a qué canal va el clip, que el canal no esté silenciado y que el plugin no esté desactivado (bypass). |
| «Saltaste a otra parte mientras tomaba el audio» | Hubo un salto o un bucle. Usa el modo Song, quita el bucle y deja que suene de corrido. |
| «Esta parte todavía no fue tomada» | Dale Play desde el principio de lo que quieres editar y deja que llegue de corrido. |
| «El audio del canal cambió» aparece en cada Play | Algo antes del plugin cambia en cada pasada (automatización, un efecto con modulación aleatoria…). Pon DJ Edit Cutter en el primer slot del canal, o suelta el archivo. |
| Los compases no caen donde deben | Con **Cuadrícula de FL**: **Mover el 1**. Si la canción no sigue el tempo de FL: **Detectar del audio**. |
| Oigo clics en los empalmes | Sube **Suavizado de empalmes**. |
| «No puedo leer archivos M4A/AAC…» | Convierte el archivo a WAV, FLAC o MP3, o deja que el plugin tome el audio del canal. |
| No encuentra el archivo soltado | Comprueba que esa canción suena en ese canal; si empieza al principio del proyecto, pulsa **El archivo empieza en el compás 1**. |

Para avisar de un problema, abre un *issue* en <https://github.com/ivanlruiz/dj-edit-cutter/issues> con tu versión de
FL Studio, lo que hiciste y el texto exacto que mostró el plugin.

Para compilar el plugin o colaborar, mira [README-dev.md](README-dev.md).
