'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runProject, formatReport } = require('../server/ladder/project');
const X = require('../server/ladder/xml');
const B = require('../server/ladder/block');
const A = require('../server/ladder/analyzer');

const example = path.resolve(__dirname, '../examples/inspection');
const cli = path.resolve(__dirname, '../server/test-project.js');

module.exports = async function testProject(withMcpServer) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lad-suite-'));
  try {
    fs.cpSync(example, temp, { recursive: true });
    const file = path.join(temp, 'suite.json');
    const blocks = path.join(temp, 'blocks');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const invoke = (...args) => spawnSync(process.execPath, [cli, file, ...args], { cwd: os.tmpdir(), encoding: 'utf8' });
    const passed = invoke('--format', 'json');
    assert.strictEqual(passed.status, 0, passed.stderr || passed.stdout);
    const baseline = JSON.parse(passed.stdout);
    assert.deepStrictEqual(baseline.cases.map(c => [c.status, c.result.scans]), [['passed', 5], ['passed', 8], ['passed', 100]]);
    assert.strictEqual(baseline.blocks.length, 3);

    // Repeating a stateful case must start its timer from a fresh instance.
    manifest.cases.push({ ...manifest.cases[0], name: 'repeat' });
    manifest.cases.unshift(
      { name: 'Fail <A&B>', steps: [{ expect: { '#Ready': 1 } }] },
      { name: 'typo', steps: [{ expect: { '#Raedy': 0 } }] },
      { name: 'no assertion', steps: [{ run: 1 }] }
    );
    fs.writeFileSync(file, JSON.stringify(manifest));
    const report = runProject(file);
    assert(!report.ok);
    assert.deepStrictEqual(report.cases.map(c => c.status), ['failed', 'error', 'error', 'passed', 'passed', 'passed', 'passed']);
    assert(report.cases[1].message.includes('#Raedy'));
    assert.deepStrictEqual(report.cases[3].result, report.cases[6].result);
    const single = { ...manifest, cases: [{
      name: 'FC entry', entry: 'FC_Eligible', init: { '#Enabled': 1, '#Present': 1 },
      steps: [{ run: 1, expect: { '#Eligible': 1 } }],
    }] };
    const fcSuite = path.join(temp, 'fc-entry.json');
    fs.writeFileSync(fcSuite, JSON.stringify(single));
    assert(runProject(fcSuite).ok);
    const junit = invoke('--format', 'junit');
    assert.strictEqual(junit.status, 1, junit.stderr);
    const suite = X.parse(junit.stdout);
    assert.strictEqual(suite.attrs.tests, '8');
    assert.strictEqual(suite.attrs.failures, '1');
    assert.strictEqual(suite.attrs.errors, '2');
    assert.strictEqual(suite.children[1].attrs.name, 'Fail <A&B>');

    await withMcpServer(async rpc => {
      const r = await rpc('tools/call', { name: 'tia_test_ladder_project', arguments: { manifestPath: file, format: 'json' } });
      assert(!r.result.isError, r.result.content[0].text);
      assert.deepStrictEqual(JSON.parse(r.result.content[0].text), report);
    });
    assert(formatReport(report).includes('step 1 @0ms: #Ready expected 1, got 0'));

    const delay = path.join(blocks, 'FB_Delay.xml');
    const saved = fs.readFileSync(delay, 'utf8');
    fs.copyFileSync(delay, path.join(blocks, 'duplicate.xml'));
    assert.throws(() => runProject(file), /Duplicate block: FB_Delay/);
    fs.unlinkSync(path.join(blocks, 'duplicate.xml'));
    fs.unlinkSync(delay);
    const missing = invoke();
    assert.strictEqual(missing.status, 2);
    assert(missing.stderr.includes('FB_Inspection NW2: missing CALL target FB_Delay'));
    fs.writeFileSync(delay, saved.replace('Name="Active"', 'Name="Renamed"'));
    assert.throws(() => runProject(file), /unknown parameter FB_Delay.Active/);
    fs.writeFileSync(delay, saved.replace('<Part Name="Contact"', '<Part Name="UnknownVendorPart"'));
    assert.throws(() => runProject(file), /FB_Delay NW1/);
    fs.writeFileSync(delay, saved);
    const recursive = B.createBlockXml({ type: 'FB', name: 'Loop', networks: [
      { dsl: 'CALL("Loop", inst="DB_Loop")' },
    ] }, { callCatalog: { Loop: { blockType: 'FB', params: [] } } });
    fs.writeFileSync(path.join(blocks, 'Loop.xml'), recursive.xml);
    assert.throws(() => runProject(file), /Recursive CALL: .*Loop -> Loop/);

    const coils = ['First', 'Second'].map(name => B.readBlock(B.createBlockXml({
      name, type: 'FB', interface: { Output: [{ name: 'Flag', type: 'Bool' }] },
      networks: [{ dsl: 'COIL(#Flag), COIL("Shared")' }],
    }).xml, { simulationOnly: true }));
    const findings = A.analyze(coils).findings.filter(f => f.code === 'DOUBLE_COIL');
    assert.strictEqual(findings.length, 1);
    assert(findings[0].message.includes('"Shared"'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
