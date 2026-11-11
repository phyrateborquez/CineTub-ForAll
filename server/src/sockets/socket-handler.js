const ClientRegistry = require('./client-registry');

function createSocketHandlers(io, syncEngine) {
  const registry = new ClientRegistry();

  io.on('connection', (socket) => {
    console.log(`[socket] Client connected: ${socket.id} (total: ${registry.getCount() + 1})`);

    // Register client
    registry.register(socket.id);
    syncEngine.addClient(socket.id);

    // Send current state immediately
    socket.emit('sync:state', {
      video: syncEngine.state.currentVideo,
      position: syncEngine.state.position,
      isPlaying: syncEngine.state.isPlaying,
      playlist: syncEngine.state.playlist,
      timestamp: Date.now(),
    });

    // Handle client ready
    socket.on('client:ready', (data) => {
      syncEngine.markClientReady(socket.id);
      console.log(`[socket] Client ready: ${socket.id}`);
      io.emit('client:count', { count: registry.getCount() });
    });

    // Handle client heartbeat
    socket.on('client:heartbeat', (data) => {
      if (!data || !Number.isFinite(data.position) || data.position < 0) return;
      registry.updateHeartbeat(socket.id, data.position);
      syncEngine.handleHeartbeat(socket.id, data.position);
    });

    // Handle client reconnect
    socket.on('client:reconnect', (data) => {
      if (!data || !Number.isFinite(data.lastKnownPosition)) return;
      syncEngine.markClientReady(socket.id);
      console.log(`[socket] Client reconnected: ${socket.id}, last known position: ${data.lastKnownPosition}`);
      syncEngine.handleHeartbeat(socket.id, data.lastKnownPosition);
    });

    socket.on('client:video-error', (data) => {
      syncEngine.reportVideoError(socket.id, data).catch(error => {
        console.error('[socket] Could not recover video:', error.message);
      });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      registry.unregister(socket.id);
      syncEngine.removeClient(socket.id);
      console.log(`[socket] Client disconnected: ${socket.id} (total: ${registry.getCount()})`);
      io.emit('client:count', { count: registry.getCount() });
    });
  });

  // Expose client count for API
  return {
    getClientCount: () => registry.getCount(),
  };
}

module.exports = createSocketHandlers;
