const playlistRepo = require('../repositories/playlist-repo');

class PlaylistManager {
  constructor(syncEngine) {
    this.syncEngine = syncEngine;
  }

  _mutate(operation) {
    return this.syncEngine ? this.syncEngine.runExclusive(operation) : operation();
  }

  addVideo(title, sourceUrl, duration) {
    return this._mutate(async () => {
      const video = await playlistRepo.insert(title, sourceUrl, duration);
      if (this.syncEngine) await this.syncEngine.updatePlaylist();
      return video;
    });
  }

  updateVideo(id, updates) {
    return this._mutate(async () => {
      const existing = await playlistRepo.getById(id);
      if (!existing) throw new Error('Video not found');
      const video = await playlistRepo.update(
        id,
        updates.title || existing.title,
        updates.source_url || existing.source_url,
        updates.duration || existing.duration
      );
      if (this.syncEngine) {
        this.syncEngine.failedIds.delete(id);
        await this.syncEngine.updatePlaylist();
      }
      return video;
    });
  }

  removeVideo(id) {
    if (this.syncEngine) return this.syncEngine.removeVideo(id);
    return this._mutate(async () => {
      if (!await playlistRepo.getById(id)) throw new Error('Video not found');
      await playlistRepo.delete(id);
    });
  }

  reorderVideo(id, newOrderIndex) {
    return this._mutate(async () => {
      if (!await playlistRepo.getById(id)) throw new Error('Video not found');
      await playlistRepo.reorder(id, newOrderIndex);
      if (this.syncEngine) await this.syncEngine.updatePlaylist();
    });
  }

  reorderPlaylist(orderArray) {
    return this._mutate(async () => {
      const playlist = await playlistRepo.getAll();
      const ids = new Set(playlist.map(video => video.id));
      const submittedIds = new Set(orderArray.map(item => item?.id));
      if (orderArray.length !== ids.size || submittedIds.size !== ids.size ||
          orderArray.some(item => !item || !ids.has(item.id))) {
        const error = new Error('La lista cambió. Recarga y vuelve a ordenar.');
        error.status = 409;
        throw error;
      }
      await playlistRepo.reorderBatch(orderArray.map((item, index) => ({ id: item.id, orderIndex: index })));
      if (this.syncEngine) await this.syncEngine.updatePlaylist();
    });
  }

  getPlaylist() {
    return playlistRepo.getAll();
  }

  getNextVideo(currentOrderIndex) {
    return playlistRepo.getNext(currentOrderIndex);
  }

  getFirstVideo() {
    return playlistRepo.getFirst();
  }
}

module.exports = PlaylistManager;
