# ReproductorPro

Un canal web comunitario para ver videos de YouTube en sincronía. El administrador prepara la lista y controla la emisión. Cada espectador se incorpora al video en curso, en el mismo punto que el resto.

[Abrir el reproductor](https://reproductor-pro.onrender.com/player/) · [Panel de administración](https://reproductor-pro.onrender.com/admin/)

## Cómo funciona

1. El administrador agrega videos con su título, enlace de YouTube y duración.
2. Desde el panel puede iniciar, pausar, saltar de video o cambiar la posición.
3. El servidor mantiene el estado de la emisión y corrige el desfase de los espectadores.
4. Al terminar un video, elige al azar entre los que quedan por reproducir en el ciclo. Cuando se completa la lista, comienza otro ciclo.

Los espectadores controlan su volumen y pueden silenciar el audio de forma independiente. El reproductor pide una interacción inicial para comenzar la reproducción.

## Funciones

- Reproducción sincronizada mediante Socket.IO.
- Panel protegido por contraseña y cookie de sesión.
- Gestión de videos y control de reproducción.
- Reproductor público integrable mediante un iframe.
- Persistencia de la lista y del estado de reproducción en SQLite local o Turso.
- Conteo de clientes conectados en el panel.

## Ejecutar en tu equipo

Requiere Node.js 20 o superior y npm.

```bash
git clone https://github.com/phyrateborquez/reproductor-pro.git
cd reproductor-pro/server
npm install
```

Copia `.env.example` a `.env`. En PowerShell puedes usar `Copy-Item .env.example .env` y en Linux o macOS, `cp .env.example .env`.

Edita `.env` con estos valores para desarrollo local.

```dotenv
NODE_ENV=development
PORT=3000
ADMIN_PASSWORD=elige-una-contraseña
SESSION_SECRET=elige-un-secreto-largo-y-aleatorio
ALLOWED_ORIGINS=http://localhost:3000
```

Deja vacías `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` para utilizar SQLite local. La base y sus tablas se crean al arrancar.

```bash
npm run dev
```

- [Administración local](http://localhost:3000/admin) para agregar videos y controlar la emisión.
- [Reproductor local](http://localhost:3000/player) para ver el canal.
- [Estado del servidor](http://localhost:3000/health) para comprobar que responde.

Puedes generar un secreto de sesión con este comando.

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## Integrar el canal en tu sitio

```html
<iframe
  src="https://reproductor-pro.onrender.com/player"
  title="Canal de video comunitario"
  width="800"
  height="500"
  style="border: 0; width: 100%; aspect-ratio: 16 / 10; height: auto;"
  allow="autoplay; fullscreen"
  allowfullscreen
></iframe>
```

La política `frame-ancestors` en [app.js](server/src/app.js) permite la integración desde el mismo origen y desde `https://futuroalternativo.net` y `https://www.futuroalternativo.net`. Para integrar el canal en otro dominio, agrega ese origen a la política y configura `ALLOWED_ORIGINS` para las conexiones permitidas.

Los videos deben permitir reproducción insertada en YouTube. La duración ingresada en el panel determina cuándo el servidor pasa al siguiente video.

## Configuración

Las variables se definen en `server/.env` durante el desarrollo y en el entorno del servicio durante el despliegue.

| Variable | Uso |
| --- | --- |
| `ADMIN_PASSWORD` | Contraseña de administración. El servidor la exige al arrancar. |
| `SESSION_SECRET` | Secreto para firmar sesiones. Define un valor largo y aleatorio en producción. |
| `NODE_ENV` | `development` por defecto. Usa `production` con HTTPS para las cookies seguras. |
| `PORT` | Puerto HTTP, por defecto `3000`. |
| `ALLOWED_ORIGINS` | Orígenes separados por comas. Sin definir, permite localhost en desarrollo y los dominios de FuturoAlternativo en producción. |
| `TURSO_DATABASE_URL` | URL de la base remota de Turso. Se utiliza junto con su token. |
| `TURSO_AUTH_TOKEN` | Token de acceso a Turso. |
| `DB_PATH` | Ruta de SQLite local. Sin definir, usa `server/data/reproductor.db`. El ejemplo `.env` usa `./data/reproductor.db`, relativo al directorio de ejecución. |
| `DRIFT_THRESHOLD` | Desfase tolerado por el servidor antes de corregirlo, por defecto `1` segundo. |
| `BROADCAST_INTERVAL` | Intervalo de envío del estado, por defecto `2000` milisegundos. |

## Despliegue

Para Render, configura `server` como directorio raíz, `npm install` como comando de instalación y `npm start` como comando de inicio. Define las variables de producción, incluida la contraseña, el secreto de sesión y ambas credenciales de Turso.

Turso conserva los datos fuera del sistema de archivos efímero del servicio. Mantén una sola instancia del servidor, ya que el reloj de reproducción se administra en memoria.

El flujo documentado del proyecto despliega desde `main` mediante la integración de Render con GitHub. El endpoint `/health` sirve para comprobar la respuesta del proceso.

La carpeta [deploy](deploy/) contiene plantillas de PM2 y Nginx para un servidor propio. Ajusta las rutas, el dominio y las variables al entorno donde vayas a ejecutarlo.

## Código y documentación

El backend utiliza Node.js, Express, Socket.IO y libSQL. Las interfaces se sirven desde Express y usan HTML, CSS y JavaScript.

| Carpeta | Contenido |
| --- | --- |
| `server/src/` | API, motor de sincronización, acceso a datos y configuración. |
| `server/public/admin/` | Panel de administración. |
| `server/public/player/` | Reproductor público. |
| `server/src/db/migrations/` | Esquema de la base de datos. |
| `deploy/` | Plantillas de despliegue. |

[DOCUMENTACION.md](DOCUMENTACION.md) y [design.md](design.md) amplían la arquitectura y los eventos de comunicación. Ambos contienen referencias históricas pendientes de actualizar. Para consultar la configuración vigente, revisa [config/index.js](server/src/config/index.js).
