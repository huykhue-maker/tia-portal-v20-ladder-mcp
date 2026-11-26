'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runProject } = require('../server/ladder/project');
const X = require('../server/ladder/xml');

const example = path.resolve(__dirname, '../examples/typed-inspection');
const cli = path.resolve(__dirname, '../server/test-project.js');

module.exports = async function testProjectSymbols(withMcpServer) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lad-typed-'));
  try {
    fs.cpSync(example, temp, { recursive: true });
    const file = path.join(temp, 'suite.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const invoke = format => spawnSync(process.execPath, [cli, file, '--format', format], { encoding: 'utf8' });
    const junit = invoke('junit');
    assert.equal(junit.status, 0, junit.stderr);
    assert.equal(X.parse(junit.stdout).attrs.tests, '4');
    await withMcpServer(async rpc => {
      const { result } = await rpc('tools/call', { name: 'tia_test_ladder_project', arguments: { manifestPath: file, format: 'json' } });
      assert(!result.isError, result.content[0].text);
      assert.equal(result.structuredContent.ok, true);
      assert.deepEqual(result.structuredContent.cases.map(c => c.status), ['passed', 'passed', 'passed']);
    });

    const bad = (key, value = 0) => ({ name: key, steps: [{ expect: { [key]: value } }] });
    manifest.cases.push(
      { name: 'Signed valid index', init: { '"DB_Settings".Samples[-1]': 7 }, steps: [{ expect: { '"db_settings".Samples[-1]': 7 } }] },
      bad('"AUDIT_UNDECLARED"'), bad('"DB_Audit".Typo'), bad('#Ready.WrongField'),
      bad('"DB_Settings".Inspection.Typo'), bad('"DB_Settings".Samples[2]'),
      bad('"DB_Settings".Samples[0, 1]'), bad('"PartPresent"', 'not-a-bool')
    );
    fs.writeFileSync(file, JSON.stringify(manifest));
    const report = runProject(file);
    assert.equal(report.ok, false);
    assert.deepEqual(report.cases.slice(0, 4).map(c => c.status), ['passed', 'passed', 'passed', 'passed']);
    const expected = [/Unknown global.*AUDIT_UNDECLARED/, /Unknown global.*DB_Audit/, /Unknown member.*WrongField/,
      /Unknown member.*Typo/, /outside -1\.\.1/, /Expected 1 array indices/, /invalid Bool value/];
    for (const [i, error] of expected.entries()) {
      const result = report.cases[i + 4];
      assert.equal(result.status, 'error');
      assert.match(result.message, /^step 1 expect:/);
      assert.match(result.message, error);
    }
    const failed = invoke('junit');
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(X.parse(failed.stdout).attrs.errors, String(expected.length));

    const tagXml = path.join(temp, 'blocks', 'Inputs.xml');
    const tags = fs.readFileSync(tagXml, 'utf8');
    fs.writeFileSync(tagXml, tags.replace('PartPresent', 'PartRemoved'));
    assert.throws(() => runProject(file), /FB_Check\.xml: FB_Check NW1: Unknown global.*PartPresent/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
