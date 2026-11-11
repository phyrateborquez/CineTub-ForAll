const http = require('http');
const { Server } = require('socket.io');
const config = require('./config');
const db = require('./db');
const SyncEngine = require('./services/sync-engine');
const PlaylistManager = require('./services/playlist-manager');
const createApp = require('./app');
const createSocketHandlers = require('./sockets/socket-handler');

// Validate required config
if (!config.adminPassword) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is required');
  process.exit(1);
}

async function start() {
  // Initialize database (async for libSQL/Turso)
  console.log('[db] Initializing database...');
  await db.initDatabase();
  console.log('[db] Database initialized');

  // Crear servicios primero (necesarios para pasarlos a createApp)
  const syncEngine = new SyncEngine(null); // io se asigna después
  const playlistManager = new PlaylistManager(syncEngine);

  // ✅ ORDEN CORRECTO: crear el servidor HTTP con Express desde el inicio.
  // Esto evita ERR_HTTP_HEADERS_SENT que ocurre cuando Socket.IO y Express
  // comparten el mismo servidor usando server.on('request', app).
  const app = createApp(syncEngine, playlistManager);
  const server = http.createServer(app);

  // Adjuntar Socket.IO al servidor HTTP ya existente
  const io = new Server(server, {
    cors: {
      origin: config.allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
    transports: ['websocket', 'polling'],
  });

  // Asignar io al syncEngine ahora que ya existe
  syncEngine.io = io;

  // Wire socket handlers
  createSocketHandlers(io, syncEngine);

  // Start sync engine (async — loads state from Turso)
  await syncEngine.start();

  // Start listening
  server.listen(config.port, () => {
    console.log(`[server] Listening on port ${config.port} (${config.nodeEnv})`);
    console.log(`[server] Admin: http://localhost:${config.port}/admin`);
    console.log(`[server] Player: http://localhost:${config.port}/player`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[server] Saving state before shutdown...');
    const timeout = setTimeout(() => {
      console.error('[server] Shutdown timed out');
      process.exit(1);
    }, 20000);
    timeout.unref();
    const closed = new Promise(resolve => server.close(resolve));
    io.close();
    try {
      await syncEngine.stop();
      await closed;
      db.close();
      clearTimeout(timeout);
      process.exit(0);
    } catch (error) {
      console.error('[server] Could not save final state:', error.message);
      process.exit(1);
    }
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});

module.exports = { };
