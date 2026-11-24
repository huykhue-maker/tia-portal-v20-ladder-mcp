'use strict';
// SimaticML FlgNet XML -> Ladder AST (+ canonical DSL).  The graph (Parts + Wires) is converted into
// series/parallel condition trees and action chains.  Anything that cannot be expressed faithfully
// is reported in `notes` and makes the network non-editable (it is then preserved untouched).

const X = require('./xml');
const C = require('./catalog');
const O = require('./operand');
const D = require('./dsl');

function readOperand(el, notes) {
  const scope = el.attrs.Scope;
  const sym = X.kid(el, 'Symbol');
  if (sym) {
    const comps = X.kids(sym, 'Component');
    if (comps.length) {
      const path = comps.map(c => c.attrs.Name);
      if (comps.some(c => X.kid(c, 'Access'))) { notes.push('array index access on ' + path.join('.')); return { k: 'raw', value: path.join('.') + '[...]' }; }
      if (X.kids(sym, 'Address').length || X.kids(sym, 'AbsoluteOffset').length) notes.push('mixed symbolic/absolute access');
      return (scope === 'LocalVariable' || scope === 'LocalConstant') ? O.local(path) : O.global(path);
    }
  }
  const addr = X.kid(el, 'Address');
  if (addr) {
    if (addr.attrs.Area === 'DB' || addr.attrs.Area === 'DI') { notes.push('absolute DB access'); return { k: 'raw', value: '%' + addr.attrs.Area + addr.attrs.BlockNumber + '.' + addr.attrs.BitOffset }; }
    return O.abs(addr.attrs.Area, addr.attrs.Type || 'Bool', parseInt(addr.attrs.BitOffset || '0', 10));
  }
  const con = X.kid(el, 'Constant');
  if (con) {
    const type = X.textOf(X.kid(con, 'ConstantType')), value = X.textOf(X.kid(con, 'ConstantValue'));
    if (!value && con.attrs.Name) return O.global([con.attrs.Name]);
    return O.lit(type || 'auto', value);
  }
  notes.push('unsupported access scope ' + scope);
  return { k: 'raw', value: '<' + scope + '>' };
}
function instOperand(inst) {
  const path = X.kids(inst, 'Component').map(c => c.attrs.Name);
  if (!path.length) return { k: 'raw', value: '<instance>' };
  return inst.attrs.Scope === 'LocalVariable' ? O.local(path) : O.global(path);
}

const andItems = n => (n.t === 'and' ? n.items : n.t === 'true' ? [] : [n]);
function mkAnd(list) {
  const out = [];
  for (const it of list) { if (it.t === 'and') out.push(...it.items); else if (it.t !== 'true') out.push(it); }
  if (!out.length) return { t: 'true' };
  return out.length === 1 ? out[0] : { t: 'and', items: out };
}
function mkOrFactored(list) {
  const flat = [];
  for (const it of list) { if (it.t === 'or') flat.push(...it.items); else flat.push(it); }
  const uniq = flat.filter((x, i) => flat.indexOf(x) === i);
  if (uniq.length === 1) return uniq[0];
  const branches = uniq.map(andItems);
  let p = 0;
  for (;;) {
    const first = branches[0][p];
    if (!first || !branches.every(b => b[p] === first)) break;
    p++;
  }
  if (p > 0) {
    const rests = branches.map(b => mkAnd(b.slice(p)));
    const inner = rests.some(r => r.t === 'true') ? { t: 'true' } : mkOrFactored(rests);
    return mkAnd([...branches[0].slice(0, p), inner]);
  }
  return { t: 'or', items: uniq };
}
function containsRef(n) {
  if (!n) return false;
  if (n.t === 'ref') return true;
  if (n.t === 'and' || n.t === 'or') return n.items.some(containsRef);
  return false;
}

function readFlgNet(flg, opts) {
  opts = opts || {};
  const notes = [];
  const parts = new Map();
  const partsEl = X.kid(flg, 'Parts');
  for (const el of (partsEl ? partsEl.children : [])) {
    const uid = el.attrs.UId;
    if (el.name === 'Access') parts.set(uid, { uid, kind: 'access', op: readOperand(el, notes) });
    else if (el.name === 'Part') {
      const inst = X.kid(el, 'Instance');
      parts.set(uid, {
        uid, kind: 'part', name: el.attrs.Name, version: el.attrs.Version,
        templates: X.kids(el, 'TemplateValue').map(t => ({ name: t.attrs.Name, type: t.attrs.Type, value: X.textOf(t) })),
        negated: new Set(X.kids(el, 'Negated').map(n => n.attrs.Name)),
        inst: inst ? instOperand(inst) : null,
      });
    } else if (el.name === 'Call') {
      const ci = X.kid(el, 'CallInfo'); const inst = ci && X.kid(ci, 'Instance');
      parts.set(uid, {
        uid, kind: 'call', name: ci ? ci.attrs.Name : '?', blockType: ci ? ci.attrs.BlockType : 'FC', inst: inst ? instOperand(inst) : null,
        params: ci ? X.kids(ci, 'Parameter').map(p => ({ name: p.attrs.Name, section: p.attrs.Section, type: p.attrs.Type })) : [],
      });
    }
  }
  const nets = []; const pinNet = new Map();
  const wiresEl = X.kid(flg, 'Wires');
  for (const w of (wiresEl ? X.kids(wiresEl, 'Wire') : [])) {
    const net = { members: [] };
    for (const m of w.children) {
      if (m.name === 'Powerrail') net.members.push({ k: 'pwr' });
      else if (m.name === 'NameCon') net.members.push({ k: 'name', uid: m.attrs.UId, pin: m.attrs.Name });
      else if (m.name === 'IdentCon') net.members.push({ k: 'ident', uid: m.attrs.UId });
      else { net.members.push({ k: 'open' }); notes.push('open/unfinished connection'); }
    }
    const idx = nets.push(net) - 1;
    for (const m of net.members) if (m.k === 'name') pinNet.set(m.uid + ':' + m.pin, idx);
  }
  const isOut = (part, pin) => {
    if (!part) return false;
    if (part.kind === 'call') {
      if (pin === 'en') return false; if (pin === 'eno') return true;
      const p = part.params.find(x => x.name === pin);
      return p ? (p.section === 'Output' || p.section === 'Return') : C.isOutputPin(pin);
    }
    return C.isOutputPin(pin);
  };
  const netOf = (uid, pin) => pinNet.get(uid + ':' + pin);

  const condCache = new Map();
  function dataOperand(uid, pin) {
    const ni = netOf(uid, pin);
    if (ni === undefined) return null;
    const net = nets[ni];
    const id = net.members.find(m => m.k === 'ident');
    if (id) { const a = parts.get(id.uid); return a && a.kind === 'access' ? a.op : { k: 'raw', value: '?' }; }
    const src = net.members.find(m => m.k === 'name' && isOut(parts.get(m.uid), m.pin) && !(m.uid === uid && m.pin === pin));
    if (src) {
      const sp = parts.get(src.uid);
      if (sp && sp.inst) return sp.inst.k === 'raw' ? sp.inst : { k: sp.inst.k, path: [...sp.inst.path, src.pin] };
      notes.push('value wired directly between boxes (' + (sp ? sp.name : '?') + '#' + src.uid + '.' + src.pin + ')');
      return { k: 'raw', value: '<' + (sp ? sp.name : '?') + '#' + src.uid + '.' + src.pin + '>' };
    }
    return null;
  }
  function tpl(part, name) { const t = part.templates.find(x => x.name === name); return t ? t.value : null; }
  function condNode(part) {
    if (condCache.has(part.uid)) return condCache.get(part.uid);
    let n;
    switch (part.name) {
      case 'Contact': n = { t: 'contact', op: dataOperand(part.uid, 'operand') || { k: 'raw', value: '?' }, neg: part.negated.has('operand') }; break;
      case 'PBox': n = { t: 'rtrig', mem: dataOperand(part.uid, 'bit') || { k: 'raw', value: '?' } }; break;
      case 'NBox': n = { t: 'ftrig', mem: dataOperand(part.uid, 'bit') || { k: 'raw', value: '?' } }; break;
      case 'Not': n = { t: 'not' }; break;
      default: {
        const rel = C.REL_FROM_PART[part.name];
        n = { t: 'cmp', rel, a: dataOperand(part.uid, 'in1') || { k: 'raw', value: '?' }, b: dataOperand(part.uid, 'in2') || { k: 'raw', value: '?' }, type: tpl(part, 'SrcType') };
      }
    }
    n.id = part.uid; condCache.set(part.uid, n); return n;
  }
  const sigMemo = new Map(), outMemo = new Map(), visiting = new Set();
  function outSignal(uid, pin) {
    const key = uid + ':' + pin;
    if (outMemo.has(key)) return outMemo.get(key);
    const part = parts.get(uid);
    let res;
    if (part && part.kind === 'part' && C.PART_KIND[part.name] === 'cond' && pin === 'out') {
      const fin = netOf(uid, C.COND_FLOW_IN[part.name]);
      const inExpr = fin === undefined ? { t: 'open' } : netSignal(fin);
      res = mkAnd([inExpr, condNode(part)]);
    } else res = { t: 'ref', id: uid, pin };
    outMemo.set(key, res); return res;
  }
  function netSignal(ni) {
    if (sigMemo.has(ni)) return sigMemo.get(ni);
    if (visiting.has(ni)) { notes.push('feedback loop in network'); return { t: 'open' }; }
    visiting.add(ni);
    const net = nets[ni]; const srcs = [];
    if (net.members.some(m => m.k === 'pwr')) srcs.push({ t: 'true' });
    for (const m of net.members) if (m.k === 'name' && isOut(parts.get(m.uid), m.pin)) srcs.push(outSignal(m.uid, m.pin));
    const res = srcs.length === 0 ? { t: 'open' } : srcs.length === 1 ? srcs[0] : mkOrFactored(srcs);
    visiting.delete(ni); sigMemo.set(ni, res); return res;
  }

  // ---------------------------------------------------------------- actions
  function paramFrom(uid, pin, kind) {
    const ni = netOf(uid, pin);
    if (ni === undefined) return null;
    const net = nets[ni];
    const id = net.members.find(m => m.k === 'ident');
    if (kind === 'out') return id ? { v: 'op', op: (parts.get(id.uid) || {}).op } : null;
    if (id && !net.members.some(m => m.k === 'pwr' || (m.k === 'name' && isOut(parts.get(m.uid), m.pin)))) return { v: 'op', op: parts.get(id.uid).op };
    if (kind === 'flow' || kind === 'any') {
      const s = netSignal(ni);
      if (s.t === 'open') return null;
      if (containsRef(s)) notes.push('box input ' + pin + ' fed by another box output');
      return { v: 'cond', cond: s };
    }
    const op = dataOperand(uid, pin); return op ? { v: 'op', op } : null;
  }
  function actionPartKind(part) {
    if (part.kind === 'call') return 'call';
    if (part.kind !== 'part') return null;
    return C.PART_KIND[part.name] === 'action' || !C.PART_KIND[part.name] ? part.name : null;
  }
  function mainFlow(part) {
    if (part.kind === 'call') return 'en';
    if (C.BOXES[part.name]) return C.BOXES[part.name].main;
    if (C.ACTION_FLOW_IN[part.name]) return C.ACTION_FLOW_IN[part.name];
    return ['in', 'en', 'IN', 'pre'].find(p => netOf(part.uid, p) !== undefined) || 'in';
  }
  function flowOutPin(part) {
    if (part.kind === 'call') return 'eno';
    if (C.BOXES[part.name]) return C.BOXES[part.name].flowOut;
    if (['Move', 'Add', 'Sub', 'Mul', 'Div', 'Mod'].includes(part.name)) return 'eno';
    return null;
  }
  function buildAction(part) {
    const u = part.uid;
    if (part.kind === 'call') {
      const args = {};
      for (const p of part.params) {
        const P = paramFrom(u, p.name, p.section === 'Input' ? 'flow' : 'out') || (p.section === 'InOut' ? paramFrom(u, p.name, 'val') : null);
        if (P) args[p.name] = P;
      }
      return { t: 'call', name: part.name, inst: part.inst, args, blockType: part.blockType };
    }
    switch (part.name) {
      case 'Coil': return { t: 'coil', kind: part.negated.has('operand') ? 'NCOIL' : 'COIL', op: dataOperand(u, 'operand') || { k: 'raw', value: '?' } };
      case 'SCoil': return { t: 'coil', kind: 'SET', op: dataOperand(u, 'operand') || { k: 'raw', value: '?' } };
      case 'RCoil': return { t: 'coil', kind: 'RESET', op: dataOperand(u, 'operand') || { k: 'raw', value: '?' } };
      case 'Move': {
        const dst = [];
        for (let i = 1; netOf(u, 'out' + i) !== undefined; i++) dst.push(dataOperand(u, 'out' + i) || { k: 'raw', value: '?' });
        if (!dst.length) notes.push('MOVE without destination');
        return { t: 'move', src: dataOperand(u, 'in') || { k: 'raw', value: '?' }, dst };
      }
      default:
    }
    if (C.MATH_FROM_PART[part.name]) {
      if (netOf(u, 'in3') !== undefined) notes.push(part.name + ' with more than 2 inputs');
      return { t: 'math', fn: C.MATH_FROM_PART[part.name], a: dataOperand(u, 'in1') || { k: 'raw', value: '?' }, b: dataOperand(u, 'in2') || { k: 'raw', value: '?' }, dst: dataOperand(u, 'out') || { k: 'raw', value: '?' }, type: tpl(part, 'SrcType') };
    }
    const B = C.BOXES[part.name];
    if (B) {
      const params = {};
      for (const k of B.valIn) { const P = paramFrom(u, k, 'val'); if (P) params[k] = P; }
      for (const k of B.flowIn) { const P = paramFrom(u, k, 'flow'); if (P) params[k] = P; }
      for (const k of [...B.valOut, ...B.boolOut]) { const P = paramFrom(u, k, 'out'); if (P) params[k] = P; }
      return { t: 'box', name: part.name, inst: part.inst || { k: 'raw', value: '?' }, params, type: tpl(part, 'value_type') || (B.kind === 'timer' ? 'Time' : 'Int') };
    }
    notes.push('unsupported instruction ' + part.name);
    return { t: 'raw', label: part.name + '#' + u };
  }

  const act = new Map();
  for (const part of parts.values()) {
    if (part.kind === 'access' || !actionPartKind(part)) continue;
    const node = buildAction(part);
    const mp = mainFlow(part);
    const ni = netOf(part.uid, mp);
    const Ex = ni === undefined ? { t: 'open' } : netSignal(ni);
    const items = Ex.t === 'and' ? Ex.items : [Ex];
    let parent = null, rest = Ex;
    if (items[0].t === 'ref') {
      const pp = parts.get(items[0].id);
      if (pp && flowOutPin(pp) === items[0].pin && actionPartKind(pp)) { parent = items[0].id; rest = mkAnd(items.slice(1)); }
    }
    if (!parent && containsRef(Ex)) notes.push('power flow joins several box outputs at ' + (part.name || '?') + '#' + part.uid);
    if (rest.t === 'open') notes.push('unconnected input on ' + (part.name || '?') + '#' + part.uid);
    act.set(part.uid, { uid: part.uid, node, parent, rest, ni });
  }
  const groupsMap = new Map();
  for (const a of act.values()) {
    const key = (a.parent || 'root') + '|' + a.ni;
    if (!groupsMap.has(key)) groupsMap.set(key, { parent: a.parent, rest: a.rest, list: [], min: +a.uid });
    const g = groupsMap.get(key); g.list.push(a); g.min = Math.min(g.min, +a.uid);
  }
  const mkFlow = g => {
    g.list.sort((x, y) => x.uid - y.uid);
    return { cond: g.rest.t === 'true' ? null : g.rest, then: g.list.map(x => x.node), min: g.min };
  };
  const rungs = [];
  for (const g of [...groupsMap.values()].sort((x, y) => x.min - y.min)) {
    const f = mkFlow(g);
    if (g.parent) {
      const pa = act.get(g.parent);
      if (pa) { (pa.node.next = pa.node.next || []).push(f); continue; }
    }
    rungs.push(f);
  }
  // actions whose parent is missing/invalid were rooted already; clean helper field
  const strip = f => { delete f.min; for (const a of f.then) for (const n of (a.next || [])) strip(n); };
  rungs.forEach(strip);
  const uniqNotes = [...new Set(notes)];
  const hasRaw = JSON.stringify(rungs).includes('"k":"raw"') || JSON.stringify(rungs).includes('"t":"raw"') || JSON.stringify(rungs).includes('"t":"open"') || JSON.stringify(rungs).includes('"t":"ref"');
  return { flows: rungs, notes: uniqNotes, complete: uniqNotes.length === 0 && !hasRaw, dsl: D.printNetwork(rungs) };
}

module.exports = { readFlgNet, readOperand, instOperand };
