'use strict';

// Run only with a disposable native V16 project. No project save or PLC download.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const B = require('../server/ladder/block');
const { BridgeClient } = require('../server/bridge_client');

async function main() {
  const [file, plcName = ''] = process.argv.slice(2);
  if (!file || path.extname(file).toLowerCase() !== '.ap16' || !fs.existsSync(file)) {
    throw new Error('Usage: npm run test:tia-v16 -- <disposable-project.ap16> [PLC-name]');
  }
  const bridge = new BridgeClient({ version: '16' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-v16-smoke-'));
  let connected = false;
  try {
    const status = await bridge.call('status');
    assert.equal(status.portalVersion, '16');
    assert.equal(status.opennessAccessible, true, status.opennessError);
    const session = await bridge.call('connect', { mode: 'headless' });
    connected = true;
    assert.equal(session.attachedExisting, false);
    assert.equal(session.connected, true);
    const opened = await bridge.call('open_project', { path: path.resolve(file) });
    assert.equal(opened.projectOpen, true);

    const selection = { plcName };
    await bridge.call('list_blocks', selection);
    assert(Array.isArray((await bridge.call('list_tags', selection)).tables));
    const blockName = 'FB_McpCompat_' + randomBytes(4).toString('hex');
    const xmlPath = path.join(dir, blockName + '.xml');
    const exported = path.join(dir, 'export.xml');
    const src = B.createBlockXml({
      portalVersion: '16', type: 'FB', name: blockName,
      interface: { Input: [{ name: 'Enable', type: 'Bool' }], Output: [{ name: 'Active', type: 'Bool' }] },
      networks: [{ dsl: 'NO(#Enable) => COIL(#Active)' }],
    }).xml;
    fs.writeFileSync(xmlPath, src, 'utf8');
    const imported = await bridge.call('import_block', { ...selection, xmlPath });
    try {
      assert(imported.blocks.includes(blockName));
      const response = await bridge.call('export_block', { ...selection, blockName, outPath: exported });
      const read = B.readBlock(fs.readFileSync(response.path, 'utf8'), { simulationOnly: true });
      assert.equal(read.doc.portalVersion, '16');
      assert.equal(read.networks[0].dsl, 'NO(#Enable) => COIL(#Active)');
      const result = await bridge.call('compile', { ...selection, enableSimulation: false });
      assert.equal(result.software.errorCount, 0, JSON.stringify(result.software.messages));
      console.log('PASS | V16 Openness, native project, XML import/export and software compile');
    } finally {
      if (imported.blocks.includes(blockName)) await bridge.call('delete_block', { ...selection, blockName });
    }
  } finally {
    try {
      if (connected) await bridge.call('disconnect', { closeTia: true });
    } finally {
      bridge.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
