const path = require('path');
const { requireAuth } = require('../middleware/auth');
const { verifyPassword } = require('../middleware/auth');
const { validateVideoBody } = require('../middleware/validate');

function createAdminRoutes(playlistManager, syncEngine) {
  const express = require('express');
  const router = express.Router();

  // ================================================================
  // Servir el panel de administración
  // ================================================================
  router.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/admin/index.html'));
  });

  // ================================================================
  // CRIT-02: Rutas de Autenticación (NO protegidas por sesión)
  // ================================================================

  // POST /api/auth/login — Verifica contraseña y crea sesión
  router.post('/api/auth/login', (req, res) => {
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Contraseña requerida' });
    }

    if (!verifyPassword(password)) {
      console.warn('[auth] Login fallido desde', req.ip);
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Error al crear sesión' });
      req.session.isAdmin = true;
      console.log('[auth] Login exitoso desde', req.ip);
      return res.json({ ok: true });
    });
  });

  // POST /api/auth/logout — Destruye la sesión
  router.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: 'Error al cerrar sesión' });
      res.clearCookie('rp.sid');
      return res.json({ ok: true });
    });
  });

  // GET /api/auth/status — Estado de autenticación
  router.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.isAdmin === true) {
      return res.json({ authenticated: true });
    }
    return res.json({ authenticated: false });
  });

  // ================================================================
  // API protegida — todas las rutas de aquí hacia abajo requieren sesión
  // IMPORTANTE: Las rutas estáticas VAN ANTES que las dinámicas (:id)
  // para evitar ERR_HTTP_HEADERS_SENT
  // ================================================================

  // GET /api/playlist
  router.get('/api/playlist', requireAuth, async (req, res) => {
    try {
      const playlist = await playlistManager.getPlaylist();
      res.json(playlist);
    } catch (err) {
      console.error('[routes] Error al obtener playlist:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // POST /api/playlist — Agregar video
  router.post('/api/playlist', requireAuth, validateVideoBody, async (req, res) => {
    try {
      const { title, source_url } = req.body;
      const duration = Math.round(Number(req.body.duration)); // siempre entero de segundos
      const video = await playlistManager.addVideo(title, source_url, duration);
      res.status(201).json(video);
    } catch (err) {
      console.error('[routes] Error al agregar video:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ⚠️ RUTA ESTÁTICA ANTES QUE DINÁMICA — evita que /api/playlist/reorder
  // sea capturada por /api/playlist/:id
  router.put('/api/playlist/reorder', requireAuth, async (req, res) => {
    try {
      if (!Array.isArray(req.body)) {
        return res.status(400).json({ error: 'El body debe ser un array de {id, orderIndex}' });
      }
      await playlistManager.reorderPlaylist(req.body);
      res.status(204).send();
    } catch (err) {
      console.error('[routes] Error al reordenar:', err);
      if (err.status === 409) return res.status(409).json({ error: err.message });
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // PUT /api/playlist/:id — Actualizar metadata (DESPUÉS de la ruta estática)
  router.put('/api/playlist/:id', requireAuth, validateVideoBody, async (req, res) => {
    try {
      const video = await playlistManager.updateVideo(
        parseInt(req.params.id, 10),
        req.body
      );
      res.json(video);
    } catch (err) {
      if (err.message === 'Video not found') {
        return res.status(404).json({ error: 'Video no encontrado' });
      }
      console.error('[routes] Error al actualizar video:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  router.post('/api/playlist/delete-selected', requireAuth, async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'Selecciona al menos un video válido' });
    }
    try {
      const removedIds = await playlistManager.removeVideos([...new Set(ids)]);
      res.json({ removedIds });
    } catch (error) {
      console.error('[routes] Error al eliminar selección:', error.message);
      res.status(500).json({ error: 'No se pudo eliminar la selección. Intenta nuevamente.' });
    }
  });

  // DELETE /api/playlist/:id
  router.delete('/api/playlist/:id', requireAuth, async (req, res) => {
    try {
      await playlistManager.removeVideo(parseInt(req.params.id, 10));
      res.status(204).send();
    } catch (err) {
      if (err.message === 'Video not found') {
        return res.status(404).json({ error: 'Video no encontrado' });
      }
      console.error('[routes] Error al eliminar video:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // GET /api/playback
  router.get('/api/playback', requireAuth, (req, res) => {
    res.json(syncEngine.getState());
  });

  // POST /api/playback/play
  router.post('/api/playback/play', requireAuth, async (req, res) => {
    try {
      const started = await syncEngine.play();
      if (!started) {
        return res.status(400).json({ error: 'No hay videos en la playlist' });
      }
      res.json(syncEngine.getState());
    } catch (err) {
      console.error('[routes] Error en playback:play:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // POST /api/playback/pause
  router.post('/api/playback/pause', requireAuth, async (req, res) => {
    try {
      await syncEngine.pause();
      res.json(syncEngine.getState());
    } catch (err) {
      console.error('[routes] Error en playback:pause:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // POST /api/playback/skip
  router.post('/api/playback/skip', requireAuth, async (req, res) => {
    try {
      await syncEngine.skip();
      res.json(syncEngine.getState());
    } catch (err) {
      console.error('[routes] Error en playback:skip:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // POST /api/playback/seek
  router.post('/api/playback/seek', requireAuth, async (req, res) => {
    try {
      const position = parseFloat(req.body.position);
      if (!Number.isFinite(position) || position < 0) {
        return res.status(400).json({ error: 'Posición válida requerida' });
      }
      await syncEngine.seekTo(position);
      res.json(syncEngine.getState());
    } catch (err) {
      console.error('[routes] Error en playback:seek:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  return router;
}

module.exports = createAdminRoutes;
