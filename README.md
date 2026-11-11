# CineTub-ForAll

Convierte tu página web en una sala de video compartida. Prepara una lista de videos de YouTube, controla la emisión desde el panel de administración y permite que tu comunidad vea el mismo contenido al mismo tiempo.

Puedes alojar el software en tu propio servidor e insertar el reproductor en tu sitio mediante un iframe.

## Una programación para toda tu comunidad

El administrador agrega videos con su título, enlace y duración. Desde el panel puede iniciar o pausar la emisión, saltar al siguiente video y cambiar la posición de reproducción.

Cada espectador se incorpora al video que está en curso. El servidor mantiene el reloj de la emisión y corrige los desfases entre los reproductores. El volumen y el silencio se controlan de forma individual.

Cuando termina un video, el servidor elige al azar entre los que quedan por reproducir en ese ciclo. Al completar la lista, comienza un nuevo ciclo.

## Qué incluye

- Panel de administración protegido por contraseña.
- Gestión de la lista de videos y controles de reproducción.
- Reproducción sincronizada para los espectadores conectados.
- Reproductor público adaptable e integrable en tu página.
- Guardado de la lista y del estado de reproducción.
- Conteo de clientes conectados.

## Instalación local

Descarga el código y abre una terminal en la carpeta `server`. Utiliza un entorno compatible con la versión mínima indicada en el campo `engines` de [package.json](server/package.json).

Instala las dependencias.

```bash
npm install
```

Crea `.env` dentro de `server` con la siguiente configuración.

```dotenv
NODE_ENV=development
PORT=3000
ADMIN_PASSWORD=elige-una-contraseña
SESSION_SECRET=elige-un-secreto-largo-y-aleatorio
ALLOWED_ORIGINS=http://localhost:3000
DB_PATH=./data/reproductor.db
```

Con esta configuración se utiliza una base de datos local. El directorio y las tablas se crean al arrancar.

Para generar un secreto de sesión puedes ejecutar este comando.

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Inicia el servidor desde la carpeta `server`.

```bash
npm run dev
```

Abre el [panel local](http://localhost:3000/admin), ingresa la contraseña y agrega los videos. Luego abre el [reproductor local](http://localhost:3000/player) para ver la emisión.

## Instalar en tu servidor

1. Copia el proyecto e instala las dependencias desde `server`.
2. Configura la contraseña, el secreto de sesión, la ruta de datos y los orígenes de tu sitio.
3. Usa `NODE_ENV=production` y publica el servicio con HTTPS para que funcionen las cookies seguras del panel.
4. Ejecuta `npm start` desde `server` y configura el reinicio automático del proceso.
5. Guarda la base de datos en almacenamiento persistente y realiza copias de seguridad.

Ejecuta una sola instancia del servidor, ya que el reloj de reproducción se mantiene en memoria. El endpoint `/health` permite comprobar que el proceso responde.

## Insertar el reproductor en tu página

Sustituye el dominio de ejemplo por la dirección donde alojaste el software.

```html
<iframe
  src="https://canal.tudominio.com/player"
  title="Canal de video comunitario"
  style="display: block; width: 100%; aspect-ratio: 16 / 10; border: 0;"
  allow="autoplay; fullscreen"
  allowfullscreen
></iframe>
```

Para permitir que tu página inserte el reproductor, configura su origen en la directiva `frameAncestors` de [app.js](server/src/app.js). Por ejemplo, agrega `https://www.tudominio.com` a esa lista.

Define también `ALLOWED_ORIGINS` con los orígenes que podrán conectarse al servicio. Esta variable controla las conexiones y la directiva anterior controla la inserción del iframe. Ambas se configuran por separado.

## Configuración

Define las variables en `server/.env` o en el entorno del proceso.

| Variable | Función |
| --- | --- |
| `ADMIN_PASSWORD` | Contraseña del panel. Es obligatoria para arrancar. |
| `SESSION_SECRET` | Secreto para firmar las sesiones. Utiliza un valor largo y aleatorio. |
| `NODE_ENV` | `development` para uso local y `production` para el servidor con HTTPS. |
| `PORT` | Puerto HTTP del servicio. El valor predeterminado es `3000`. |
| `ALLOWED_ORIGINS` | Orígenes permitidos, separados por comas. Define los de tu propia instalación. |
| `DB_PATH` | Ruta del archivo de datos. Las rutas relativas se resuelven desde el directorio de ejecución. |
| `DRIFT_THRESHOLD` | Desfase tolerado por el servidor antes de corregirlo. Por defecto, `1` segundo. |
| `BROADCAST_INTERVAL` | Intervalo de envío del estado a los clientes. Por defecto, `2000` milisegundos. |

## Antes de programar tus videos

Los videos de YouTube deben permitir reproducción insertada. Su disponibilidad depende de las restricciones de cada video.

Ingresa la duración correcta al agregar cada video. El servidor utiliza ese valor para decidir cuándo avanzar al siguiente.

El navegador puede pedir una interacción inicial para permitir la reproducción. Cada espectador puede ajustar su volumen sin afectar a los demás.

## Organización del código

| Carpeta | Contenido |
| --- | --- |
| `server/src/` | Servidor, API, sincronización y configuración. |
| `server/public/admin/` | Interfaz de administración. |
| `server/public/player/` | Reproductor público. |
| `server/src/db/migrations/` | Esquema de la base de datos. |

Para adaptar la instalación, consulta la [configuración del servidor](server/src/config/index.js) y las [políticas de acceso e integración](server/src/app.js).
