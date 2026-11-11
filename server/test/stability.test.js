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
