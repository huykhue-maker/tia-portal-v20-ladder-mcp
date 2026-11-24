'use strict';
// Ladder DSL: tokenizer, parser (text -> AST) and canonical printer (AST -> text).

const { local, global, lit, abs, text } = require('./operand');
const C = require('./catalog');

class DslError extends Error {
  constructor(msg, src, pos) {
    let line = 1, col = 1;
    if (src && pos !== undefined) {
      for (let i = 0; i < pos && i < src.length; i++) { if (src[i] === '\n') { line++; col = 1; } else col++; }
    }
    super(msg + (src && pos !== undefined ? ' (line ' + line + ', col ' + col + ')' : ''));
    this.name = 'DslError'; this.line = line; this.col = col;
  }
}

const ID_START = /[A-Za-z_]/, ID_CH = /[A-Za-z0-9_]/;

function tokenize(src) {
  const toks = []; let i = 0; const n = src.length;
  const push = (t, pos, extra) => toks.push(Object.assign({ t, pos }, extra || {}));
  const skipWs = () => { while (i < n && /\s/.test(src[i])) i++; };

  function readName(pos0) {
    if (src[i] === '"') {
      const e = src.indexOf('"', i + 1);
      if (e < 0) throw new DslError('unterminated quoted name', src, pos0);
      const name = src.slice(i + 1, e); i = e + 1; return name;
    }
    if (!ID_START.test(src[i] || '')) throw new DslError('expected a name', src, i);
    let j = i; while (j < n && ID_CH.test(src[j])) j++;
    const name = src.slice(i, j); i = j; return name;
  }

  function readIndexOperand() {
    skipWs();
    const pos0 = i;
    let m;
    if ((m = /^-?\d+/.exec(src.slice(i)))) {
      i += m[0].length;
      return lit('DInt', m[0]);
    }
    if (src[i] === '#') {
      i++;
      const p = [readName(pos0)]; const idx = {};
      readSubscript(p, idx, pos0);
      readMembers(p, idx, pos0);
      return local(p, idx);
    }
    if (src[i] === '"') {
      const p = [readName(pos0)]; const idx = {};
      readSubscript(p, idx, pos0);
      readMembers(p, idx, pos0);
      return global(p, idx);
    }
    if (ID_START.test(src[i] || '')) {
      const p = [readName(pos0)]; const idx = {};
      readSubscript(p, idx, pos0);
      readMembers(p, idx, pos0);
      return global(p, idx);
    }
    throw new DslError('invalid array index expression', src, i);
  }

  function readSubscript(pathArr, idxMap, pos0) {
    if (src[i] !== '[') return;
    const dims = [];
    while (src[i] === '[') {
      i++; // consume '['
      do {
        dims.push(readIndexOperand());
        skipWs();
      } while (src[i] === ',' && (i++, true));
      if (src[i] !== ']') throw new DslError('expected "]" after array index', src, pos0);
      i++; // consume ']'
    }
    idxMap[pathArr.length - 1] = dims;
  }

  function readMembers(pathArr, idxMap, pos0) {
    while (src[i] === '.' && (ID_START.test(src[i + 1] || '') || src[i + 1] === '"')) {
      i++;
      pathArr.push(readName(pos0));
      readSubscript(pathArr, idxMap, pos0);
    }
    return pathArr;
  }

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new DslError('unterminated comment', src, i); i = e + 2; continue; }
    const pos = i;
    if (c === '=' && src[i + 1] === '>') { push('=>', pos); i += 2; continue; }
    if ('(),;&|!{}='.includes(c)) { push(c, pos); i++; continue; }
    if (c === '#') {
      i++;
      const p = [readName(pos)]; const idx = {};
      readSubscript(p, idx, pos);
      readMembers(p, idx, pos);
      push('op', pos, { op: local(p, idx) });
      continue;
    }
    if (c === '"') {
      const p = [readName(pos)]; const idx = {};
      readSubscript(p, idx, pos);
      readMembers(p, idx, pos);
      push('op', pos, { op: global(p, idx) });
      continue;
    }
    if (c === '%') {
      const m = /^%([IQMiqm])([BWDbwd]?)(\d+)(?:\.([0-7]))?(?::([A-Za-z]+))?/.exec(src.slice(i));
      if (!m) throw new DslError('bad absolute address (use %I0.0, %Q0.1, %M10.0, %MW20, %QD4, %IW64:Int)', src, i);
      const area = { I: 'Input', Q: 'Output', M: 'Memory' }[m[1].toUpperCase()];
      let w = m[2].toUpperCase();
      if (!w && m[4] === undefined) throw new DslError('bit address needs a bit number, e.g. %I0.0', src, i);
      if (w && m[4] !== undefined) throw new DslError('bit access on word addresses is not supported', src, i);
      if (!w) w = 'X';
      const type = m[5] || ({ X: 'Bool', B: 'Byte', W: 'Word', D: 'DWord' })[w];
      const byte = parseInt(m[3], 10), bit = m[4] !== undefined ? parseInt(m[4], 10) : 0;
      push('op', pos, { op: abs(area, type, byte * 8 + bit) });
      i += m[0].length; continue;
    }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) throw new DslError('unterminated string', src, i); push('str', pos, { v: src.slice(i + 1, e) }); i = e + 1; continue; }
    let m;
    if ((m = /^(?:LT|T)#[-0-9A-Za-z_.:]+/i.exec(src.slice(i)))) {
      push('op', pos, { op: lit(m[0].toUpperCase().startsWith('LT#') ? 'LTime' : 'Time', m[0].replace(/^(lt|t)#/i, s => s.toUpperCase())) });
      i += m[0].length; continue;
    }
    if ((m = /^\d+#[0-9A-Fa-f_]+/.exec(src.slice(i)))) { push('op', pos, { op: lit('auto', m[0]) }); i += m[0].length; continue; }
    if ((m = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(src.slice(i))) && (/\d/.test(c) || c === '-')) {
      const o = lit('auto', m[0]); if (/[.eE]/.test(m[0])) o.real = true;
      push('op', pos, { op: o }); i += m[0].length; continue;
    }
    if (ID_START.test(c)) {
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const head = m[0];
      const nextCh = src[i + head.length];
      if (nextCh === '[') {
        i += head.length;
        const p = [head]; const idx = {};
        readSubscript(p, idx, pos);
        readMembers(p, idx, pos);
        push('op', pos, { op: global(p, idx) });
        continue;
      }
      const full = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))[0];
      if (src[i + full.length] === '[') {
        const segs = full.split('.');
        i += full.length;
        const idx = {};
        readSubscript(segs, idx, pos);
        readMembers(segs, idx, pos);
        push('op', pos, { op: global(segs, idx) });
        continue;
      }
      push('id', pos, { v: full }); i += full.length; continue;
    }
    throw new DslError('unexpected character "' + c + '"', src, i);
  }
  push('eof', n);
  return toks;
}

const mkAnd = items => {
  const out = [];
  for (const it of items) { if (it.t === 'and') out.push(...it.items); else if (it.t !== 'true') out.push(it); }
  if (out.length === 0) return { t: 'true' };
  return out.length === 1 ? out[0] : { t: 'and', items: out };
};
const mkOr = items => {
  const out = [];
  for (const it of items) {
    // A parallel branch that is always TRUE (power rail bypass) makes the whole
    // OR TRUE. Keeping it as "TRUE | X" makes the DSL fail the exact roundtrip
    // test and marks real TIA networks containing a bypass as READ-ONLY.
    if (it.t === 'true') return { t: 'true' };
    if (it.t === 'or') out.push(...it.items); else out.push(it);
  }
  if (out.length === 0) return { t: 'true' };
  const uniq = [];
  const seen = new Set();
  for (const it of out) {
    const k = JSON.stringify(it);
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(it);
  }
  return uniq.length === 1 ? uniq[0] : { t: 'or', items: uniq };
};

function cleanTypeArg(op) {
  return op.k === 'global' ? op.path.join('.') : text(op).replace(/^"|"$/g, '');
}

class Parser {
  constructor(src) { this.src = src; this.toks = tokenize(src); this.p = 0; }
  peek(o) { return this.toks[Math.min(this.p + (o || 0), this.toks.length - 1)]; }
  next() { return this.toks[this.p++]; }
  accept(t) { if (this.peek().t === t) { this.p++; return true; } return false; }
  err(msg, tok) { throw new DslError(msg, this.src, (tok || this.peek()).pos); }
  expect(t, what) {
    if (this.peek().t !== t) this.err('expected ' + (what || '"' + t + '"') + ' but found ' + this.describe(this.peek()));
    return this.next();
  }
  describe(tok) { return tok.t === 'eof' ? 'end of input' : tok.t === 'id' ? '"' + tok.v + '"' : tok.t === 'op' ? '"' + text(tok.op) + '"' : '"' + tok.t + '"'; }

  parseAll() {
    const flows = [];
    while (this.peek().t !== 'eof') {
      if (this.accept(';')) continue;
      flows.push(this.parseFlow());
    }
    return flows;
  }
  startsCond() {
    const t = this.peek();
    if (t.t === '!' || t.t === '(' || t.t === 'op') return true;
    if (t.t === 'id') {
      const up = t.v.toUpperCase(), paren = this.peek(1).t === '(';
      if (paren) return C.COND_FUNCS.has(up);
      // Actions always require "("; any bare identifier (even if named LIMIT/MIN/MAX/SIN) is a condition operand.
      return true;
    }
    return false;
  }
  parseFlow() {
    let cond = null;
    if (this.startsCond()) {
      cond = this.parseOr();
      if (this.peek().t !== '=>') this.err('a condition must be followed by "=>" and an action (found ' + this.describe(this.peek()) + ')');
      this.next();
    }
    const then = this.parseActions();
    return { cond: cond && cond.t === 'true' ? null : cond, then };
  }
  parseActions() {
    const list = [];
    do {
      const a = this.parseAction();
      if (this.peek().t === '=>') {
        const tok = this.next();
        if (a.t === 'coil') this.err('a coil ends the rung; nothing can follow it', tok);
        a.next = this.parseNext();
      }
      list.push(a);
    } while (this.accept(','));
    return list;
  }
  parseNext() {
    if (this.accept('{')) {
      const flows = [];
      while (this.peek().t !== '}') {
        if (this.peek().t === 'eof') this.err('missing "}"');
        if (this.accept(';')) continue;
        flows.push(this.parseFlow());
      }
      this.next();
      return flows;
    }
    return [this.parseFlow()];
  }
  parseOr() {
    const items = [this.parseAnd()];
    while (this.accept('|')) items.push(this.parseAnd());
    return mkOr(items);
  }
  parseAnd() {
    const items = [this.parseUnary()];
    while (this.accept('&')) items.push(this.parseUnary());
    return mkAnd(items);
  }
  parseUnary() {
    const bang = this.peek();
    if (this.accept('!')) {
      const e = this.parsePrimary();
      if (e.t !== 'contact') this.err('"!" can only negate a contact (NO/NC or a plain operand); use NC() / NOT()', bang);
      e.neg = !e.neg; e.bare = false; return e;
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.peek();
    if (t.t === '(') { this.next(); const e = this.parseOr(); this.expect(')'); return e; }
    if (t.t === 'op') { this.next(); return { t: 'contact', op: t.op, neg: false, bare: true }; }
    if (t.t === 'id') {
      const up = t.v.toUpperCase();
      if (this.peek(1).t === '(') {
        if (!C.COND_FUNCS.has(up)) {
          if (C.ACTION_FUNCS.has(up)) this.err(up + '() is an action; put it after "=>"', t);
          this.err('unknown condition function ' + t.v + '. Valid: ' + [...C.COND_FUNCS].join(', '), t);
        }
        this.next(); this.next();
        const args = this.parseArgsRest();
        return this.buildCond(up, args, t);
      }
      this.next();
      if (up === 'NOT') return { t: 'not' };
      if (up === 'TRUE') return { t: 'true' };
      if (up === 'FALSE') return { t: 'contact', op: lit('Bool', 'FALSE'), neg: false, bare: true };
      return { t: 'contact', op: global(t.v.split('.')), neg: false, bare: true };
    }
    this.err('expected a contact, operand or "(" but found ' + this.describe(t));
  }
  parseArgsRest() {
    const args = { pos: [], named: {} };
    if (this.accept(')')) return args;
    do {
      const t = this.peek();
      if (t.t === 'id' && this.peek(1).t === '=') {
        this.next(); this.next();
        args.named[t.v] = this.parseParamValue();
      } else args.pos.push(this.parseParamValue());
    } while (this.accept(','));
    this.expect(')');
    return args;
  }
  parseParamValue() {
    const c = this.parseOr();
    if (c.t === 'contact' && c.bare) return { v: 'op', op: c.op };
    if (c.t === 'true') return { v: 'op', op: lit('Bool', 'TRUE') };
    return { v: 'cond', cond: c };
  }
  needOp(P, what, tok) {
    if (!P || P.v !== 'op') this.err(what + ' must be an operand (#local, "tag", %I0.0 or literal)', tok);
    return P.op;
  }
  buildCond(up, args, tok) {
    switch (up) {
      case 'NO': case 'NC':
        if (args.pos.length !== 1) this.err(up + '(operand) takes exactly 1 operand', tok);
        return { t: 'contact', op: this.needOp(args.pos[0], up + ' operand', tok), neg: up === 'NC' };
      case 'NOT': return { t: 'not' };
      case 'TRUE': return { t: 'true' };
      case 'RTRIG': case 'FTRIG':
        if (args.pos.length !== 1) this.err(up + '(mem_bit) takes exactly 1 memory-bit operand', tok);
        return { t: up === 'RTRIG' ? 'rtrig' : 'ftrig', mem: this.needOp(args.pos[0], up + ' memory bit', tok) };
      default: {
        if (args.pos.length < 2 || args.pos.length > 3) this.err(up + '(a, b[, Type]) takes 2 operands and an optional type', tok);
        const a = this.needOp(args.pos[0], up + ' first operand', tok), b = this.needOp(args.pos[1], up + ' second operand', tok);
        let type = null;
        if (args.pos[2]) type = cleanTypeArg(this.needOp(args.pos[2], 'type', tok));
        if (args.named.TYPE || args.named.type || args.named.Type) {
          const P = args.named.TYPE || args.named.type || args.named.Type;
          type = cleanTypeArg(this.needOp(P, 'type', tok));
        }
        return { t: 'cmp', rel: up, a, b, type };
      }
    }
  }
  parseAction() {
    const t = this.peek();
    if (t.t !== 'id' || this.peek(1).t !== '(') {
      this.err('expected an action such as COIL(x), SET(x), RESET(x), TON(...), MOVE(...), CALL(...) but found ' + this.describe(t));
    }
    const up = t.v.toUpperCase();
    if (!C.ACTION_FUNCS.has(up)) {
      if (C.COND_FUNCS.has(up)) this.err(up + '() is a condition and cannot be used as an action', t);
      this.err('unknown action ' + t.v + '. Valid: ' + [...C.ACTION_FUNCS].join(', '), t);
    }
    this.next(); this.next();
    const args = this.parseArgsRest();
    return this.buildAction(up, args, t);
  }
  buildAction(up, args, tok) {
    if (C.COILS[up]) {
      if (args.pos.length !== 1 || Object.keys(args.named).length) this.err(up + '(operand) takes exactly 1 operand', tok);
      return { t: 'coil', kind: up, op: this.needOp(args.pos[0], up + ' operand', tok) };
    }
    if (up === 'MOVE') {
      if (args.pos.length < 2) this.err('MOVE(src, dst[, dst2...]) needs a source and at least one destination', tok);
      const ops = args.pos.map((P, i) => this.needOp(P, 'MOVE argument ' + (i + 1), tok));
      return { t: 'move', src: ops[0], dst: ops.slice(1) };
    }
    if (C.MATH[up]) {
      if (args.pos.length < 3 || args.pos.length > 4) this.err(up + '(a, b, dst[, Type]) takes 3 operands and an optional type', tok);
      const ops = args.pos.slice(0, 3).map((P, i) => this.needOp(P, up + ' argument ' + (i + 1), tok));
      let type = null;
      if (args.pos[3]) type = cleanTypeArg(this.needOp(args.pos[3], 'type', tok));
      const P = args.named.TYPE || args.named.type || args.named.Type;
      if (P) type = cleanTypeArg(this.needOp(P, 'type', tok));
      return { t: 'math', fn: up, a: ops[0], b: ops[1], dst: ops[2], type };
    }
    if (C.UNARY_MATH[up]) {
      if (args.pos.length < 2 || args.pos.length > 3) this.err(up + '(src, dst[, Type]) takes 2 operands and an optional type', tok);
      const src = this.needOp(args.pos[0], up + ' input', tok);
      const dst = this.needOp(args.pos[1], up + ' output', tok);
      let type = null;
      if (args.pos[2]) type = cleanTypeArg(this.needOp(args.pos[2], 'type', tok));
      const P = args.named.TYPE || args.named.type || args.named.Type;
      if (P) type = cleanTypeArg(this.needOp(P, 'type', tok));
      return { t: 'unary', fn: up, src, dst, type };
    }
    if (C.CONV_OPS[up]) {
      const info = C.CONV_OPS[up];
      const needCount = info.ins.length + 1;
      const maxCount = needCount + (info.dualType ? 2 : 1);
      if (args.pos.length < needCount || args.pos.length > maxCount) {
        this.err(up + '(' + [...info.ins, 'out', info.dualType ? 'SrcType, DestType' : 'Type'].join(', ') + ') wrong argument count', tok);
      }
      const ins = args.pos.slice(0, info.ins.length).map((P, i) => this.needOp(P, up + ' ' + info.ins[i], tok));
      const out = this.needOp(args.pos[info.ins.length], up + ' out', tok);
      let srcType = args.pos[needCount] ? cleanTypeArg(this.needOp(args.pos[needCount], 'SrcType', tok)) : null;
      let destType = (info.dualType && args.pos[needCount + 1]) ? cleanTypeArg(this.needOp(args.pos[needCount + 1], 'DestType', tok)) : null;
      for (const [k, P] of Object.entries(args.named)) {
        const kl = k.toLowerCase();
        if (kl === 'srctype' || kl === 'type') srcType = cleanTypeArg(this.needOp(P, k, tok));
        else if (kl === 'desttype') destType = cleanTypeArg(this.needOp(P, k, tok));
      }
      return { t: 'conv', fn: up, ins, out, srcType, destType };
    }
    if (C.BOXES[up]) {
      const B = C.BOXES[up];
      if (args.pos.length < 1) this.err((B.partName || up) + '(instance, ...) needs an instance operand first', tok);
      const inst = this.needOp(args.pos[0], up + ' instance', tok);
      const params = {}; let type = null;
      const allPins = [...B.valIn, ...(B.optIn || []), ...B.flowIn, ...B.valOut, ...B.boolOut];
      const pinMap = new Map(allPins.map(p => [p.toUpperCase(), p]));
      if (args.pos[1]) params[B.posParams[0]] = args.pos[1];
      if (args.pos.length > 2) this.err((B.partName || up) + ' takes the instance and at most one positional value (' + B.posParams[0] + '); use NAME=value for the rest', tok);
      for (const k of Object.keys(args.named)) {
        const K = k.toUpperCase();
        if (K === 'TYPE') { type = cleanTypeArg(this.needOp(args.named[k], 'type', tok)); continue; }
        const canon = pinMap.get(K);
        if (!canon) this.err((B.partName || up) + ' has no pin "' + k + '". Pins: ' + allPins.join(', '), tok);
        params[canon] = args.named[k];
      }
      return { t: 'box', name: up, inst, params, type };
    }
    if (up === 'CALL') {
      if (args.pos.length !== 1) this.err('CALL("BlockName", inst="DB", Param=value...) needs the block name first', tok);
      const nm = this.needOp(args.pos[0], 'block name', tok);
      const name = nm.k === 'lit' ? nm.value : nm.path[0];
      let inst = null; const a = {};
      for (const k of Object.keys(args.named)) {
        if (k.toLowerCase() === 'inst') inst = this.needOp(args.named[k], 'inst', tok);
        else a[k] = args.named[k];
      }
      return { t: 'call', name, inst, args: a };
    }
    this.err('unsupported action ' + up, tok);
  }
}

function parseNetwork(src) {
  const p = new Parser(src);
  const flows = p.parseAll();
  return { flows };
}
function parseOperandString(s) {
  const toks = tokenize(String(s));
  if (toks[0].t !== 'op' && !(toks[0].t === 'id')) throw new DslError('not an operand: ' + s);
  if (toks[0].t === 'id') {
    const up = toks[0].v.toUpperCase();
    if (up === 'TRUE' || up === 'FALSE') return lit('Bool', up);
    return global(toks[0].v.split('.'));
  }
  return toks[0].op;
}

// ---------------------------------------------------------------- printing
const opT = text;
function printParam(P) {
  if (P.v === 'op') return opT(P.op);
  return printCond(P.cond, 0);
}
function printCond(n, prec) {
  switch (n.t) {
    case 'true': return 'TRUE';
    case 'contact': return (n.neg ? 'NC(' : 'NO(') + opT(n.op) + ')';
    case 'not': return 'NOT()';
    case 'rtrig': return 'RTRIG(' + opT(n.mem) + ')';
    case 'ftrig': return 'FTRIG(' + opT(n.mem) + ')';
    case 'cmp': return n.rel + '(' + opT(n.a) + ', ' + opT(n.b) + (n.type ? ', ' + n.type : '') + ')';
    case 'ref': return 'REF(' + n.id + '.' + n.pin + ')';
    case 'open': return 'OPEN()';
    case 'and': return n.items.map(x => printCond(x, 1)).join(' & ');
    case 'or': { const s = n.items.map(x => printCond(x, 0)).join(' | '); return prec > 0 ? '(' + s + ')' : s; }
    default: return '?';
  }
}
function printAction(a) {
  let s;
  switch (a.t) {
    case 'coil': s = a.kind + '(' + opT(a.op) + ')'; break;
    case 'move': s = 'MOVE(' + [a.src, ...a.dst].map(opT).join(', ') + ')'; break;
    case 'math': s = a.fn + '(' + [opT(a.a), opT(a.b), opT(a.dst)].concat(a.type ? [a.type] : []).join(', ') + ')'; break;
    case 'unary': s = a.fn + '(' + [opT(a.src), opT(a.dst)].concat(a.type ? [a.type] : []).join(', ') + ')'; break;
    case 'conv': {
      const info = C.CONV_OPS[a.fn];
      const args = [...a.ins.map(opT), opT(a.out)];
      if (info && info.dualType) {
        if (a.srcType || a.destType) args.push(a.srcType || info.defSrc, a.destType || info.defDest);
      } else if (a.srcType) {
        args.push(a.srcType);
      }
      s = a.fn + '(' + args.join(', ') + ')';
      break;
    }
    case 'box': {
      const B = C.BOXES[a.name];
      const order = [...B.valIn, ...(B.optIn || []), ...B.flowIn, ...B.valOut, ...B.boolOut];
      const parts = [opT(a.inst)];
      for (const k of order) if (a.params[k]) parts.push(k + '=' + printParam(a.params[k]));
      if (a.type && B.kind !== 'motion' && a.type !== B.defType) parts.push('Type=' + a.type);
      s = (B.partName || a.name) + '(' + parts.join(', ') + ')';
      break;
    }
    case 'call': {
      const parts = ['"' + a.name + '"'];
      if (a.inst) parts.push('inst=' + opT(a.inst));
      for (const k of Object.keys(a.args)) parts.push(k + '=' + printParam(a.args[k]));
      s = 'CALL(' + parts.join(', ') + ')'; break;
    }
    case 'raw': s = 'RAW(' + a.label + ')'; break;
    default: s = '?(' + a.t + ')';
  }
  if (a.next && a.next.length) {
    s += ' => ' + (a.next.length === 1 ? printFlow(a.next[0]) : '{ ' + a.next.map(printFlow).join('; ') + ' }');
  }
  return s;
}
function printFlow(f) {
  const c = f.cond && f.cond.t !== 'true' ? printCond(f.cond, 0) + ' => ' : '';
  return c + f.then.map(printAction).join(', ');
}
function printNetwork(flows) { return flows.map(printFlow).join('\n'); }

module.exports = { parseNetwork, parseOperandString, tokenize, printNetwork, printFlow, printCond, printAction, DslError, mkAnd, mkOr };
