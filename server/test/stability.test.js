const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// Tests always use a disposable database, never deployment credentials.
process.env.TURSO_DATABASE_URL = '';
process.env.TURSO_AUTH_TOKEN = '';
process.env.ADMIN_PASSWORD = require('node:crypto').randomBytes(24).toString('hex');
process.env.SESSION_SECRET = require('node:crypto').randomBytes(48).toString('hex');
if (!process.env.CINETUB_TEST_DB) throw new Error('Run these tests with npm test');
process.env.DB_PATH = process.env.CINETUB_TEST_DB;
const db = require('../src/db');
const playlistRepo = require('../src/repositories/playlist-repo');
const playbackRepo = require('../src/repositories/playback-repo');
const SyncEngine = require('../src/services/sync-engine');
const PlaylistManager = require('../src/services/playlist-manager');

let engine;
let manager;
let events;

before(async () => {
  await db.initDatabase();
  await db.run('PRAGMA foreign_keys = ON');
});

beforeEach(async () => {
  await db.run('DELETE FROM playback_state');
  await db.run('DELETE FROM playlist');
  events = [];
  engine = new SyncEngine({ emit: (name, data) => events.push({ name, data }), to: () => ({ emit() {} }) });
  manager = new PlaylistManager(engine);
});

after(() => {
  db.close();
});

async function addVideos(count = 3) {
  const videos = [];
  for (let index = 0; index < count; index += 1) {
    videos.push(await manager.addVideo(`Video ${index}`, 'https://youtu.be/abcdefghijk', 100));
  }
  return videos;
}

test('simultaneous end, skips and ticks produce only one transition', async () => {
  await addVideos();
  await engine.play();
  engine.state.position = 100;
  await Promise.all([engine._tick(), engine.skip(), engine.skip(), engine._tick()]);
  assert.equal(events.filter(event => event.name === 'video:advance').length, 1);
  assert.equal(engine.state.position, 0);
  assert.ok(Date.now() - engine.state.lastTick < 1000);
  assert.equal((await playbackRepo.get()).current_video_id, engine.state.currentVideo.id);
});

test('removing the only playing video leaves a consistent empty channel', async () => {
  const [video] = await addVideos(1);
  await engine.play();
  await manager.removeVideo(video.id);
  assert.equal(engine.state.currentVideo, null);
  assert.equal(engine.state.isPlaying, false);
  assert.equal(engine.state.position, 0);
  assert.deepEqual(await playlistRepo.getAll(), []);
  assert.equal((await playbackRepo.get()).current_video_id, null);
});

test('deleting the current video while paused preserves the pause', async () => {
  await addVideos(2);
  await engine.play();
  const id = engine.state.currentVideo.id;
  await engine.pause();
  await manager.removeVideo(id);
  assert.notEqual(engine.state.currentVideo.id, id);
  assert.equal(engine.state.isPlaying, false);
  assert.equal(events.find(event => event.name === 'video:advance').data.isPlaying, false);
});

test('a failed deletion rolls back playback and the queue remains usable', async () => {
  await addVideos(2);
  await engine.play();
  const id = engine.state.currentVideo.id;
  await db.run("CREATE TRIGGER reject_delete BEFORE DELETE ON playlist BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  try {
    await assert.rejects(manager.removeVideo(id));
    assert.equal(engine.state.currentVideo.id, id);
    assert.equal((await playbackRepo.get()).current_video_id, id);
    assert.ok(await playlistRepo.getById(id));
  } finally {
    await db.run('DROP TRIGGER reject_delete');
  }
  await engine.skip();
  assert.notEqual(engine.state.currentVideo.id, id);
});

test('reordering is atomic and rejects outdated lists', async () => {
  const videos = await addVideos();
  await db.run(`CREATE TRIGGER reject_order BEFORE UPDATE OF order_index ON playlist
    WHEN OLD.id = ${videos[1].id} BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  try {
    await assert.rejects(manager.reorderPlaylist([...videos].reverse()));
    assert.deepEqual((await playlistRepo.getAll()).map(video => video.id), videos.map(video => video.id));
  } finally {
    await db.run('DROP TRIGGER reject_order');
  }
  await assert.rejects(manager.reorderPlaylist(videos.slice(1)), { status: 409 });
  await manager.reorderPlaylist([...videos].reverse());
  assert.deepEqual((await playlistRepo.getAll()).map(video => video.id), videos.map(video => video.id).reverse());
});

test('database errors do not publish a transition or block later retries', async () => {
  await addVideos(2);
  await engine.play();
  const id = engine.state.currentVideo.id;
  const original = playbackRepo.upsert;
  playbackRepo.upsert = async () => { throw new Error('database unavailable'); };
  try {
    await assert.rejects(engine.skip(), /database unavailable/);
    assert.equal(engine.state.currentVideo.id, id);
    assert.equal(events.filter(event => event.name === 'video:advance').length, 0);
  } finally {
    playbackRepo.upsert = original;
  }
  await engine.skip();
  assert.notEqual(engine.state.currentVideo.id, id);
});

test('only permanent errors from distinct viewers advance the current video', async () => {
  await addVideos(3);
  await engine.play();
  const id = engine.state.currentVideo.id;
  for (const socket of ['one', 'two']) {
    engine.addClient(socket);
    engine.markClientReady(socket);
  }
  await engine.reportVideoError('one', { videoId: id, code: 5 });
  await engine.reportVideoError('unknown', { videoId: id, code: 100 });
  await engine.reportVideoError('one', { videoId: id, code: 100 });
  await engine.reportVideoError('one', { videoId: id, code: 100 });
  assert.equal(engine.state.currentVideo.id, id);
  await engine.reportVideoError('two', { videoId: id, code: 150 });
  assert.notEqual(engine.state.currentVideo.id, id);
  await engine.reportVideoError('two', { videoId: id, code: 100 });
  assert.equal(events.filter(event => event.name === 'video:advance').length, 1);
  assert.ok(engine.failedIds.has(id));
});

test('an unavailable sole video stops instead of looping through errors', async () => {
  await addVideos(1);
  await engine.play();
  engine.addClient('viewer');
  engine.markClientReady('viewer');
  await engine.reportVideoError('viewer', { videoId: engine.state.currentVideo.id, code: 100 });
  assert.equal(engine.state.currentVideo, null);
  assert.equal(engine.state.isPlaying, false);
  assert.equal((await playbackRepo.get()).current_video_id, null);
  assert.equal(await engine.play(), true);
});

test('shutdown drains pending writes and restart restores position and pause', async () => {
  await addVideos(2);
  await engine.play();
  await engine.seekTo(25);
  await engine.pause();
  const pending = engine.seekTo(37);
  const stopping = engine.stop();
  await assert.rejects(engine.skip(), /shutting down/);
  await Promise.all([pending, stopping]);
  db.close();
  await db.initDatabase();
  const restored = new SyncEngine(engine.io);
  await restored.start();
  try {
    assert.equal(restored.state.currentVideo.id, engine.state.currentVideo.id);
    assert.equal(restored.state.position, 37);
    assert.equal(restored.state.isPlaying, false);
  } finally {
    await restored.stop();
  }
});

test('shutdown retries a temporary save failure', async () => {
  await addVideos(1);
  await engine.play();
  const original = playbackRepo.upsert;
  let attempts = 0;
  playbackRepo.upsert = (...args) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('temporary failure'));
    return original(...args);
  };
  try {
    await engine.stop();
    assert.equal(attempts, 2);
  } finally {
    playbackRepo.upsert = original;
  }
});

test('admin API can add, play and delete the sole video', async () => {
  const http = require('node:http');
  const createApp = require('../src/app');
  const server = http.createServer(createApp(engine, manager));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  try {
    assert.equal((await request('/api/playlist')).status, 401);
    assert.equal((await request('/api/playlist/delete-selected', 'POST', { ids: [1] })).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', { password: process.env.ADMIN_PASSWORD })).status, 200);
    const response = await request('/api/playlist', 'POST', {
      title: 'Integration test', source_url: 'https://youtu.be/abcdefghijk', duration: 307,
    });
    assert.equal(response.status, 201);
    const video = await response.json();
    assert.equal((await request('/api/playback/play', 'POST', {})).status, 200);
    assert.equal((await request(`/api/playlist/${video.id}`, 'DELETE')).status, 204);
    const state = await (await request('/api/playback')).json();
    assert.equal(state.video, null);
    assert.equal(state.isPlaying, false);
    for (const ids of [[], [0], ['1'], [null], [-1]]) {
      assert.equal((await request('/api/playlist/delete-selected', 'POST', { ids })).status, 400);
    }
    const videos = await addVideos(3);
    const ids = videos.map(item => item.id);
    const bulk = await request('/api/playlist/delete-selected', 'POST', { ids: [...ids, ids[0]] });
    assert.equal(bulk.status, 200);
    assert.equal((await bulk.json()).removedIds.length, 3);
    assert.deepEqual(await playlistRepo.getAll(), []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('old saved states with a missing video restart idle', async () => {
  await db.run('PRAGMA foreign_keys = OFF');
  await playbackRepo.upsert(999999, 100, true);
  await db.run('PRAGMA foreign_keys = ON');
  await engine.start();
  try {
    assert.equal(engine.state.currentVideo, null);
    assert.equal(engine.state.isPlaying, false);
    assert.equal(engine.state.position, 0);
  } finally {
    await engine.stop();
  }
});

test('public player clears an empty channel and preserves paused advances', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const context = {
    document: { addEventListener() {} },
    Date,
    console,
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../public/player/player.js'), 'utf8');
  vm.runInContext(`${source}\nthis.PlayerApp = PlayerApp;`, context);
  const player = Object.create(context.PlayerApp.prototype);
  let destroyed = false;
  player.currentPlayer = { destroy() { destroyed = true; } };
  player.currentVideo = { id: 1 };
  for (const name of ['videoTitle', 'durationEl', 'currentTimeEl', 'errorOverlay', 'bufferingIndicator', 'startOverlay']) {
    player[name] = { textContent: '', classList: { add() {} } };
  }
  player._clearTimeDisplay = () => {};
  player._updateStatusBadge = () => {};
  player._startHeartbeat = () => {};
  player._handleSyncState({ video: null, position: 0, isPlaying: false });
  assert.equal(destroyed, true);
  assert.equal(player.currentPlayer, null);
  assert.equal(player.currentVideo, null);
  let playing;
  player._loadVideo = (video, position, isPlaying) => { playing = isPlaying; };
  player._handleVideoAdvance({ video: { id: 2 }, isPlaying: false });
  assert.equal(playing, false);
});

test('bulk deletion skips selected videos in a single playback transition', async () => {
  const videos = await addVideos(4);
  await engine.play();
  const currentId = engine.state.currentVideo.id;
  const other = videos.find(video => video.id !== currentId);
  const removed = await manager.removeVideos([currentId, other.id]);
  assert.deepEqual(new Set(removed), new Set([currentId, other.id]));
  assert.ok(!removed.includes(engine.state.currentVideo.id));
  assert.equal(engine.state.isPlaying, true);
  assert.equal(events.filter(event => event.name === 'video:advance').length, 1);
  assert.equal((await playlistRepo.getAll()).length, 2);
  assert.equal((await playbackRepo.get()).current_video_id, engine.state.currentVideo.id);
});

test('bulk deletion preserves playback when the current video is unselected', async () => {
  const videos = await addVideos(4);
  await engine.play();
  await engine.seekTo(23);
  const currentId = engine.state.currentVideo.id;
  const ids = videos.filter(video => video.id !== currentId).map(video => video.id);
  await manager.removeVideos(ids);
  assert.equal(engine.state.currentVideo.id, currentId);
  assert.ok(engine.state.position >= 23);
  assert.equal(engine.state.isPlaying, true);
  assert.equal(events.filter(event => event.name === 'video:advance').length, 0);
});

test('selecting every video leaves the channel idle and retries are harmless', async () => {
  const videos = await addVideos();
  await engine.play();
  const ids = videos.map(video => video.id);
  await manager.removeVideos(ids);
  assert.deepEqual(await playlistRepo.getAll(), []);
  assert.equal(engine.state.currentVideo, null);
  assert.equal(engine.state.isPlaying, false);
  assert.deepEqual(await manager.removeVideos(ids), []);
});

test('bulk deletion rolls back every deletion and the playback state on failure', async () => {
  const videos = await addVideos(3);
  await engine.play();
  const currentId = engine.state.currentVideo.id;
  await db.run(`CREATE TRIGGER reject_bulk BEFORE DELETE ON playlist
    WHEN OLD.id = ${videos[1].id} BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  try {
    await assert.rejects(manager.removeVideos(videos.map(video => video.id)));
    assert.equal((await playlistRepo.getAll()).length, 3);
    assert.equal(engine.state.currentVideo.id, currentId);
    assert.equal((await playbackRepo.get()).current_video_id, currentId);
    assert.equal(events.filter(event => event.name === 'video:advance').length, 0);
  } finally {
    await db.run('DROP TRIGGER reject_bulk');
  }
});

test('selection survives refreshes and a failed deletion remains retryable', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const context = { document: { addEventListener() {} }, confirm: () => true, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/admin/admin.js'), 'utf8') +
    '\nthis.PlaylistModule = PlaylistModule;', context);
  const module = Object.create(context.PlaylistModule.prototype);
  module.deletingSelection = false;
  module.playlist = [{ id: 1, title: 'One', duration: 10 }, { id: 2, title: 'Two', duration: 20 }];
  module.selectedIds = new Set([1, 99]);
  module._escapeHtml = value => value;
  for (const name of ['selectAll', 'selectionCount', 'deleteSelectedBtn', 'playlistCount',
    'playlistEmpty', 'playlistTable', 'playlistBody', 'playlistFeedback']) {
    module[name] = { classList: { add() {}, remove() {} } };
  }
  module._renderPlaylist();
  assert.deepEqual([...module.selectedIds], [1]);
  assert.equal(module.selectAll.indeterminate, true);
  assert.equal(module.deleteSelectedBtn.disabled, false);
  module.api = { post: async () => { throw new Error('offline'); } };
  await module._handleDeleteSelected();
  assert.deepEqual([...module.selectedIds], [1]);
  assert.match(module.playlistFeedback.textContent, /offline/);
  assert.equal(module.deletingSelection, false);
  module.selectedIds.add(2);
  module._updateSelection();
  assert.equal(module.selectAll.checked, true);
  assert.equal(module.selectAll.indeterminate, false);
  module.api = { post: async () => ({ removedIds: [1, 2] }) };
  module.fetchPlaylist = async () => {};
  await module._handleDeleteSelected();
  assert.equal(module.playlist.length, 0);
  assert.equal(module.selectedIds.size, 0);
  assert.equal(module.deleteSelectedBtn.disabled, true);
});
