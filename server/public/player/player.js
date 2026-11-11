/**
 * ============================================================
 * Player Application — ReproductorPro
 * 
 * Synchronized video player client.
 * Connects to server via Socket.IO, receives sync state,
 * and controls video playback across all connected clients.
 * ============================================================
 */

/* ============================================================
   1. YouTube Player Adapter
   ============================================================ */
class YouTubePlayer {
  constructor(container, videoId) {
    this.container = container;
    this.videoId = videoId;
    this.player = null;
    this.muted = false;
    this._listeners = new Map();
    this._ready = false;

    this._createPlayer();
  }

  _createPlayer() {
    // Load YouTube IFrame API if not already loaded
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }

    // Wait for API ready
    const onReady = () => {
      this.player = new YT.Player(this.container, {
        videoId: this.videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,
          modestbranding: 1,
          rel: 0,
          disablekb: 1,
          fs: 0,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => this._onReady(),
          onStateChange: (e) => this._onStateChange(e.data),
          onError: (e) => this._onError(e.data),
        },
      });
    };

    if (window.YT && window.YT.Player) {
      onReady();
    } else {
      window.onYouTubeIframeAPIReady = onReady;
    }
  }

  _onReady() {
    this._ready = true;
    this._emit('ready');
  }

  _onStateChange(state) {
    const stateMap = {
      '-1': 'unstarted',
      0: 'ended',
      1: 'playing',
      2: 'paused',
      3: 'buffering',
      5: 'cued',
    };
    this._emit('stateChange', stateMap[state] || 'unknown');

    if (state === 0) {
      this._emit('ended');
    }
  }

  _onError(code) {
    this._emit('error', code);
  }

  loadVideo(videoId) {
    this.videoId = videoId;
    if (this.player && this._ready) {
      this.player.loadVideoById(videoId);
    }
  }

  play() {
    if (this.player && this._ready) {
      this.player.playVideo();
    }
  }

  pause() {
    if (this.player && this._ready) {
      this.player.pauseVideo();
    }
  }

  seekTo(seconds) {
    if (this.player && this._ready) {
      this.player.seekTo(seconds, true);
    }
  }

  getPosition() {
    if (this.player && this._ready) {
      return this.player.getCurrentTime() || 0;
    }
    return 0;
  }

  getDuration() {
    if (this.player && this._ready) {
      return this.player.getDuration() || 0;
    }
    return 0;
  }

  getState() {
    if (!this.player || !this._ready) return 'unstarted';
    const stateMap = {
      '-1': 'unstarted',
      0: 'ended',
      1: 'playing',
      2: 'paused',
      3: 'buffering',
      5: 'cued',
    };
    return stateMap[this.player.getPlayerState()] || 'unknown';
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.player) {
      muted ? this.player.mute() : this.player.unMute();
    }
  }

  setVolume(volume) {
    if (this.player) {
      this.player.setVolume(volume);
    }
  }

  destroy() {
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    this._listeners.clear();
    this._ready = false;
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
  }

  _emit(event, data) {
    const callbacks = this._listeners.get(event) || [];
    callbacks.forEach((cb) => cb(data));
  }
}



/* ============================================================
   3. Player Factory
   ============================================================ */
function createPlayer(container, videoId) {
  return new YouTubePlayer(container, videoId);
}

/* ============================================================
   5. Format Utilities
   ============================================================ */
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatSource() {
  return 'YouTube';
}

/* ============================================================
   6. Main Player Application
   ============================================================ */
class PlayerApp {
  constructor() {
    // DOM elements
    this.playerContainer = document.getElementById('player-container');
    this.startOverlay = document.getElementById('start-overlay');
    this.errorOverlay = document.getElementById('error-overlay');
    this.errorMessage = document.getElementById('error-message');
    this.bufferingIndicator = document.getElementById('buffering-indicator');
    this.muteBtn = document.getElementById('mute-btn');
    this.muteIcon = document.getElementById('mute-icon');
    this.volumeSlider = document.getElementById('volume-slider');
    this.currentTimeEl = document.getElementById('current-time');
    this.durationEl = document.getElementById('duration');
    this.statusBadge = document.getElementById('status-badge');
    this.videoTitle = document.getElementById('video-title');
    this.videoSource = document.getElementById('video-source');
    this.connectionDot = document.getElementById('connection-dot');
    this.connectionText = document.getElementById('connection-text');

    // State
    this.currentPlayer = null;
    this.currentVideo = null;
    this.isPlaying = false;
    this.isMuted = true; // Start muted for autoplay policy
    this.volume = 80;
    this.userInteracted = false;
    this.clockOffset = 0; // Server time - client time
    this.heartbeatInterval = null;
    this._wasConnected = false; // Track if this is a reconnect
    this._lastPosition = 0; // Last known position for reconnect
    this._timeUpdateInterval = null; // Separate timer for fluid time display

    this._bindEvents();
    this._connectSocket();
  }

  /* --- Event Binding --- */
  _bindEvents() {
    // Click to start (autoplay policy workaround)
    this.startOverlay.addEventListener('click', () => this._onUserInteract());

    // Mute button
    this.muteBtn.addEventListener('click', () => this._toggleMute());

    // Volume slider
    this.volumeSlider.addEventListener('input', (e) => {
      this.volume = parseInt(e.target.value, 10);
      if (this.currentPlayer) {
        this.currentPlayer.setVolume(this.volume);
      }
    });
  }

  /* --- Socket.IO Connection --- */
  _connectSocket() {
    this.socket = io();

    this.socket.on('connect', () => {
      this._updateConnectionStatus('connected', 'Conectado');

      // On reconnect, send last known position for faster resync
      if (this._wasConnected) {
        this.socket.emit('client:reconnect', {
          lastKnownPosition: this._lastPosition || 0,
          clientTime: Date.now(),
        });
      } else {
        // First connection — request full sync state
        this.socket.emit('client:ready', { clientTime: Date.now() });
        this._wasConnected = true;
      }
    });

    this.socket.on('disconnect', () => {
      this._updateConnectionStatus('disconnected', 'Desconectado');
      this._clearHeartbeat();
    });

    this.socket.on('connect_error', () => {
      this._updateConnectionStatus('connecting', 'Reconectando...');
    });

    // Sync state from server
    this.socket.on('sync:state', (data) => this._handleSyncState(data));

    // Video advance
    this.socket.on('video:advance', (data) => this._handleVideoAdvance(data));

    // Playlist update
    this.socket.on('playlist:update', (data) => this._handlePlaylistUpdate(data));

    // Drift correction
    this.socket.on('drift:correct', (data) => this._handleDriftCorrect(data));

    // Video error
    this.socket.on('error:video', (data) => this._handleVideoError(data));
  }

  /* --- Connection Status --- */
  _updateConnectionStatus(state, text) {
    this.connectionDot.className = `connection-dot ${state}`;
    this.connectionText.textContent = text;
  }

  /* --- User Interaction (autoplay policy) --- */
  _onUserInteract() {
    this.userInteracted = true;
    this.startOverlay.classList.add('hidden');

    // Unmute if user clicked
    this.isMuted = false;
    this._updateMuteIcon();

    if (this.currentPlayer) {
      this.currentPlayer.setMuted(false);
      this.currentPlayer.setVolume(this.volume);
      this.currentPlayer.play();
    }
  }

  /* --- Mute Control --- */
  _toggleMute() {
    this.isMuted = !this.isMuted;
    this._updateMuteIcon();
    if (this.currentPlayer) {
      this.currentPlayer.setMuted(this.isMuted);
    }
  }

  _updateMuteIcon() {
    this.muteIcon.textContent = this.isMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    this.muteBtn.setAttribute('aria-label', this.isMuted ? 'Activar sonido' : 'Silenciar');
  }

  /* --- Sync State Handler --- */
  _handleSyncState(data) {
    // Calculate clock offset
    if (data.serverTime) {
      this.clockOffset = data.serverTime - Date.now();
    } else if (data.timestamp) {
      this.clockOffset = data.timestamp - Date.now();
    }

    const { video, position, isPlaying, playlist } = data;

    // If video changed, create new player
    if (!video) {
      this.currentPlayer?.destroy();
      this.currentPlayer = null;
      this.currentVideo = null;
      this._clearTimeDisplay();
      this.videoTitle.textContent = 'Esperando videos';
      this.durationEl.textContent = '0:00';
      this.currentTimeEl.textContent = '0:00';
      this.errorOverlay.classList.add('hidden');
      this.bufferingIndicator.classList.add('hidden');
      this.startOverlay.classList.add('hidden');
    } else if (!this.currentVideo || this.currentVideo.id !== video.id) {
      this._loadVideo(video, position, isPlaying);
    } else if (this.currentVideo) {
      // Sync position if drift is significant
      this._syncPosition(position, isPlaying);
    }

    // Update UI
    this.isPlaying = isPlaying;
    this._updateStatusBadge();

    // Start heartbeat
    this._startHeartbeat();
  }

  /* --- Video Advance Handler --- */
  _handleVideoAdvance(data) {
    if (data.video) {
      this._loadVideo(data.video, data.position || 0, data.isPlaying ?? this.isPlaying);
    }
  }

  /* --- Playlist Update Handler --- */
  _handlePlaylistUpdate(data) {
    // Could update a playlist display if we had one
    console.log('Playlist updated:', data);
  }

  /* --- Drift Correction Handler --- */
  _handleDriftCorrect(data) {
    if (this.currentPlayer && data.position != null) {
      this.currentPlayer.seekTo(data.position);
    }
  }

  /* --- Video Error Handler --- */
  _handleVideoError(data) {
    this.errorOverlay.classList.remove('hidden');
    this.errorMessage.textContent = data?.message || 'Error al cargar el video';
  }

  /* --- Load Video --- */
  _loadVideo(video, position, isPlaying) {
    // Destroy current player
    if (this.currentPlayer) {
      this.currentPlayer.destroy();
    }

    // Clear time display interval while switching
    this._clearTimeDisplay();

    // Hide error overlay
    this.errorOverlay.classList.add('hidden');

    // Store video info
    this.currentVideo = video;
    this.isPlaying = isPlaying;
    this._lastPosition = position || 0;

    // Update UI
    this.videoTitle.textContent = video.title || 'Video sin título';
    // Source label hidden by design — uncomment to restore
    // this.videoSource.textContent = formatSource(video.source_type);
    this._updateStatusBadge();

    // Extract video ID from URL
    const videoId = this._extractVideoId(video.source_url);
    if (!videoId) {
      this._handleVideoError({ message: 'URL de video inválida' });
      return;
    }

    // Show buffering
    this.bufferingIndicator.classList.remove('hidden');

    // Create new player
    try {
      this.currentPlayer = createPlayer(this.playerContainer, videoId);

      this.currentPlayer.on('ready', () => {
        this.bufferingIndicator.classList.add('hidden');

        // Seek to position
        this.currentPlayer.seekTo(position || 0);

        // Update duration display
        const duration = this.currentPlayer.getDuration();
        this.durationEl.textContent = formatTime(duration);

        // Play or pause based on state
        if (this.isPlaying) {
          if (this.userInteracted) {
            this.currentPlayer.setMuted(this.isMuted);
            this.currentPlayer.setVolume(this.volume);
            this.currentPlayer.play();
          } else {
            // Show start overlay if user hasn't interacted
            this.currentPlayer.pause();
            this.startOverlay.classList.remove('hidden');
          }
        } else {
          this.currentPlayer.pause();
        }
      });

      this.currentPlayer.on('stateChange', (state) => {
        if (state === 'buffering') {
          this.bufferingIndicator.classList.remove('hidden');
        } else {
          this.bufferingIndicator.classList.add('hidden');
        }

        if (state === 'ended') {
          // Server will handle advance, but update UI
          this._updateStatusBadge();
        }
      });

      this.currentPlayer.on('error', (code) => {
        if (this.currentVideo !== video) return;
        console.error('Player error:', code);
        this._handleVideoError({ message: 'Error de reproducción' });
        this.socket.emit('client:video-error', { videoId: video.id, code });
      });
    } catch (err) {
      console.error('Failed to create player:', err);
      this._handleVideoError({ message: 'Error al inicializar el reproductor' });
    }
  }

  /* --- Sync Position --- */
  _syncPosition(targetPosition, isPlaying) {
    if (!this.currentPlayer) return;

    const currentPosition = this.currentPlayer.getPosition();
    const drift = Math.abs(currentPosition - targetPosition);

    // Only seek if drift is significant (> 1 second)
    if (drift > 1) {
      this.currentPlayer.seekTo(targetPosition);
    }

    // Update play/pause state
    if (isPlaying && this.currentPlayer.getState() !== 'playing') {
      if (this.userInteracted) {
        this.currentPlayer.play();
      }
    } else if (!isPlaying && this.currentPlayer.getState() === 'playing') {
      this.currentPlayer.pause();
    }

    this.isPlaying = isPlaying;
    this._updateStatusBadge();
  }

  /* --- Heartbeat --- */
  _startHeartbeat() {
    this._clearHeartbeat();

    // Heartbeat every 5s — sends position to server for drift check
    this.heartbeatInterval = setInterval(() => {
      if (this.currentPlayer && this.socket?.connected) {
        const pos = this.currentPlayer.getPosition();
        this._lastPosition = pos;
        this.socket.emit('client:heartbeat', {
          position: pos,
          clientTime: Date.now(),
        });
      }
    }, 5000);

    // Time display update every 1s — fluid counter independent of heartbeat
    this._startTimeDisplay();
  }

  _startTimeDisplay() {
    this._clearTimeDisplay();
    this._timeUpdateInterval = setInterval(() => {
      if (this.currentPlayer) {
        this.currentTimeEl.textContent = formatTime(this.currentPlayer.getPosition());
      }
    }, 1000);
  }

  _clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _clearTimeDisplay() {
    if (this._timeUpdateInterval) {
      clearInterval(this._timeUpdateInterval);
      this._timeUpdateInterval = null;
    }
  }

  /* --- Status Badge --- */
  _updateStatusBadge() {
    if (!this.currentVideo) {
      this.statusBadge.textContent = 'Esperando';
      this.statusBadge.className = 'badge badge-idle';
    } else if (this.isPlaying) {
      this.statusBadge.textContent = 'En vivo';
      this.statusBadge.className = 'badge badge-playing';
    } else {
      this.statusBadge.textContent = 'Pausado';
      this.statusBadge.className = 'badge badge-paused';
    }
  }

  /* --- Extract Video ID from URL --- */
  _extractVideoId(url) {
    if (!url) return null;

    try {
      // Handle various YouTube URL formats
      const match = url.match(
        /(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/watch\?.+&v=))([\w-]{11})/
      );
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

}

/* ============================================================
   7. Initialize Application
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  new PlayerApp();
});
