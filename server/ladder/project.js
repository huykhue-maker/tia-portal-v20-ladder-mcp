'use strict';

const fs = require('fs');
const path = require('path');
const B = require('./block');
const A = require('./analyzer');
const D = require('./dsl');
const S = require('./simulator');
const X = require('./xml');
const AST = require('./ast');
const { createSymbols, membersOf, validateOperand, acceptsValue } = require('./project_symbols');

function* xmlFiles(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) yield* xmlFiles(file);
    else if (stat.isFile() && path.extname(name).toLowerCase() === '.xml') yield file;
  }
}

function loadBlocks(directory) {
  const reads = new Map();
  const dependencies = new Map();
  const symbols = createSymbols();
  const sourceFiles = new Map();
  for (const file of xmlFiles(directory)) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const root = X.parse(src);
      const tables = X.kids(root, 'SW.Tags.PlcTagTable');
      for (const table of tables) symbols.addTags(table);
      const objects = (root?.children || []).filter(node => /^SW\.(Blocks\.|Types\.PlcStruct$)/.test(node.name));
      if (!objects.length && tables.length) continue;
      if (objects.length > 1) throw new Error('Expected one block or UDT per XML document');
      const kind = objects[0]?.name;
      if (['SW.Blocks.GlobalDB', 'SW.Types.PlcStruct', 'SW.Blocks.InstanceDB'].includes(kind)) {
        const data = B.parseBlock(src, root);
        if (kind === 'SW.Types.PlcStruct') symbols.addUdt(data.name, data.interface);
        else if (kind === 'SW.Blocks.GlobalDB') symbols.addDb(data.name, data.interface);
        continue;
      }
      const block = B.readBlock(src, { root, simulationOnly: true });
      const name = block.block.name;
      if (!name || !['OB', 'FB', 'FC'].includes(block.block.type)) throw new Error('Expected a named OB, FB or FC');
      if (!block.networks.length) throw new Error(name + ': no LAD networks to simulate');
      if (reads.has(name)) throw new Error('Duplicate block: ' + name);
      const refs = [];
      for (const net of block.networks) {
        if (!net.complete) throw new Error(name + ' NW' + net.index + ': ' + (net.notes.join('; ') || 'incomplete LAD decoding'));
        for (const call of S.calls(net.flows)) refs.push({ call, nw: net.index });
      }
      // Keep the decoded networks and interface; release the source XML and syntax tree.
      const { doc, ...decoded } = block;
      reads.set(name, decoded);
      sourceFiles.set(name, path.relative(directory, file));
      dependencies.set(name, refs);
    } catch (error) {
      throw new Error(path.relative(directory, file) + ': ' + error.message);
    }
  }
  if (!reads.size) throw new Error('No block XML files in ' + directory);
  const checked = new Set();
  const active = new Set();
  function visit(name) {
    if (checked.has(name)) return;
    if (active.has(name)) throw new Error('Recursive CALL: ' + [...active, name].join(' -> '));
    active.add(name);
    for (const { call, nw } of dependencies.get(name)) {
      const target = call.name;
      const callee = reads.get(target);
      const where = name + ' NW' + nw + ': ';
      if (!callee) throw new Error(where + 'missing CALL target ' + target);
      if (callee.block.type !== call.blockType) throw new Error(where + 'CALL expects ' + call.blockType + ' but ' + target + ' is ' + callee.block.type);
      const pins = new Set(['Input', 'Output', 'InOut', 'Return'].flatMap(section => (callee.interface[section] || []).map(m => m.name.toLowerCase())));
      for (const pin of Object.keys(call.args)) {
        if (!pins.has(pin.toLowerCase())) throw new Error(where + 'unknown parameter ' + target + '.' + pin);
      }
      visit(target);
    }
    active.delete(name);
    checked.add(name);
  }
  for (const name of reads.keys()) visit(name);
  return { reads, symbols, sourceFiles };
}

function validateScenario(test, entry, resolve) {
  if (!Array.isArray(test.steps) || !test.steps.length) throw new Error('Expected non-empty steps');
  for (const field of Object.keys(test)) {
    if (!['name', 'entry', 'scanMs', 'watch', 'init', 'steps'].includes(field)) throw new Error('Unknown case field ' + field);
  }
  if (test.init !== undefined && (!test.init || typeof test.init !== 'object' || Array.isArray(test.init))) throw new Error('init must be a variable map');
  if (test.watch !== undefined && !Array.isArray(test.watch)) throw new Error('watch must be an array of variables');
  const locals = new Set(Object.values(entry.interface).flat().map(member => member.name));
  function checkKeys(values, where, isWatch = false) {
    const entries = isWatch ? values.map(key => [key]) : Object.entries(values);
    for (const [key, value] of entries) {
      if (typeof key !== 'string') throw new Error(where + ': expected a variable name');
      let op;
      try { op = D.parseOperandString(key); }
      catch (error) { throw new Error(where + ': ' + key + ': ' + error.message); }
      if (op.k === 'lit' || op.k === 'raw') throw new Error(where + ': expected a variable name: ' + key);
      if (!resolve && op.k === 'local' && !locals.has(op.path[0])) throw new Error('Unknown local ' + key + ' in ' + entry.block.name);
      if (resolve) {
        const type = validateOperand(op, resolve, where);
        if (!isWatch && !acceptsValue(type, value, S.parseTime)) throw new Error(where + ': invalid ' + type + ' value for ' + key);
      }
    }
  }
  checkKeys(test.init || {}, 'init');
  checkKeys(test.watch || [], 'watch', true);
  for (const [i, step] of test.steps.entries()) {
    const label = 'step ' + (i + 1);
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(label + ': expected an object');
    for (const field of Object.keys(step)) {
      if (!['run', 'set', 'expect', 'until', 'timeout', 'tolerance'].includes(field)) throw new Error(label + ': unknown field ' + field);
    }
    for (const field of ['set', 'expect', 'until']) {
      const values = step[field];
      if (values === undefined) continue;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(label + ': expected a variable map');
      checkKeys(values, label + ' ' + field);
    }
    if (step.run !== undefined) {
      const duration = typeof step.run === 'string' ? S.parseTime(step.run) : null;
      const valid = duration !== null ? duration >= 0 : Number.isSafeInteger(step.run) && step.run >= 0;
      if (!valid) throw new Error(label + ': invalid run');
    }
    if (step.tolerance !== undefined && (!Number.isFinite(step.tolerance) || step.tolerance < 0)) throw new Error(label + ': invalid tolerance');
    if (step.timeout !== undefined && !step.until) throw new Error(label + ': timeout requires until');
  }
}

function runProject(manifestPath, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!manifest || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error('Expected non-empty cases in project manifest');
  if (manifest.strictSymbols !== undefined && typeof manifest.strictSymbols !== 'boolean') throw new Error('strictSymbols must be a boolean');
  const { reads, symbols, sourceFiles } = loadBlocks(path.resolve(path.dirname(manifestPath), manifest.blockDir || 'blocks'));
  const blocks = [...reads.values()];
  const resolvers = new Map();
  if (manifest.strictSymbols) {
    for (const block of blocks) {
      const name = block.block.name;
      const locals = membersOf(block.interface);
      const returnValue = B.fcReturnBinding({ kind: block.block.type, name, interface: block.interface });
      if (returnValue) locals.set(name, locals.get(returnValue.member.name));
      const resolve = op => symbols.resolve(op, locals);
      resolvers.set(name, resolve);
      for (const net of block.networks) {
        AST.walkFlows(net.flows, (op, mode) => {
          if (mode !== 'inst' && (op.k === 'local' || op.k === 'global')) {
            validateOperand(op, resolve, sourceFiles.get(name) + ': ' + name + ' NW' + net.index, true);
          }
        });
      }
    }
  }
  const analysis = A.analyze(blocks, { ...opts, cases: manifest.cases, entry: manifest.entry });
  const program = S.buildProgram(blocks, manifest.entry);
  program.resolveGlobal = op => symbols.resolve(op);
  const cases = [];
  const names = new Set();
  for (const test of manifest.cases) {
    if (!test || typeof test.name !== 'string' || !test.name.trim() || names.has(test.name)) throw new Error('Each case needs a distinct non-empty name');
    names.add(test.name);
    const entry = test.entry === undefined ? manifest.entry : test.entry;
    try {
      if (!reads.has(entry)) throw new Error('Unknown entry block: ' + entry);
      validateScenario(test, reads.get(entry), resolvers.get(entry));
      const result = S.runScenario({ ...program, entry }, test);
      if (!result.expects.length) throw new Error('Case needs at least one expect or until assertion');
      cases.push({ name: test.name, entry, status: result.ok ? 'passed' : 'failed', result });
    } catch (error) {
      cases.push({ name: test.name, entry, status: 'error', message: error.message });
    }
  }
  return { ok: !analysis.summary.error && cases.every(c => c.status === 'passed'), blocks: [...reads.keys()], analysis, cases };
}

function caseDetails(c) {
  if (!c.result) return c.message;
  const lines = c.result.expects.filter(e => !e.ok).map(e =>
    'step ' + e.step + ' @' + e.t + 'ms: ' + e.key + ' expected ' + e.expected + ', got ' + e.actual);
  return lines.concat(c.result.warnings).join('\n');
}

function formatReport(report, format = 'text') {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'junit') {
    const tests = [{ name: 'Static analysis', status: report.analysis.summary.error ? 'failed' : 'passed', details: A.formatAnalysis(report.analysis) },
      ...report.cases.map(c => ({ name: c.name, status: c.status, details: caseDetails(c) }))];
    const count = status => tests.filter(t => t.status === status).length;
    return '<testsuite name="LAD offline" tests="' + tests.length + '" failures="' + count('failed') + '" errors="' + count('error') + '">\n' +
      tests.map(t => {
        const tag = t.status === 'error' ? 'error' : t.status === 'failed' ? 'failure' : 'system-out';
        return '  <testcase name="' + X.escAttr(t.name) + '">' + (t.details ? '<' + tag + '>' + X.esc(t.details) + '</' + tag + '>' : '') + '</testcase>';
      }).join('\n') + '\n</testsuite>';
  }
  if (format !== 'text') throw new Error('Expected report format text, json or junit');
  const lines = [(report.ok ? 'PASS' : 'FAIL') + ' | ' + report.blocks.length + ' blocks | ' + report.cases.filter(c => c.status === 'passed').length + '/' + report.cases.length + ' cases passed', A.formatAnalysis(report.analysis)];
  for (const c of report.cases) {
    lines.push(c.status.toUpperCase() + ' ' + c.name + ' (' + c.entry + ')' + (c.result ? ' - ' + c.result.scans + ' scans, ' + c.result.time + ' ms' : ''));
    const details = caseDetails(c);
    if (details) lines.push(details);
  }
  return lines.join('\n');
}

module.exports = { runProject, formatReport };
