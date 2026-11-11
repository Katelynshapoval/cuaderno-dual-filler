# Cuaderno Dual

Extensión de Chrome que rellena el cuaderno de seguimiento de FP Dual del portal del Gobierno de Aragón (`aplicaciones.aragon.es`). Eliges un intervalo de fechas, tus horas y una descripción, y la extensión va guardando los días uno a uno en el formulario de **Desarrollo**, como si pulsaras **Nueva** tú.

- Puedes poner horas distintas para cada día de la semana, o subir el PDF de tu calendario FP Dual para que use las horas de cada tipo de día y se salte festivos y vacaciones.
- En la descripción puedes usar `{fecha}`, `{dia}` y `{horas}`, que cambian en cada día.
- Los días que ya están registrados no se tocan: si el portal pasa a **Actualizar** porque esa fecha ya existe, la extensión se salta ese día sin modificarlo, vuelve al formulario de Nueva y sigue con el siguiente. Al terminar te dice cuántos días estaban ya registrados.
- Todo se hace en tu navegador: no se envía nada a ningún servidor aparte del propio portal.

## Instalación

Necesitas Google Chrome (también funciona en Edge, Brave y otros navegadores basados en Chromium).

### 1. Descarga el código

Con Git:

```bash
git clone https://github.com/Katelynshapoval/cuaderno-dual-filler.git
```

Sin Git: entra en [el repositorio](https://github.com/Katelynshapoval/cuaderno-dual-filler), pulsa **Code → Download ZIP** y descomprímelo en una carpeta que no vayas a borrar (por ejemplo, en Documentos).

> Chrome carga la extensión desde esa carpeta cada vez que se abre, así que no la borres ni la muevas después de instalarla.

### 2. Carga la extensión en Chrome

1. Abre `chrome://extensions` en la barra de direcciones (en Edge: `edge://extensions`).
2. Activa el **Modo de desarrollador** (interruptor arriba a la derecha).
3. Pulsa **Cargar descomprimida**.
4. Elige la carpeta `cuaderno-dual-filler`, la que contiene el archivo `manifest.json`.
5. Aparecerá **Cuaderno Dual** en la lista. Pulsa el icono del puzle de la barra de Chrome y fija la extensión con la chincheta para tener el icono siempre a mano.

Si Chrome muestra un aviso sobre extensiones en modo de desarrollador al abrirse, es normal: ciérralo y ya está.

## Uso

1. Entra en el portal, abre tu cuaderno y ve a la página de **Desarrollo** (la que tiene Fecha, Horas, Descripción y el botón Nueva).
2. Pulsa el icono de la extensión. Se abre el panel a la derecha (no se abre solo al entrar en la web).
3. **Fechas**: elige el intervalo o usa los atajos (Hoy, Esta semana, Semana pasada, Este mes).
4. **Horario**: escribe las horas de cada día de la semana. Los días con 0 horas se saltan. Si tienes el PDF del calendario FP Dual, súbelo y ajusta las horas de cada tipo de día.
5. **Descripción**: escribe lo que has hecho. Observaciones y dificultades son opcionales.
6. Revisa el resumen de abajo (días, horas e intervalo) y pulsa **Rellenar**.

Deja la pestaña abierta mientras se rellena: el portal recarga la página después de cada día y el panel vuelve a aparecer para enseñarte el progreso. Puedes **Parar** en cualquier momento y **Continuar** después; los días ya guardados se quedan en el portal.

Si el portal rechaza un día, el panel te dice el motivo. Puedes corregirlo y pulsar **Continuar**, o **Saltar este día**.

El calendario PDF solo se guarda en memoria: si recargas la página tendrás que subirlo otra vez.

## Cómo actualizar

Cuando haya una versión nueva:

**Si lo descargaste con Git**, entra en la carpeta y trae los cambios:

```bash
cd cuaderno-dual-filler
git pull
```

**Si lo descargaste en ZIP**, descarga el ZIP otra vez y sustituye el contenido de la carpeta antigua por el nuevo (en la misma ubicación, para que Chrome la siga encontrando).

Después, en los dos casos:

1. Abre `chrome://extensions`.
2. Pulsa el botón de recargar (la flecha circular) en la tarjeta de **Cuaderno Dual**.
3. Recarga la pestaña del portal si la tenías abierta.

Puedes comprobar la versión instalada en la tarjeta de la extensión, en `chrome://extensions`.

## Problemas frecuentes

- **Sale "Esta página no es el cuaderno"**: el panel solo funciona en páginas de `aplicaciones.aragon.es`. Pulsa **Abrir el portal**, entra en tu cuaderno y vuelve a pulsar el icono.
- **Sale "No he podido abrir el panel"**: recarga la página del portal y vuelve a pulsar el icono.
- **"No encuentro el formulario de Desarrollo"**: asegúrate de estar en la página de Desarrollo de tu cuaderno, no en el listado de cuadernos.
- **"El portal se ha quedado en modo Actualizar"**: pulsa **Volver** en el portal, entra otra vez en Desarrollo y pulsa **Continuar** en el panel.
- **Error en la tarjeta de la extensión tras actualizar**: pulsa recargar en `chrome://extensions`. Si sigue, quítala y vuelve a cargarla con **Cargar descomprimida**.

## Desarrollo

Pruebas de la lógica (necesitan Node 18 o superior):

```bash
node --test test/plan.test.js test/calendar.test.js
```

Las pruebas del panel y del rellenado están en `test/harness.html` y `test/portal.html` (una réplica del formulario del portal). Sírvelas con un servidor local, por ejemplo `python -m http.server`, y ábrelas en el navegador: el resultado aparece como `PASS` o `FAIL`.
