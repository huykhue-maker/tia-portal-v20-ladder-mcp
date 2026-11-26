'use strict';
// SimaticML FlgNet XML -> Ladder AST (+ canonical DSL).  Handles TIA V20 <Part Name="O"> OR gates,
// array subscript <Access>, unary/trig math, conversions/scaling, and Motion Control technology boxes.

const X = require('./xml');
const C = require('./catalog');
const O = require('./operand');
const D = require('./dsl');

function readComponents(comps, notes, fcReturn) {
  const path = [];
  const idx = {};
  let slice = null;
  comps.forEach((c, i) => {
    path.push(c.attrs.Name);
    const accs = X.kids(c, 'Access');
    if (accs.length) idx[i] = accs.map(a => readOperand(a, notes, fcReturn));
    if (c.attrs.SliceAccessModifier) slice = c.attrs.SliceAccessModifier.toUpperCase();
  });
  return { path, idx, slice };
}

function readOperand(el, notes, fcReturn) {
  const scope = el.attrs.Scope;
  const sym = X.kid(el, 'Symbol');
  if (sym) {
    const comps = X.kids(sym, 'Component');
    if (comps.length) {
      const { path, idx, slice } = readComponents(comps, notes, fcReturn);
      if (scope === 'LocalVariable' && fcReturn && path.length === 1 &&
          (path[0]?.toLowerCase() === fcReturn.blockName.toLowerCase() || /^Ret_Val$/i.test(path[0]))) path[0] = fcReturn.member.name;
      if (X.kids(sym, 'Address').length || X.kids(sym, 'AbsoluteOffset').length) notes.push('mixed symbolic/absolute access');
      return (scope === 'LocalVariable' || scope === 'LocalConstant') ? O.local(path, idx, slice) : O.global(path, idx, slice);
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
    if (scope === 'LocalConstant' && con.attrs.Name) return O.local([con.attrs.Name]);
    if (!value && con.attrs.Name) return O.global([con.attrs.Name]);
    return O.lit(type || 'auto', value);
  }
  notes.push('unsupported access scope ' + scope);
  return { k: 'raw', value: '<' + scope + '>' };
}
function instOperand(inst, notes) {
  const comps = X.kids(inst, 'Component');
  if (!comps.length) return { k: 'raw', value: '<instance>' };
  const { path, idx } = readComponents(comps, notes || []);
  return inst.attrs.Scope === 'LocalVariable' ? O.local(path, idx) : O.global(path, idx);
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
    if (el.name === 'Access') parts.set(uid, { uid, kind: 'access', op: readOperand(el, notes, opts.fcReturn) });
    else if (el.name === 'Part') {
      const inst = X.kid(el, 'Instance');
      parts.set(uid, {
        uid, kind: 'part', name: el.attrs.Name, version: el.attrs.Version,
        templates: X.kids(el, 'TemplateValue').map(t => ({ name: t.attrs.Name, type: t.attrs.Type, value: X.textOf(t) })),
        negated: new Set(X.kids(el, 'Negated').map(n => n.attrs.Name)),
        inst: inst ? instOperand(inst, notes) : null,
      });
    } else if (el.name === 'Call') {
      const ci = X.kid(el, 'CallInfo'); const inst = ci && X.kid(ci, 'Instance');
      parts.set(uid, {
        uid, kind: 'call', name: ci ? ci.attrs.Name : '?', blockType: ci ? ci.attrs.BlockType : 'FC', inst: inst ? instOperand(inst, notes) : null,
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
      else if (m.name === 'OpenCon') net.members.push({ k: 'open' });
      else { net.members.push({ k: 'open' }); notes.push('unknown wire connection ' + m.name); }
    }
    const idx = nets.push(net) - 1;
    for (const m of net.members) if (m.k === 'name') pinNet.set(m.uid + ':' + m.pin.toLowerCase(), idx);
  }
  const isOut = (part, pin) => {
    if (!part) return false;
    if (part.kind === 'call') {
      const key = pin.toLowerCase();
      if (key === 'en') return false; if (key === 'eno') return true;
      const p = part.params.find(x => x.name.toLowerCase() === key);
      return p ? (p.section === 'Output' || p.section === 'Return') : C.isOutputPin(pin);
    }
    return C.isOutputPin(pin, part.name);
  };
  const netOf = (uid, pin) => pinNet.get(uid + ':' + pin.toLowerCase());

  const condCache = new Map();
  function dataOperand(uid, pin) {
    const ni = netOf(uid, pin);
    if (ni === undefined) return null;
    const net = nets[ni];
    const id = net.members.find(m => m.k === 'ident');
    if (id) { const a = parts.get(id.uid); return a && a.kind === 'access' ? a.op : { k: 'raw', value: '?' }; }
    const src = net.members.find(m => m.k === 'name' && isOut(parts.get(m.uid), m.pin) && !(m.uid === uid && m.pin.toLowerCase() === pin.toLowerCase()));
    if (src) {
      const sp = parts.get(src.uid);
      if (sp && sp.inst) return sp.inst.k === 'raw' ? sp.inst : { k: sp.inst.k, path: [...sp.inst.path, src.pin], idx: sp.inst.idx };
      notes.push('value wired directly between boxes (' + (sp ? sp.name : '?') + '#' + src.uid + '.' + src.pin + ')');
      return { k: 'raw', value: '<' + (sp ? sp.name : '?') + '#' + src.uid + '.' + src.pin + '>' };
    }
    return null;
  }
  const operand = (uid, pin) => dataOperand(uid, pin) || { k: 'raw', value: '?' };
  function tpl(part, name) { const t = part.templates.find(x => x.name === name); return t ? t.value : null; }
  function condNode(part) {
    if (condCache.has(part.uid)) return condCache.get(part.uid);
    let n;
    switch (part.name) {
      case 'Contact': n = { t: 'contact', op: dataOperand(part.uid, 'operand') || { k: 'raw', value: '?' }, neg: part.negated.has('operand') }; break;
      case 'PBox': n = { t: 'rtrig', mem: dataOperand(part.uid, 'bit') || { k: 'raw', value: '?' } }; break;
      case 'NBox': n = { t: 'ftrig', mem: dataOperand(part.uid, 'bit') || { k: 'raw', value: '?' } }; break;
      case 'PContact': case 'NContact':
        n = { t: 'edgeContact', rising: part.name === 'PContact', op: operand(part.uid, 'operand'), mem: operand(part.uid, 'bit') };
        break;
      case 'InRange': case 'OutRange':
        n = { t: 'range', fn: C.RANGE_FROM_PART[part.name], inputs: C.RANGE_PINS.map(pin => operand(part.uid, pin)), type: tpl(part, 'SrcType') };
        break;
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
    pin = pin.toLowerCase();
    const key = uid + ':' + pin;
    if (outMemo.has(key)) return outMemo.get(key);
    const part = parts.get(uid);
    let res;
    if (part && part.kind === 'part' && part.name === 'O' && pin === 'out') {
      const branches = [];
      const card = parseInt(tpl(part, 'Card') || '0', 10);
      const maxIn = Math.max(card, 16);
      for (let i = 1; i <= maxIn; i++) {
        const fin = netOf(uid, 'in' + i);
        if (fin === undefined) { if (i > card) break; continue; }
        const bSig = netSignal(fin);
        if (bSig.t !== 'open') branches.push(bSig);
      }
      res = branches.length === 0 ? { t: 'open' } : mkOrFactored(branches);
    } else if (part && part.kind === 'part' && C.PART_KIND[part.name] === 'cond' && pin === 'out') {
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
    const bk = C.BOX_FROM_PART[part.name];
    if (bk) return C.BOXES[bk].main;
    if (C.ACTION_FLOW_IN[part.name]) return C.ACTION_FLOW_IN[part.name];
    return ['in', 'en', 'IN', 'pre'].find(p => netOf(part.uid, p) !== undefined) || 'in';
  }
  function flowOutPin(part) {
    if (part.kind === 'call') return 'eno';
    const bk = C.BOX_FROM_PART[part.name];
    if (bk) return C.BOXES[bk].flowOut;
    if (C.LATCH_FROM_PART[part.name]) return 'q';
    if (part.name === 'Move' || /^sel$/i.test(part.name) || C.MATH_FROM_PART[part.name] || C.SHIFT_FROM_PART[part.name] || C.UNARY_FROM_PART[part.name] || C.CONV_FROM_PART[part.name]) return 'eno';
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
      return { t: 'call', name: part.name, inst: part.inst, args, blockType: part.blockType, params: part.params };
    }
    switch (part.name) {
      case 'Coil': return { t: 'coil', kind: part.negated.has('operand') ? 'NCOIL' : 'COIL', op: dataOperand(u, 'operand') || { k: 'raw', value: '?' } };
      case 'SCoil': return { t: 'coil', kind: 'SET', op: dataOperand(u, 'operand') || { k: 'raw', value: '?' } };
      case 'RCoil': return { t: 'coil', kind: 'RESET', op: dataOperand(u, 'operand') || { k: 'raw', value: '?' } };
      case 'Sr': case 'Rs': {
        const fn = C.LATCH_FROM_PART[part.name];
        return { t: 'latch', fn, op: operand(u, 'operand'), secondary: paramFrom(u, C.LATCHES[fn].secondary, 'flow'), out: paramFrom(u, 'Q', 'out')?.op || null };
      }
      case 'Sel': case 'SEL': return { t: 'select', gate: paramFrom(u, 'g', 'flow') || { v: 'op', op: { k: 'raw', value: '?' } },
        inputs: ['in0', 'in1'].map(pin => operand(u, pin)), dst: operand(u, 'out'), type: tpl(part, 'value_type') || tpl(part, 'SrcType') };
      case 'Move': {
        const dst = [];
        for (let i = 1; netOf(u, 'out' + i) !== undefined; i++) {
          const d = dataOperand(u, 'out' + i);
          if (d) dst.push(d);
        }
        if (!dst.length) notes.push('MOVE without destination');
        return { t: 'move', src: dataOperand(u, 'in') || { k: 'raw', value: '?' }, dst };
      }
      default:
    }
    if (C.MATH_FROM_PART[part.name]) {
      const fn = C.MATH_FROM_PART[part.name];
      const inputs = [operand(u, 'in1'), operand(u, 'in2')];
      if (C.VARIADIC_MATH.has(fn)) {
        for (let i = 3; netOf(u, 'in' + i) !== undefined; i++) inputs.push(operand(u, 'in' + i));
        if (Number(tpl(part, 'Card')) > inputs.length) notes.push(part.name + ' has unconnected inputs');
      } else if (netOf(u, 'in3') !== undefined) notes.push(part.name + ' with more than 2 inputs');
      const operands = inputs.length === 2 ? { a: inputs[0], b: inputs[1] } : { inputs };
      return { t: 'math', fn, ...operands, dst: operand(u, 'out'), type: tpl(part, 'value_type') || tpl(part, 'SrcType') };
    }
    if (C.SHIFT_FROM_PART[part.name]) {
      return { t: 'shift', fn: C.SHIFT_FROM_PART[part.name], src: operand(u, 'in'), count: operand(u, 'n'), dst: operand(u, 'out'), type: tpl(part, 'SrcType') };
    }
    if (C.UNARY_FROM_PART[part.name]) {
      return { t: 'unary', fn: C.UNARY_FROM_PART[part.name], src: dataOperand(u, 'in') || { k: 'raw', value: '?' }, dst: dataOperand(u, 'out') || { k: 'raw', value: '?' }, type: tpl(part, 'SrcType') };
    }
    if (C.CONV_FROM_PART[part.name]) {
      const fn = C.CONV_FROM_PART[part.name];
      const info = C.CONV_OPS[fn];
      const ins = info.ins.map(pin => dataOperand(u, pin) || { k: 'raw', value: '?' });
      const out = dataOperand(u, 'out') || { k: 'raw', value: '?' };
      return { t: 'conv', fn, ins, out, srcType: tpl(part, 'SrcType'), destType: tpl(part, 'DestType') };
    }
    const bk = C.BOX_FROM_PART[part.name];
    if (bk) {
      const B = C.BOXES[bk];
      const params = {};
      for (const k of [...B.valIn, ...(B.optIn || [])]) { const P = paramFrom(u, k, 'val'); if (P) params[k] = P; }
      for (const k of B.flowIn) { const P = paramFrom(u, k, 'flow'); if (P) params[k] = P; }
      for (const k of [...B.valOut, ...B.boolOut]) { const P = paramFrom(u, k, 'out'); if (P) params[k] = P; }
      return { t: 'box', name: bk, inst: part.inst || { k: 'raw', value: '?' }, params, type: tpl(part, 'value_type') || tpl(part, 'time_type') || (B.kind === 'timer' ? 'Time' : (B.kind === 'motion' ? 'Void' : 'Int')) };
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
      if (pp && flowOutPin(pp)?.toLowerCase() === items[0].pin && actionPartKind(pp)) { parent = items[0].id; rest = mkAnd(items.slice(1)); }
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
  const strip = f => { delete f.min; for (const a of f.then) for (const n of (a.next || [])) strip(n); };
  rungs.forEach(strip);
  const uniqNotes = [...new Set(notes)];
  const hasRaw = JSON.stringify(rungs).includes('"k":"raw"') || JSON.stringify(rungs).includes('"t":"raw"') || JSON.stringify(rungs).includes('"t":"open"') || JSON.stringify(rungs).includes('"t":"ref"');
  return { flows: rungs, notes: uniqNotes, complete: uniqNotes.length === 0 && !hasRaw, dsl: D.printNetwork(rungs) };
}

module.exports = { readFlgNet, readOperand, instOperand };
