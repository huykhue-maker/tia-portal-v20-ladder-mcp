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
const L = require('../server/ladder/learn');

const SKIP = Symbol('skip');
let skipped = 0;
let passed = 0;
let total = 0;
const suite = process.argv[2] || 'all';
if (!['offline', 'tia', 'tia-isolation', 'all'].includes(suite)) {
  throw new Error('Expected test suite: offline, tia, tia-isolation or all');
}

function test(name, fn, group = 'offline') {
  if (suite !== 'all' && suite !== group) return;
  total++;
  return Promise.resolve().then(fn).then(result => {
    if (result === SKIP) {
      skipped++;
      console.log('  [SKIP]', name);
      return;
    }
    passed++;
    console.log('  [PASS]', name);
  }).catch(err => {
    console.error('  [FAIL]', name, '\n       ', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

async function withMcpServer(run, timeoutMs = 15000, preload, env = {}) {
  const serverPath = path.join(__dirname, '..', 'server', 'index.js');
  const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TIA_PORTAL_VERSION: '20', ...env } });
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
    const t = setTimeout(() => reject(new Error('MCP RPC timeout: ' + method)), timeoutMs);
    pending.set(id, { resolve: m => { clearTimeout(t); resolve(m); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
    assert.strictEqual(init.result.serverInfo.name, 'tia-portal-v' + (env.TIA_PORTAL_VERSION || '20') + '-mcp');

    await run(rpc);
  } finally {
    child.kill();
  }
}

async function main() {
  console.log('=== TIA Portal V20 MCP & Ladder Engine Test Suite ===');
  await test('Offline project runner: CLI, MCP, JUnit, independent cases and diagnostics', () =>
    require('./project')(withMcpServer));
  await test('Typed LAD project: DB defaults, tag table and strict symbol diagnostics', () =>
    require('./project_symbols')(withMcpServer));
  await test('Offline baseline comparison: intermediate divergence, initial state, CLI, MCP and JUnit', () =>
    require('./project_compare')(withMcpServer));
  await test('TIA V16 profile: matching bridge, V16 XML, patching and offline simulation', () =>
    require('./tia_v16_profile')(withMcpServer));

  await test('Offline MCP: until obeys the simulated deadline', async () => {
    await withMcpServer(async rpc => {
      async function simulate(step, scanMs = 10) {
        const response = await rpc('tools/call', { name: 'tia_dry_run_ladder', arguments: {
          entry: 'Main',
          inlineBlocks: [{ name: 'Main', networks: ['ADD(#Count, 1, #Count, DInt)'] }],
          scenario: { scanMs, init: { '#Count': 0 }, steps: [step] },
        } });
        return response.result;
      }
      for (const [target, timeout, expected] of [
        [3, '20ms', 'FAIL - 2 scans, simulated 20 ms'],
        [2, '20ms', 'PASS - 2 scans, simulated 20 ms'],
        [3, '25ms', 'FAIL - 2 scans, simulated 20 ms'],
        [1, '5ms', 'FAIL - 0 scans, simulated 0 ms'],
        [1, '0ms', 'FAIL - 0 scans, simulated 0 ms'],
        [0, '0ms', 'PASS - 0 scans, simulated 0 ms'],
        [2, undefined, 'PASS - 2 scans, simulated 20 ms'],
      ]) {
        const result = await simulate({ until: { '#Count': target }, timeout });
        assert(!result.isError);
        assert.strictEqual(result.content[0].text.split('\n')[0], expected);
      }
      for (const value of ['bad', '1.2.3ms', '-10ms', '']) {
        const result = await simulate({ until: { '#Count': 1 }, timeout: value });
        assert(result.isError && /step 1.*timeout/i.test(result.content[0].text));
      }
      for (const until of [{}, { '#Count': 1, '#Other': 1 }]) {
        const result = await simulate({ until });
        assert(result.isError && /step 1.*until/i.test(result.content[0].text));
      }
      for (const scanMs of [0, -1, 0.5]) {
        const result = await simulate({ run: 0 }, scanMs);
        assert(result.isError && /scanMs/.test(result.content[0].text));
      }
      const elapsed = await simulate({
        set: { '#Elapsed': 'T#20ms' }, until: { '#Elapsed': 'T#20ms' },
        timeout: '0ms', expect: { '#Elapsed': 'T#20ms' },
      });
      assert(elapsed.content[0].text.startsWith('PASS - 0 scans'), elapsed.content[0].text);
      const exact = await simulate({
        set: { '#Value': 1.0001 }, until: { '#Value': 1 }, timeout: '0ms', tolerance: 0,
      });
      assert(exact.content[0].text.startsWith('FAIL - 0 scans'), exact.content[0].text);
    });
  });

  await test('Offline MCP: IEC ROUND ties and missing CALL targets', async () => {
    await withMcpServer(async rpc => {
      const dryRun = async (networks, steps, more = []) => (await rpc('tools/call', { name: 'tia_dry_run_ladder', arguments: {
        entry: 'Main', inlineBlocks: [{ name: 'Main', networks }, ...more], scenario: { steps },
      } })).result;
      const cases = [[10.5, 10], [11.5, 12], [-1.5, -2], [-2.5, -2], [0.5, 0], [-0.5, 0], [7.49, 7], [-7.51, -8]];
      const rounded = await dryRun(['ROUND(#X, #Y, Real, DInt)'],
        cases.map(([input, output]) => ({ set: { '#X': input }, run: 1, expect: { '#Y': output } })));
      assert.match(rounded.content[0].text, /^PASS/);
      for (const logic of ['CALL("NotLoaded")', 'NO(#Disabled) => MOVE(1, #X) => CALL("NotLoaded")']) {
        const result = await dryRun(['COIL(#Y)', logic], [{ run: 0 }]);
        assert(result.isError);
        assert.match(result.content[0].text, /Main NW2: missing CALL target NotLoaded/);
      }
      const loaded = await dryRun(['CALL("Loaded") => COIL(#Y)'], [{ run: 1, expect: { '#Y': 1 } }], [{ name: 'Loaded', type: 'FC', networks: [] }]);
      assert.match(loaded.content[0].text, /^PASS/);
    });
  });

  await test('Impact analysis: exact symbol, CALL sites, transitive callers and suite cases', async () => {
    const manifestPath = path.join(__dirname, '..', 'examples', 'inspection', 'suite.json');
    const P = require('../server/ladder/project');
    const report = P.runProject(manifestPath, { targetBlock: 'FC_Eligible', targetSymbol: '#Present' });
    assert(report.ok);
    assert.deepStrictEqual(report.analysis.impact.affectedBlocks, ['FB_Inspection', 'FC_Eligible']);
    assert(report.analysis.impact.networks.some(n => n.block === 'FB_Inspection' && n.nw === 1 && n.reasons.includes('CALL FC_Eligible')));
    assert.strictEqual(report.analysis.impact.suggestedCases.length, 3);
    const exact = P.runProject(manifestPath, { targetSymbol: '#PresentExtra' });
    assert.deepStrictEqual(exact.analysis.impact.networks, []);
    // Local #Var and global "Var" stay isolated; Global DB members normalize cleanly with or without quotes
    const scopedBlocks = ['FB_Target', 'FB_Unrelated', 'OB_Caller'].map(name => {
      if (name === 'OB_Caller') {
        return B.readBlock(B.createBlockXml({
          name, type: 'OB',
          networks: [{ dsl: 'NO("Shared") => MOVE("DB_Cfg".Speed, "DB_Cfg".Speed)' }],
        }).xml, { simulationOnly: true });
      }
      return B.readBlock(B.createBlockXml({
        name, type: 'FB',
        interface: { Input: [{ name: 'Flag', type: 'Bool' }], Output: [{ name: 'Out', type: 'Bool' }] },
        networks: [{ dsl: 'NO(#Flag) => COIL(#Out)' }],
      }).xml, { simulationOnly: true });
    });
    const localScoped = A.analyze(scopedBlocks, { targetBlock: 'FB_Target', targetSymbol: '#Flag' }).impact;
    assert.deepStrictEqual(localScoped.affectedBlocks, ['FB_Target'], 'Local #Flag in FB_Target must not bleed into FB_Unrelated');
    const globalOnly = A.analyze(scopedBlocks, { targetSymbol: 'Flag' }).impact;
    assert.deepStrictEqual(globalOnly.affectedBlocks, [], 'Global "Flag" must not falsely match local #Flag');
    const dbMember = A.analyze(scopedBlocks, { targetSymbol: 'DB_Cfg.Speed' }).impact;
    assert.deepStrictEqual(dbMember.affectedBlocks, ['OB_Caller'], 'Unquoted DB_Cfg.Speed must match "DB_Cfg".Speed');

    await withMcpServer(async rpc => {
      const result = (await rpc('tools/call', { name: 'tia_test_ladder_project', arguments: { manifestPath, format: 'json', targetBlock: 'FC_Eligible' } })).result;
      assert(!result.isError);
      assert.strictEqual(result.structuredContent.analysis.impact.suggestedCases.length, 3);
    });
  });

  await test('Scoped cache never shares tags, DBs or CALL signatures between PLCs/projects', () => {
    const { BridgeClient } = require('../server/bridge_client');
    const client = new BridgeClient();
    client.setScope('Project_A.ap20', 'PLC_1');
    client.tagsCache.Start = { address: '%I0.0' };
    client.dbsCache.DB1 = { Static: [] };
    client.learned.calls.Worker = { type: 'FB' };
    client.setScope(undefined, '');
    assert(client.tagsCache.Start && client.dbsCache.DB1 && client.learned.calls.Worker);
    client.setScope(undefined, 'PLC_2');
    assert.deepStrictEqual(client.tagsCache, {});
    assert.deepStrictEqual(client.dbsCache, {});
    assert.deepStrictEqual(client.learned.calls, {});
    client.setScope(undefined, '');
    assert(client.tagsCache.Start && client.learned.calls.Worker, 'Omitted plcName must return to the project default PLC');
    client.setScope(undefined, 'PLC_2');
    assert.deepStrictEqual(client.tagsCache, {});
    client.setScope('Project_B.ap20', 'PLC_1');
    assert.deepStrictEqual(client.tagsCache, {});
    client.setScope('Project_A.ap20', 'PLC_1');
    assert(client.tagsCache.Start && client.learned.calls.Worker);
    client.invalidateObject('Worker');
    client.invalidateObject('DB1');
    assert(!client.learned.calls.Worker && !client.dbsCache.DB1);
    assert.notStrictEqual(client.uniqueExportPath('Main', '.xml'), client.uniqueExportPath('Main', '.xml'));
    client.clearProjectScope();
    assert.deepStrictEqual(client.tagsCache, {});
  });

  await test('MCP tools/call executes FIFO even when the first call waits for the bridge', async () => {
    await withMcpServer(async rpc => {
      const order = [];
      const first = rpc('tools/call', { name: 'tia_status', arguments: {} }).then(r => { order.push('status'); return r; });
      const second = rpc('tools/call', { name: 'tia_test_ladder_project', arguments: {
        manifestPath: path.join(__dirname, '..', 'examples', 'inspection', 'suite.json'), format: 'json',
      } }).then(r => { order.push('suite'); return r; });
      const results = await Promise.all([first, second]);
      assert(results[0].result.isError);
      assert.match(results[0].result.content[0].text, /fixture status rejected/);
      assert(!results[1].result.isError);
      assert(JSON.parse(results[1].result.content[0].text).ok);
      assert.deepStrictEqual(order, ['status', 'suite']);
    }, 15000, path.join(__dirname, 'fixtures', 'delayed-bridge.js'));
  });

  await test('Temp resets per OB scan and FB call; Initial_Call and OB system inputs', () => {
    const net = dsl => D.parseNetwork(dsl).flows;
    const program = { entry: 'Main', blocks: {
      Main: { type: 'OB', inputs: ['Initial_Call'], temps: [{ name: 'T', type: 'Bool' }], skipped: [], flows: [
        ...net('NO(#Initial_Call) => COIL("First")'),
        ...net('NO(#T) => COIL("Stale")'),
        ...net('TRUE => SET(#T)'),
        ...net('TRUE => CALL("Worker", inst="DB_Worker")'),
        ...net('TRUE => CALL("Worker", inst="DB_Worker")'),
      ] },
      Worker: { type: 'FB', inputs: [], outputs: [], inouts: [], temps: [{ name: 'Tmp', type: 'Bool' }], skipped: [], flows: [
        ...net('NO(#Tmp) => COIL("CallStale")'), ...net('TRUE => SET(#Tmp)'),
      ] },
    } };
    const result = S.runScenario(program, { steps: [
      { run: 1, expect: { '"First"': 1, '"Stale"': 0, '"CallStale"': 0 } },
      { run: 1, expect: { '"First"': 0, '"Stale"': 0, '"CallStale"': 0 } },
    ] });
    assert(result.ok, S.formatResults(result));
    const read = { block: { name: 'Main' }, interface: { Input: [], Temp: [{ name: 'T', type: 'Bool' }] }, networks: [
      { index: 1, dsl: 'NO(#T) => COIL("Bad")', flows: net('NO(#T) => COIL("Bad")') },
    ] };
    assert(A.analyze([read]).findings.some(f => f.code === 'TEMP_READ_BEFORE_WRITE'));
    for (const [secondaryType, number, inputs] of [
      ['Startup', 100, ['LostRetentive', 'LostRTC']],
      ['CyclicInterrupt', 30, ['Initial_Call', 'Event_Count']],
    ]) {
      const xml = B.createBlockXml({ type: 'OB', name: secondaryType, number, secondaryType }).xml;
      const parsed = B.readBlock(xml);
      assert(xml.includes('<SecondaryType>' + secondaryType + '</SecondaryType>'));
      for (const input of inputs) assert(parsed.interface.Input.some(m => m.name === input));
    }
  });

  await test('PLCSIM raw unsigned encoding and PLC time comparison in compiled bridge', async () => {
    if (!fs.existsSync(path.join(__dirname, '..', 'bridge', 'TiaBridge.exe'))) return SKIP;
    const { BridgeClient } = require('../server/bridge_client');
    const client = new BridgeClient();
    try {
      const result = await client.call('sim_codec_self_test', {});
      if (result.skipped) return SKIP;
      assert.deepStrictEqual(result, { passed: true, unsignedWord: true, unsignedDWord: true, timeLiteral: true });
    } finally { client.shutdown(); }
  });

  await test('Online backup identity and checksum isolation', async () => {
    const { OnlineBackups } = require('../server/online_backups');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-scope-'));
    let scope = {projectPath:'A',device:'Station',cpu:'CPU',software:'PLC',group:'Folder',kind:'block',name:'Main',objectType:'OB',number:'1'};
    let imported = 0;
    const bridge = {
      async call(cmd, args) {
        if(args.action === 'export') fs.writeFileSync(args.xmlPath, '<original/>');
        if(args.action === 'import') { assert.deepStrictEqual(args.expectedScope, scope); imported++; }
        return {...scope};
      },
      saveBackup(label, xml) { const file = path.join(dir,label+'__1.xml'); fs.writeFileSync(file,xml); return file; },
      listBackups(label) { return fs.readdirSync(dir).filter(f=>f.startsWith(label+'__') && f.endsWith('.xml')).map(file=>({file,path:path.join(dir,file)})); }
    };
    try {
      const service = new OnlineBackups(bridge);
      const args = {blockName:'Main'};
      const saved = await service.edit(args,'block',()=>({xml:'<changed/>'}));
      const file = path.basename(saved.backup);
      const originalScope = {...scope};
      for(const key of ['projectPath','device','cpu','software','group','kind','name','objectType','number']) {
        scope = {...originalScope,[key]:'Other'};
        await assert.rejects(service.rollback({...args,backupFile:file},'restore'), /No matching verified backup/);
      }
      scope = originalScope;
      await service.rollback(args,'restore');
      assert.strictEqual(imported,2);
      await assert.rejects(service.rollback({...args,backupFile:'../'+file},'restore'), /No matching/);
      fs.appendFileSync(saved.backup,'corrupted');
      await assert.rejects(service.rollback(args,'restore'), /checksum mismatch/);
      assert.strictEqual(imported,2);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });

  // 1. Ladder DSL <-> SimaticML XML roundtrip
  await test('Deleted block/DB/UDT backups can be listed and restored into their original group', async () => {
    const { OnlineBackups } = require('../server/online_backups');
    for (const [kind, objectType] of [['block', 'FB'], ['block', 'GlobalDB'], ['udt', 'PlcType']]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-restore-'));
      let exists = true, imports = 0, projectPath = 'ProjectA', plc = 'PLC_A';
      const scope = { projectPath, device: 'Station', cpu: plc, software: plc, group: 'Folder/Nested', kind, name: 'Object', objectType, number: '1' };
      const bridge = {
        async call(cmd, args) {
          if (cmd === 'status') return { projectPath };
          if (cmd === 'list_blocks') return { plc };
          if (cmd === 'import_block' || cmd === 'import_type') {
            assert.strictEqual(cmd, kind === 'udt' ? 'import_type' : 'import_block');
            assert.strictEqual(args.group, 'Folder/Nested');
            assert.strictEqual(args.plcName, 'PLC_A');
            assert.strictEqual(fs.readFileSync(args.xmlPath, 'utf8'), '<original/>');
            imports++; exists = true; return {};
          }
          if (!exists) throw new Error(kind + " 'Object' not found.");
          if (args.action === 'export') fs.writeFileSync(args.xmlPath, '<original/>');
          return { ...scope };
        },
        saveBackup(label, xml) { const file = path.join(dir, label + '__1.xml'); fs.writeFileSync(file, xml); return file; },
        listBackups(label) { return fs.readdirSync(dir).filter(f => f.endsWith('.xml') && (!label || f.startsWith(label))).map(file => ({ file, path: path.join(dir, file) })); },
      };
      try {
        const service = new OnlineBackups(bridge), args = { blockName: 'Object', kind, plcName: 'PLC_A' };
        const backup = await service.backupOnly(args, kind);
        assert.strictEqual(JSON.parse(fs.readFileSync(backup + '.json')).group, scope.group);
        exists = false;
        assert.strictEqual((await service.rollback(args, 'list')).length, 1);
        projectPath = 'OtherProject';
        assert.strictEqual((await service.rollback(args, 'list')).length, 0);
        projectPath = 'ProjectA'; plc = 'PLC_B';
        assert.strictEqual((await service.rollback(args, 'list')).length, 0);
        plc = 'PLC_A';
        assert.strictEqual((await service.rollback({ ...args, group: 'Wrong' }, 'list')).length, 0);
        await service.rollback(args, 'restore');
        assert.strictEqual(imports, 1);
        exists = false;
        fs.appendFileSync(backup, 'corrupt');
        await assert.rejects(service.rollback(args, 'restore'), /checksum mismatch/);
        assert.strictEqual(imports, 1);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

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
    function secondUnit(xml) {
      const { start, end } = B.parseBlock(xml).networks[1].el;
      return Buffer.from(xml.slice(start, end));
    }
    assert.deepStrictEqual(secondUnit(patched.xml), secondUnit(customXml));
    const changedWire = secondUnit(customXml).toString().replace(/<Wire UId="\d+"/, '<Wire UId="99999"');
    assert.notDeepStrictEqual(Buffer.from(changedWire), secondUnit(patched.xml));
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

  await test('Offline MCP: list tools, create, patch and simulate a timed output', async () => {
    await withMcpServer(async rpc => {
      const listed = await rpc('tools/list', {});
      assert(listed.result.tools.some(t => t.name === 'tia_test_ladder_project'));
      assert.strictEqual(listed.result.tools.length, 31, 'Expected 31 MCP tools');
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
      for (const arguments_ of [
        { action: 'download' },
        { action: 'download', plcName: 'Conveyor_PLC', pcInterface: 'PN/IE' },
        { action: 'download', plcName: 'Conveyor_PLC', pcInterface: 'PLCSIM', targetInterfaceIndex: -1 },
      ]) {
        const denied = await rpc('tools/call', { name: 'tia_download_and_online', arguments: arguments_ });
        assert(denied.result.isError, 'Ambiguous download must fail before reaching TIA');
      }
      const hardwareSchema = listed.result.tools.find(t => t.name === 'tia_hardware_config').inputSchema;
      assert(!Object.hasOwn(hardwareSchema.properties.disableSecurity, 'default') || hardwareSchema.properties.disableSecurity.default === false);
      assert.match(hardwareSchema.properties.disableSecurity.description, /default: false/);
      const downloadSchema = listed.result.tools.find(t => t.name === 'tia_download_and_online').inputSchema;
      assert.strictEqual(downloadSchema.properties.allowDifferentTargetConfiguration.type, 'boolean');
      assert.strictEqual(downloadSchema.properties.allowStopModules.type, 'boolean');
      const onlineBad = await rpc('tools/call', { name: 'tia_download_and_online', arguments: { action: 'go_online', plcName: 'Conveyor_PLC', pcInterface: '' } });
      assert(onlineBad.result.isError);
      assert.match(onlineBad.result.content[0].text, /exact non-empty name/);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-mcp-'));
      const tmpXml = path.join(dir, 'FB_McpTest.xml');
      try {
        const created = await rpc('tools/call', {
          name: 'tia_create_ladder_block',
          arguments: {
            type: 'FB', name: 'FB_McpTest', outXmlPath: tmpXml, importToTia: false,
            interface: { Input: [{ name: 'Btn', type: 'Bool' }], Output: [{ name: 'Lamp', type: 'Bool' }] },
            networks: [{ title: 'Light', dsl: 'NO(#Btn) => COIL(#Lamp)' }],
          },
        });
        assert(!created.result.isError, created.result.content[0].text);

        const original = fs.readFileSync(tmpXml);
        const call = (name, args) => rpc('tools/call', { name, arguments: args });
        const patch = {
          xmlPath: tmpXml,
          ops: [{ op: 'replace', nw: 1, dsl: 'NO(#Btn) => TON(#T1, PT=T#500ms) => COIL(#Lamp)', title: 'Delayed Light' }],
        };
        const preview = await call('tia_patch_ladder_network', { ...patch, previewOnly: true });
        assert(!preview.result.isError, preview.result.content[0].text);
        const report = preview.result.content[0].text.replace(/^PREVIEW\n/, '');
        for (const expected of ['Before NW1: Light', 'After NW1: Delayed Light', 'TON_TIME']) assert(report.includes(expected));
        assert.deepStrictEqual(fs.readFileSync(tmpXml), original);
        const mixed = await call('tia_patch_ladder_network', {
          xmlPath: tmpXml, previewOnly: true,
          ops: [
            { op: 'insert', nw: 1, title: 'Inserted', dsl: 'NC(#Btn) => COIL(#Lamp)' },
            { op: 'delete', nw: 2 },
            { op: 'set_text', nw: 1, comment: 'Check button' },
            { op: 'append', title: 'Appended', dsl: 'NO(#Btn) => COIL(#Lamp)' },
          ],
        });
        assert(!mixed.result.isError, mixed.result.content[0].text);
        for (const expected of ['Before NW1: Light', 'After NW1: Inserted', 'Check button', 'After NW2: Appended']) {
          assert(mixed.result.content[0].text.includes(expected));
        }
        assert.deepStrictEqual(fs.readFileSync(tmpXml), original);
        const listed = await call('tia_rollback_block', { xmlPath: tmpXml });
        assert(listed.result.content[0].text.includes('No backups found'));
        const patched = await call('tia_patch_ladder_network', { ...patch, compact: true });
        assert(!patched.result.isError, patched.result.content[0].text);
        assert(patched.result.content[0].text.endsWith(report));
        const backupFile = path.basename(/^BACKUP: (.+)$/m.exec(patched.result.content[0].text)[1]);

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
        const other = path.join(dir, 'other', path.basename(tmpXml));
        fs.mkdirSync(path.dirname(other));
        fs.copyFileSync(tmpXml, other);
        const rollback = xmlPath => call('tia_rollback_block', { xmlPath, backupFile, action: 'restore' });
        assert((await rollback(other)).result.isError);
        assert.deepStrictEqual(fs.readFileSync(other), fs.readFileSync(tmpXml));
        assert(!(await rollback(tmpXml)).result.isError);
        assert.deepStrictEqual(fs.readFileSync(tmpXml), original);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await test('TIA MCP: Openness status and bridge smoke tests', async () => {
    await withMcpServer(async rpc => {
      // Call live tia_status (spawns real compiled TiaBridge.exe!)
      const st = await rpc('tools/call', { name: 'tia_status', arguments: {} });
      assert(!st.result.isError, 'tia_status error: ' + st.result.content[0].text);
      assert(st.result.content[0].text.includes('OPENNESS ACCESSIBLE: true'), 'Expected TiaBridge opennessAccessible=true');
      const noProjectClose = await rpc('tools/call', { name: 'tia_close_project', arguments: { disconnect: true } });
      assert(!noProjectClose.result.isError, noProjectClose.result.content[0].text);

      // Smoke test new bridge tools that do not require an open TIA project
      const eh = await rpc('tools/call', { name: 'tia_escape_hatch', arguments: { action: 'list_handles' } });
      assert(!eh.result.isError, 'tia_escape_hatch(list_handles) failed: ' + eh.result.content[0].text);

      const simRt = await rpc('tools/call', { name: 'tia_plcsim_runtime', arguments: { action: 'status' } });
      assert(!simRt.result.isError, 'tia_plcsim_runtime(status) failed: ' + simRt.result.content[0].text);
      if (simRt.result.structuredContent.runtimeAvailable === false) {
        const unavailable = await rpc('tools/call', { name: 'tia_plcsim_runtime', arguments: { action: 'read', instanceName: 'Instance_1', signals: ['%I0.0'] } });
        assert(unavailable.result.isError);
        assert.match(unavailable.result.content[0].text, /Advanced Runtime (Manager|API)/);
      }

      const hwPresets = await rpc('tools/call', { name: 'tia_hardware_config', arguments: { action: 'presets' } });
      assert(!hwPresets.result.isError, 'tia_hardware_config(presets) should work offline without tia_connect: ' + hwPresets.result.content[0].text);
      assert(hwPresets.result.content[0].text.includes('CPU_1214C_DC_DC_DC'), 'Expected CPU_1214C_DC_DC_DC in hardware presets');

      // Smoke test new tools wired in server/index.js (when disconnected/no project, should return clean MCP error without crashing server)
      for (const probe of [
        { name: 'tia_watch_table', arguments: { action: 'list' } },
        { name: 'tia_show_in_editor', arguments: { kind: 'block', name: 'Main' } },
        { name: 'tia_scl_source', arguments: { action: 'export', blockName: 'Main' } },
        { name: 'tia_cross_reference', arguments: { filter: 'used' } },
        { name: 'tia_network_config', arguments: { action: 'inspect' } },
      ]) {
        const res = await rpc('tools/call', probe);
        assert(res && res.result && Array.isArray(res.result.content) && res.result.content.length > 0, 'Malformed MCP response from ' + probe.name);
      }
    });
  }, 'tia');

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

    const indexed = S.buildProgram([{
      block: { name: 'FB_Index', type: 'FB' }, interface: {},
      networks: [{ dsl: cases[6], flows: D.parseNetwork(cases[6]).flows }],
    }], 'FB_Index');
    const indexedResult = S.runScenario(indexed, {
      init: { '#En': 1, '#Arr[0]': 11, '#Arr[1]': 22 },
      steps: [{ run: 1, expect: { '#OutVal': 11 } }, { set: { '#Idx': 1 }, expect: { '#OutVal': 22 } }],
    });
    assert(indexedResult.ok, S.formatResults(indexedResult));

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

  // 7. Edge cases & regression tests from Senior Code Audit
  await test('7. Edge cases: action-named tags, ROUND/TRUNC dualType, SCALE_X type inference, stale learned Card, OR bypass & nested OR', () => {
    // 7a. Bare global tag whose name collides with action names (LIMIT, MIN, MAX, SIN)
    const bareLim = D.parseNetwork('LIMIT & MIN => COIL(#Alarm)');
    const genLim = G.generateFlgNet(bareLim.flows, {});
    const backLim = R.readFlgNet(X.parse(genLim.xml));
    assert.strictEqual(backLim.complete, true);
    assert.strictEqual(backLim.dsl, 'NO("LIMIT") & NO("MIN") => COIL(#Alarm)');

    // 7b. ROUND / TRUNC / CEIL / FLOOR emit BOTH SrcType and DestType & simulate accurately
    for (const fn of ['ROUND', 'TRUNC', 'CEIL', 'FLOOR']) {
      const dsl = 'NO(#En) => ' + fn + '(#X, #Y, Real, DInt)';
      const gen = G.generateFlgNet(D.parseNetwork(dsl).flows, {});
      assert(gen.xml.includes('<TemplateValue Name="SrcType" Type="Type">Real</TemplateValue>'), fn + ' missing SrcType');
      assert(gen.xml.includes('<TemplateValue Name="DestType" Type="Type">DInt</TemplateValue>'), fn + ' missing DestType');
      assert(!gen.xml.includes('Name="Card"'), fn + ' must not emit Card');
      const back = R.readFlgNet(X.parse(gen.xml));
      assert.strictEqual(back.complete, true, fn + ' roundtrip incomplete');
      assert.strictEqual(back.dsl, dsl, fn + ' roundtrip mismatch');
    }

    // 7c. SCALE_X type inference: min/max/out are Int, value is Real -> SrcType=Real, DestType=Int
    const typeMap = { '#MinInt': 'Int', '#MaxInt': 'Int', '#OutInt': 'Int', '#NormReal': 'Real' };
    const scaleGen = G.generateFlgNet(D.parseNetwork('NO(#En) => SCALE_X(#MinInt, #NormReal, #MaxInt, #OutInt)').flows, {
      resolveType: op => typeMap['#' + op.path[0]] || null,
    });
    assert(scaleGen.xml.includes('<TemplateValue Name="SrcType" Type="Type">Real</TemplateValue>'), 'SCALE_X SrcType must come from value (Real), not min (Int)');
    assert(scaleGen.xml.includes('<TemplateValue Name="DestType" Type="Type">Int</TemplateValue>'), 'SCALE_X DestType must be Int');

    // 7d. Legacy XML read alias <Part Name="Scale"> parses cleanly as SCALE_X
    const legacyScaleXml = scaleGen.xml.replace('<Part Name="Scale_X"', '<Part Name="Scale"');
    const legacyRead = R.readFlgNet(X.parse(legacyScaleXml));
    assert.strictEqual(legacyRead.complete, true, 'Legacy <Part Name="Scale"> should read cleanly');
    assert(legacyRead.dsl.includes('SCALE_X(#MinInt, #NormReal, #MaxInt, #OutInt, Real, Int)'), 'Unexpected DSL: ' + legacyRead.dsl);

    // 7e. Stale learned_catalog.json with bogus Card on Sub / Limit / Round is stripped
    const staleLearned = {
      parts: {
        Sub: { templates: [{ name: 'Card', type: 'Cardinality', value: '2' }, { name: 'SrcType', type: 'Type', value: 'Real' }] },
        Limit: { templates: [{ name: 'Card', type: 'Cardinality', value: '3' }] },
        Round: { templates: [{ name: 'Card', type: 'Cardinality', value: '1' }, { name: 'SrcType', type: 'Type', value: 'Real' }] },
      },
      calls: {},
    };
    const subClean = G.generateFlgNet(D.parseNetwork('NO(#En) => SUB(#A, #B, #C, Real)').flows, { learned: staleLearned }).xml;
    assert(!subClean.includes('Name="Card"'), 'Stale Card must be stripped from Sub');
    const limClean = G.generateFlgNet(D.parseNetwork('NO(#En) => LIMIT(0.0, #X, 10.0, #Y, Real)').flows, { learned: staleLearned }).xml;
    assert(!limClean.includes('Name="Card"') && limClean.includes('Name="value_type"'), 'Stale Card stripped and value_type preserved on Limit');
    const rndClean = G.generateFlgNet(D.parseNetwork('NO(#En) => ROUND(#X, #Y, Real, DInt)').flows, { learned: staleLearned }).xml;
    assert(!rndClean.includes('Name="Card"') && rndClean.includes('Name="DestType"'), 'Stale Card stripped and DestType preserved on Round');

    // 7f. Direct AST OR with TRUE bypass emits ZERO dangling Contact parts
    const directAst = [{
      cond: { t: 'or', items: [{ t: 'contact', op: { k: 'local', path: ['A'] }, neg: false }, { t: 'true' }] },
      then: [{ t: 'coil', kind: 'COIL', op: { k: 'local', path: ['Y'] } }],
    }];
    const bypassXml = G.generateFlgNet(directAst, {}).xml;
    assert(!bypassXml.includes('<Part Name="Contact"'), 'OR with TRUE bypass must not emit dangling Contact');

    // 7g. Nested OR & OR inside CTU reset pin roundtrip cleanly
    for (const dsl of [
      '(NO(#A) | NO(#B)) & (NO(#C) | NO(#D)) => COIL(#Y)',
      'NO(#Pulse) => CTU(#C1, PV=5, R=NO(#R1) | NO(#R2), CV=#Cnt) => COIL(#Done)',
    ]) {
      const gen = G.generateFlgNet(D.parseNetwork(dsl).flows, {});
      const back = R.readFlgNet(X.parse(gen.xml));
      assert.strictEqual(back.complete, true, 'Expected complete roundtrip for: ' + dsl);
      assert.strictEqual(back.dsl, dsl, 'Roundtrip mismatch for: ' + dsl + '\n  got: ' + back.dsl);
    }

    // 7h. Simulate ROUND, TRUNC, CEIL, FLOOR end-to-end
    const rndBlock = B.createBlockXml({
      type: 'FB',
      name: 'FB_Rounding',
      interface: {
        Input: [{ name: 'Val', type: 'Real' }],
        Output: [
          { name: 'OutRound', type: 'DInt' },
          { name: 'OutTrunc', type: 'DInt' },
          { name: 'OutCeil', type: 'DInt' },
          { name: 'OutFloor', type: 'DInt' },
        ],
      },
      networks: [
        { title: 'Rounding', dsl: 'ROUND(#Val, #OutRound, Real, DInt), TRUNC(#Val, #OutTrunc, Real, DInt), CEIL(#Val, #OutCeil, Real, DInt), FLOOR(#Val, #OutFloor, Real, DInt)' },
      ],
    }, {});
    const prog = S.buildProgram([B.readBlock(rndBlock.xml, { format: 'dsl' })], 'FB_Rounding');
    const sim = S.runScenario(prog, {
      scanMs: 10,
      init: { '#Val': 3.7 },
      steps: [{ run: 1, expect: { '#OutRound': 4, '#OutTrunc': 3, '#OutCeil': 4, '#OutFloor': 3 } }],
    });
    assert.strictEqual(sim.ok, true, 'Rounding simulation failed:\n' + S.formatResults(sim));
  });

  await test('8. SimaticML V20 Timers (TypedConstant, time_type, OpenCon), Counters (OpenCon), DB/UDT XML & MCP negotiation', async () => {
    // 8a. TON / TOF / TP / TONR emit TypedConstant, time_type, and OpenCon on omitted ET/R/Q
    for (const timer of ['TON', 'TOF', 'TP', 'TONR']) {
      const dsl = 'NO(#Active) => ' + timer + '(#T1, PT=T#5s) => COIL(#Q)';
      const gen = G.generateFlgNet(D.parseNetwork(dsl).flows, {});
      assert(gen.xml.includes('<Access Scope="TypedConstant"'), timer + ' must emit TypedConstant for T#5s');
      assert(!gen.xml.includes('<ConstantType>Time</ConstantType>'), timer + ' TypedConstant must omit ConstantType');
      assert(gen.xml.includes('<TemplateValue Name="time_type" Type="Type">Time</TemplateValue>'), timer + ' must emit time_type TemplateValue');
      assert(gen.xml.includes('Name="ET"') && gen.xml.includes('<OpenCon'), timer + ' must connect OpenCon to omitted ET');
      if (timer === 'TONR') assert(gen.xml.includes('Name="R"') && gen.xml.includes('<OpenCon'), 'TONR must connect OpenCon to omitted R');
      const back = R.readFlgNet(X.parse(gen.xml));
      assert.strictEqual(back.complete, true, timer + ' roundtrip incomplete: ' + JSON.stringify(back.notes));
      assert.strictEqual(back.dsl, dsl, timer + ' roundtrip mismatch');
    }

    // Bare timer without downstream COIL wires OpenCon to Q and ET
    const bareTon = G.generateFlgNet(D.parseNetwork('NO(#Active) => TON(#T1, PT=TIME#2s)').flows, {});
    assert(bareTon.xml.includes('Name="Q"') && bareTon.xml.includes('Name="ET"') && bareTon.xml.includes('<OpenCon'), 'Bare TON must connect OpenCon to Q and ET');
    assert.strictEqual(R.readFlgNet(X.parse(bareTon.xml)).complete, true);

    // 8b. CTU / CTD / CTUD emit OpenCon for omitted R / LD / CD / CV / QD
    for (const [dsl, pin] of [
      ['NO(#Active) => CTU(#C1, PV=5) => COIL(#Q)', 'R'],
      ['NO(#Active) => CTD(#C2, PV=5)', 'LD'],
      ['NO(#Active) => CTUD(#C3, PV=5, CV=#Cnt) => COIL(#Q)', 'CD'],
    ]) {
      const gen = G.generateFlgNet(D.parseNetwork(dsl).flows, {});
      assert(gen.xml.includes('Name="' + pin + '"') && gen.xml.includes('<OpenCon'), dsl + ' missing OpenCon on ' + pin);
      const back = R.readFlgNet(X.parse(gen.xml));
      assert.strictEqual(back.complete, true, dsl + ' incomplete');
      assert.strictEqual(back.dsl, dsl, dsl + ' roundtrip mismatch');
    }

    // 8c. InstanceDB XML omits read-only MemoryLayout; GlobalDB/UDT XML build cleanly
    const idb = B.createDbXml({ kind: 'InstanceDB', name: 'DB_TrafficLight', instanceOf: 'FB_TrafficLight' });
    assert(idb.includes('<SW.Blocks.InstanceDB') && !idb.includes('<MemoryLayout>'), 'InstanceDB must omit MemoryLayout');
    const gdb = B.createDbXml({ kind: 'GlobalDB', name: 'DB_Settings', members: [{ name: 'TGreen', type: 'Time' }] });
    assert(gdb.includes('<SW.Blocks.GlobalDB') && gdb.includes('<MemoryLayout>Optimized</MemoryLayout>'));
    const udt = B.createDbXml({ kind: 'UDT', name: 'UDT_Axis', members: [{ name: 'Pos', type: 'Real' }] });
    assert(udt.includes('<SW.Types.PlcStruct') && udt.includes('<Section Name="None">'));

    // 8d. Stale learned TON without templates still receives time_type
    const staleTimer = { parts: { TON: { version: '1.0', templates: [{ name: 'Version', type: 'String', value: '1.0' }] } }, calls: {} };
    const tonFixed = G.generateFlgNet(D.parseNetwork('NO(#Active) => TON(#T1, PT=T#1s) => COIL(#Q)').flows, { learned: staleTimer });
    assert(tonFixed.xml.includes('<TemplateValue Name="time_type" Type="Type">Time</TemplateValue>'));

    // 8e. MCP protocolVersion negotiation + structuredContent + create FB -> call from Main offline
    await withMcpServer(async rpc => {
      const bogusInit = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
      assert.strictEqual(bogusInit.result.protocolVersion, '2025-11-25');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-chain-'));
      try {
        const fbPath = path.join(dir, 'FB_Unit.xml');
        const obPath = path.join(dir, 'Main.xml');
        const cFb = (await rpc('tools/call', {
          name: 'tia_create_ladder_block',
          arguments: {
            type: 'FB', name: 'FB_Unit', importToTia: false, outXmlPath: fbPath,
            interface: { Input: [{ name: 'Active', type: 'Bool' }], Output: [{ name: 'Out', type: 'Bool' }] },
            networks: [{ title: 'Delay', dsl: 'NO(#Active) => TON(#T1, PT=T#100ms) => COIL(#Out)' }],
          },
        })).result;
        assert(!cFb.isError, cFb.content[0].text);

        // FB_Unit signature is auto-learned into callCatalog without needing blueprint
        const cOb = (await rpc('tools/call', {
          name: 'tia_create_ladder_block',
          arguments: {
            type: 'OB', name: 'Main', number: 1, importToTia: false, outXmlPath: obPath,
            networks: [{ title: 'Call', dsl: 'TRUE => CALL("FB_Unit", inst="DB_Unit", Active="Btn", Out="Lamp")' }],
          },
        })).result;
        assert(!cOb.isError, cOb.content[0].text);
        assert(fs.readFileSync(obPath, 'utf8').includes('Informative="true"'), 'OB system params must include Informative="true"');

        const an = (await rpc('tools/call', { name: 'tia_analyze_ladder', arguments: { xmlPaths: [obPath, fbPath] } })).result;
        assert(!an.isError && an.structuredContent && an.structuredContent.summary.error === 0);

        const dry = (await rpc('tools/call', {
          name: 'tia_dry_run_ladder',
          arguments: {
            entry: 'Main', xmlPaths: [obPath, fbPath],
            scenario: { scanMs: 50, steps: [{ set: { Btn: true }, until: { Lamp: true }, timeout: '500ms' }] },
          },
        })).result;
        assert(!dry.isError && dry.structuredContent && dry.structuredContent.ok === true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  await test('Phase 1: FC return signature survives network learning and simulates case-insensitive pins', () => {
    const fc = B.readBlock(B.createBlockXml({
      type: 'FC', name: 'FC_Result',
      interface: {
        Input: [{ name: 'In1', type: 'Int' }], Output: [{ name: 'Copy', type: 'Int' }],
        Return: [{ name: 'Ret_Val', type: 'Int' }],
      },
      networks: [{ dsl: 'ADD(#In1, 1, #Ret_Val, Int) => MOVE(#In1, #Copy)' }],
    }).xml);
    assert.deepStrictEqual(fc.interface.Return.map(m => [m.name, m.type]), [['Ret_Val', 'Int']]);
    assert.match(fc.doc.src, /<Component Name="FC_Result"/);
    assert(fc.networks[0].editable);
    const entry = L.callEntryFromInterface('FC', fc.interface);
    assert.deepStrictEqual(entry.params.map(p => [p.name, p.section]), [['In1', 'Input'], ['Copy', 'Output'], ['Ret_Val', 'Return']]);
    assert.deepStrictEqual(L.callEntryFromInterface('FC', { Return: [{ name: 'Ret_Val', type: 'Void' }] }).params, []);

    const learned = L.emptyLearned();
    learned.calls.FC_Result = entry;
    L.learnFlgNet(X.parse('<FlgNet><Parts><Call UId="1"><CallInfo Name="FC_Result" BlockType="FC" Version="1.0"><Parameter Name="In1" Section="Input" Type="Int" /></CallInfo></Call></Parts></FlgNet>'), learned);
    assert.deepStrictEqual(learned.calls.FC_Result, { ...entry, version: '1.0' });
    const callerXml = B.createBlockXml({
      type: 'FB', name: 'Caller',
      interface: { Output: [{ name: 'Result', type: 'Int' }, { name: 'Echo', type: 'Int' }] },
      networks: [{ dsl: 'CALL("FC_Result", in1=41, COPY=#Echo, RET_VAL=#Result)' }],
    }, { callCatalog: learned.calls }).xml;
    assert.match(callerXml, /<Parameter Name="Ret_Val" Section="Return" Type="Int"/);
    assert.match(callerXml, /<NameCon UId="\d+" Name="Ret_Val"/);
    const caller = B.readBlock(callerXml.replaceAll('Name="Ret_Val"', 'Name="RET_VAL"').replaceAll('Name="Copy"', 'Name="COPY"'));
    assert(caller.networks[0].editable);
    const result = S.runScenario(S.buildProgram([caller, fc], 'Caller'), { steps: [{ run: 1, expect: { '#Result': 42, '#Echo': 41 } }] });
    assert(result.ok, JSON.stringify(result));
  });

  await test('Phase 1: CALL XREF and Temp initialization follow the callee pin directions', () => {
    const callee = B.readBlock(B.createBlockXml({
      type: 'FC', name: 'FC_Pins', interface: {
        Input: [{ name: 'InPin', type: 'Int' }], Output: [{ name: 'OutPin', type: 'Int' }], InOut: [{ name: 'IoPin', type: 'Int' }],
      }, networks: [{ dsl: 'MOVE(#InPin, #OutPin, #IoPin)' }],
    }).xml);
    const catalog = { FC_Pins: L.callEntryFromInterface('FC', callee.interface) };
    const caller = B.readBlock(B.createBlockXml({
      type: 'FB', name: 'Caller',
      interface: { Temp: ['Good', 'Bad', 'Both'].map(name => ({ name, type: 'Int' })) },
      networks: [
        { dsl: 'CALL("FC_Pins", OutPin=#Good, InPin=1, IoPin=#Both)' },
        { dsl: 'CALL("FC_Pins", OutPin=#Bad, InPin=#Bad)' },
        { dsl: 'CALL("FC_Pins", InPin=#Good)' },
      ],
    }, { callCatalog: catalog }).xml);
    for (const [reads, opts] of [[[caller, callee], {}], [[caller], { callCatalog: catalog }], [[caller], {}]]) {
      const analysis = A.analyze(reads, opts);
      const warnings = analysis.findings.filter(f => f.code === 'TEMP_READ_BEFORE_WRITE').map(f => f.message.split(' ')[0]);
      assert.deepStrictEqual(warnings, ['#Both', '#Bad']);
      const access = symbol => A.analyze(reads, { ...opts, symbol }).xref['#' + symbol].map(x => x.access);
      assert.deepStrictEqual(access('Good'), ['write', 'read']);
      assert.deepStrictEqual(access('Bad'), ['read', 'write']);
      assert.deepStrictEqual(access('Both'), ['read/write']);
    }
  });

  await test('Phase 1: DB/UDT and interface retain start values, with fresh simulator frame defaults', () => {
    const saved = { name: 'Count', type: 'Int', startValue: 0, retain: true };
    const db = B.parseBlock(B.createDbXml({ name: 'DB_Values', members: [saved] }));
    assert.deepStrictEqual(db.interface.Static[0], { ...saved, startValue: '0', comment: '' });
    const udt = B.createDbXml({ kind: 'UDT', name: 'UDT_Values' });
    const editedUdt = B.parseBlock(B.addMembers(udt, [{ section: 'None', name: 'Mode', type: 'Bool', startValue: false }]));
    assert.strictEqual(editedUdt.interface.None[0].startValue, 'FALSE');
    assert.match(B.interfaceText(editedUdt.interface), /Mode:Bool = FALSE/);

    const sampleXml = B.createBlockXml({
      type: 'FB', name: 'FB_Values',
      interface: {
        Static: [{ name: 'Seed', type: 'Int', startValue: 7, retain: true }],
        Constant: [{ name: 'Limit', type: 'Real', startValue: '1500.0' }],
        Output: [{ name: 'Count', type: 'Int' }, { name: 'Reading', type: 'Real' }],
      },
      networks: [{ dsl: 'ADD(#Seed, 1, #Seed, Int) => MOVE(#Seed, #Count) => MOVE(#Limit, #Reading)' }],
    }).xml;
    const patched = B.addMembers(sampleXml, [{ section: 'Constant', name: 'Flag', type: 'Bool', startValue: true }]);
    assert.match(patched, /Scope="LocalConstant"[^>]*>\s*<Constant Name="Limit"/);
    assert.match(patched, /Name="Seed" Datatype="Int" Remanence="Retain"/);
    const sample = B.readBlock(patched, { format: 'both' });
    assert(sample.networks[0].editable);
    assert.match(B.interfaceText(sample.interface), /Seed:Int = 7 \[Retain\]/);
    assert.match(B.interfaceText(sample.interface), /Limit:Real = 1500\.0, Flag:Bool = TRUE/);
    const catalog = { FB_Values: L.callEntryFromInterface('FB', sample.interface) };
    const caller = B.readBlock(B.createBlockXml({ type: 'FB', name: 'Parent', networks: [
      { dsl: 'CALL("FB_Values", inst=#First, Count="CountA", Reading="ReadingA")' },
      { dsl: 'NO("EnableB") => CALL("FB_Values", inst=#Second, Count="CountB")' },
    ] }, { callCatalog: catalog }).xml);
    const nested = S.runScenario(S.buildProgram([sample, caller], 'Parent'), { steps: [
      { run: 1, expect: { CountA: 8, ReadingA: 1500 } },
      { set: { EnableB: true }, run: 1, expect: { CountA: 9, CountB: 8, ReadingA: 1500 } },
    ] });
    assert(nested.ok, JSON.stringify(nested));
    const root = S.runScenario(S.buildProgram([sample], 'FB_Values'), { init: { '#Seed': 20, '#Limit': 999 }, steps: [
      { run: 2, expect: { '#Count': 22, '#Reading': 999, '#Flag': true } },
    ] });
    assert(root.ok, JSON.stringify(root));
  });

  await test('Phase 1: latch, range, select, operand edges and variadic math round-trip and simulate', () => {
    const dsl = [
      'NO(#Set) => SR(#SrBit, R1=NO(#Reset), Q=#SrQ)',
      'NO(#Reset) => RS(#RsBit, S1=NO(#Set)) => COIL(#RsQ)',
      'NO(#Enable) & IN_RANGE(5, #Value, 10, Int) => COIL(#Inside)',
      'NO(#Enable) & OUT_RANGE(5, #Value, 10, Int) => COIL(#Outside)',
      'NO(#Enable) => SEL(#Switch, 10, 20, #Selected, Int)',
      'NO(#Enable) & PCONTACT(#Signal, #RiseMem) => COIL(#Rise)',
      'NO(#Enable) & NCONTACT(#Signal, #FallMem) => COIL(#Fall)',
      'ADD(1, 2, 3, #Sum3, Int), ADD(1, 2, 3, 4, #Sum4, Int)',
      'MUL(2, 3, 4, #Product, Int), MIN(9, 4, 2, 8, #Min, Int), MAX(3, 8, 2, #Max, Int)',
      'ADD(1, 2, #Pair, Int), ADD(1, 2, #Value, "GlobalTotal")',
      'SEL(1, 10, 20, "LiteralSelected", Int)',
    ];
    const members = (names, type) => names.split(' ').map(name => ({ name, type }));
    const xml = B.createBlockXml({ type: 'FB', name: 'Industrial', interface: {
      Input: [...members('Set Reset Enable Switch Signal', 'Bool'), ...members('Value', 'Int')],
      Output: [...members('SrQ RsQ Inside Outside Rise Fall', 'Bool'), ...members('Selected Sum3 Sum4 Product Min Max Pair', 'Int')],
      Static: members('SrBit RsBit', 'Bool'),
    }, networks: dsl.map(d => ({ dsl: d })) }).xml;
    // TIA V20 exports the system instructions with uppercase part names and data pins.
    const exported = xml.replace(/<Part Name="(Sel|Min|Max)"/g, (_, name) => '<Part Name="' + name.toUpperCase() + '"');
    const block = B.readBlock(exported, { format: 'both' });
    for (const [i, row] of block.networks.entries()) {
      assert(row.editable, row.dsl + ' ' + row.notes.join(', '));
      const expected = dsl[i].replace('"GlobalTotal")', '"GlobalTotal", Int)').replace('SEL(1,', 'SEL(TRUE,');
      assert.strictEqual(row.dsl, expected);
    }
    for (const part of ['Sr', 'Rs', 'InRange', 'OutRange', 'Sel', 'PContact', 'NContact']) assert(xml.includes('<Part Name="' + part + '"'));
    assert.match(xml, /Name="Card" Type="Cardinality">4</);
    assert.match(xml, /Name="in4"/);
    const ascii = block.networks.map(row => row.ascii).join('\n');
    for (const text of ['SR(', 'RS(', 'IN_RANGE(', 'OUT_RANGE(', 'SEL(', 'PCONTACT(', 'NCONTACT(', '1 + 2 + 3 + 4']) assert(ascii.includes(text), text);
    const result = S.runScenario(S.buildProgram([block], 'Industrial'), { steps: [
      { set: { '#Enable': true, '#Set': true, '#Reset': true, '#Value': 5 }, run: 1,
        expect: { '#SrQ': false, '#RsQ': true, '#Inside': true, '#Outside': false, '#Selected': 10,
          '#Sum3': 6, '#Sum4': 10, '#Pair': 3, '#Product': 24, '#Min': 2, '#Max': 8, GlobalTotal: 8, LiteralSelected: 20 } },
      { set: { '#Set': false, '#Reset': false, '#Value': 10, '#Switch': true, '#Signal': true }, run: 1,
        expect: { '#SrQ': false, '#RsQ': true, '#Inside': true, '#Outside': false, '#Selected': 20, '#Rise': true, '#Fall': false } },
      { set: { '#Value': 11 }, run: 1, expect: { '#Inside': false, '#Outside': true, '#Rise': false, '#Fall': false } },
      { set: { '#Signal': false, '#Value': 4, '#Set': true }, run: 1,
        expect: { '#SrQ': true, '#RsQ': true, '#Inside': false, '#Outside': true, '#Rise': false, '#Fall': true } },
      { set: { '#Signal': true, '#Enable': false, '#Switch': false, '#Set': false, '#Reset': true }, run: 1,
        expect: { '#SrQ': false, '#RsQ': false, '#Inside': false, '#Outside': false, '#Selected': 20, '#Rise': false } },
      { set: { '#Enable': true }, run: 1, expect: { '#Selected': 10, '#Rise': false, '#Fall': false } },
    ] });
    assert(result.ok, JSON.stringify(result));
  });

  await test('Phase 1: MCP initialize instructions, 31 annotated tools and member schemas', () => withMcpServer(async rpc => {
    const init = (await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} })).result;
    for (const hint of ['tia_project_blueprint', 'tia_analyze_ladder', 'tia_dry_run_ladder', 'list_connections', 'deleting', 'overwriting']) {
      assert(init.instructions.includes(hint), hint);
    }
    const { tools } = (await rpc('tools/list', {})).result;
    assert.strictEqual(new Set(tools.map(t => t.name)).size, 31);
    assert.strictEqual(tools.length, 31);
    for (const tool of tools) for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.strictEqual(typeof tool.annotations?.[hint], 'boolean', tool.name + ' ' + hint);
    }
    const tool = name => tools.find(t => t.name === name);
    assert.strictEqual(tool('tia_analyze_ladder').annotations.readOnlyHint, true);
    assert.strictEqual(tool('tia_download_and_online').annotations.openWorldHint, true);
    assert.strictEqual(tool('tia_edit_db_udt').annotations.destructiveHint, true);
    const props = name => tool(name).inputSchema.properties;
    for (const schema of [props('tia_edit_db_udt').add, props('tia_edit_block_interface').add, props('tia_create_ladder_block').interface.properties.Constant]) {
      assert(schema.items.properties.startValue);
      assert.strictEqual(schema.items.properties.retain.type, 'boolean');
      assert.strictEqual(schema.items.properties.members.type, 'array');
    }
    assert(props('tia_project_blueprint').group);
    assert(props('tia_project_blueprint').maxLearnBlocks);
    assert(props('tia_network_config').action.enum.includes('connect_io_system'));
    assert(props('tia_network_config').ioSystemName);
    assert(props('tia_network_config').pnDeviceName);
  }));

  await test('Phase 2: Slice access (.%X/.%B/.%W) and Bitwise/Shift round-trip and simulate', () => {
    const dsl = [
      'NO(#Ctrl.%X0) => COIL(#Bit0Out)',
      'NO(#SetHigh) => COIL(#Status.%X3)',
      'MOVE(16#AB, #Status.%B1)',
      'AND_WORD(#WordA, #WordB, #AndOut, Word)',
      'W_OR(#WordA, #WordB, #WordC, #OrOut, Word)',
      'XOR_WORD(#WordA, #WordB, #XorOut, Word)',
      'SHL(#WordA, 2, #ShlOut, Word)',
      'SHR(#WordB, 1, #ShrOut, Word)',
    ];
    const xml = B.createBlockXml({
      type: 'FB', name: 'FB_BitSlice',
      interface: {
        Input: [
          { name: 'Ctrl', type: 'Word' },
          { name: 'SetHigh', type: 'Bool' },
          { name: 'WordA', type: 'Word' },
          { name: 'WordB', type: 'Word' },
          { name: 'WordC', type: 'Word' },
        ],
        Output: [
          { name: 'Bit0Out', type: 'Bool' },
          { name: 'AndOut', type: 'Word' },
          { name: 'OrOut', type: 'Word' },
          { name: 'XorOut', type: 'Word' },
          { name: 'ShlOut', type: 'Word' },
          { name: 'ShrOut', type: 'Word' },
        ],
        Static: [{ name: 'Status', type: 'Word' }],
      },
      networks: dsl.map(d => ({ dsl: d })),
    }).xml;
    assert(xml.includes('SliceAccessModifier="x0"'));
    assert(xml.includes('SliceAccessModifier="x3"'));
    assert(xml.includes('SliceAccessModifier="b1"'));
    for (const part of ['And', 'Or', 'Xor', 'Shl', 'Shr']) assert(xml.includes('<Part Name="' + part + '"'), part);
    const block = B.readBlock(xml, { format: 'both' });
    for (const row of block.networks) assert(row.editable, row.dsl + ' ' + (row.notes || []).join(', '));
    const res = S.runScenario(S.buildProgram([block], 'FB_BitSlice'), {
      steps: [{
        set: { '#Ctrl': 0x0001, '#SetHigh': true, '#WordA': 0x00F0, '#WordB': 0x003C, '#WordC': 0x0003 },
        run: 1,
        expect: {
          '#Bit0Out': true,
          '#Status': 0xAB08,
          '#Status.%X3': true,
          '#Status.%B1': 0xAB,
          '#AndOut': 0x0030,
          '#OrOut': 0x00FF,
          '#XorOut': 0x00CC,
          '#ShlOut': 0x03C0,
          '#ShrOut': 0x001E,
        },
      }],
    });
    assert(res.ok, S.formatResults(res));
  });

  await test('Phase 2: Nested Struct XML and multi-level UDT type resolution', () => {
    const dbXml = B.createDbXml({
      kind: 'GlobalDB', name: 'DB_Line',
      members: [
        {
          name: 'Header', type: 'Struct',
          members: [
            { name: 'Speed', type: 'Real', startValue: '12.5', retain: true },
            { name: 'Enabled', type: 'Bool', startValue: true },
          ],
        },
        { name: 'Motor1', type: '"UDT_Motor"' },
      ],
    });
    assert(dbXml.includes('<Member Name="Header" Datatype="Struct">'));
    assert(dbXml.includes('<Member Name="Speed" Datatype="Real" Remanence="Retain">'));
    const parsedDb = B.parseBlock(dbXml);
    assert(parsedDb.interface.Static.some(m => m.name === 'Header.Speed' && m.type === 'Real' && m.startValue === '12.5' && m.retain === true));

    const udts = {
      UDT_Motor: { None: [{ name: 'Cfg', type: '"UDT_Cfg"' }, { name: 'Running', type: 'Bool' }] },
      UDT_Cfg: { None: [{ name: 'MaxSpeed', type: 'Real' }, { name: 'Steps', type: 'Array[0..3] of DInt' }] },
    };
    const fbXml = B.createBlockXml({
      type: 'FB', name: 'FB_UdtTest',
      interface: {
        Static: [
          { name: 'LocalMotor', type: '"UDT_Motor"' },
          { name: 'SumSpeed', type: 'Real' },
          { name: 'StepOut', type: 'DInt' },
        ],
      },
      networks: [
        { dsl: 'ADD("DB_Line".Motor1.Cfg.MaxSpeed, #LocalMotor.Cfg.MaxSpeed, #SumSpeed)' },
        { dsl: 'ADD("DB_Line".Motor1.Cfg.Steps[1], 10, #StepOut)' },
      ],
    }, { dbs: { DB_Line: parsedDb.interface }, udts }).xml;
    assert(fbXml.includes('<TemplateValue Name="SrcType" Type="Type">Real</TemplateValue>'));
    assert(fbXml.includes('<TemplateValue Name="SrcType" Type="Type">DInt</TemplateValue>'));
  });

  await test('Phase 2: Modular blueprint filtering, UDT learning and structuredContent', async () => {
    const { BridgeClient } = require('../server/bridge_client');
    const { createToolHandler } = require('../server/handlers');
    const client = new BridgeClient();
    const calls = [];
    const udtXml = B.createDbXml({ kind: 'UDT', name: 'UDT_Axis', members: [{ name: 'TargetPos', type: 'Real' }] });
    const dbXml = B.createDbXml({ kind: 'GlobalDB', name: 'DB_Axis', members: [{ name: 'Axis1', type: '"UDT_Axis"' }] });
    const fbXml = B.createBlockXml({ type: 'FB', name: 'FB_Axis', interface: { Input: [{ name: 'En', type: 'Bool' }] } }).xml;
    client.call = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'list_devices') return { project: 'DemoProj', devices: [{ name: 'Station_1', items: [{ name: 'PLC_1', isPlc: true, typeIdentifier: 'CPU' }] }] };
      if (cmd === 'list_blocks') return {
        plc: 'PLC_1',
        blocks: [
          { name: 'FB_Axis', number: 1, type: 'FB', language: 'LAD', group: 'Motion/Axes', isConsistent: true },
          { name: 'DB_Axis', number: 2, type: 'GlobalDB', language: 'DB', group: 'Motion', isConsistent: true },
          { name: 'FB_Other', number: 3, type: 'FB', language: 'LAD', group: 'Other', isConsistent: true },
        ],
      };
      if (cmd === 'list_tags') return { plc: 'PLC_1', tables: [{ table: 'Default', tags: [{ name: 'Start', type: 'Bool', address: '%I0.0' }] }] };
      if (cmd === 'list_types') return { plc: 'PLC_1', types: [{ name: 'UDT_Axis', group: '', isConsistent: true }] };
      if (cmd === 'list_tech_objects') return { plc: 'PLC_1', technologicalObjects: [] };
      if (cmd === 'export_block') {
        fs.writeFileSync(args.outPath, args.blockName === 'DB_Axis' ? dbXml : fbXml, 'utf8');
        return { path: args.outPath };
      }
      if (cmd === 'export_type') {
        fs.writeFileSync(args.outPath, udtXml, 'utf8');
        return { path: args.outPath };
      }
      throw new Error('Unexpected cmd: ' + cmd);
    };
    const { handleTool } = createToolHandler({ bridge: client, onlineBackups: {} });
    const res = await handleTool('tia_project_blueprint', { group: 'Motion', maxLearnBlocks: 3 });
    assert.strictEqual(res.json.blocksCount, 2);
    assert.strictEqual(res.json.totalBlocksCount, 3);
    assert.strictEqual(res.json.tagsCount, 1);
    assert.deepStrictEqual(res.json.udts, ['UDT_Axis']);
    assert.strictEqual(res.json.learnedBlocksCount, 3);
    assert.strictEqual(res.json.groupFilter, 'Motion');
    assert(client.udtsCache.UDT_Axis, 'UDT_Axis should be cached in udtsCache');
    assert(!calls.some(c => c.cmd === 'export_block' && c.args.blockName === 'FB_Other'));
  });

  if (suite === 'tia-isolation') {
    await test('Headless TIA: isolated PLC writes and backup restore across two projects', () =>
      require('./tia_isolation')(withMcpServer), 'tia-isolation');
  }

  console.log('\n=== SUMMARY: ' + passed + ' passed, ' + skipped + ' skipped, ' + (total - passed - skipped) + ' failed (' + total + ' groups) ===');
}

main();
