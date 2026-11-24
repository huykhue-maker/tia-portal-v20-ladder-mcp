'use strict';
// Static analysis over Ladder blocks: double coils, set/reset balance, undeclared / unused variables,
// timer & edge-memory reuse, cross-reference.
const A = require('./ast');
const O = require('./operand');

function analyze(blockReads, opts) {
  opts = opts || {};
  const findings = []; const xref = new Map();
  const writes = new Map(); // key -> [{block, nw, kind}]
  const add = (level, code, message, where) => findings.push({ level, code, message, where });
  const globalWrite = new Map(); // key -> Set(blocks)
  for (const r of blockReads) {
    const bname = r.block.name; const declared = new Map();
    for (const sec of Object.keys(r.interface)) for (const m of r.interface[sec]) declared.set(m.name.split('.')[0], sec);
    const used = new Set(), written = new Set();
    const timerUse = new Map(), edgeUse = new Map();
    let nonLad = 0;
    for (const n of r.networks) {
      if (!n.flows || n.dsl === null) { nonLad++; continue; }
      if (!n.flows.length) { add('info', 'EMPTY_NETWORK', 'Network is empty', bname + ' NW' + n.index); continue; }
      A.walkFlows(n.flows, (op, mode, node) => {
        if (!op || op.k === 'lit' || op.k === 'raw') return;
        const key = O.text(op);
        const head = op.k === 'local' ? op.path[0] : null;
        if (head) used.add(head);
        const rw = mode === 'w' ? 'write' : mode === 'rw' ? 'read/write' : 'read';
        if (!xref.has(key)) xref.set(key, []);
        xref.get(key).push({ block: bname, nw: n.index, access: mode === 'inst' || mode === 'mem' ? 'instance' : rw });
        if (mode === 'inst') {
          if (!timerUse.has(key)) timerUse.set(key, []); timerUse.get(key).push(n.index);
        }
        if (mode === 'mem') { if (!edgeUse.has(key)) edgeUse.set(key, []); edgeUse.get(key).push(n.index); }
        if (mode === 'w' || mode === 'rw') {
          if (op.k === 'local' && op.path.length === 1) written.add(head);
          const kind = node && node.t === 'coil' ? node.kind : 'ASSIGN';
          if (!writes.has(key)) writes.set(key, []);
          writes.get(key).push({ block: bname, nw: n.index, kind });
          if (op.k !== 'local') { if (!globalWrite.has(key)) globalWrite.set(key, new Set()); globalWrite.get(key).add(bname); }
        }
      });
      // undeclared locals
      A.walkFlows(n.flows, (op) => {
        if (op && op.k === 'local' && !declared.has(op.path[0])) add('error', 'UNDECLARED', '#' + op.path[0] + ' is not declared in the block interface', bname + ' NW' + n.index);
      });
    }
    for (const [k, list] of timerUse) if (list.length > 1 && new Set(list).size >= 1 && list.length > 1) add('warning', 'INSTANCE_REUSE', k + ' is used as instance in ' + list.length + ' places (NW' + [...new Set(list)].join(', NW') + ') - one instance per timer/counter/FB call', bname);
    for (const [k, list] of edgeUse) if (list.length > 1) add('warning', 'EDGE_MEM_REUSE', 'Edge memory bit ' + k + ' is used by ' + list.length + ' edge instructions (NW' + [...new Set(list)].join(', NW') + '); each edge needs its own bit', bname);
    for (const [name, sec] of declared) {
      if (!used.has(name) && sec !== 'Return' && sec !== 'Constant') add('info', 'UNUSED', name + ' (' + sec + ') is declared but never used', bname);
      else if (used.has(name) && !written.has(name) && (sec === 'Temp' || sec === 'Static' || sec === 'Output')) {
        const isInst = [...timerUse.keys()].includes('#' + name) || [...edgeUse.keys()].includes('#' + name);
        const member = [...xref.keys()].some(k => k.startsWith('#' + name + '.'));
        if (!isInst && !member) add(sec === 'Output' ? 'warning' : 'info', 'NEVER_WRITTEN', '#' + name + ' (' + sec + ') is read but never written in ' + bname, bname);
      }
    }
    if (nonLad) add('info', 'NON_LAD', nonLad + ' non-Ladder network(s) skipped in ' + bname, bname);
  }
  for (const [key, list] of writes) {
    const coils = list.filter(w => w.kind === 'COIL' || w.kind === 'NCOIL');
    const sets = list.filter(w => w.kind === 'SET'), resets = list.filter(w => w.kind === 'RESET');
    const loc = l => l.map(w => w.block + ' NW' + w.nw).join(', ');
    if (coils.length > 1) add('warning', 'DOUBLE_COIL', key + ' is driven by ' + coils.length + ' coils (' + loc(coils) + '): the last one wins every scan', loc(coils));
    if (coils.length && (sets.length || resets.length)) add('warning', 'COIL_AND_SETRESET', key + ' is written by both a coil and Set/Reset (' + loc(list) + '): the coil overrides latching', loc(list));
    if (sets.length && !resets.length) add('warning', 'SET_WITHOUT_RESET', key + ' is Set (' + loc(sets) + ') but never Reset', loc(sets));
    if (resets.length && !sets.length && !coils.length) add('info', 'RESET_WITHOUT_SET', key + ' is Reset (' + loc(resets) + ') but never Set', loc(resets));
  }
  for (const [key, blocks] of globalWrite) if (blocks.size > 1) add('warning', 'MULTI_BLOCK_WRITE', key + ' is written from ' + blocks.size + ' blocks (' + [...blocks].join(', ') + ')', [...blocks].join(', '));
  const rank = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.level] - rank[b.level]);
  const out = { findings, summary: { error: findings.filter(f => f.level === 'error').length, warning: findings.filter(f => f.level === 'warning').length, info: findings.filter(f => f.level === 'info').length } };
  if (opts.symbol) {
    const q = opts.symbol.replace(/^"|"$/g, '').toLowerCase();
    out.xref = {};
    for (const [k, v] of xref) if (k.replace(/["#]/g, '').toLowerCase().includes(q)) out.xref[k] = v;
  } else out.xrefCount = xref.size;
  return out;
}

function formatAnalysis(a) {
  const lines = ['ANALYSIS: ' + a.summary.error + ' error(s), ' + a.summary.warning + ' warning(s), ' + a.summary.info + ' info'];
  for (const f of a.findings) lines.push('  [' + f.level.toUpperCase() + '] ' + f.code + ': ' + f.message + (f.where ? '  @ ' + f.where : ''));
  if (a.xref) for (const [k, v] of Object.entries(a.xref)) lines.push('XREF ' + k + ': ' + v.map(x => x.block + ' NW' + x.nw + ' (' + x.access + ')').join('; '));
  return lines.join('\n');
}

module.exports = { analyze, formatAnalysis };
