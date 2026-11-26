'use strict';
// Ladder AST -> SimaticML FlgNet XML (network source for TIA Portal V20 LAD blocks).
// UIds, Parts, Access nodes and Wires are generated deterministically; OR branches emit <Part Name="O">
// as required by TIA Portal V20 SimaticML.

const { E, ser } = require('./xml');
const C = require('./catalog');
const O = require('./operand');

const FLG_NS = 'http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v5';
class GenError extends Error { constructor(msg, code) { super(msg); this.name = 'GenError'; this.code = code || 'E_GEN'; } }

function canonType(t) {
  return C.dataType(t) || t;
}

class Gen {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.uid = 20;
    this.items = [];
    this.order = [];
    this.info = new Map();
    this.par = new Map();
    this.needs = [];
    this.decls = [];
    this.warnings = [];
    this.dbInstances = [];
  }
  nid() { return ++this.uid; }
  find(k) { let r = k; while (this.par.get(r) !== r) r = this.par.get(r); let c = k; while (this.par.get(c) !== r) { const n = this.par.get(c); this.par.set(c, r); c = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.par.set(rb, ra); }
  reg(key, info) { if (!this.info.has(key)) { this.info.set(key, info); this.order.push(key); this.par.set(key, key); } return key; }
  PWR() { return this.reg('PWR', { role: 'src', kind: 'pwr', rank: 0 }); }
  pin(uid, pin, role) { return this.reg('P:' + uid + ':' + pin, { role, kind: 'name', uid, pin, rank: 2 }); }
  ident(uid, role) { return this.reg('I:' + uid, { role, kind: 'ident', uid, rank: 1 }); }
  openPin(role) { const uid = this.nid(); return this.reg('O:' + uid, { role, kind: 'open', uid, rank: 3 }); }
  connect(srcs, dst) { for (const s of srcs) this.union(s, dst); }
  need(key, label) { this.needs.push({ key, label }); }
  decl(section, name, type) {
    if (!this.decls.find(d => d.name === name && d.section === section)) this.decls.push({ section, name, type });
  }

  // ---------------------------------------------------------------- operands
  typeOf(op) {
    if (!op) return null;
    if (op.slice) return O.sliceType(op.slice);
    if (op.k === 'lit') return op.type && op.type !== 'auto' ? canonType(op.type) : null;
    if (op.k === 'abs') return canonType(op.type);
    const r = this.ctx.resolveType ? this.ctx.resolveType(op) : null;
    return r ? canonType(r) : null;
  }
  inferType(ops, explicit, where, fallback) {
    if (explicit) return canonType(explicit);
    for (const o of ops) { const t = this.typeOf(o); if (t) return t; }
    const lits = ops.filter(o => o && o.k === 'lit' && o.type === 'auto');
    if (lits.length) return lits.some(l => l.real) ? 'Real' : 'Int';
    if (fallback) return canonType(fallback);
    throw new GenError('Cannot infer the data type for ' + where + ' (' + ops.map(O.text).join(', ') + '). Add the type as the last argument, e.g. ' + where + '(..., Int), or declare the variable in the block interface / tag table.', 'E_TYPE');
  }
  componentNodes(op) {
    return op.path.map((n, i) => {
      const attrs = { Name: n };
      const dims = op.idx && op.idx[i];
      if (dims && dims.length) attrs.AccessModifier = 'Array';
      if (op.slice && i === op.path.length - 1) attrs.SliceAccessModifier = op.slice.toLowerCase();
      if (!dims || !dims.length) return E('Component', attrs);
      return E('Component', attrs, dims.map(d => this.accessNode(d, undefined, 'DInt')));
    });
  }
  accessNode(op, uid, hint) {
    const attrs = uid !== undefined ? { Scope: '', UId: uid } : { Scope: '' };
    switch (op.k) {
      case 'local':
      case 'global':
        if (op.k === 'local' && this.ctx.isLocalConstant?.(op)) {
          attrs.Scope = 'LocalConstant';
          return E('Access', attrs, E('Constant', { Name: op.path.join('.') }));
        }
        attrs.Scope = op.k === 'local' ? 'LocalVariable' : 'GlobalVariable';
        // The FC return pin is Ret_Val at CALL sites and the FC name inside its body.
        if (op.k === 'local' && this.ctx.fcReturn && op.path.length === 1 && /^Ret_Val$/i.test(op.path[0])) {
          op = { ...op, path: [this.ctx.fcReturn.blockName] };
        }
        return E('Access', attrs, E('Symbol', {}, this.componentNodes(op)));
      case 'abs':
        attrs.Scope = 'Address';
        return E('Access', attrs, E('Address', { Area: op.area, Type: op.type, BitOffset: op.bitOffset }));
      case 'lit': {
        let type = op.type;
        if (type === 'auto') {
          if (/^\d+#/.test(op.value)) type = hint && /Word|Byte|Int/.test(hint) ? hint : 'Word';
          else type = hint || (op.real ? 'Real' : 'Int');
        }
        const ctype = canonType(type);
        if (ctype === 'Time' || ctype === 'LTime' || ctype === 'S5Time' || /^(?:L?TIME|LT|T|S5TIME|S5T)#/i.test(op.value)) {
          attrs.Scope = 'TypedConstant';
          return E('Access', attrs, E('Constant', {}, [E('ConstantValue', {}, op.value)]));
        }
        attrs.Scope = 'LiteralConstant';
        const value = ctype === 'Bool' && /^[01]$/.test(op.value) ? (op.value === '1' ? 'TRUE' : 'FALSE') : op.value;
        return E('Access', attrs, E('Constant', {}, [E('ConstantType', {}, ctype), E('ConstantValue', {}, value)]));
      }
      default: throw new GenError('unsupported operand ' + JSON.stringify(op));
    }
  }
  bind(op, pinKey, mode, hint) {
    const uid = this.nid();
    this.items.push(this.accessNode(op, uid, hint));
    this.union(this.ident(uid, mode === 'write' ? 'dst' : 'src'), pinKey);
  }
  instanceNode(op) {
    return E('Instance', { Scope: op.k === 'local' ? 'LocalVariable' : 'GlobalVariable', UId: this.nid() },
      this.componentNodes(op));
  }
  partNode(name, uid, o) {
    o = o || {};
    const content = [];
    if (o.instance) content.push(o.instance);
    for (const t of (o.templates || [])) content.push(E('TemplateValue', { Name: t.name, Type: t.type }, String(t.value)));
    for (const n of (o.negated || [])) content.push(E('Negated', { Name: n }));
    return E('Part', { Name: name, Version: o.version, UId: uid, DisabledENO: o.disabledEno }, content);
  }
  addPart(name, o) { const uid = this.nid(); this.items.push(this.partNode(name, uid, o)); return uid; }

  // ---------------------------------------------------------------- conditions
  mergeOr(outs) {
    if (outs.length <= 1) return outs;
    if (outs.includes('PWR')) return ['PWR'];
    const uid = this.addPart('O', {
      version: C.versionFor('O', this.ctx.learned),
      templates: C.templatesFor('O', { card: outs.length }, this.ctx.learned),
    });
    outs.forEach((srcKey, i) => {
      const kin = this.pin(uid, 'in' + (i + 1), 'dst');
      this.connect([srcKey], kin);
      this.need(kin, 'O.in' + (i + 1));
    });
    return [this.pin(uid, 'out', 'src')];
  }

  cond(n, srcs) {
    switch (n.t) {
      case 'true': return srcs;
      case 'and': { let cur = srcs; for (const it of n.items) cur = this.cond(it, cur); return cur; }
      case 'or': {
        if (n.items.some(it => it.t === 'true')) return srcs;
        const outs = [];
        for (const it of n.items) {
          const branchOuts = this.cond(it, srcs);
          const single = this.mergeOr(branchOuts);
          for (const k of single) if (!outs.includes(k)) outs.push(k);
        }
        return this.mergeOr(outs);
      }
      case 'contact': {
        const uid = this.addPart('Contact', { negated: n.neg ? ['operand'] : [], version: C.versionFor('Contact', this.ctx.learned) });
        const kin = this.pin(uid, 'in', 'dst'); this.connect(srcs, kin); this.need(kin, 'Contact input');
        const kop = this.pin(uid, 'operand', 'dst'); this.bind(n.op, kop, 'read', 'Bool'); this.need(kop, 'Contact operand');
        return [this.pin(uid, 'out', 'src')];
      }
      case 'rtrig': case 'ftrig': {
        const nm = n.t === 'rtrig' ? 'PBox' : 'NBox';
        const uid = this.addPart(nm, { version: C.versionFor(nm, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, 'in', 'dst'));
        this.bind(n.mem, this.pin(uid, 'bit', 'dst'), 'read', 'Bool');
        this.noteMem(n.mem);
        return [this.pin(uid, 'out', 'src')];
      }
      case 'edgeContact': {
        const name = n.rising ? 'PContact' : 'NContact';
        const uid = this.addPart(name, { version: C.versionFor(name, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, C.COND_FLOW_IN[name], 'dst'));
        this.bind(n.op, this.pin(uid, 'operand', 'dst'), 'read', 'Bool');
        this.bind(n.mem, this.pin(uid, 'bit', 'dst'), 'read', 'Bool');
        this.noteMem(n.mem);
        return [this.pin(uid, 'out', 'src')];
      }
      case 'range': {
        const type = this.inferType(n.inputs, n.type, n.fn);
        const name = C.RANGE[n.fn];
        const uid = this.addPart(name, { version: C.versionFor(name, this.ctx.learned), templates: C.templatesFor(name, { type }, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, C.COND_FLOW_IN[name], 'dst'));
        C.RANGE_PINS.forEach((pin, i) => this.bind(n.inputs[i], this.pin(uid, pin, 'dst'), 'read', type));
        return [this.pin(uid, 'out', 'src')];
      }
      case 'not': {
        const uid = this.addPart('Not', {});
        this.connect(srcs, this.pin(uid, 'in', 'dst'));
        return [this.pin(uid, 'out', 'src')];
      }
      case 'cmp': {
        const type = this.inferType([n.a, n.b], n.type, n.rel);
        const nm = C.REL[n.rel];
        const uid = this.addPart(nm, { version: C.versionFor(nm, this.ctx.learned), templates: C.templatesFor(nm, { type }, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, 'pre', 'dst'));
        this.bind(n.a, this.pin(uid, 'in1', 'dst'), 'read', type);
        this.bind(n.b, this.pin(uid, 'in2', 'dst'), 'read', type);
        return [this.pin(uid, 'out', 'src')];
      }
      default: throw new GenError('cannot generate condition node of type ' + n.t);
    }
  }
  noteMem(op) { if (op.k === 'local' && op.path.length === 1 && !op.idx) this.decl('Static', op.path[0], 'Bool'); }

  // ---------------------------------------------------------------- actions
  flow(f, srcs) {
    let cur = srcs;
    if (f.cond) cur = this.cond(f.cond, srcs);
    for (const a of f.then) this.action(a, cur);
  }
  nextFlows(a, outKey) { for (const f of (a.next || [])) this.flow(f, [outKey]); }
  paramPin(P, pinKey, hint) {
    if (P.v === 'op') this.bind(P.op, pinKey, 'read', hint);
    else this.connect(this.cond(P.cond, [this.PWR()]), pinKey);
  }
  action(a, srcs) {
    switch (a.t) {
      case 'coil': {
        const sp = C.COILS[a.kind];
        const uid = this.addPart(sp.part, { negated: sp.neg ? ['operand'] : [], version: C.versionFor(sp.part, this.ctx.learned) });
        const kin = this.pin(uid, 'in', 'dst'); this.connect(srcs, kin); this.need(kin, a.kind + ' input');
        const kop = this.pin(uid, 'operand', 'dst'); this.bind(a.op, kop, 'read', 'Bool'); this.need(kop, a.kind + ' operand');
        return;
      }
      case 'box': return this.box(a, srcs);
      case 'move': {
        const hint = this.typeOf(a.dst[0]) || this.typeOf(a.src);
        const uid = this.addPart('Move', { version: C.versionFor('Move', this.ctx.learned), templates: C.templatesFor('Move', { card: a.dst.length }, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, 'en', 'dst'));
        this.bind(a.src, this.pin(uid, 'in', 'dst'), 'read', hint);
        a.dst.forEach((d, i) => this.bind(d, this.pin(uid, 'out' + (i + 1), 'src'), 'write'));
        return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
      }
      case 'math': {
        const inputs = C.mathInputs(a);
        const fallback = (a.fn === 'W_AND' || a.fn === 'W_OR' || a.fn === 'W_XOR') ? 'Word' : undefined;
        const type = this.inferType([...inputs, a.dst], a.type, a.fn, fallback);
        const nm = C.MATH[a.fn];
        const uid = this.addPart(nm, { version: C.versionFor(nm, this.ctx.learned), templates: C.templatesFor(nm, { type, card: inputs.length }, this.ctx.learned),
          disabledEno: a.fn === 'MIN' || a.fn === 'MAX' ? 'false' : undefined });
        this.connect(srcs, this.pin(uid, 'en', 'dst'));
        inputs.forEach((op, i) => this.bind(op, this.pin(uid, 'in' + (i + 1), 'dst'), 'read', type));
        this.bind(a.dst, this.pin(uid, 'out', 'src'), 'write');
        return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
      }
      case 'shift': {
        const type = this.inferType([a.src, a.dst], a.type, a.fn, 'Word');
        const nm = C.SHIFT[a.fn];
        const uid = this.addPart(nm, { version: C.versionFor(nm, this.ctx.learned), templates: C.templatesFor(nm, { type }, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, 'en', 'dst'));
        this.bind(a.src, this.pin(uid, 'in', 'dst'), 'read', type);
        this.bind(a.count, this.pin(uid, 'n', 'dst'), 'read', 'UInt');
        this.bind(a.dst, this.pin(uid, 'out', 'src'), 'write');
        return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
      }
      case 'select': {
        const type = this.inferType([...a.inputs, a.dst], a.type, 'SEL');
        const uid = this.addPart('Sel', { version: C.versionFor('Sel', this.ctx.learned), templates: C.templatesFor('Sel', { type }, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, 'en', 'dst'));
        this.paramPin(a.gate, this.pin(uid, 'g', 'dst'), 'Bool');
        a.inputs.forEach((op, i) => this.bind(op, this.pin(uid, 'in' + i, 'dst'), 'read', type));
        this.bind(a.dst, this.pin(uid, 'out', 'src'), 'write');
        return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
      }
      case 'latch': {
        const info = C.LATCHES[a.fn];
        const uid = this.addPart(info.part, { version: C.versionFor(info.part, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, info.main, 'dst'));
        this.bind(a.op, this.pin(uid, 'operand', 'dst'), 'read', 'Bool');
        const secondary = this.pin(uid, info.secondary.toLowerCase(), 'dst');
        if (a.secondary) this.paramPin(a.secondary, secondary, 'Bool');
        else this.union(this.openPin('src'), secondary);
        const q = this.pin(uid, 'q', 'src');
        if (a.out) this.bind(a.out, q, 'write');
        else if (!a.next?.length) this.union(q, this.openPin('dst'));
        return this.nextFlows(a, q);
      }
      case 'unary': {
        const defT = ['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SQRT', 'EXP', 'LN'].includes(a.fn) ? 'Real' : null;
        const type = this.inferType([a.src, a.dst], a.type, a.fn, defT);
        const nm = C.UNARY_MATH[a.fn];
        const uid = this.addPart(nm, { version: C.versionFor(nm, this.ctx.learned), templates: C.templatesFor(nm, { type }, this.ctx.learned) });
        this.connect(srcs, this.pin(uid, 'en', 'dst'));
        this.bind(a.src, this.pin(uid, 'in', 'dst'), 'read', type);
        this.bind(a.dst, this.pin(uid, 'out', 'src'), 'write');
        return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
      }
      case 'conv': {
        const info = C.CONV_OPS[a.fn];
        const srcOps = a.fn === 'SCALE_X' ? [a.ins[1]] : a.ins;
        const destOps = a.fn === 'SCALE_X' ? [a.out, a.ins[0], a.ins[2]] : [a.out];
        const srcType = this.inferType(srcOps, a.srcType, a.fn, info.defSrc);
        const destType = info.dualType ? this.inferType(destOps, a.destType, a.fn, info.defDest) : srcType;
        const uid = this.addPart(info.part, {
          version: C.versionFor(info.part, this.ctx.learned),
          templates: C.templatesFor(info.part, { type: srcType, destType }, this.ctx.learned),
        });
        this.connect(srcs, this.pin(uid, 'en', 'dst'));
        info.ins.forEach((pinName, i) => {
          const hint = a.fn === 'SCALE_X' && pinName !== 'value' ? destType : srcType;
          this.bind(a.ins[i], this.pin(uid, pinName, 'dst'), 'read', hint);
        });
        this.bind(a.out, this.pin(uid, 'out', 'src'), 'write');
        return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
      }
      case 'call': return this.call(a, srcs);
      default: throw new GenError('cannot generate action of type ' + a.t);
    }
  }
  box(a, srcs) {
    const B = C.BOXES[a.name];
    const partName = B.partName || a.name;
    let type = a.type || B.defType;
    if (B.kind === 'counter' && !a.type) {
      const t = a.params.PV && a.params.PV.v === 'op' ? this.typeOf(a.params.PV.op) : null;
      if (t && /Int/.test(t)) type = t;
    }
    type = canonType(type);
    const instNode = this.instanceNode(a.inst);
    const uid = this.addPart(partName, {
      version: C.versionFor(partName, this.ctx.learned), instance: instNode,
      templates: C.templatesFor(partName, { type }, this.ctx.learned),
    });
    const kmain = this.pin(uid, B.main, 'dst'); this.connect(srcs, kmain); this.need(kmain, partName + '.' + B.main);
    for (const k of B.valIn) {
      const P = a.params[k];
      if (!P) throw new GenError(partName + ' needs ' + k + '=..., e.g. ' + partName + '(' + O.text(a.inst) + ', ' + k + '=' + (B.kind === 'timer' ? 'T#3s' : B.kind === 'motion' ? '"Truc_X"' : '10') + ')', 'E_PARAM');
      const kp = this.pin(uid, k, 'dst'); this.paramPin(P, kp, B.kind === 'timer' ? 'Time' : (B.kind === 'motion' ? undefined : type)); this.need(kp, partName + '.' + k);
    }
    const needsOpenCon = B.kind === 'motion' || B.kind === 'timer' || B.kind === 'counter';
    const hasNext = Array.isArray(a.next) && a.next.length > 0;
    for (const k of (B.optIn || [])) {
      const kp = this.pin(uid, k, 'dst');
      if (a.params[k]) {
        const hint = /Position|Distance|Velocity/.test(k) ? 'Real' : (/Mode|Direction/.test(k) ? 'Int' : 'Bool');
        this.paramPin(a.params[k], kp, hint);
      } else if (needsOpenCon) {
        this.union(this.openPin('src'), kp);
      }
    }
    for (const k of B.flowIn) {
      if (a.params[k]) this.paramPin(a.params[k], this.pin(uid, k, 'dst'), 'Bool');
      else if (needsOpenCon) this.union(this.openPin('src'), this.pin(uid, k, 'dst'));
    }
    for (const k of [...B.valOut, ...B.boolOut]) {
      const P = a.params[k];
      if (!P) {
        if (needsOpenCon && (k !== B.flowOut || !hasNext)) this.union(this.pin(uid, k, 'src'), this.openPin('dst'));
        continue;
      }
      if (P.v !== 'op') throw new GenError(partName + '.' + k + ' is an output; give it a variable (e.g. ' + k + '=#var) or chain with "=>"', 'E_PARAM');
      this.bind(P.op, this.pin(uid, k, 'src'), 'write');
    }
    if (a.inst.k === 'local' && a.inst.path.length === 1 && !a.inst.idx) this.decl('Static', a.inst.path[0], C.boxInstanceType(a.name, type));
    else if (a.inst.k === 'global') this.dbInstances.push({ name: a.inst.path[0], type: C.boxInstanceType(a.name, type) });
    return this.nextFlows(a, this.pin(uid, B.flowOut, 'src'));
  }
  call(a, srcs) {
    const cat = this.ctx.callCatalog && this.ctx.callCatalog[a.name];
    if (!cat) {
      const known = Object.keys(this.ctx.callCatalog || {});
      throw new GenError('Unknown block "' + a.name + '" for CALL. ' + (known.length ? 'Known blocks/instructions: ' + known.slice(0, 40).join(', ') : 'No call catalog loaded (run tia_project_blueprint first so block interfaces are learned).'), 'E_CALL');
    }
    const uid = this.nid();
    const info = [];
    if (cat.blockType === 'FB') {
      if (!a.inst) throw new GenError('CALL("' + a.name + '") is an FB: pass inst="InstanceDB" or inst=#MultiInstance', 'E_CALL');
      info.push(this.instanceNode(a.inst));
      if (a.inst.k === 'local' && a.inst.path.length === 1 && !a.inst.idx) this.decl('Static', a.inst.path[0], '"' + a.name + '"');
      else if (a.inst.k === 'global') this.dbInstances.push({ name: a.inst.path[0], type: a.name, fb: true });
    }
    for (const p of cat.params) info.push(E('Parameter', { Name: p.name, Section: p.section, Type: p.type }));
    const attrs = { Name: a.name, BlockType: cat.blockType };
    if (cat.version) attrs.Version = cat.version;
    this.items.push(E('Call', { UId: uid }, [E('CallInfo', attrs, info)]));
    this.connect(srcs, this.pin(uid, 'en', 'dst'));
    for (const k of Object.keys(a.args)) {
      const p = cat.params.find(x => x.name.toLowerCase() === k.toLowerCase());
      if (!p) throw new GenError('Block "' + a.name + '" has no parameter "' + k + '". Parameters: ' + cat.params.map(x => x.name + ':' + x.section).join(', '), 'E_CALL');
      const P = a.args[k];
      if (p.section === 'Input') this.paramPin(P, this.pin(uid, p.name, 'dst'), p.type);
      else {
        if (P.v !== 'op') throw new GenError('Parameter ' + k + ' of "' + a.name + '" is ' + p.section + '; give it a variable', 'E_CALL');
        if (p.section === 'InOut') this.bind(P.op, this.pin(uid, p.name, 'dst'), 'read');
        else this.bind(P.op, this.pin(uid, p.name, 'src'), 'write');
      }
    }
    return this.nextFlows(a, this.pin(uid, 'eno', 'src'));
  }

  // ---------------------------------------------------------------- finish
  finish(flows) {
    for (const f of flows) this.flow(f, [this.PWR()]);
    const groups = new Map();
    for (const k of this.order) { const r = this.find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); }
    for (const n of this.needs) {
      const g = groups.get(this.find(n.key));
      if (!g || g.length < 2) throw new GenError('Unconnected pin: ' + n.label, 'E_WIRE');
    }
    const wires = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const mem = g.slice().sort((x, y) => {
        const ix = this.info.get(x), iy = this.info.get(y);
        const sx = ix.role === 'src' ? 0 : 1, sy = iy.role === 'src' ? 0 : 1;
        return sx - sy || ix.rank - iy.rank || this.order.indexOf(x) - this.order.indexOf(y);
      });
      wires.push(mem.map(k => {
        const i = this.info.get(k);
        if (i.kind === 'pwr') return E('Powerrail');
        if (i.kind === 'ident') return E('IdentCon', { UId: i.uid });
        if (i.kind === 'open') return E('OpenCon', { UId: i.uid });
        return E('NameCon', { UId: i.uid, Name: i.pin });
      }));
    }
    const wireNodes = wires.map(w => E('Wire', { UId: this.nid() }, w));
    const content = [E('Parts', {}, this.items)];
    if (wireNodes.length) content.push(E('Wires', {}, wireNodes));
    return E('FlgNet', { xmlns: FLG_NS }, content);
  }
}

function generateFlgNet(flows, ctx) {
  const g = new Gen(ctx);
  const node = g.finish(flows);
  return { node, xml: ser(node, 0), decls: g.decls, dbInstances: g.dbInstances, warnings: g.warnings };
}

module.exports = { generateFlgNet, GenError, canonType, FLG_NS };
