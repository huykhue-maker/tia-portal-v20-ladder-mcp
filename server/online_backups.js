'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const fields = ['projectPath', 'device', 'cpu', 'software', 'group', 'kind', 'name', 'objectType', 'number'];

function scopeKey(scope) {
  if (!scope || fields.some(k => typeof scope[k] !== 'string' || (!scope[k] && k !== 'group' && k !== 'number'))) {
    throw new Error('Incomplete online backup identity from TIA.');
  }
  return JSON.stringify(fields.map(k => scope[k]));
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function label(scope) {
  return 'online_' + digest(scopeKey(scope));
}

async function withScratchXml(operation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-object-'));
  try {
    return await operation(path.join(dir, 'object.xml'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

class OnlineBackups {
  constructor(bridge) {
    this.bridge = bridge;
  }

  request(args, kind) {
    const name = args.blockName || args.name;
    if (!name) throw new Error('blockName is required for an online backup target.');
    return { name, kind, plcName: args.plcName || '', group: args.group };
  }

  async edit(args, kind, transform, preview = false) {
    const request = this.request(args, kind);
    return withScratchXml(async xmlPath => {
      const scope = await this.bridge.call('existing_object', { ...request, action: 'export', forWrite: !preview, xmlPath });
      const original = fs.readFileSync(xmlPath);
      const xml = original.toString('utf8');
      const result = transform(xml);
      if (preview) return { xml, result };
      const backup = this.bridge.saveBackup(label(scope), original);
      const manifest = { scope, sha256: digest(original), file: path.basename(backup) };
      fs.writeFileSync(backup + '.json', JSON.stringify(manifest, null, 2), { flag: 'wx' });
      fs.writeFileSync(xmlPath, result.xml, 'utf8');
      await this.bridge.call('existing_object', { ...request, action: 'import', expectedScope: scope, xmlPath });
      return { xml, result, backup };
    });
  }

  async rollback(args, action) {
    const request = this.request(args, args.kind || 'block');
    const scope = await this.bridge.call('existing_object', { ...request, action: 'describe', forWrite: action === 'restore' });
    const list = this.bridge.listBackups(label(scope)).filter(item => fs.existsSync(item.path + '.json'));
    if (action === 'list') return list;
    const chosen = args.backupFile === undefined ? list[0] : list.find(item => item.file === args.backupFile);
    if (!chosen) throw new Error('No matching verified backup for this project, PLC, group and object. Legacy backups have no verified target.');
    const manifest = JSON.parse(fs.readFileSync(chosen.path + '.json', 'utf8'));
    const bytes = fs.readFileSync(chosen.path);
    if (scopeKey(manifest.scope) !== scopeKey(scope) || manifest.file !== chosen.file || manifest.sha256 !== digest(bytes)) {
      throw new Error('Backup identity or XML checksum mismatch. Restore cancelled.');
    }
    await withScratchXml(async xmlPath => {
      fs.writeFileSync(xmlPath, bytes);
      await this.bridge.call('existing_object', { ...request, action: 'import', expectedScope: scope, xmlPath });
    });
    return chosen.file;
  }
}

module.exports = { OnlineBackups };
