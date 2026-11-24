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
let total = 0;
function test(name, fn) {
  total++;
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
      assert.strictEqual(listed.result.tools.length, 30, 'Expected 30 MCP tools, got ' + listed.result.tools.length);
      const toolNames = new Set(listed.result.tools.map(t => t.name));
      const newTools = [
        'tia_watch_table',
        'tia_show_in_editor',
        'tia_scl_source',
        'tia_cross_reference',
        'tia_hardware_config',
        'tia_network_config',
        'tia_plcsim_runtime',
        'tia_escape_hatch',
      ];
      for (const nt of newTools) {
        assert(toolNames.has(nt), 'Missing newly added MCP tool in tools/list: ' + nt);
      }

      // Call live tia_status (spawns real compiled TiaBridge.exe!)
      const st = await rpc('tools/call', { name: 'tia_status', arguments: {} });
      assert(!st.result.isError, 'tia_status error: ' + st.result.content[0].text);
      assert(st.result.content[0].text.includes('OPENNESS ACCESSIBLE: true'), 'Expected TiaBridge opennessAccessible=true');

      // Smoke test new bridge tools that do not require an open TIA project
      const eh = await rpc('tools/call', { name: 'tia_escape_hatch', arguments: { action: 'list_handles' } });
      assert(!eh.result.isError, 'tia_escape_hatch(list_handles) failed: ' + eh.result.content[0].text);

      const simRt = await rpc('tools/call', { name: 'tia_plcsim_runtime', arguments: { action: 'status' } });
      assert(!simRt.result.isError, 'tia_plcsim_runtime(status) failed: ' + simRt.result.content[0].text);

      // Smoke test new tools wired in server/index.js (when disconnected/no project, should return clean MCP error without crashing server)
      for (const probe of [
        { name: 'tia_watch_table', arguments: { action: 'list' } },
        { name: 'tia_show_in_editor', arguments: { kind: 'block', name: 'Main' } },
        { name: 'tia_scl_source', arguments: { action: 'export', blockName: 'Main' } },
        { name: 'tia_cross_reference', arguments: { filter: 'used' } },
        { name: 'tia_hardware_config', arguments: { action: 'presets' } },
        { name: 'tia_network_config', arguments: { action: 'inspect' } },
      ]) {
        const res = await rpc('tools/call', probe);
        assert(res && res.result && Array.isArray(res.result.content) && res.result.content.length > 0, 'Malformed MCP response from ' + probe.name);
      }

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

  // 6. New Ladder V20 features: <Part Name="O"> parallel OR, Sub without Card, SIN/COS/CONV/NORM_X/SCALE_X/LIMIT, Array & Motion
  await test('6. Ladder V20 features (O-gate OR, Sub without Card, CONV, SIN, COS, NORM_X, SCALE_X, Array, Motion) roundtrip & dry-run', () => {
    // 6a. Verify Sub has NO Card template and OR emits <Part Name="O"> with Card="3"
    const subXml = G.generateFlgNet(D.parseNetwork('NO(#En) => SUB(#A, #B, #Diff, Real)').flows, {}).xml;
    assert(subXml.includes('<Part Name="Sub"'), 'Expected Sub part');
    assert(!subXml.includes('Name="Card"'), 'Sub in TIA V20 must NOT have a Card TemplateValue!');

    const orXml = G.generateFlgNet(D.parseNetwork('(NO(#M1) | NO(#M2) | NC(#M3)) => COIL(#Out)').flows, {}).xml;
    assert(orXml.includes('<Part Name="O"'), 'Parallel OR in TIA V20 must emit <Part Name="O">');
    assert(orXml.includes('<TemplateValue Name="Card" Type="Cardinality">3</TemplateValue>'), 'OR gate must have Card=3');

    // 6b. Roundtrip all new Ladder DSL constructs
    const cases = [
      'NO(#M1) | NO(#M2) | NC(#M3) => COIL(#Out)',
      'NO(#En) => SUB(#A, #B, #Diff, Real)',
      'NO(#En) => CONV(#RawInt, #ValReal, Int, Real)',
      'NO(#En) => COS(#Angle, #CosVal, Real), SIN(#Angle, #SinVal, Real)',
      'NO(#En) => NORM_X(0, #RawInt, 27648, #NormVal, Int, Real) => SCALE_X(0.0, #NormVal, 100.0, #TempC, Real, Real)',
      'NO(#En) => LIMIT(0.0, #TempC, 100.0, #Clamped, Real)',
      'NO(#En) => MOVE(#Arr[#Idx], #OutVal)',
      'MC_Power("MC_Power_DB", Axis="Truc_X", Enable=NO(#ServoOn), Status=#ServoOk)',
      'MC_MoveAbsolute("MC_Move_DB", Axis="Truc_X", Position=40.0, Velocity=20.0, Execute=NO(#Go), Done=#Done)',
    ];
    for (const dsl of cases) {
      const flows = D.parseNetwork(dsl).flows;
      const gen = G.generateFlgNet(flows, {});
      const back = R.readFlgNet(X.parse(gen.xml));
      assert.strictEqual(back.complete, true, 'Expected complete roundtrip for: ' + dsl + ' notes=' + JSON.stringify(back.notes));
      assert.strictEqual(back.dsl, dsl, 'Roundtrip mismatch:\n  in : ' + dsl + '\n  out: ' + back.dsl);
    }

    // 6c. In-RAM scan-cycle simulation of CONV, NORM_X, SCALE_X, SIN, COS, SUB & OR
    const mathBlock = B.createBlockXml({
      type: 'FB',
      name: 'FB_MathAnalog',
      interface: {
        Input: [
          { name: 'En1', type: 'Bool' },
          { name: 'En2', type: 'Bool' },
          { name: 'RawAnalog', type: 'Int' },
          { name: 'Angle', type: 'Real' },
        ],
        Output: [
          { name: 'Active', type: 'Bool' },
          { name: 'ConvReal', type: 'Real' },
          { name: 'NormVal', type: 'Real' },
          { name: 'TempC', type: 'Real' },
          { name: 'CosOut', type: 'Real' },
          { name: 'SinOut', type: 'Real' },
          { name: 'DiffOut', type: 'Real' },
        ],
      },
      networks: [
        { title: 'OR Enable', dsl: '(NO(#En1) | NO(#En2)) => COIL(#Active)' },
        { title: 'Analog NORM_X + SCALE_X + CONV', dsl: 'NO(#Active) => CONV(#RawAnalog, #ConvReal, Int, Real), NORM_X(0, #RawAnalog, 27648, #NormVal, Int, Real) => SCALE_X(0.0, #NormVal, 100.0, #TempC, Real, Real)' },
        { title: 'Trig COS/SIN & SUB', dsl: 'NO(#Active) => COS(#Angle, #CosOut, Real), SIN(#Angle, #SinOut, Real), SUB(#TempC, 10.0, #DiffOut, Real)' },
      ],
    }, {});

    const read = B.readBlock(mathBlock.xml, { format: 'dsl' });
    const prog = S.buildProgram([read], 'FB_MathAnalog');
    const sim = S.runScenario(prog, {
      scanMs: 10,
      init: { '#En1': 0, '#En2': 1, '#RawAnalog': 13824, '#Angle': 0.0 },
      watch: ['#Active', '#ConvReal', '#NormVal', '#TempC', '#CosOut', '#SinOut', '#DiffOut'],
      steps: [
        {
          run: 1,
          tolerance: 0.01,
          expect: {
            '#Active': 1,
            '#ConvReal': 13824.0,
            '#NormVal': 0.5,
            '#TempC': 50.0,
            '#CosOut': 1.0,
            '#SinOut': 0.0,
            '#DiffOut': 40.0,
          },
        },
      ],
    });
    assert.strictEqual(sim.ok, true, 'Math/Analog/OR simulation failed:\n' + S.formatResults(sim));
  });

  console.log('\n=== SUMMARY: ' + passed + '/' + total + ' test groups passed ===');
}

main();
