'use strict';
// Scan-cycle simulator for the Ladder AST (dry-run in RAM, no PLC needed).
// Supports IEC 61131-3 contacts/coils, OR/AND RLO, edge triggers, IEC timers/counters,
// dynamic array indexing, math/trig/analog scaling (NORM_X/SCALE_X/CONV/LIMIT),
// FC/FB calls, and S7-1200/1500 TO_PositioningAxis Motion Control (MC_Power/Reset/Home/Move*/Halt)!

const D = require('./dsl');
const O = require('./operand');
const C = require('./catalog');

const RANGES = {
  SInt: [-128, 127], Int: [-32768, 32767], DInt: [-2147483648, 2147483647], USInt: [0, 255], UInt: [0, 65535], UDInt: [0, 4294967295],
  Byte: [0, 255], Word: [0, 65535], DWord: [0, 4294967295],
};
const INTEGER = new Set(Object.keys(RANGES));

function roundToEven(value) {
  const lower = Math.floor(value);
  if (value - lower === 0.5) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

function parseTime(s) {
  if (typeof s === 'number') return s;
  const m = /^(?:(?:L?(?:TIME|T)|S5TIME|S5T)#)?(-?[\d._]+(?:ms|us|ns|d|h|m|s)(?:[\d._]+(?:ms|us|ns|d|h|m|s))*)$/i.exec(String(s).trim());
  if (!m) return null;
  let total = 0; const re = /([\d._]+)(ms|us|ns|d|h|m|s)/gi; let t;
  const mult = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
  while ((t = re.exec(m[1]))) {
    const digits = t[1].replace(/_/g, '');
    if (!digits) return null;
    total += Number(digits) * mult[t[2].toLowerCase()];
  }
  if (!Number.isFinite(total)) return null;
  return m[1].startsWith('-') ? -Math.abs(total) : total;
}
function litValue(op) {
  const v = op.value;
  if (op.type === 'Bool' || /^(TRUE|FALSE)$/i.test(v)) return /^(TRUE|1)$/i.test(v);
  if (op.type === 'Time' || op.type === 'LTime' || op.type === 'S5Time' || /^(?:L?(?:TIME|T)|S5TIME|S5T)#/i.test(v)) return parseTime(v) || 0;
  const h = /^(\d+)#([0-9A-Fa-f_]+)$/.exec(v);
  if (h) return parseInt(h[2].replace(/_/g, ''), parseInt(h[1], 10));
  const n = Number(v); return Number.isNaN(n) ? v : n;
}
function startValue(member) {
  const type = C.dataType(member.type) || member.type;
  const value = String(member.startValue);
  if (/^(W?String|W?Char)(?:\[|$)/i.test(type)) {
    const text = /^(?:[A-Z]+#)?(['"])(.*)\1$/is.exec(value);
    return text ? text[2].replaceAll(text[1] + text[1], text[1]) : value;
  }
  const literal = value.replace(/^(?:[A-Z][A-Z0-9_]*#)(?=-?\d)/i, '');
  return litValue(O.lit(type, /^(Time|LTime|S5Time)$/i.test(type) ? value : literal.replace(/(?<=\d)_(?=\d)/g, '')));
}
const num = v => (typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'number' ? v : (Number(v) || 0)));

class Frame { constructor() { this.locals = new Map(); this.timers = new Map(); this.counters = new Map(); this.inst = new Map(); } }

class Simulator {
  constructor(program, opts) {
    opts = opts || {};
    this.program = program; this.entry = opts.entry;
    this.scanMs = opts.scanMs === undefined ? 10 : opts.scanMs;
    if (!Number.isSafeInteger(this.scanMs) || this.scanMs <= 0) throw new Error('scanMs must be a positive integer.');
    this.time = 0; this.scans = 0;
    this.globals = new Map(); this.gTimers = new Map(); this.gCounters = new Map(); this.gInst = new Map();
    this.axes = new Map(); // axisKey -> { pos, vel, enabled, homed, error, activeMove }
    this.mcInst = new Map(); // mcInstKey -> { execPrev, busy, done, aborted, error, target, speed }
    this.root = this.createFrame(this.program.blocks[this.entry]);
    this.warnings = new Set(); this.types = opts.types || (() => null);
    this.operands = new Map();
    this.bindings = new WeakMap();
    this.prev = new Map(); this.timeline = [];
  }
  createFrame(block) {
    const frame = new Frame();
    for (const member of (block?.initialMembers || [])) frame.locals.set(O.text(O.local(member.name.split('.'))), startValue(member));
    return frame;
  }

  // Resolve dynamic array indices e.g. #Arr[#i] -> #Arr[2]
  resolveOperand(op, f) {
    if (!op.idx || !Object.keys(op.idx).length) return op;
    const resolvedIdx = {};
    for (const [compIdx, dims] of Object.entries(op.idx)) {
      resolvedIdx[compIdx] = dims.map(d => O.lit('DInt', String(Math.trunc(num(this.read(d, f))))));
    }
    return op.k === 'local' ? O.local(op.path, resolvedIdx, op.slice) : O.global(op.path, resolvedIdx, op.slice);
  }
  bindOperand(op, resolved) {
    const symbol = resolved.k === 'global' ? this.program.resolveGlobal?.(resolved) : null;
    const binding = {
      key: O.text(symbol?.op || resolved),
      defaultValue: symbol?.start === undefined ? undefined : startValue({ type: symbol.type, startValue: symbol.start }),
    };
    if (op.path?.length >= 2 && !op.idx) {
      binding.instanceKey = O.text({ k: op.k, path: op.path.slice(0, -1) });
      binding.field = op.path.at(-1);
    }
    return binding;
  }

  operandBinding(op, frame) {
    const resolved = this.resolveOperand(op, frame);
    // An indexed operand can point at another address after every write or scan.
    if (resolved !== op) return this.bindOperand(op, resolved);
    let binding = this.bindings.get(op);
    if (!binding) {
      binding = this.bindOperand(op, op);
      this.bindings.set(op, binding);
    }
    return binding;
  }

  resolveKey(op, frame) {
    return this.operandBinding(op, frame).key;
  }

  getAxis(axisName) {
    if (!this.axes.has(axisName)) {
      this.axes.set(axisName, { pos: 0.0, vel: 0.0, enabled: false, homed: false, error: false, owner: null, target: 0.0, speed: 0.0 });
    }
    return this.axes.get(axisName);
  }
  syncAxisToGlobals(axisName, ax) {
    const q = '"' + axisName + '"';
    this.globals.set(q + '.ActualPosition', ax.pos);
    this.globals.set(q + '.Position', ax.pos);
    this.globals.set(q + '.ActualVelocity', ax.vel);
    this.globals.set(q + '.Velocity', ax.vel);
    this.globals.set(q + '.StatusBits.Enable', ax.enabled);
    this.globals.set(q + '.StatusBits.HomingDone', ax.homed);
    this.globals.set(q + '.StatusBits.Error', ax.error);
    this.globals.set(q + '.StatusBits.Standstill', Math.abs(ax.vel) < 1e-9);
  }

  mapOf(op, f) { return op.k === 'local' ? f.locals : this.globals; }
  storeOf(op, f) { return op.k === 'local' ? { timers: f.timers, counters: f.counters } : { timers: this.gTimers, counters: this.gCounters }; }
  read(op, f) {
    if (op.k === 'lit') return litValue(op);
    if (op.slice) {
      const s = O.parseSlice(op.slice);
      if (s) {
        const base = op.k === 'local' ? O.local(op.path, op.idx) : O.global(op.path, op.idx);
        const raw = (Math.trunc(num(this.read(base, f))) >>> 0);
        if (s.kind === 'X') return ((raw >>> s.index) & 1) !== 0;
        if (s.kind === 'B') return (raw >>> (s.index * 8)) & 0xFF;
        if (s.kind === 'W') return (raw >>> (s.index * 16)) & 0xFFFF;
        if (s.kind === 'D') return s.index === 0 ? raw : 0;
      }
    }
    const binding = this.operandBinding(op, f);
    if (binding.instanceKey !== undefined) {
      const key = binding.instanceKey;
      const field = binding.field;
      const timers = op.k === 'local' ? f.timers : this.gTimers;
      const t = timers.get(key);
      if (t) return ({ ET: t.et, Q: t.q, PT: t.pt, IN: t.inp })[field];
      const counters = op.k === 'local' ? f.counters : this.gCounters;
      const c = counters.get(key);
      if (c) return ({ CV: c.cv, QU: c.qu, QD: c.qd, PV: c.pv })[field];
      const mc = this.mcInst.get(key);
      if (mc && field in mc.pins) return mc.pins[field];
    }
    const store = this.mapOf(op, f);
    if (binding.defaultValue === undefined) return store.get(binding.key);
    return store.has(binding.key) ? store.get(binding.key) : binding.defaultValue;
  }
  write(op, v, f) {
    if (op.k === 'lit') return;
    if (op.slice) {
      const s = O.parseSlice(op.slice);
      if (s) {
        const base = op.k === 'local' ? O.local(op.path, op.idx) : O.global(op.path, op.idx);
        let cur = (Math.trunc(num(this.read(base, f))) >>> 0);
        const iv = typeof v === 'boolean' ? (v ? 1 : 0) : (Math.trunc(num(v)) >>> 0);
        if (s.kind === 'X') cur = iv ? (cur | (1 << s.index)) >>> 0 : (cur & ~(1 << s.index)) >>> 0;
        else if (s.kind === 'B') { const sh = s.index * 8; cur = ((cur & ~(0xFF << sh)) | ((iv & 0xFF) << sh)) >>> 0; }
        else if (s.kind === 'W') { const sh = s.index * 16; cur = ((cur & ~(0xFFFF << sh)) | ((iv & 0xFFFF) << sh)) >>> 0; }
        else if (s.kind === 'D' && s.index === 0) cur = iv >>> 0;
        this.write(base, cur, f);
        return;
      }
    }
    const key = this.resolveKey(op, f);
    if (typeof v === 'number' && this.types(op) === 'Bool') v = v !== 0;
    this.mapOf(op, f).set(key, v);
  }
  setInput(key, value) {
    const op = D.parseOperandString(key);
    let v = value;
    if (typeof v === 'string') { const t = parseTime(v); v = /^(?:L?(?:TIME|T)|S5TIME|S5T)#/i.test(v) ? t : (/^(true|false)$/i.test(v) ? /^true$/i.test(v) : (Number.isNaN(Number(v)) ? v : Number(v))); }
    this.write(op, v, this.root);
  }
  get(key) {
    let op = this.operands.get(key);
    if (!op) {
      op = D.parseOperandString(key);
      this.operands.set(key, op);
    }
    return this.read(op, this.root);
  }

  // ---------------------------------------------------------------- conditions
  cond(n, rlo, f) {
    switch (n.t) {
      case 'true': return rlo;
      case 'contact': { const v = !!num(this.read(n.op, f)); return rlo && (n.neg ? !v : v); }
      case 'not': return !rlo;
      case 'rtrig': case 'ftrig': {
        const memKey = this.resolveKey(n.mem, f), map = this.mapOf(n.mem, f); const old = !!map.get(memKey);
        map.set(memKey, rlo);
        return n.t === 'rtrig' ? (rlo && !old) : (!rlo && old);
      }
      case 'edgeContact': {
        const on = !!num(this.read(n.op, f)), previous = !!num(this.read(n.mem, f));
        this.write(n.mem, on, f);
        return rlo && (n.rising ? on && !previous : !on && previous);
      }
      case 'range': {
        const [min, value, max] = n.inputs.map(op => num(this.read(op, f)));
        return rlo && (n.fn === 'IN_RANGE' ? min <= value && value <= max : value < min || value > max);
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
  storeNumber(dst, r, type, fnLabel, f) {
    if (!Number.isFinite(r)) return false;
    if (INTEGER.has(type)) r = Math.trunc(r);
    const rg = RANGES[type];
    if (rg && (r < rg[0] || r > rg[1])) {
      this.warnings.add('overflow in ' + fnLabel + ' -> ' + O.text(dst) + ' (' + type + '); ENO=0, result not stored');
      return false;
    }
    this.write(dst, r, f);
    return true;
  }

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
      case 'select': {
        if (rlo) {
          const value = this.read(a.inputs[this.paramBool(a.gate, f) ? 1 : 0], f);
          this.write(a.dst, value === undefined ? 0 : value, f);
        }
        return this.next(a, rlo, f);
      }
      case 'latch': {
        const secondary = a.secondary ? this.paramBool(a.secondary, f) : false;
        if (secondary || rlo) this.write(a.op, a.fn === 'SR' ? !secondary : secondary, f);
        const q = !!num(this.read(a.op, f));
        if (a.out) this.write(a.out, q, f);
        return this.next(a, q, f);
      }
      case 'math': {
        let eno = rlo;
        if (rlo) {
          const values = C.mathInputs(a).map(op => num(this.read(op, f)));
          const [x, y] = values;
          const isBit = a.fn === 'W_AND' || a.fn === 'W_OR' || a.fn === 'W_XOR';
          const type = a.type || this.types(a.dst) || (isBit ? 'Word' : (values.every(Number.isInteger) ? 'Int' : 'Real'));
          const bitMask = type === 'Byte' ? 0xFF : (type === 'Word' ? 0xFFFF : 0xFFFFFFFF);
          let r;
          switch (a.fn) {
            case 'ADD': r = values.reduce((sum, v) => sum + v); break;
            case 'SUB': r = x - y; break;
            case 'MUL': r = values.reduce((product, v) => product * v); break;
            case 'DIV': if (y === 0) { eno = false; break; } r = INTEGER.has(type) ? Math.trunc(x / y) : x / y; break;
            case 'MOD': if (y === 0) { eno = false; break; } r = x % y; break;
            case 'MIN': r = values.reduce((min, v) => Math.min(min, v)); break;
            case 'MAX': r = values.reduce((max, v) => Math.max(max, v)); break;
            case 'W_AND': r = (values.reduce((acc, v) => (acc & (Math.trunc(v) >>> 0)) >>> 0, bitMask) & bitMask) >>> 0; break;
            case 'W_OR': r = (values.reduce((acc, v) => (acc | (Math.trunc(v) >>> 0)) >>> 0, 0) & bitMask) >>> 0; break;
            case 'W_XOR': r = (values.reduce((acc, v) => (acc ^ (Math.trunc(v) >>> 0)) >>> 0, 0) & bitMask) >>> 0; break;
            default:
          }
          if (eno) eno = this.storeNumber(a.dst, r, type, a.fn, f);
        }
        return this.next(a, eno, f);
      }
      case 'shift': {
        let eno = rlo;
        if (rlo) {
          const x = Math.trunc(num(this.read(a.src, f))) >>> 0;
          const n = Math.max(0, Math.trunc(num(this.read(a.count, f))));
          const type = a.type || this.types(a.dst) || 'Word';
          const width = (type === 'Byte' || type === 'USInt' || type === 'SInt') ? 8 : ((type === 'Word' || type === 'UInt' || type === 'Int') ? 16 : 32);
          const mask = width === 8 ? 0xFF : (width === 16 ? 0xFFFF : 0xFFFFFFFF);
          const r = n >= width ? 0 : (a.fn === 'SHL' ? (((x << n) & mask) >>> 0) : (((x & mask) >>> n) >>> 0));
          eno = this.storeNumber(a.dst, r, type, a.fn, f);
        }
        return this.next(a, eno, f);
      }
      case 'unary': {
        let eno = rlo;
        if (rlo) {
          const x = num(this.read(a.src, f));
          const type = a.type || this.types(a.dst) || 'Real';
          let r;
          switch (a.fn) {
            case 'SIN': r = Math.sin(x); break;
            case 'COS': r = Math.cos(x); break;
            case 'TAN': r = Math.tan(x); break;
            case 'ASIN': if (x < -1 || x > 1) eno = false; else r = Math.asin(x); break;
            case 'ACOS': if (x < -1 || x > 1) eno = false; else r = Math.acos(x); break;
            case 'ATAN': r = Math.atan(x); break;
            case 'SQRT': if (x < 0) eno = false; else r = Math.sqrt(x); break;
            case 'SQR': r = x * x; break;
            case 'ABS': r = Math.abs(x); break;
            case 'EXP': r = Math.exp(x); break;
            case 'LN': if (x <= 0) eno = false; else r = Math.log(x); break;
            default: eno = false;
          }
          if (eno) eno = this.storeNumber(a.dst, r, type, a.fn, f);
        }
        return this.next(a, eno, f);
      }
      case 'conv': {
        let eno = rlo;
        if (rlo) {
          const info = C.CONV_OPS[a.fn];
          const destType = a.destType || this.types(a.out) || (info && info.dualType ? info.defDest : (a.srcType || (info && info.defSrc) || 'Real'));
          let r;
          if (a.fn === 'CONV') {
            r = num(this.read(a.ins[0], f));
            if (INTEGER.has(destType)) r = Math.round(r);
          } else if (a.fn === 'TRUNC') {
            r = Math.trunc(num(this.read(a.ins[0], f)));
          } else if (a.fn === 'ROUND') {
            r = roundToEven(num(this.read(a.ins[0], f)));
          } else if (a.fn === 'CEIL') {
            r = Math.ceil(num(this.read(a.ins[0], f)));
          } else if (a.fn === 'FLOOR') {
            r = Math.floor(num(this.read(a.ins[0], f)));
          } else if (a.fn === 'NORM_X') {
            const mn = num(this.read(a.ins[0], f)), val = num(this.read(a.ins[1], f)), mx = num(this.read(a.ins[2], f));
            if (mx === mn) eno = false; else r = (val - mn) / (mx - mn);
          } else if (a.fn === 'SCALE_X') {
            const mn = num(this.read(a.ins[0], f)), val = num(this.read(a.ins[1], f)), mx = num(this.read(a.ins[2], f));
            r = val * (mx - mn) + mn;
            if (INTEGER.has(destType)) r = Math.round(r);
          } else if (a.fn === 'LIMIT') {
            const mn = num(this.read(a.ins[0], f)), val = num(this.read(a.ins[1], f)), mx = num(this.read(a.ins[2], f));
            if (mn > mx) eno = false; else r = Math.min(Math.max(val, mn), mx);
          }
          if (eno) eno = this.storeNumber(a.out, r, destType, a.fn, f);
        }
        return this.next(a, eno, f);
      }
      case 'box': return this.box(a, rlo, f);
      case 'call': return this.call(a, rlo, f);
      default: this.warnings.add('cannot simulate action ' + a.t);
    }
  }
  motionBox(a, rlo, f, B) {
    const instKey = this.resolveKey(a.inst, f);
    let mc = this.mcInst.get(instKey);
    if (!mc) {
      mc = { execPrev: false, pins: { Status: false, Done: false, Busy: false, Error: false, CommandAborted: false, InVelocity: false, ErrorID: 0, ErrorInfo: 0 } };
      this.mcInst.set(instKey, mc);
    }
    if (!rlo) return this.next(a, false, f);
    const axisOp = a.params.Axis && a.params.Axis.op;
    const axisName = axisOp ? axisOp.path[0] : 'Axis';
    const ax = this.getAxis(axisName);
    const dtSec = this.scanMs / 1000.0;

    if (a.name === 'MC_POWER') {
      const en = a.params.Enable ? this.paramBool(a.params.Enable, f) : false;
      ax.enabled = en && !ax.error;
      if (!ax.enabled && ax.owner) { ax.vel = 0; ax.owner = null; }
      mc.pins.Status = ax.enabled;
      mc.pins.Busy = en;
      mc.pins.Error = ax.error;
    } else if (a.name === 'MC_RESET') {
      const ex = a.params.Execute ? this.paramBool(a.params.Execute, f) : false;
      if (ex && !mc.execPrev) { ax.error = false; mc.pins.Done = true; mc.pins.Error = false; }
      else if (!ex) { mc.pins.Done = false; mc.pins.Busy = false; }
      mc.execPrev = ex;
    } else if (a.name === 'MC_HOME') {
      const ex = a.params.Execute ? this.paramBool(a.params.Execute, f) : false;
      const pos = a.params.Position ? num(this.paramVal(a.params.Position, f)) : 0.0;
      if (ex && !mc.execPrev) {
        if (!ax.enabled) { mc.pins.Error = true; mc.pins.Done = false; }
        else { ax.pos = pos; ax.vel = 0; ax.homed = true; ax.owner = null; mc.pins.Done = true; mc.pins.Error = false; }
      } else if (!ex) { mc.pins.Done = false; mc.pins.Error = false; }
      mc.execPrev = ex;
    } else if (a.name === 'MC_MOVEABSOLUTE' || a.name === 'MC_MOVERELATIVE') {
      const ex = a.params.Execute ? this.paramBool(a.params.Execute, f) : false;
      const vel = Math.abs(a.params.Velocity ? num(this.paramVal(a.params.Velocity, f)) : 10.0) || 10.0;
      if (ex && !mc.execPrev) {
        if (!ax.enabled || (a.name === 'MC_MOVEABSOLUTE' && !ax.homed)) {
          mc.pins.Error = true; mc.pins.Busy = false; mc.pins.Done = false;
        } else {
          const distOrPos = a.name === 'MC_MOVEABSOLUTE'
            ? (a.params.Position ? num(this.paramVal(a.params.Position, f)) : 0.0)
            : ax.pos + (a.params.Distance ? num(this.paramVal(a.params.Distance, f)) : 0.0);
          ax.owner = instKey; ax.target = distOrPos; ax.speed = vel;
          mc.pins.Busy = true; mc.pins.Done = false; mc.pins.CommandAborted = false; mc.pins.Error = false;
        }
      }
      if (mc.pins.Busy) {
        if (ax.owner !== instKey || !ax.enabled) {
          mc.pins.Busy = false; mc.pins.CommandAborted = true;
        } else {
          const diff = ax.target - ax.pos;
          const step = ax.speed * dtSec;
          if (Math.abs(diff) <= step + 1e-9) {
            ax.pos = ax.target; ax.vel = 0; ax.owner = null;
            mc.pins.Busy = false; mc.pins.Done = true;
          } else {
            ax.pos += Math.sign(diff) * step;
            ax.vel = Math.sign(diff) * ax.speed;
          }
        }
      } else if (!ex) {
        mc.pins.Done = false; mc.pins.CommandAborted = false; mc.pins.Error = false;
      }
      mc.execPrev = ex;
    } else if (a.name === 'MC_MOVEVELOCITY' || a.name === 'MC_MOVEJOG') {
      const vel = a.params.Velocity ? num(this.paramVal(a.params.Velocity, f)) : 10.0;
      let active = false, dir = 1;
      if (a.name === 'MC_MOVEJOG') {
        const jf = a.params.JogForward ? this.paramBool(a.params.JogForward, f) : false;
        const jb = a.params.JogBackward ? this.paramBool(a.params.JogBackward, f) : false;
        if (jf && !jb) { active = true; dir = 1; } else if (jb && !jf) { active = true; dir = -1; }
      } else {
        active = a.params.Execute ? this.paramBool(a.params.Execute, f) : false;
      }
      if (active && ax.enabled) {
        ax.owner = instKey; ax.vel = dir * vel; ax.pos += ax.vel * dtSec;
        mc.pins.Busy = true; mc.pins.InVelocity = true;
      } else {
        if (ax.owner === instKey) { ax.vel = 0; ax.owner = null; }
        mc.pins.Busy = false; mc.pins.InVelocity = false;
      }
    } else if (a.name === 'MC_HALT') {
      const ex = a.params.Execute ? this.paramBool(a.params.Execute, f) : false;
      if (ex && !mc.execPrev) { ax.vel = 0; ax.owner = null; mc.pins.Done = true; }
      else if (!ex) mc.pins.Done = false;
      mc.execPrev = ex;
    }

    this.syncAxisToGlobals(axisName, ax);
    for (const k of [...B.valOut, ...B.boolOut]) {
      if (a.params[k] && a.params[k].v === 'op') this.write(a.params[k].op, mc.pins[k], f);
    }
    return this.next(a, true, f);
  }

  box(a, rlo, f) {
    const B = C.BOXES[a.name];
    if (B.kind === 'motion') return this.motionBox(a, rlo, f, B);
    const st = this.storeOf(a.inst, f), key = this.resolveKey(a.inst, f);
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
    if (!callee) throw new Error('missing CALL target ' + a.name);
    let child;
    if (callee.type === 'FB' && a.inst) {
      const st = a.inst.k === 'local' ? f.inst : this.gInst; const k = this.resolveKey(a.inst, f);
      if (!st.has(k)) st.set(k, this.createFrame(callee));
      child = st.get(k);
    } else child = this.createFrame(callee);
    this.resetTemps(callee, child);
    for (const k of Object.keys(a.args)) {
      const key = k.toLowerCase();
      if ((callee.outputs || []).some(pin => pin.toLowerCase() === key)) continue;
      const pin = [...(callee.inputs || []), ...(callee.inouts || [])].find(name => name.toLowerCase() === key) || k;
      child.locals.set(O.text(O.local([pin])), this.paramVal(a.args[k], f));
    }
    this.runFlows(callee.flows, child);
    for (const k of Object.keys(a.args)) {
      const P = a.args[k];
      const pin = [...(callee.outputs || []), ...(callee.inouts || [])].find(name => name.toLowerCase() === k.toLowerCase());
      if (P.v === 'op' && pin) this.write(P.op, child.locals.get(O.text(O.local([pin]))), f);
    }
    return this.next(a, true, f);
  }
  runFlows(flows, f) { for (const fl of flows) this.flow(fl, true, f); }
  resetTemps(block, frame) {
    for (const m of (block.temps || [])) frame.locals.set('#' + m.name, /^Bool$/i.test(m.type) ? false : 0);
  }
  scan() {
    const entry = this.program.blocks[this.entry];
    if (!entry) throw new Error('entry block "' + this.entry + '" not found');
    this.resetTemps(entry, this.root);
    if (entry.type === 'OB' && entry.inputs.includes('Initial_Call')) this.root.locals.set('#Initial_Call', this.scans === 0);
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
    for (const k of (this.watch && this.watch.length ? this.watch : this.watchKeys())) {
      let v; try { v = this.get(k); } catch (e) { continue; }
      const previous = this.prev.get(k);
      const old = previous === undefined ? 0 : previous;
      const value = traceValue(v);
      if (old !== value) this.timeline.push({ t: this.time, key: k, from: old, to: value });
      this.prev.set(k, value);
    }
  }
}

function* calls(flows) {
  for (const flow of flows) for (const action of flow.then) {
    if (action.t === 'call') yield action;
    if (action.next) yield* calls(action.next);
  }
}

function buildProgram(blockReads, entry) {
  const names = new Set(blockReads.map(r => r.block.name));
  const blocks = Object.create(null);
  for (const r of blockReads) {
    const flows = []; const skipped = [];
    for (const n of r.networks) {
      if (!n.flows || n.dsl === null) { skipped.push(n.index); continue; }
      for (const call of calls(n.flows)) {
        if (!names.has(call.name)) throw new Error(r.block.name + ' NW' + n.index + ': missing CALL target ' + call.name);
      }
      flows.push(...n.flows);
    }
    blocks[r.block.name] = {
      name: r.block.name, type: r.block.type, flows, skipped,
      outputs: [...(r.interface.Output || []), ...(r.interface.Return || [])].map(m => m.name),
      inouts: (r.interface.InOut || []).map(m => m.name),
      inputs: (r.interface.Input || []).map(m => m.name),
      temps: (r.interface.Temp || []).map(m => ({ name: m.name, type: m.type })),
      initialMembers: [...(r.interface.Static || []), ...(r.interface.Constant || [])].filter(m => m.startValue !== undefined),
    };
  }
  return { blocks, entry };
}

function approxEq(a, b, tol) {
  if (typeof a === 'number' && typeof b === 'number' && (!Number.isInteger(a) || !Number.isInteger(b))) {
    return Math.abs(a - b) <= (tol === undefined ? 1e-3 : tol);
  }
  return a === b;
}

function expectedValue(value) {
  return norm(typeof value === 'string' && /^(?:L?(?:TIME|T)|S5TIME|S5T)#/i.test(value) ? parseTime(value) : value);
}

function runScenario(program, scenario, types, { traceFromInit = false } = {}) {
  const sim = new Simulator(program, { entry: program.entry, scanMs: scenario.scanMs, types });
  sim.watch = (scenario.watch || []).map(k => O.text(D.parseOperandString(k)));
  const results = { expects: [], ok: true, scans: 0 };
  for (const [k, v] of Object.entries(scenario.init || {})) sim.setInput(k, v);
  if (traceFromInit) {
    results.scanMs = sim.scanMs;
    results.initial = Object.fromEntries(sim.watch.map(key => [key, traceValue(sim.get(key))]));
    sim.prev = new Map(Object.entries(results.initial));
  }
  const runTime = ms => { const n = ms === 0 ? 0 : Math.max(1, Math.round(ms / sim.scanMs)); for (let i = 0; i < n; i++) sim.scan(); };
  let stepNo = 0;
  for (const st of (scenario.steps || [])) {
    stepNo++;
    if (st.set) for (const [k, v] of Object.entries(st.set)) sim.setInput(k, v);
    if (st.run !== undefined) {
      if (typeof st.run === 'number') for (let i = 0; i < st.run; i++) sim.scan();
      else { const ms = parseTime(st.run); if (ms === null) throw new Error('step ' + stepNo + ': bad run duration ' + st.run); runTime(ms); }
    } else if (st.set && !st.until) sim.scan();
    if (st.until !== undefined) {
      if (!st.until || typeof st.until !== 'object' || Array.isArray(st.until) || Object.keys(st.until).length !== 1) {
        throw new Error('step ' + stepNo + ': until requires exactly one variable and target value.');
      }
      const [k, v] = Object.entries(st.until)[0];
      const limit = parseTime(st.timeout === undefined ? '10s' : st.timeout);
      if (!Number.isFinite(limit) || limit < 0) throw new Error('step ' + stepNo + ': invalid timeout ' + st.timeout);
      const t0 = sim.time;
      const maxScans = Math.floor(limit / sim.scanMs);
      const target = expectedValue(v);
      const matches = () => approxEq(norm(sim.get(k)), target, st.tolerance);
      let hit = matches();
      for (let i = 0; !hit && i < maxScans; i++) {
        sim.scan();
        hit = matches();
      }
      results.expects.push({ step: stepNo, key: k, expected: v, actual: sim.get(k), ok: hit, t: sim.time, note: hit ? 'reached after ' + (sim.time - t0) + ' ms' : 'timeout after ' + limit + ' ms' });
      if (!hit) results.ok = false;
    }
    if (st.expect) {
      for (const [k, v] of Object.entries(st.expect)) {
        const actual = sim.get(k);
        const ok = approxEq(norm(actual), expectedValue(v), st.tolerance);
        results.expects.push({ step: stepNo, key: k, expected: v, actual: actual === undefined ? 0 : actual, ok, t: sim.time });
        if (!ok) results.ok = false;
      }
    }
  }
  results.scans = sim.scans; results.time = sim.time;
  results.timeline = sim.timeline; results.warnings = [...sim.warnings]; results.skipped = Object.values(program.blocks).filter(b => b.skipped.length).map(b => b.name + ': NW' + b.skipped.join(',NW') + ' not Ladder (skipped)');
  results.final = {};
  for (const k of sim.watchKeys(sim.watch)) { const v = sim.get(k); results.final[k] = traceValue(v); }
  return results;
}
const traceValue = value => typeof value === 'boolean' ? Number(value) : value === undefined ? 0 : value;
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

module.exports = { Simulator, calls, buildProgram, runScenario, formatResults, parseTime };
