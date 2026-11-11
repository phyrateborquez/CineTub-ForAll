const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The native database may retain file handles until the test process exits.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetub-test-'));
try {
  const files = fs.readdirSync(path.join(__dirname, '../test'))
    .filter(file => file.endsWith('.test.js'))
    .map(file => path.join(__dirname, '../test', file));
  const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: { ...process.env, CINETUB_TEST_DB: path.join(directory, 'test.db') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
  fs.rmdirSync(directory);
}
