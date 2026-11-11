/**
 * ============================================================
 * Admin Application — ReproductorPro
 *
 * Admin dashboard client.
 * Autenticación via Cookie HttpOnly (CRIT-02).
 * Gestión de playlist y reproducción en tiempo real via Socket.IO.
 * ============================================================
 */

/* ============================================================
   1. API Helper — fetch wrapper con cookies de sesión
   La autenticación ya no usa sessionStorage ni headers manuales.
   El navegador envía automáticamente la Cookie HttpOnly en cada
   petición gracias a credentials: 'include'.
   ============================================================ */
class ApiClient {
  constructor() {
    this.basePath = '';
  }

  async _fetch(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const res = await fetch(`${this.basePath}${path}`, {
      ...options,
      headers,
      credentials: 'include', // Envía la cookie de sesión HttpOnly automáticamente
    });

    if (res.status === 401) {
      throw new Error('UNAUTHORIZED');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || body?.message || `HTTP ${res.status}`);
    }

    // 204 No Content — no hay body que parsear
    if (res.status === 204) return null;

    return res.json();
  }

  get(path) {
    return this._fetch(path, { method: 'GET' });
  }

  post(path, body) {
    return this._fetch(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put(path, body) {
    return this._fetch(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  delete(path) {
    return this._fetch(path, { method: 'DELETE' });
  }
}

/* ============================================================
   2. Auth Module — usa /api/auth/login y /api/auth/logout
   La cookie es manejada por el navegador (HttpOnly, invisible a JS)
   ============================================================ */
class AuthModule {
  constructor(api, onLogout) {
    this.api = api;
    this.onLogout = onLogout;

    this.loginScreen = document.getElementById('login-screen');
    this.dashboard = document.getElementById('dashboard');
    this.loginForm = document.getElementById('login-form');
    this.passwordInput = document.getElementById('admin-password');
    this.loginError = document.getElementById('login-error');
    this.logoutBtn = document.getElementById('logout-btn');

    this._bindEvents();
  }

  _bindEvents() {
    this.loginForm.addEventListener('submit', (e) => this._handleLogin(e));
    this.logoutBtn.addEventListener('click', () => this._handleLogout());
  }

  async _handleLogin(e) {
    e.preventDefault();
    const password = this.passwordInput.value.trim();
    if (!password) return;

    this.loginError.classList.add('hidden');

    try {
      // El servidor valida la contraseña y crea una Cookie HttpOnly de sesión.
      // A partir de aquí, el navegador envía la cookie automáticamente.
      await this.api.post('/api/auth/login', { password });
      this.passwordInput.value = ''; // Limpiar el campo inmediatamente
      this._showDashboard();
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        this.loginError.classList.remove('hidden');
        this.passwordInput.value = '';
        this.passwordInput.focus();
      } else {
        console.error('[auth] Error en login:', err);
      }
    }
  }

  async _handleLogout() {
    try {
      await this.api.post('/api/auth/logout', {});
    } catch (err) {
      console.error('[auth] Error en logout:', err);
    } finally {
      this._showLogin();
      if (this.onLogout) this.onLogout();
    }
  }

  _showDashboard() {
    this.loginScreen.classList.add('hidden');
    this.dashboard.classList.remove('hidden');
    this.dashboard.classList.add('animate-fade');
  }

  _showLogin() {
    this.loginScreen.classList.remove('hidden');
    this.dashboard.classList.add('hidden');
    this.passwordInput.value = '';
  }

  // Verifica si ya hay una sesión activa al cargar la página
  // (el servidor lo sabe por la cookie que envía el navegador)
  async checkAuth() {
    try {
      const { authenticated } = await this.api.get('/api/auth/status');
      if (authenticated) {
        this._showDashboard();
        return true;
      }
    } catch {
      // Sin sesión activa — mostrar login
    }
    this._showLogin();
    return false;
  }
}

/* ============================================================
   3. Playlist Module — CRUD + Drag & Drop
   ============================================================ */
class PlaylistModule {
  constructor(api) {
    this.api = api;

    // DOM elements
    this.addForm = document.getElementById('add-video-form');
    this.titleInput = document.getElementById('video-title');
    this.urlInput = document.getElementById('video-url');
    this.durationMinutes = document.getElementById('duration-minutes');
    this.durationSeconds = document.getElementById('duration-seconds');
    this.addBtn = document.getElementById('add-btn');
    this.feedback = document.getElementById('form-feedback');

    this.playlistEmpty = document.getElementById('playlist-empty');
    this.playlistTable = document.getElementById('playlist-table');
    this.playlistBody = document.getElementById('playlist-body');
    this.playlistCount = document.getElementById('playlist-count');

    this.editModal = document.getElementById('edit-modal');
    this.editForm = document.getElementById('edit-form');
    this.editId = document.getElementById('edit-id');
    this.editTitle = document.getElementById('edit-title');
    this.editUrl = document.getElementById('edit-url');
    this.editDurationMinutes = document.getElementById('edit-duration-minutes');
    this.editDurationSeconds = document.getElementById('edit-duration-seconds');
    this.editCancel = document.getElementById('edit-cancel');
    this.editSave = document.getElementById('edit-save');
    this.modalClose = document.getElementById('modal-close');
    this.modalBackdrop = this.editModal.querySelector('.modal-backdrop');
    this.durationDetector = new VideoDurationDetector(this.urlInput, this.durationMinutes, this.durationSeconds);
    this.editDurationDetector = new VideoDurationDetector(this.editUrl, this.editDurationMinutes, this.editDurationSeconds);

    // State
    this.playlist = [];
    this.draggedId = null;

    this._bindEvents();
  }

  _bindEvents() {
    // Add video form
    this.addForm.addEventListener('submit', (e) => this._handleAdd(e));

    // Edit modal
    this.editCancel.addEventListener('click', () => this._closeEditModal());
    this.modalClose.addEventListener('click', () => this._closeEditModal());
    this.modalBackdrop.addEventListener('click', () => this._closeEditModal());
    this.editForm.addEventListener('submit', (e) => this._handleEdit(e));

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.editModal.classList.contains('hidden')) {
        this._closeEditModal();
      }
    });

    // Delegated events for playlist table
    this.playlistBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = parseInt(btn.dataset.id, 10);

      if (action === 'edit') this._openEditModal(id);
      if (action === 'delete') this._handleDelete(id);
    });

    // Drag & Drop
    this.playlistBody.addEventListener('dragstart', (e) => this._onDragStart(e));
    this.playlistBody.addEventListener('dragend', (e) => this._onDragEnd(e));
    this.playlistBody.addEventListener('dragover', (e) => this._onDragOver(e));
    this.playlistBody.addEventListener('dragenter', (e) => this._onDragEnter(e));
    this.playlistBody.addEventListener('dragleave', (e) => this._onDragLeave(e));
    this.playlistBody.addEventListener('drop', (e) => this._onDrop(e));
  }



  /* --- Add Video --- */
  async _handleAdd(e) {
    e.preventDefault();
    this._clearFeedback();

    const title = this.titleInput.value.trim();
    const sourceUrl = this.urlInput.value.trim();
    const mins = parseInt(this.durationMinutes.value, 10) || 0;
    const secs = parseInt(this.durationSeconds.value, 10) || 0;
    const duration = mins * 60 + secs;

    // Client-side validation
    const errors = [];
    if (!title || title.length > 200) errors.push('Título requerido (máx 200 caracteres)');
    if (!sourceUrl || !this._isValidUrl(sourceUrl)) errors.push('URL válida requerida de YouTube');
    if (duration <= 0) errors.push('La duración debe ser mayor a 0 (al menos 1 segundo)');
    if (secs < 0 || secs > 59) errors.push('Los segundos deben estar entre 0 y 59');

    if (errors.length) {
      this._showFeedback(errors.join('. '), 'error');
      return;
    }

    this.addBtn.disabled = true;
    this.addBtn.textContent = 'Agregando...';

    try {
      await this.api.post('/api/playlist', {
        title,
        source_url: sourceUrl,
        duration,
      });

      // Reset form
      this.durationDetector.reset();
      this.addForm.reset();
      this._showFeedback('Video agregado correctamente', 'success');
      setTimeout(() => this._clearFeedback(), 3000);

      // Refresh playlist
      await this.fetchPlaylist();
    } catch (err) {
      this._showFeedback(`Error: ${err.message}`, 'error');
    } finally {
      this.addBtn.disabled = false;
      this.addBtn.textContent = 'Agregar a la playlist';
    }
  }

  _isValidUrl(str) {
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /* --- Fetch & Render --- */
  async fetchPlaylist() {
    try {
      this.playlist = await this.api.get('/api/playlist');
      this._renderPlaylist();
    } catch (err) {
      console.error('Failed to fetch playlist:', err);
    }
  }

  _renderPlaylist() {
    const count = this.playlist.length;
    this.playlistCount.textContent = `${count} video${count !== 1 ? 's' : ''}`;

    if (count === 0) {
      this.playlistEmpty.classList.remove('hidden');
      this.playlistTable.classList.add('hidden');
      return;
    }

    this.playlistEmpty.classList.add('hidden');
    this.playlistTable.classList.remove('hidden');

    this.playlistBody.innerHTML = this.playlist
      .map((video, index) => this._renderRow(video, index))
      .join('');
  }

  _renderRow(video, index) {
    const duration = this._formatDuration(video.duration);

    return `
      <tr draggable="true" data-id="${video.id}" data-index="${index}">
        <td class="col-order">${index + 1}</td>
        <td class="col-drag">
          <span class="drag-handle" title="Arrastrar para reordenar">&#9776;</span>
        </td>
        <td class="col-title" title="${this._escapeHtml(video.title)}">
          ${this._escapeHtml(video.title)}
        </td>
        <td class="col-duration">${duration}</td>
        <td class="col-actions">
          <button class="action-btn" data-action="edit" data-id="${video.id}" title="Editar">
            &#9998;
          </button>
          <button class="action-btn delete" data-action="delete" data-id="${video.id}" title="Eliminar">
            &#128465;
          </button>
        </td>
      </tr>
    `;
  }

  _formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* --- Delete Video --- */
  async _handleDelete(id) {
    const video = this.playlist.find((v) => v.id === id);
    if (!video) return;

    if (!confirm(`¿Eliminar "${video.title}" de la playlist?`)) return;

    try {
      await this.api.delete(`/api/playlist/${id}`);
      await this.fetchPlaylist();
    } catch (err) {
      alert(`Error al eliminar: ${err.message}`);
    }
  }

  /* --- Edit Modal --- */
  _openEditModal(id) {
    const video = this.playlist.find((v) => v.id === id);
    if (!video) return;
    this.editDurationDetector.reset();

    this.editId.value = video.id;
    this.editTitle.value = video.title;
    this.editUrl.value = video.source_url;
    // Decompose total seconds into minutes + seconds
    this.editDurationMinutes.value = Math.floor((video.duration || 0) / 60);
    this.editDurationSeconds.value = (video.duration || 0) % 60;

    this.editModal.classList.remove('hidden');
    this.editTitle.focus();
  }

  _closeEditModal() {
    this.editDurationDetector.reset();
    this.editModal.classList.add('hidden');
    this.editForm.reset();
  }

  async _handleEdit(e) {
    e.preventDefault();

    const id = parseInt(this.editId.value, 10);
    const title = this.editTitle.value.trim();
    const sourceUrl = this.editUrl.value.trim();
    const mins = parseInt(this.editDurationMinutes.value, 10) || 0;
    const secs = parseInt(this.editDurationSeconds.value, 10) || 0;
    const duration = mins * 60 + secs;

    if (!title || !sourceUrl || duration <= 0) {
      alert('Todos los campos son requeridos y la duración debe ser mayor a 0');
      return;
    }

    try {
      await this.api.put(`/api/playlist/${id}`, {
        title,
        source_url: sourceUrl,
        duration,
      });

      this._closeEditModal();
      await this.fetchPlaylist();
    } catch (err) {
      alert(`Error al actualizar: ${err.message}`);
    }
  }

  /* --- Drag & Drop --- */
  _onDragStart(e) {
    const row = e.target.closest('tr');
    if (!row) return;

    this.draggedId = parseInt(row.dataset.id, 10);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id);
  }

  _onDragEnd(e) {
    const row = e.target.closest('tr');
    if (row) row.classList.remove('dragging');

    // Remove all drag-over indicators
    this.playlistBody.querySelectorAll('.drag-over').forEach((el) => {
      el.classList.remove('drag-over');
    });

    this.draggedId = null;
  }

  _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  _onDragEnter(e) {
    const row = e.target.closest('tr');
    if (!row || parseInt(row.dataset.id, 10) === this.draggedId) return;

    this.playlistBody.querySelectorAll('.drag-over').forEach((el) => {
      el.classList.remove('drag-over');
    });
    row.classList.add('drag-over');
  }

  _onDragLeave(e) {
    const row = e.target.closest('tr');
    if (row) row.classList.remove('drag-over');
  }

  async _onDrop(e) {
    e.preventDefault();

    const targetRow = e.target.closest('tr');
    if (!targetRow || !this.draggedId) return;

    const targetId = parseInt(targetRow.dataset.id, 10);
    if (targetId === this.draggedId) return;

    // Reorder in memory first
    const draggedIndex = this.playlist.findIndex((v) => v.id === this.draggedId);
    const targetIndex = this.playlist.findIndex((v) => v.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Move item
    const [moved] = this.playlist.splice(draggedIndex, 1);
    this.playlist.splice(targetIndex, 0, moved);

    // Build new order array
    const newOrder = this.playlist.map((v, i) => ({ id: v.id, orderIndex: i }));

    try {
      await this.api.put('/api/playlist/reorder', newOrder);
      await this.fetchPlaylist();
    } catch (err) {
      console.error('Reorder failed:', err);
      // Revert: fetch original order
      await this.fetchPlaylist();
    }
  }

  /* --- Feedback --- */
  _showFeedback(message, type) {
    this.feedback.textContent = message;
    this.feedback.className = `form-feedback ${type}`;
    this.feedback.classList.remove('hidden');
  }

  _clearFeedback() {
    this.feedback.classList.add('hidden');
    this.feedback.textContent = '';
  }
}

/* ============================================================
   4. Playback Module
   ============================================================ */
class PlaybackModule {
  constructor(api) {
    this.api = api;

    // DOM elements
    this.videoEl = document.getElementById('playback-video');
    this.positionEl = document.getElementById('playback-position');
    this.durationEl = document.getElementById('playback-duration');
    this.statusEl = document.getElementById('playback-status');
    this.playBtn = document.getElementById('play-btn');
    this.pauseBtn = document.getElementById('pause-btn');
    this.skipBtn = document.getElementById('skip-btn');

    // State
    this.currentVideo = null;
    this.position = 0;
    this.isPlaying = false;
    this._updateInterval = null;

    this._bindEvents();
  }

  _bindEvents() {
    this.playBtn.addEventListener('click', () => this._handlePlay());
    this.pauseBtn.addEventListener('click', () => this._handlePause());
    this.skipBtn.addEventListener('click', () => this._handleSkip());
  }

  async _handlePlay() {
    try {
      await this.api.post('/api/playback/play');
      await this.fetchState();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  async _handlePause() {
    try {
      await this.api.post('/api/playback/pause');
      await this.fetchState();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  async _handleSkip() {
    try {
      await this.api.post('/api/playback/skip');
      await this.fetchState();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  async fetchState() {
    try {
      const state = await this.api.get('/api/playback');
      this._updateState(state);
    } catch (err) {
      console.error('Failed to fetch playback state:', err);
    }
  }

  _updateState(state) {
    if (!state) return;

    this.currentVideo = state.currentVideo;
    this.position = state.position || 0;
    this.isPlaying = state.isPlaying || false;

    this._render();

    // Start/stop position ticker
    if (this.isPlaying) {
      this._startTicker();
    } else {
      this._stopTicker();
    }
  }

  _render() {
    if (this.currentVideo) {
      this.videoEl.textContent = this.currentVideo.title;
      this.durationEl.textContent = this._formatDuration(this.currentVideo.duration);
    } else {
      this.videoEl.textContent = 'Sin video';
      this.durationEl.textContent = '0:00';
    }

    this.positionEl.textContent = this._formatDuration(this.position);

    if (this.isPlaying) {
      this.statusEl.textContent = 'Reproduciendo';
      this.statusEl.className = 'badge badge-playing';
    } else if (this.currentVideo) {
      this.statusEl.textContent = 'Pausado';
      this.statusEl.className = 'badge badge-paused';
    } else {
      this.statusEl.textContent = 'Esperando';
      this.statusEl.className = 'badge badge-idle';
    }
  }

  _startTicker() {
    this._stopTicker();
    this._updateInterval = setInterval(() => {
      if (this.isPlaying) {
        this.position += 1;
        this.positionEl.textContent = this._formatDuration(this.position);
      }
    }, 1000);
  }

  _stopTicker() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
  }

  _formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  destroy() {
    this._stopTicker();
  }
}

/* ============================================================
   5. Main Admin Application
   ============================================================ */
class AdminApp {
  constructor() {
    this.api = new ApiClient();
    this.auth = new AuthModule(this.api, () => this._onLogout());
    this.playlist = new PlaylistModule(this.api);
    this.playback = new PlaybackModule(this.api);

    this.clientCountText = document.getElementById('client-count-text');

    this._connectSocket();
    this._init();
  }

  async _init() {
    // Check if already authenticated
    const authenticated = await this.auth.checkAuth();
    if (authenticated) {
      // Load initial data
      await Promise.all([
        this.playlist.fetchPlaylist(),
        this.playback.fetchState(),
      ]);
    }
  }

  /* --- Socket.IO --- */
  _connectSocket() {
    this.socket = io();

    this.socket.on('connect', () => {
      console.log('Admin connected to Socket.IO');
    });

    this.socket.on('disconnect', () => {
      console.log('Admin disconnected from Socket.IO');
    });

    // Client count updates from server
    this.socket.on('client:count', (data) => {
      this.clientCountText.textContent = data.count || 0;
    });

    // Playlist updates (e.g., from another admin tab)
    this.socket.on('playlist:update', async () => {
      await this.playlist.fetchPlaylist();
    });

    // Playback state updates
    this.socket.on('sync:state', (data) => {
      this.playback._updateState({
        currentVideo: data.video,
        position: data.position,
        isPlaying: data.isPlaying,
      });
    });
  }

  _onLogout() {
    this.playlist.durationDetector.reset();
    this.playlist.editDurationDetector.reset();
    this.playback.destroy();
    this.clientCountText.textContent = '0';
  }
}

/* ============================================================
   6. Initialize Application
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  new AdminApp();
  // window.__adminApp eliminado (MED-02): exponer la instancia
  // globalmente permite a scripts maliciosos interactuar con la app.
});

