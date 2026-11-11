const db = require('../db');

function statement(currentVideoId, position, isPlaying) {
  return {
    sql: `INSERT INTO playback_state (id, current_video_id, position, is_playing, last_updated)
          VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET current_video_id = excluded.current_video_id,
          position = excluded.position, is_playing = excluded.is_playing,
          last_updated = CURRENT_TIMESTAMP`,
    args: [currentVideoId, position, isPlaying ? 1 : 0],
  };
}

const queries = {
  get: () => db.get('SELECT * FROM playback_state WHERE id = 1'),

  upsert: async (currentVideoId, position, isPlaying) => {
    const query = statement(currentVideoId, position, isPlaying);
    return db.get(`${query.sql} RETURNING *`, query.args);
  },
  statement,
};

module.exports = queries;
