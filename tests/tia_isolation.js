'use strict';

// Creates its own headless TIA session and disposable engineering projects. No PLC connection is used.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function testTiaIsolation(withMcpServer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-isolation-'));
  await withMcpServer(async rpc => {
    const files = new Set();
    const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
    const success = async (name, args) => {
      const result = await call(name, args);
      assert(!result.isError, result.content[0].text);
      return result.content[0].text;
    };
    const denied = async (name, args, expected) => {
      const result = await call(name, args);
      assert(result.isError, 'Expected refusal from ' + name);
      assert.match(result.content[0].text, expected);
    };
    const plcA = 'PLC_A', plcB = 'PLC_B', blockName = 'FB_BackupTest', group = 'Engineering/Logic';
    const rollback = (plcName, backupFile) => ({ action: 'restore', plcName, blockName, group, backupFile });
    const createPlc = plcName => success('tia_hardware_config', { action: 'add_plc', plcName });
    const createBlock = plcName => success('tia_create_ladder_block', {
      plcName, type: 'FB', name: blockName, number: 201, group, outXmlPath: path.join(directory, 'input.xml'), importToTia: true,
      interface: { Input: [{ name: 'In1', type: 'Bool' }], Output: [{ name: 'Flag', type: 'Bool' }] },
      networks: [{ title: 'Original', dsl: 'NO(#In1) => COIL(#Flag)' }],
    });
    const patch = { blockName, group, ops: [{ op: 'replace', nw: 1, title: 'Updated', dsl: 'NC(#In1) => COIL(#Flag)' }] };
    const edit = async plcName => {
      await success('tia_compile', { plcName });
      const result = await success('tia_patch_ladder_network', { ...patch, plcName });
      const file = /^BACKUP: (.+)$/m.exec(result)[1];
      files.add(file);
      return path.basename(file);
    };
    const createProject = name => success('tia_hardware_config', { action: 'create_project', name, directory });
    const read = async plcName => { await success('tia_compile', { plcName }); return success('tia_read_ladder', { blockName, plcName }); };
    let connected = false;
    try {
      await success('tia_connect', { mode: 'headless' });
      connected = true;
      await createProject('ProjectA');
      await createPlc(plcA);
      await createBlock(); // Single PLC is unambiguous.
      const backupA = await edit();
      await createPlc(plcB);
      await createBlock(plcB);
      await denied('tia_patch_ladder_network', patch, /specify plcName/);
      await denied('tia_rollback_block', rollback(undefined, backupA), /specify plcName/);
      await denied('tia_upsert_tags', { table: 'Test', tags: [{ name: 'Fixture', type: 'Bool', address: '%M0.0' }] }, /specify plcName/);
      await denied('tia_rollback_block', rollback(plcB, backupA), /No matching verified backup/);
      await denied('tia_rollback_block', { ...rollback(plcA, backupA), group: 'Wrong' }, /group does not match/);
      assert.match(await read(plcB), /NO\(#In1\)/);
      await success('tia_rollback_block', rollback(plcA, backupA));
      assert.match(await read(plcA), /NO\(#In1\)/);
      await success('tia_close_project');
      await createProject('ProjectB');
      await createPlc(plcA);
      await createBlock(plcA);
      const backupB = await edit(plcA);
      await denied('tia_rollback_block', rollback(plcA, backupA), /No matching verified backup/);
      assert.match(await read(plcA), /NC\(#In1\)/);
      await success('tia_rollback_block', rollback(plcA)); // latest in ProjectB
      assert.match(await read(plcA), /NO\(#In1\)/);
      const fullPath = [...files].find(file => path.basename(file) === backupB);
      fs.appendFileSync(fullPath, '\n');
      await denied('tia_rollback_block', rollback(plcA, backupB), /checksum mismatch/);
    } finally {
      if (connected) await success('tia_close_project', { disconnect: true, closeTia: true });
      for (const file of files) {
        fs.rmSync(file, { force: true });
        fs.rmSync(file + '.json', { force: true });
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 180000);
};
