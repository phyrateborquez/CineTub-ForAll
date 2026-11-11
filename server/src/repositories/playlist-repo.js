const db = require('../db');
const playbackRepo = require('./playback-repo');

const queries = {
  getAll: () => db.all('SELECT * FROM playlist ORDER BY order_index ASC'),

  getById: (id) => db.get('SELECT * FROM playlist WHERE id = ?', [id]),

  insert: async (title, sourceUrl, duration) => {
    // Obtener el máximo order_index actual
    const maxOrder = await db.get('SELECT MAX(order_index) as max FROM playlist');
    const orderIndex = (maxOrder && maxOrder.max !== null) ? Number(maxOrder.max) + 1 : 0;

    const result = await db.run(
      'INSERT INTO playlist (title, source_url, duration, order_index) VALUES (?, ?, ?, ?)',
      [title, sourceUrl, duration, orderIndex]
    );

    // Obtener el registro insertado usando lastInsertRowid
    return db.get('SELECT * FROM playlist WHERE id = ?', [Number(result.lastInsertRowid)]);
  },

  update: async (id, title, sourceUrl, duration) => {
    await db.run(
      'UPDATE playlist SET title = ?, source_url = ?, duration = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [title, sourceUrl, duration, id]
    );
    return db.get('SELECT * FROM playlist WHERE id = ?', [id]);
  },

  delete: (id) => db.run('DELETE FROM playlist WHERE id = ?', [id]),

  deleteManyWithPlayback: (ids, nextId, position, isPlaying) => db.batch([
    playbackRepo.statement(nextId, position, isPlaying),
    ...ids.map(id => ({ sql: 'DELETE FROM playlist WHERE id = ?', args: [id] })),
  ]),

  reorder: (id, orderIndex) =>
    db.run('UPDATE playlist SET order_index = ? WHERE id = ?', [orderIndex, id]),

  reorderBatch: async (items) => {
    if (!items.length) return;
    await db.batch(items.map(item => ({
      sql: 'UPDATE playlist SET order_index = ? WHERE id = ?',
      args: [item.orderIndex, item.id],
    })));
  },

  getFirst: () => db.get('SELECT * FROM playlist ORDER BY order_index ASC LIMIT 1'),

  getNext: (currentOrderIndex) =>
    db.get(
      'SELECT * FROM playlist WHERE order_index > ? ORDER BY order_index ASC LIMIT 1',
      [currentOrderIndex]
    ),

  count: async () => {
    const result = await db.get('SELECT COUNT(*) as count FROM playlist');
    return result ? Number(result.count) : 0;
  },

  /**
   * Returns a random video that is NOT in `excludedIds`.
   * If all videos are excluded (full cycle complete), `excludedIds` is ignored
   * and a completely random video is returned (new shuffle cycle starts).
   * @param {Set<number>} excludedIds - IDs of videos already played this cycle.
   */
  getRandomExcluding: async (excludedIds = new Set()) => {
    const all = await db.all('SELECT * FROM playlist ORDER BY order_index ASC');
    if (!all || all.length === 0) return null;

    // Filter out already-played videos
    let candidates = all.filter((v) => !excludedIds.has(v.id));

    // If no candidates remain, start a new shuffle cycle using all videos
    if (candidates.length === 0) {
      candidates = all;
    }

    const pick = Math.floor(Math.random() * candidates.length);
    return candidates[pick];
  },
};

module.exports = queries;
