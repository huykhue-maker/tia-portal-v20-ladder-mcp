'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../server/ladder/block');
const X = require('../server/ladder/xml');
const { BridgeClient } = require('../server/bridge_client');

module.exports = async function testV16Profile(withMcpServer) {
  assert.equal(path.basename(new BridgeClient({ version: '16' }).executable), 'TiaBridge.V16.exe');
  assert.equal(path.basename(new BridgeClient({ version: '20' }).executable), 'TiaBridge.exe');
  assert.throws(() => new BridgeClient({ version: '19' }), /version 16 or 20/);
  const type = B.createDbXml({ portalVersion: '16', kind: 'UDT', name: 'T_Test', members: [{ name: 'Flag', type: 'Bool' }] });
  const parsed = B.parseBlock(type);
  assert.equal(parsed.portalVersion, '16');
  assert.match(X.path(parsed.blockEl, 'AttributeList/Interface/Sections').attrs.xmlns, /Interface\/v4$/);
  assert.equal(parsed.interface.None[0].type, 'Bool');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-v16-offline-'));
  try {
    const xmlPath = path.join(dir, 'FB_Compat.xml');
    await withMcpServer(async rpc => {
      const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
      const listed = (await rpc('tools/list', {})).result.tools;
      assert(listed.some(tool => tool.name === 'tia_open_project'));
      assert(listed.some(tool => tool.name === 'tia_test_ladder_project'));
      assert(!listed.some(tool => tool.name === 'tia_plcsim_runtime' || tool.name === 'tia_download_and_online'));
      assert.match((await call('tia_plcsim_runtime', { action: 'status' })).content[0].text, /unavailable.*V16/);
      assert.match((await call('tia_open_project', { path: 'wrong.ap20' })).content[0].text, /native \.ap16/);
      assert.match((await call('tia_open_project', { path: 'correct.ap16', upgrade: true })).content[0].text, /omit upgrade/);

      const spec = {
        type: 'FB', name: 'FB_Compat', outXmlPath: xmlPath,
        interface: { Input: [{ name: 'Input', type: 'Bool' }], Output: [{ name: 'Lamp', type: 'Bool' }] },
        networks: [{ dsl: 'NO(#Input) => COIL(#Lamp)' }, { dsl: 'NO(#Input) => COIL("AuditTag")' }],
      };
      const wrong = await call('tia_create_ladder_block', { ...spec, portalVersion: '20', importToTia: true });
      assert(wrong.isError);
      assert.match(wrong.content[0].text, /does not match/);
      assert(!fs.existsSync(xmlPath));

      const created = await call('tia_create_ladder_block', spec);
      assert(!created.isError, created.content[0].text);
      const original = fs.readFileSync(xmlPath, 'utf8');
      const block = B.parseBlock(original);
      assert.equal(block.portalVersion, '16');
      assert.match(block.networks[0].flg.attrs.xmlns, /FlgNet\/v4$/);
      assert.equal(B.parseBlock(B.createBlockXml(spec).xml).portalVersion, '20');

      const old = original.replace(/FlgNet\/v4/g, 'FlgNet/v3');
      const patched = B.patchNetworks(old, [{ op: 'replace', nw: 1, dsl: 'NC(#Input) => COIL(#Lamp)' },
        { op: 'append', dsl: 'NO(#Input) => COIL("AuditTail")' }]);
      const changed = B.parseBlock(patched.xml);
      assert.equal(changed.portalVersion, '16');
      assert(changed.networks.every(network => network.flg.attrs.xmlns.endsWith('/v3')));
      const untouched = B.parseBlock(old).networks[1].el;
      assert(patched.xml.includes(old.slice(untouched.start, untouched.end)));
      assert.throws(() => B.patchNetworks(original, [{ op: 'replace', nw: 1, dsl: 'MOVE(1, #Lamp)' }]),
        /V16 LAD generation supports/);

      fs.writeFileSync(xmlPath, patched.xml, 'utf8');
      const simulation = await call('tia_dry_run_ladder', {
        xmlPaths: [xmlPath], entry: 'FB_Compat',
        scenario: { steps: [{ set: { '#Input': 0 }, expect: { '#Lamp': 1 } }, { set: { '#Input': 1 }, expect: { '#Lamp': 0 } }] },
      });
      assert(!simulation.isError, simulation.content[0].text);
      assert.match(simulation.content[0].text, /^PASS - 2 scans/);
    }, 15000, undefined, { TIA_PORTAL_VERSION: '16' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
