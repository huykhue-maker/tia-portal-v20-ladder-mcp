'use strict';
// Persistent client for TiaBridge.exe + workspace helpers (backups, exports, learned catalog, SIM table CSV).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('./ladder/learn');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_EXE = path.join(ROOT, 'bridge', 'TiaBridge.exe');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const EXPORTS_DIR = path.join(ROOT, 'exports');
const LEARNED_FILE = path.join(ROOT, 'exports', 'learned_catalog.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(BACKUPS_DIR);
ensureDir(EXPORTS_DIR);

function safeName(s) {
  return String(s || 'unnamed').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

class BridgeClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderrBuf = '';
    this.learned = this.loadLearned();
    this.projectPath = '';
    this.scopeKey = '';
    this.scopes = new Map();
    this.defaultPlcs = new Map();
    this.setScope('', '');
  }

  loadLearned() {
    try {
      if (fs.existsSync(LEARNED_FILE)) {
        const saved = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
        return { ...saved, calls: {} };
      }
    } catch { }
    return L.emptyLearned();
  }

  saveLearned() {
    try {
      ensureDir(EXPORTS_DIR);
      const { calls, ...globalOnly } = this.learned;
      fs.writeFileSync(LEARNED_FILE, JSON.stringify(globalOnly, null, 2), 'utf8');
    } catch { }
  }

  setScope(projectPath, plcName) {
    if (projectPath !== undefined) this.projectPath = projectPath || '';
    const projectKey = this.projectPath.toLowerCase();
    if (plcName && !this.defaultPlcs.has(projectKey)) this.defaultPlcs.set(projectKey, plcName);
    const resolvedPlc = plcName || this.defaultPlcs.get(projectKey) || '';
    const key = JSON.stringify([projectKey, String(resolvedPlc).toLowerCase()]);
    if (!this.scopes.has(key)) this.scopes.set(key, { tags: {}, dbs: {}, udts: {}, calls: {} });
    this.scopeKey = key;
    this.learned.calls = this.scopes.get(key).calls;
  }

  resolveDefaultPlc(plcName) {
    if (!plcName) return;
    const emptyKey = JSON.stringify([this.projectPath.toLowerCase(), '']);
    const resolvedKey = JSON.stringify([this.projectPath.toLowerCase(), plcName.toLowerCase()]);
    if (this.scopes.has(emptyKey) && !this.scopes.has(resolvedKey)) this.scopes.set(resolvedKey, this.scopes.get(emptyKey));
    this.defaultPlcs.set(this.projectPath.toLowerCase(), plcName);
    this.setScope(undefined, plcName);
  }

  invalidateObject(name) {
    for (const [key, cache] of this.scopes) {
      if (key !== this.scopeKey) continue;
      for (const map of [cache.dbs, cache.udts, cache.calls]) for (const entry of Object.keys(map)) if (entry.toLowerCase() === name.toLowerCase()) delete map[entry];
    }
  }

  clearProjectScope() {
    this.projectPath = '';
    this.scopes.clear();
    this.defaultPlcs.clear();
    this.setScope('', '');
  }

  get tagsCache() { return this.scopes.get(this.scopeKey).tags; }
  set tagsCache(value) { this.scopes.get(this.scopeKey).tags = value; }
  get dbsCache() { return this.scopes.get(this.scopeKey).dbs; }
  set dbsCache(value) { this.scopes.get(this.scopeKey).dbs = value; }
  get udtsCache() { return this.scopes.get(this.scopeKey).udts; }
  set udtsCache(value) { this.scopes.get(this.scopeKey).udts = value; }

  ensureStarted() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    if (!fs.existsSync(BRIDGE_EXE)) {
      throw new Error('TiaBridge.exe not found at ' + BRIDGE_EXE + '. Run build.ps1 first.');
    }
    this.proc = spawn(BRIDGE_EXE, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.buf = '';
    this.stderrBuf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.ok) waiter.resolve(msg.data);
        else waiter.reject(new Error(msg.error || 'Bridge error'));
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', chunk => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-2048);
    });
    this.proc.on('exit', code => {
      const tail = this.stderrBuf.trim();
      const suffix = tail ? ' | stderr: ' + tail : '';
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('TiaBridge.exe exited unexpectedly (code ' + code + ')' + suffix));
      }
      this.pending.clear();
      this.proc = null;
    });
  }

  call(cmd, args, timeoutMs) {
    this.ensureStarted();
    const id = this.nextId++;
    const timeout = timeoutMs || (['open_project', 'create_project', 'save_project', 'compile', 'download', 'station_upload', 'connect'].includes(cmd) ? 180000 : 60000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Bridge command "' + cmd + '" timed out after ' + Math.round(timeout / 1000) + 's'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n', 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  shutdown() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.write(JSON.stringify({ id: 0, cmd: 'shutdown', args: {} }) + '\n', 'utf8'); } catch { }
      setTimeout(() => { try { if (this.proc) this.proc.kill(); } catch { } }, 500);
    }
  }

  // -------------------- Backup & Export helpers --------------------
  exportFilePath(name, ext) {
    ensureDir(EXPORTS_DIR);
    return path.join(EXPORTS_DIR, safeName(name) + (ext || '.xml'));
  }

  uniqueExportPath(name, ext) {
    ensureDir(EXPORTS_DIR);
    return path.join(EXPORTS_DIR, safeName(name) + '__' + crypto.randomBytes(8).toString('hex') + (ext || '.xml'));
  }

  saveBackup(blockName, xmlContent) {
    ensureDir(BACKUPS_DIR);
    const fname = safeName(blockName) + '__' + timestamp() + '_' + crypto.randomBytes(6).toString('hex') + '.xml';
    const full = path.join(BACKUPS_DIR, fname);
    fs.writeFileSync(full, xmlContent, { encoding: 'utf8', flag: 'wx' });
    return full;
  }

  listBackups(blockName) {
    ensureDir(BACKUPS_DIR);
    const prefix = blockName ? safeName(blockName) + '__' : '';
    return fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.xml') && (!prefix || f.startsWith(prefix)))
      .sort()
      .reverse()
      .map(f => {
        const full = path.join(BACKUPS_DIR, f);
        const st = fs.statSync(full);
        return { file: f, path: full, size: st.size, mtime: st.mtime.toISOString() };
      }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  offlineBackupLabel(xmlPath) {
    const real = fs.realpathSync.native(xmlPath);
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    return path.parse(real).name + '__' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  }

  writeSimTableCsv(name, rows) {
    ensureDir(EXPORTS_DIR);
    const full = path.join(EXPORTS_DIR, safeName(name || 'sim_table') + '_SIMTable.csv');
    const header = 'Name,Address,DataType,DisplayFormat,ModifyValue,Comment';
    const escCsv = v => {
      const s = String(v === undefined || v === null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [header];
    for (const r of rows) {
      const fmt = r.type === 'Bool' ? 'Bool' : (/Real/i.test(r.type) ? 'Floating-point' : 'DEC');
      lines.push([r.name, r.address || '', r.type || 'Bool', fmt, r.modifyValue !== undefined ? r.modifyValue : '', r.comment || ''].map(escCsv).join(','));
    }
    fs.writeFileSync(full, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
    return full;
  }
}

module.exports = { BridgeClient, ROOT, BACKUPS_DIR, EXPORTS_DIR, ensureDir, safeName };
