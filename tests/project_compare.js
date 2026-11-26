'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const B = require('../server/ladder/block');
const X = require('../server/ladder/xml');
const { runProject } = require('../server/ladder/project');

const cli = path.resolve(__dirname, '../server/test-project.js');

module.exports = async function testProjectComparison(withMcpServer) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lad-compare-'));
  try {
    const file = path.join(temp, 'suite.json');
    const variant = (directory, dsl, startValue = 12) => {
      const dir = path.join(temp, directory);
      fs.mkdirSync(dir, { recursive: true });
      const block = B.createBlockXml({
        name: 'FB_Check',
        type: 'FB',
        interface: { Input: [{ name: 'Input', type: 'Bool' }, { name: 'Permit', type: 'Bool' }], Output: [{ name: 'Out', type: 'Bool' }] },
        networks: [{ dsl }],
      });
      const db = B.createDbXml({ name: 'DB_Config', members: [{ name: 'Limit', type: 'Int', startValue }] });
      fs.writeFileSync(path.join(dir, 'FB_Check.xml'), block.xml);
      fs.writeFileSync(path.join(dir, 'DB_Config.xml'), db);
    };
    const baseline = 'NO(#Input) & NO(#Permit) => COIL(#Out)';
    const candidate = 'NO(#Input) => COIL(#Out)';
    variant('before', baseline);
    variant('after', candidate);

    const manifest = {
      blockDir: 'after', entry: 'FB_Check', strictSymbols: true,
      cases: [{
        name: 'Transient <pulse>',
        scanMs: 15,
        init: { '#Out': 1 },
        watch: ['#Out', '"DB_Config".Limit'],
        steps: [
          { set: { '#Input': 1 }, run: 1 },
          { set: { '#Input': 0 }, run: 1, expect: { '#Out': 0 } },
        ],
      }],
    };
    const save = () => fs.writeFileSync(file, JSON.stringify(manifest));
    const invoke = (...args) => spawnSync(process.execPath, [cli, file, ...args], { cwd: os.tmpdir(), encoding: 'utf8' });
    save();
    const oldFormat = runProject(file);
    assert(oldFormat.ok);
    assert.equal(oldFormat.comparison, undefined);
    assert.equal(oldFormat.cases[0].result.initial, undefined);

    const exit = invoke('--baseline', 'before');
    assert.equal(exit.status, 1, exit.stderr);
    assert.match(exit.stdout, /scan 1 @15ms #Out: baseline -> candidate 0 -> 1/);
    const xml = invoke('--format', 'junit', '--baseline', 'before');
    assert.equal(xml.status, 1, xml.stderr);
    const suite = X.parse(xml.stdout);
    assert.equal(suite.attrs.failures, '1');
    assert.equal(suite.attrs.tests, '4');
    assert.equal(suite.children[3].attrs.name, 'Compare: Transient <pulse>');

    manifest.baselineBlockDir = 'before';
    save();
    const diff = runProject(file);
    assert.equal(diff.cases[0].status, 'passed');
    assert.equal(diff.comparison.cases[0].baselineStatus, 'passed');
    assert.deepEqual(diff.comparison.cases[0].firstDifference, {
      kind: 'scan', time: 15, scan: 1, key: '#Out', baseline: 0, candidate: 1,
    });
    assert.equal(runProject(file, { baselineBlockDir: 'after' }).ok, true);

    await withMcpServer(async rpc => {
      const { result } = await rpc('tools/call', {
        name: 'tia_test_ladder_project',
        arguments: { manifestPath: file, baselineBlockDir: 'before', format: 'json' },
      });
      assert(!result.isError, result.content[0].text);
      assert.deepEqual(result.structuredContent.comparison, diff.comparison);
    });

    variant('after', baseline, 13);
    const init = runProject(file).comparison.cases[0].firstDifference;
    assert.deepEqual(init, { kind: 'initial', time: 0, key: '"DB_Config".Limit', baseline: 12, candidate: 13 });
    manifest.compareTolerance = 1;
    save();
    assert.equal(runProject(file).ok, true);

    delete manifest.compareTolerance;
    delete manifest.cases[0].init;
    variant('after', candidate);
    manifest.cases[0].steps = [
      { set: { '#Input': 1 }, until: { '#Out': 1 }, timeout: '30ms' },
    ];
    manifest.cases[0].watch = ['"DB_Config".Limit'];
    save();
    const assertion = runProject(file).comparison.cases[0].firstDifference;
    assert.deepEqual(assertion, { kind: 'assertion', time: 15, key: '#Out', step: 1, field: 'time', baseline: 30, candidate: 15 });

    manifest.cases[0].steps = [
      { run: 0, set: { '#Input': 1, '"DB_Config".Limit': 8 }, expect: { '#Out': 0 } },
    ];
    // Initial values are equal and the identical zero-scan writes remain equal.
    save();
    assert.equal(runProject(file).ok, true);
    manifest.cases[0].watch = [];
    save();
    assert.equal(invoke().status, 2);
    assert.throws(() => runProject(file), /requires a non-empty watch list/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
