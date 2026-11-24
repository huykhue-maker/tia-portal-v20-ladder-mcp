'use strict';
// Scan-cycle simulator for the Ladder AST (dry-run in RAM, no PLC needed).
// Semantics follow IEC 61131-3 / TIA: sequential rung evaluation, RLO folding through series/parallel
// groups, edge memory bits, IEC timers (TON/TOF/TP/TONR) driven by simulated time, IEC counters,
// MOVE / math with ENO, and calls to other LAD blocks (FC/FB with instance state).

const D = require('./dsl');
const O = require('./operand');

const RANGES = {
  SInt: [-128, 127], Int: [-32768, 32767], DInt: [-2147483648, 2147483647], USInt: [0, 255], UInt: [0, 65535], UDInt: [0, 4294967295],
  Byte: [0, 255], Word: [0, 65535], DWord: [0, 4294967295],
};
const INTEGER = new Set(Object.keys(RANGES));

function parseTime(s) {
  if (typeof s === 'number') return s;
  const m = /^(?:L?T#)?(-?[\d._]+(?:ms|us|ns|d|h|m|s)(?:[\d._]+(?:ms|us|ns|d|h|m|s))*)$/i.exec(String(s).trim());
  if (!m) return null;
  let total = 0; const re = /([\d._]+)(ms|us|ns|d|h|m|s)/gi; let t;
  const mult = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
  while ((t = re.exec(m[1]))) total += parseFloat(t[1].replace(/_/g, '')) * mult[t[2].toLowerCase()];
  return m[1].startsWith('-') ? -Math.abs(total) : total;
}
function litValue(op) {
  const v = op.value;
  if (op.type === 'Bool' || /^(TRUE|FALSE)$/i.test(v)) return /^TRUE$/i.test(v);
  if (op.type === 'Time' || op.type === 'LTime' || /^L?T#/i.test(v)) return parseTime(v) || 0;
  const h = /^(\d+)#([0-9A-Fa-f_]+)$/.exec(v);
  if (h) return parseInt(h[2].replace(/_/g, ''), parseInt(h[1], 10));
  const n = Number(v); return Number.isNaN(n) ? v : n;
}
const num = v => (typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'number' ? v : (Number(v) || 0)));

class Frame { constructor() { this.locals = new Map(); this.timers = new Map(); this.counters = new Map(); this.inst = new Map(); } }

class Simulator {
  constructor(program, opts) {
    opts = opts || {};
    this.program = program; this.entry = opts.entry; this.scanMs = opts.scanMs || 10;
    this.time = 0; this.scans = 0;
    this.globals = new Map(); this.gTimers = new Map(); this.gCounters = new Map(); this.gInst = new Map();
    this.root = new Frame(); this.warnings = new Set(); this.types = opts.types || (() => null);
    this.prev = new Map(); this.timeline = [];
  }
  // ---------------------------------------------------------------- state access
  mapOf(op, f) { return op.k === 'local' ? f.locals : this.globals; }
  storeOf(op, f) { return op.k === 'local' ? { timers: f.timers, counters: f.counters } : { timers: this.gTimers, counters: this.gCounters }; }
  read(op, f) {
    if (op.k === 'lit') return litValue(op);
    if (op.path && op.path.length >= 2) {
      const base = { k: op.k, path: op.path.slice(0, -1) }, field = op.path[op.path.length - 1];
      const st = this.storeOf(base, f), bk = O.text(base);
      const t = st.timers.get(bk);
      if (t) return ({ ET: t.et, Q: t.q, PT: t.pt, IN: t.inp })[field];
      const c = st.counters.get(bk);
      if (c) return ({ CV: c.cv, QU: c.qu, QD: c.qd, PV: c.pv })[field];
    }
    return this.mapOf(op, f).get(O.text(op));
  }
  write(op, v, f) {
    if (op.k === 'lit') return;
    const key = O.text(op);
    if (typeof v === 'number' && this.types(op) === 'Bool') v = v !== 0;
    this.mapOf(op, f).set(key, v);
  }
  setInput(key, value) {
    const op = D.parseOperandString(key);
    let v = value;
    if (typeof v === 'string') { const t = parseTime(v); v = /^L?T#/i.test(v) ? t : (/^(true|false)$/i.test(v) ? /^true$/i.test(v) : (Number.isNaN(Number(v)) ? v : Number(v))); }
    this.write(op, v, this.root);
  }
  get(key) { return this.read(D.parseOperandString(key), this.root); }

  // ---------------------------------------------------------------- conditions
  cond(n, rlo, f) {
    switch (n.t) {
      case 'true': return rlo;
      case 'contact': { const v = !!num(this.read(n.op, f)); return rlo && (n.neg ? !v : v); }
      case 'not': return !rlo;
      case 'rtrig': case 'ftrig': {
        const memKey = O.text(n.mem), map = this.mapOf(n.mem, f); const old = !!map.get(memKey);
        map.set(memKey, rlo);
        return n.t === 'rtrig' ? (rlo && !old) : (!rlo && old);
      }
      case 'cmp': {
        const a = num(this.read(n.a, f)), b = num(this.read(n.b, f));
        const r = ({ EQ: a === b, NE: a !== b, GT: a > b, LT: a < b, GE: a >= b, LE: a <= b })[n.rel];
        return rlo && r;
      }
      case 'and': { let r = rlo; for (const it of n.items) r = this.cond(it, r, f); return r; }
      case 'or': { let any = false; for (const it of n.items) any = this.cond(it, rlo, f) || any; return any; }
      default: this.warnings.add('cannot simulate condition ' + n.t); return false;
    }
  }
  paramBool(P, f) { return P.v === 'op' ? !!num(this.read(P.op, f)) : this.cond(P.cond, true, f); }
  paramVal(P, f) { return P.v === 'op' ? this.read(P.op, f) : this.cond(P.cond, true, f); }

  // ---------------------------------------------------------------- execution
  flow(fl, inSig, f) {
    const rlo = fl.cond ? this.cond(fl.cond, inSig, f) : inSig;
    for (const a of fl.then) this.action(a, rlo, f);
  }
  next(a, sig, f) { for (const fl of (a.next || [])) this.flow(fl, sig, f); }
  action(a, rlo, f) {
    switch (a.t) {
      case 'coil': {
        const k = a.kind;
        if (k === 'COIL') this.write(a.op, rlo, f);
        else if (k === 'NCOIL') this.write(a.op, !rlo, f);
        else if (k === 'SET') { if (rlo) this.write(a.op, true, f); }
        else if (k === 'RESET') { if (rlo) this.write(a.op, false, f); }
        return;
      }
      case 'move': {
        if (rlo) { const v = this.read(a.src, f); for (const d of a.dst) this.write(d, v === undefined ? 0 : v, f); }
        return this.next(a, rlo, f);
      }
      case 'math': {
        let eno = rlo;
        if (rlo) {
          const x = num(this.read(a.a, f)), y = num(this.read(a.b, f));
          const type = a.type || this.types(a.dst) || 'Int';
          let r;
          switch (a.fn) {
            case 'ADD': r = x + y; break; case 'SUB': r = x - y; break; case 'MUL': r = x * y; break;
            case 'DIV': if (y === 0) { eno = false; break; } r = INTEGER.has(type) ? Math.trunc(x / y) : x / y; break;
            case 'MOD': if (y === 0) { eno = false; break; } r = x % y; break;
            default:
          }
          if (eno) {
            const rg = RANGES[type];
            if (rg && (r < rg[0] || r > rg[1])) { eno = false; this.warnings.add('overflow in ' + a.fn + ' -> ' + O.text(a.dst) + ' (' + type + '); ENO=0, result not stored'); }
            else this.write(a.dst, r, f);
          }
        }
        return this.next(a, eno, f);
      }
      case 'box': return this.box(a, rlo, f);
      case 'call': return this.call(a, rlo, f);
      default: this.warnings.add('cannot simulate action ' + a.t);
    }
  }
  box(a, rlo, f) {
    const st = this.storeOf(a.inst, f), key = O.text(a.inst);
    const B = require('./catalog').BOXES[a.name];
    if (B.kind === 'timer') {
      let t = st.timers.get(key);
      if (!t) { t = { kind: a.name, inp: false, q: false, et: 0, pt: 0, start: 0, running: false, acc: 0 }; st.timers.set(key, t); }
      t.pt = a.params.PT ? num(this.paramVal(a.params.PT, f)) : 0;
      const now = this.time, IN = rlo;
      if (a.name === 'TON') {
        if (IN) { if (!t.inp) t.start = now; t.et = Math.min(now - t.start, t.pt); t.q = t.et >= t.pt; } else { t.et = 0; t.q = false; }
      } else if (a.name === 'TOF') {
        if (IN) { t.q = true; t.et = 0; t.running = false; }
        else {
          if (t.inp) { t.running = true; t.start = now; }
          if (t.running) { t.et = Math.min(now - t.start, t.pt); if (t.et >= t.pt) { t.q = false; t.running = false; } }
          else if (!t.q) t.et = 0;
        }
      } else if (a.name === 'TP') {
        if (IN && !t.inp && !t.running) { t.running = true; t.start = now; t.q = true; }
        if (t.running) { t.et = Math.min(now - t.start, t.pt); if (t.et >= t.pt) { t.running = false; t.q = false; } }
        else if (!IN) t.et = 0;
      } else { // TONR
        const R = a.params.R ? this.paramBool(a.params.R, f) : false;
        if (R) { t.acc = 0; t.et = 0; t.q = false; t.running = false; }
        else if (IN) { if (!t.inp) t.start = now; t.et = Math.min(t.acc + (now - t.start), t.pt); t.q = t.et >= t.pt; t.running = true; }
        else { if (t.running) { t.acc = t.et; t.running = false; } }
      }
      t.inp = IN;
      if (a.params.ET) this.write(a.params.ET.op, t.et, f);
      if (a.params.Q) this.write(a.params.Q.op, t.q, f);
      return this.next(a, t.q, f);
    }
    let c = st.counters.get(key);
    if (!c) { c = { kind: a.name, cv: 0, qu: false, qd: false, pv: 0, cuPrev: false, cdPrev: false }; st.counters.set(key, c); }
    c.pv = a.params.PV ? num(this.paramVal(a.params.PV, f)) : 0;
    const rg = RANGES[a.type || 'Int'] || RANGES.Int;
    const R = a.params.R ? this.paramBool(a.params.R, f) : false, LD = a.params.LD ? this.paramBool(a.params.LD, f) : false;
    let CU = false, CD = false;
    if (a.name === 'CTU' || a.name === 'CTUD') CU = rlo;
    if (a.name === 'CTD') CD = rlo;
    if (a.name === 'CTUD') CD = a.params.CD ? this.paramBool(a.params.CD, f) : false;
    const up = CU && !c.cuPrev, down = CD && !c.cdPrev;
    if (a.name === 'CTU') { if (R) c.cv = 0; else if (up && c.cv < rg[1]) c.cv++; }
    else if (a.name === 'CTD') { if (LD) c.cv = c.pv; else if (down && c.cv > rg[0]) c.cv--; }
    else { if (R) c.cv = 0; else if (LD) c.cv = c.pv; else { if (up && c.cv < rg[1]) c.cv++; if (down && c.cv > rg[0]) c.cv--; } }
    c.cuPrev = CU; c.cdPrev = CD; c.qu = c.cv >= c.pv; c.qd = c.cv <= 0;
    if (a.params.CV) this.write(a.params.CV.op, c.cv, f);
    if (a.params.QU) this.write(a.params.QU.op, c.qu, f);
    if (a.params.QD) this.write(a.params.QD.op, c.qd, f);
    return this.next(a, a.name === 'CTD' ? c.qd : c.qu, f);
  }
  call(a, rlo, f) {
    if (!rlo) return this.next(a, false, f);
    const callee = this.program.blocks[a.name];
    if (!callee) { this.warnings.add('CALL "' + a.name + '" not simulated (block not loaded); its outputs stay unchanged'); return this.next(a, true, f); }
    let child;
    if (callee.type === 'FB' && a.inst) {
      const st = a.inst.k === 'local' ? f.inst : this.gInst; const k = O.text(a.inst);
      if (!st.has(k)) st.set(k, new Frame());
      child = st.get(k);
    } else child = new Frame();
    for (const k of Object.keys(a.args)) {
      const P = a.args[k]; const isOutOnly = (callee.outputs || []).includes(k);
      if (isOutOnly) continue;
      child.locals.set('#' + k, this.paramVal(P, f));
    }
    this.runFlows(callee.flows, child);
    for (const k of Object.keys(a.args)) {
      const P = a.args[k];
      if (P.v === 'op' && ((callee.outputs || []).includes(k) || (callee.inouts || []).includes(k))) this.write(P.op, child.locals.get('#' + k), f);
    }
    return this.next(a, true, f);
  }
  runFlows(flows, f) { for (const fl of flows) this.flow(fl, true, f); }
  scan() {
    const entry = this.program.blocks[this.entry];
    if (!entry) throw new Error('entry block "' + this.entry + '" not found');
    this.runFlows(entry.flows, this.root);
    this.sample();
    this.time += this.scanMs; this.scans++;
  }
  watchKeys(extra) {
    const keys = new Set(extra || []);
    if (!extra || !extra.length) {
      for (const k of this.root.locals.keys()) keys.add(k);
      for (const k of this.globals.keys()) keys.add(k);
      for (const [k, t] of this.root.timers) { keys.add(k + '.Q'); void t; }
      for (const k of this.gTimers.keys()) keys.add(k + '.Q');
      for (const k of this.root.counters.keys()) { keys.add(k + '.CV'); keys.add(k + '.QU'); }
      for (const k of this.gCounters.keys()) { keys.add(k + '.CV'); keys.add(k + '.QU'); }
    }
    return keys;
  }
  sample() {
    for (const k of this.watchKeys(this.watch)) {
      let v; try { v = this.get(k); } catch (e) { continue; }
      const old = this.prev.get(k);
      const norm = x => (typeof x === 'boolean' ? (x ? 1 : 0) : x === undefined ? 0 : x);
      if (!this.prev.has(k) ? norm(v) !== 0 : norm(old) !== norm(v)) this.timeline.push({ t: this.time, key: k, from: norm(old), to: norm(v) });
      this.prev.set(k, v);
    }
  }
}

function buildProgram(blockReads, entry) {
  const blocks = {};
  for (const r of blockReads) {
    const flows = []; const skipped = [];
    for (const n of r.networks) { if (n.flows && n.dsl !== null) flows.push(...n.flows); else skipped.push(n.index); }
    blocks[r.block.name] = {
      name: r.block.name, type: r.block.type, flows, skipped,
      outputs: (r.interface.Output || []).map(m => m.name), inouts: (r.interface.InOut || []).map(m => m.name),
    };
  }
  return { blocks, entry };
}

function runScenario(program, scenario, types) {
  const sim = new Simulator(program, { entry: program.entry, scanMs: scenario.scanMs || 10, types });
  sim.watch = (scenario.watch || []).map(k => O.text(D.parseOperandString(k)));
  const results = { expects: [], ok: true, scans: 0 };
  for (const [k, v] of Object.entries(scenario.init || {})) sim.setInput(k, v);
  const runTime = ms => { const n = Math.max(1, Math.round(ms / sim.scanMs)); for (let i = 0; i < n; i++) sim.scan(); };
  let stepNo = 0;
  for (const st of (scenario.steps || [])) {
    stepNo++;
    if (st.set) for (const [k, v] of Object.entries(st.set)) sim.setInput(k, v);
    if (st.run !== undefined) {
      if (typeof st.run === 'number') for (let i = 0; i < st.run; i++) sim.scan();
      else { const ms = parseTime(st.run); if (ms === null) throw new Error('step ' + stepNo + ': bad run duration ' + st.run); runTime(ms); }
    } else if (st.set && !st.until) sim.scan();
    if (st.until) {
      const [k, v] = Object.entries(st.until)[0]; const limit = parseTime(st.timeout || '10s'); const t0 = sim.time;
      let hit = false;
      while (sim.time - t0 <= limit) { sim.scan(); const cur = sim.get(k); if (norm(cur) === norm(v)) { hit = true; break; } }
      results.expects.push({ step: stepNo, key: k, expected: v, actual: sim.get(k), ok: hit, t: sim.time, note: hit ? 'reached after ' + (sim.time - t0) + ' ms' : 'timeout after ' + limit + ' ms' });
      if (!hit) results.ok = false;
    }
    if (st.expect) {
      for (const [k, v] of Object.entries(st.expect)) {
        const actual = sim.get(k); const ok = norm(actual) === norm(typeof v === 'string' && /^L?T#/i.test(v) ? parseTime(v) : v);
        results.expects.push({ step: stepNo, key: k, expected: v, actual: actual === undefined ? 0 : actual, ok, t: sim.time });
        if (!ok) results.ok = false;
      }
    }
  }
  results.scans = sim.scans; results.time = sim.time;
  results.timeline = sim.timeline; results.warnings = [...sim.warnings]; results.skipped = Object.values(program.blocks).filter(b => b.skipped.length).map(b => b.name + ': NW' + b.skipped.join(',NW') + ' not Ladder (skipped)');
  results.final = {};
  for (const k of sim.watchKeys(sim.watch)) { const v = sim.get(k); results.final[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? 0 : v; }
  return results;
}
const norm = x => (typeof x === 'boolean' ? (x ? 1 : 0) : x === undefined ? 0 : (typeof x === 'string' && !Number.isNaN(Number(x)) ? Number(x) : x));

function formatResults(r) {
  const out = [];
  out.push((r.ok ? 'PASS' : 'FAIL') + ' - ' + r.scans + ' scans, simulated ' + r.time + ' ms');
  for (const e of r.expects) out.push((e.ok ? '  ok   ' : '  FAIL ') + 'step ' + e.step + ' @' + e.t + 'ms  ' + e.key + ' expected ' + e.expected + ', got ' + e.actual + (e.note ? ' (' + e.note + ')' : ''));
  if (r.timeline.length) {
    out.push('TIMELINE (changes):');
    const byT = new Map();
    for (const c of r.timeline) { if (!byT.has(c.t)) byT.set(c.t, []); byT.get(c.t).push(c.key + ' ' + c.from + '->' + c.to); }
    let n = 0;
    for (const [t, list] of byT) { if (n++ > 200) { out.push('  ... (' + (byT.size - 200) + ' more)'); break; } out.push('  ' + String(t).padStart(6) + ' ms  ' + list.join('   ')); }
  }
  out.push('FINAL: ' + Object.entries(r.final).map(([k, v]) => k + '=' + v).join('  '));
  for (const w of r.warnings) out.push('! ' + w);
  for (const w of r.skipped) out.push('! ' + w);
  return out.join('\n');
}

module.exports = { Simulator, buildProgram, runScenario, formatResults, parseTime };
