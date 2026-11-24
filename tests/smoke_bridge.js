'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const exe = path.join(__dirname, '..', 'bridge', 'TiaBridge.exe');
const r = spawnSync(exe, [], {
  input: JSON.stringify({ id: 1, cmd: 'status', args: {} }) + '\n',
  encoding: 'utf8',
});
console.log('CODE:', r.status);
console.log('OUT:', r.stdout);
if (r.stderr) console.log('ERR:', r.stderr);
