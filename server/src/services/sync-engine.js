const playlistRepo = require('../repositories/playlist-repo');
const playbackRepo = require('../repositories/playback-repo');
const config = require('../config');

class SyncEngine {
  constructor(io) {
    this.io = io;
    this.state = {
      currentVideo: null,
      position: 0,
      isPlaying: false,
      startedAt: null,
      lastTick: Date.now(),
      playlist: [],
    };
    this.clients = new Map();
    this.playedIds = new Set();
    this.failedIds = new Set();
    this.errorReports = new Map();
    this.revision = 0;
    this.queue = Promise.resolve();
    this.stopping = false;
  }

  // Every state/database mutation shares this queue. A failure does not poison it.
  runExclusive(operation) {
    if (this.stopping) return Promise.reject(new Error('Server is shutting down'));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async start() {
    const saved = await playbackRepo.get();
    this.state.playlist = await playlistRepo.getAll();
    const video = this.state.playlist.find(item => item.id === saved?.current_video_id);
    if (video) {
      this.state.currentVideo = video;
      this.state.position = Math.min(video.duration, Math.max(0, Number(saved.position) || 0));
      this.state.isPlaying = saved.is_playing === 1;
    }
    this.state.lastTick = Date.now();
    this.loopInterval = setInterval(() => this._background(this._tick()), 1000);
    this.broadcastInterval = setInterval(() => this._broadcastState(), config.broadcastInterval);
    this.persistInterval = setInterval(() => this._background(this._checkpoint()), 5000);
    console.log('[sync] Engine started');
  }

  _background(operation) {
    operation.catch(error => console.error('[sync] Operation failed; will retry on the next cycle:', error.message));
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.loopInterval);
    clearInterval(this.broadcastInterval);
    clearInterval(this.persistInterval);
    await this.queue;
    this._updatePosition();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this._persistState();
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }

  _updatePosition() {
    const now = Date.now();
    if (this.state.isPlaying && this.state.currentVideo) {
      this.state.position = Math.min(this.state.currentVideo.duration, this.state.position + (now - this.state.lastTick) / 1000);
    }
    this.state.lastTick = now;
  }

  _tick() {
    if (this.tickPending) return this.tickPending;
    const revision = this.revision;
    this.tickPending = this.runExclusive(async () => {
      if (revision !== this.revision || !this.state.isPlaying || !this.state.currentVideo) return;
      this._updatePosition();
      if (this.state.position >= this.state.currentVideo.duration) await this._advanceVideo();
    }).finally(() => { this.tickPending = null; });
    return this.tickPending;
  }

  _checkpoint() {
    if (this.persistPending) return this.persistPending;
    this.persistPending = this.runExclusive(() => this._persistState())
      .finally(() => { this.persistPending = null; });
    return this.persistPending;
  }

  _selectNext(playlist, playedIds) {
    const available = playlist.filter(video => !this.failedIds.has(video.id));
    let candidates = available.filter(video => !playedIds.has(video.id));
    if (!candidates.length) {
      playedIds.clear();
      candidates = available;
      if (candidates.length > 1) candidates = candidates.filter(video => video.id !== this.state.currentVideo?.id);
    }
    return candidates[Math.floor(Math.random() * candidates.length)] || null;
  }

  async _advanceVideo(removeId = null) {
    const playlist = (await playlistRepo.getAll()).filter(video => video.id !== removeId);
    const playedIds = new Set([...this.playedIds].filter(id => playlist.some(video => video.id === id)));
    if (this.state.currentVideo) playedIds.add(this.state.currentVideo.id);
    const next = this._selectNext(playlist, playedIds);
    const isPlaying = Boolean(next && this.state.isPlaying);
    // Persist before publishing. Deletion and state replacement commit together.
    if (removeId !== null) {
      await playlistRepo.deleteWithPlayback(removeId, next?.id || null, 0, isPlaying);
    } else {
      await playbackRepo.upsert(next?.id || null, 0, isPlaying);
    }
    this.state = {
      ...this.state,
      currentVideo: next,
      position: 0,
      isPlaying,
      playlist,
      startedAt: next ? Date.now() : null,
      lastTick: Date.now(),
    };
    this.playedIds = playedIds;
    this.errorReports.clear();
    this.revision += 1;
    this.io.emit('video:advance', { video: next, position: 0, isPlaying, timestamp: Date.now() });
    this._broadcastState();
  }

  removeVideo(id) {
    return this.runExclusive(async () => {
      if (!await playlistRepo.getById(id)) throw new Error('Video not found');
      if (this.state.currentVideo?.id === id) {
        await this._advanceVideo(id);
      } else {
        await playlistRepo.delete(id);
      }
      this.playedIds.delete(id);
      this.failedIds.delete(id);
      await this.updatePlaylist();
    });
  }

  _broadcastState() {
    this.io.emit('sync:state', {
      video: this.state.currentVideo,
      position: this.state.position,
      isPlaying: this.state.isPlaying,
      playlist: this.state.playlist,
      timestamp: Date.now(),
    });
  }

  _persistState() {
    return playbackRepo.upsert(this.state.currentVideo?.id || null, this.state.position, this.state.isPlaying);
  }

  async updatePlaylist() {
    this.state.playlist = await playlistRepo.getAll();
    const current = this.state.playlist.find(video => video.id === this.state.currentVideo?.id);
    if (current) this.state.currentVideo = current;
    this.io.emit('playlist:update', { playlist: this.state.playlist });
  }

  play() {
    return this.runExclusive(async () => {
      this._updatePosition();
      const playlist = await playlistRepo.getAll();
      this.failedIds.clear();
      const video = this.state.currentVideo || this._selectNext(playlist, new Set(this.playedIds));
      if (!video) return false;
      const position = this.state.currentVideo ? this.state.position : 0;
      await playbackRepo.upsert(video.id, position, true);
      this.state = {
        ...this.state,
        currentVideo: video,
        position,
        isPlaying: true,
        playlist,
        lastTick: Date.now(),
      };
      this._broadcastState();
      return true;
    });
  }

  pause() {
    return this.runExclusive(async () => {
      this._updatePosition();
      await playbackRepo.upsert(this.state.currentVideo?.id || null, this.state.position, false);
      this.state.isPlaying = false;
      this._broadcastState();
    });
  }

  skip() {
    const revision = this.revision;
    return this.runExclusive(async () => {
      if (revision === this.revision && this.state.currentVideo) await this._advanceVideo();
    });
  }

  seekTo(position) {
    return this.runExclusive(async () => {
      if (!Number.isFinite(position) || position < 0) throw new Error('Invalid playback position');
      const target = Math.min(position, this.state.currentVideo?.duration || 0);
      await playbackRepo.upsert(this.state.currentVideo?.id || null, target, this.state.isPlaying);
      this.state.position = target;
      this.state.lastTick = Date.now();
      this._broadcastState();
    });
  }

  addClient(socketId) {
    this.clients.set(socketId, { lastHeartbeat: Date.now(), reportedPosition: 0, isPlayer: false });
  }

  markClientReady(socketId) {
    const client = this.clients.get(socketId);
    if (client) client.isPlayer = true;
  }

  removeClient(socketId) {
    this.clients.delete(socketId);
    this.errorReports.delete(socketId);
  }

  reportVideoError(socketId, data) {
    if (!data || ![100, 101, 150].includes(data.code)) return Promise.resolve();
    const revision = this.revision;
    return this.runExclusive(async () => {
      const client = this.clients.get(socketId);
      if (!client?.isPlayer || revision !== this.revision || data.videoId !== this.state.currentVideo?.id) return;
      client.lastHeartbeat = Date.now();
      this.errorReports.set(socketId, Date.now());
      const now = Date.now();
      const players = [...this.clients.values()].filter(item => item.isPlayer && now - item.lastHeartbeat < 20000);
      const reports = [...this.errorReports.values()].filter(time => now - time < 15000);
      if (reports.length < Math.min(2, players.length) || !this.state.isPlaying) return;
      const videoId = this.state.currentVideo.id;
      this.failedIds.add(videoId);
      try {
        await this._advanceVideo();
      } catch (error) {
        this.failedIds.delete(videoId);
        throw error;
      }
    });
  }

  handleHeartbeat(socketId, position) {
    const client = this.clients.get(socketId);
    if (!client || !Number.isFinite(position) || position < 0) return;
    client.lastHeartbeat = Date.now();
    client.reportedPosition = position;
    if (Math.abs(this.state.position - position) > config.driftThreshold) {
      this.io.to(socketId).emit('drift:correct', { position: this.state.position, timestamp: Date.now() });
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  getState() {
    return {
      video: this.state.currentVideo,
      position: this.state.position,
      isPlaying: this.state.isPlaying,
      playlist: this.state.playlist,
      clients: this.getClientCount(),
    };
  }
}

module.exports = SyncEngine;
