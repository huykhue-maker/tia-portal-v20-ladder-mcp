'use strict';
// End-to-end automated test suite for TIA Portal V20 MCP Server & Ladder Engine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const D = require('../server/ladder/dsl');
const G = require('../server/ladder/gen');
const R = require('../server/ladder/reader');
const B = require('../server/ladder/block');
const A = require('../server/ladder/analyzer');
const S = require('../server/ladder/simulator');
const X = require('../server/ladder/xml');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  [PASS]', name);
  }).catch(err => {
    console.error('  [FAIL]', name, '\n       ', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

async function main() {
  console.log('=== TIA Portal V20 MCP & Ladder Engine Test Suite ===');

  // 1. Ladder DSL <-> SimaticML XML roundtrip
  await test('1. Ladder DSL <-> SimaticML XML full roundtrip (contacts, OR branches, RTRIG, TON, CTU, CMP, MATH, MOVE, CALL)', () => {
    const callCatalog = {
      FB_Axis: {
        blockType: 'FB',
        params: [
          { name: 'Enable', section: 'Input', type: 'Bool' },
          { name: 'Speed', section: 'Input', type: 'Real' },
          { name: 'Done', section: 'Output', type: 'Bool' },
        ],
      },
    };
    const cases = [
      '(NO(#Start) | NO(#Run)) & NC(#Stop) & NC("E_Stop") => COIL(#Run)',
      'NO(#Run) => TON(#T_Delay, PT=T#3s) => COIL(#Ready), SET(%Q0.1)',
      'NO(#Sensor) & RTRIG(#M_Edge) => CTU(#C_Parts, PV=5, R=NO(#Reset_Cnt), CV=#Count) => COIL(#Batch_Full)',
      'GE(#Count, 5, Int) => ADD(#Total, 1, #Total, Int), MOVE(0, #Count)',
      'NO(#Run) => CALL("FB_Axis", inst="DB_AxisX", Enable=#Run, Speed=150.5, Done=#Axis_Ok) => COIL(#Step2)',
    ];
    for (const dsl of cases) {
      const flows = D.parseNetwork(dsl).flows;
      const gen = G.generateFlgNet(flows, { callCatalog });
      const back = R.readFlgNet(X.parse(gen.xml));
      assert.strictEqual(back.complete, true, 'Expected complete roundtrip for: ' + dsl + ' notes=' + JSON.stringify(back.notes));
      assert.strictEqual(back.dsl, dsl, 'Roundtrip mismatch:\n  in : ' + dsl + '\n  out: ' + back.dsl);
    }
  });

  // 2. Surgical network patching preserves untouched complex networks byte-for-byte
  await test('2. Surgical network patch preserves untouched complex CNC Motion Control XML byte-for-byte', () => {
    const base = B.createBlockXml({
      type: 'FB',
      name: 'FB_CNC_Main',
      interface: {
        Input: [{ name: 'Start', type: 'Bool' }, { name: 'Stop', type: 'Bool' }],
        Output: [{ name: 'Spindle', type: 'Bool' }],
        Static: [{ name: 'Step', type: 'Int' }],
      },
      networks: [
        { title: 'NW1 Latch', dsl: '(NO(#Start) | NO(#Spindle)) & NC(#Stop) => COIL(#Spindle)' },
        { title: 'NW2 Placeholder', dsl: 'NO(#Spindle) => MOVE(1, #Step)' },
      ],
    }, {});

    // Inject a synthetic complex Siemens Motion Control / non-standard Part inside NW2
    const untouchedBlock = `<Part Name="MC_Power" Version="6.0" UId="99"><Instance Scope="GlobalVariable" UId="98"><Component Name="DB_MC_Power_X" /></Instance><TemplateValue Name="AxisType" Type="Type">TO_PositioningAxis</TemplateValue></Part>`;
    const customXml = base.xml.replace('<Part Name="Move" UId="23">', untouchedBlock + '\n                <Part Name="Move" UId="23">');
    assert(customXml.includes(untouchedBlock), 'Injected synthetic MC_Power part');

    const patched = B.patchNetworks(customXml, [
      { op: 'replace', nw: 1, dsl: '(NO(#Start) | NO(#Spindle)) & NC(#Stop) => TON(#T_Spindle, PT=T#2s) => COIL(#Spindle)', title: 'NW1 Delayed Spindle' },
      { op: 'append', dsl: 'NO(#Spindle) => MOVE(2, #Step)', title: 'NW3 Set Step 2' },
    ], {});

    assert(patched.xml.includes(untouchedBlock), 'Untouched NW2 MC_Power XML MUST remain byte-for-byte intact!');
    const parsed = B.parseBlock(patched.xml);
    assert.strictEqual(parsed.networks.length, 3);
    assert(parsed.interface.Static.some(m => m.name === 'T_Spindle' && m.type === 'TON_TIME'), 'Auto-declared Static T_Spindle:TON_TIME');
  });

  // 3. Static analyzer detects Double Coil, Set without Reset, Timer/Edge reuse, Undeclared, XRef
  await test('3. Static analyzer catches Double Coil, Set-without-Reset, Edge reuse & Cross-Reference', () => {
    const buggy = B.createBlockXml({
      type: 'FB',
      name: 'FB_Buggy',
      interface: {
        Input: [{ name: 'A', type: 'Bool' }, { name: 'B', type: 'Bool' }],
        Output: [{ name: 'Motor', type: 'Bool' }, { name: 'Alarm', type: 'Bool' }],
        Static: [{ name: 'UnusedVar', type: 'Int' }],
      },
      networks: [
        { title: 'NW1', dsl: 'NO(#A) & RTRIG(#e1) => COIL(#Motor)' },
        { title: 'NW2', dsl: 'NO(#B) & RTRIG(#e1) => COIL(#Motor), SET(#Alarm)' },
      ],
    }, {});
    const read = B.readBlock(buggy.xml, { format: 'dsl' });
    const res = A.analyze([read], { symbol: 'Motor' });
    const codes = new Set(res.findings.map(f => f.code));
    assert(codes.has('DOUBLE_COIL'), 'Should catch DOUBLE_COIL');
    assert(codes.has('SET_WITHOUT_RESET'), 'Should catch SET_WITHOUT_RESET');
    assert(codes.has('EDGE_MEM_REUSE'), 'Should catch EDGE_MEM_REUSE');
    assert(codes.has('UNUSED'), 'Should catch UNUSED');
    assert(res.xref['#Motor'] && res.xref['#Motor'].length === 2, 'Cross-reference should list both writes to #Motor');
  });

  // 4. Scan-cycle dry-run simulator (Latch + 3s TON + CTU + E-Stop + FB Call)
  await test('4. Scan-cycle dry-run simulator validates CNC spindle delay, part counter & E-Stop', () => {
    const spindleXml = B.createBlockXml({
      type: 'FB',
      name: 'FB_Spindle',
      interface: {
        Input: [{ name: 'Start', type: 'Bool' }, { name: 'Stop', type: 'Bool' }, { name: 'EStop', type: 'Bool' }, { name: 'PartPulse', type: 'Bool' }],
        Output: [{ name: 'Run', type: 'Bool' }, { name: 'Ready', type: 'Bool' }, { name: 'BatchDone', type: 'Bool' }],
        Static: [{ name: 'Count', type: 'Int' }],
      },
      networks: [
        { title: 'Latch', dsl: '(NO(#Start) | NO(#Run)) & NC(#Stop) & NC(#EStop) => COIL(#Run)' },
        { title: '3s Stabilize', dsl: 'NO(#Run) => TON(#T_Stab, PT=T#3s) => COIL(#Ready)' },
        { title: 'Count 2 parts when Ready', dsl: 'NO(#Ready) & NO(#PartPulse) => CTU(#C_Part, PV=2, R=NO(#EStop), CV=#Count) => COIL(#BatchDone)' },
      ],
    }, {});

    const read = B.readBlock(spindleXml.xml, { format: 'dsl' });
    const prog = S.buildProgram([read], 'FB_Spindle');
    const sim = S.runScenario(prog, {
      scanMs: 100,
      init: { '#Start': 0, '#Stop': 0, '#EStop': 0, '#PartPulse': 0 },
      watch: ['#Run', '#Ready', '#Count', '#BatchDone'],
      steps: [
        { set: { '#Start': 1 }, run: 1, expect: { '#Run': 1, '#Ready': 0 } },
        { set: { '#Start': 0 }, run: 'T#2s', expect: { '#Run': 1, '#Ready': 0 } },
        { run: 'T#1500ms', expect: { '#Ready': 1 } },
        { set: { '#PartPulse': 1 }, run: 1, expect: { '#Count': 1, '#BatchDone': 0 } },
        { set: { '#PartPulse': 0 }, run: 1 },
        { set: { '#PartPulse': 1 }, run: 1, expect: { '#Count': 2, '#BatchDone': 1 } },
        { set: { '#EStop': 1, '#PartPulse': 0 }, run: 1, expect: { '#Run': 0, '#Ready': 0, '#Count': 0, '#BatchDone': 0 } },
      ],
    });
    assert.strictEqual(sim.ok, true, 'Simulation failed:\n' + S.formatResults(sim));
  });

  // 5. Full Live MCP Server Stdio JSON-RPC 2.0 Integration Test
  await test('5. MCP Server stdio JSON-RPC (initialize, tools/list, live tia_status, offline create/read/patch/analyze/dry_run)', async () => {
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const w = pending.get(msg.id);
        if (w) { pending.delete(msg.id); w.resolve(msg); }
      }
    });
    let nextId = 1;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error('MCP RPC timeout: ' + method)), 15000);
      pending.set(id, { resolve: m => { clearTimeout(t); resolve(m); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    try {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
      assert.strictEqual(init.result.serverInfo.name, 'tia-portal-v20-mcp');

      const listed = await rpc('tools/list', {});
      assert.strictEqual(listed.result.tools.length, 22, 'Expected 22 MCP tools, got ' + listed.result.tools.length);

      // Call live tia_status (spawns real compiled TiaBridge.exe!)
      const st = await rpc('tools/call', { name: 'tia_status', arguments: {} });
      assert(!st.result.isError, 'tia_status error: ' + st.result.content[0].text);
      assert(st.result.content[0].text.includes('OPENNESS ACCESSIBLE: true'), 'Expected TiaBridge opennessAccessible=true');

      // Offline create -> read -> patch -> analyze -> dry_run via MCP tools!
      const tmpXml = path.join(os.tmpdir(), 'tia_mcp_test_fb.xml');
      const created = await rpc('tools/call', {
        name: 'tia_create_ladder_block',
        arguments: {
          type: 'FB', name: 'FB_McpTest', outXmlPath: tmpXml, importToTia: false,
          interface: { Input: [{ name: 'Btn', type: 'Bool' }], Output: [{ name: 'Lamp', type: 'Bool' }] },
          networks: [{ title: 'Light', dsl: 'NO(#Btn) => COIL(#Lamp)' }],
        },
      });
      assert(!created.result.isError, created.result.content[0].text);

      const patched = await rpc('tools/call', {
        name: 'tia_patch_ladder_network',
        arguments: {
          xmlPath: tmpXml,
          ops: [{ op: 'replace', nw: 1, dsl: 'NO(#Btn) => TON(#T1, PT=T#500ms) => COIL(#Lamp)', title: 'Delayed Light' }],
        },
      });
      assert(!patched.result.isError, patched.result.content[0].text);

      const sim = await rpc('tools/call', {
        name: 'tia_dry_run_ladder',
        arguments: {
          entry: 'FB_McpTest', xmlPaths: [tmpXml],
          scenario: {
            scanMs: 50,
            steps: [
              { set: { '#Btn': 1 }, run: 'T#200ms', expect: { '#Lamp': 0 } },
              { run: 'T#400ms', expect: { '#Lamp': 1 } },
            ],
          },
        },
      });
      assert(!sim.result.isError, sim.result.content[0].text);
      assert(sim.result.content[0].text.startsWith('PASS'), sim.result.content[0].text);

      try { fs.unlinkSync(tmpXml); } catch { }
    } finally {
      child.kill();
    }
  });

  console.log('\n=== SUMMARY: ' + passed + '/5 test groups passed ===');
}

main();
