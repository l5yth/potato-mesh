const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fetch = global.fetch;

const appDir = path.join(__dirname, '..');
const supportDir = path.join(appDir, 'test', 'support');

// ensure test database exists
const createDb = spawn('ruby', [path.join(supportDir, 'create_db.rb'), path.join(__dirname, 'test.db')], { cwd: appDir });

const wait = ms => new Promise(r => setTimeout(r, ms));

async function startServer() {
  await new Promise(res => createDb.on('exit', res));
  const server = spawn('ruby', ['app.rb'], { cwd: appDir, env: { ...process.env, MESH_DB: path.join(__dirname, 'test.db') } });
  await wait(500); // wait for server to boot
  return server;
}

test('fetch nodes from running server', async (t) => {
  const server = await startServer();
  try {
    const res = await fetch('http://localhost:4567/api/nodes');
    const json = await res.json();
    assert.ok(Array.isArray(json));
  } finally {
    server.kill();
  }
});
