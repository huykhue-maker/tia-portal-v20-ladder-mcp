'use strict';
// ASCII ladder renderer (series / parallel layout) for readable previews.
const O = require('./operand');
const C = require('./catalog');

const blk = (lines, mid) => ({ lines, mid, w: lines.reduce((m, l) => Math.max(m, l.length), 0), h: lines.length });
const leaf = s => blk([s], 0);
const wire = () => blk(['-'], 0);
const pad = (s, w, ch) => s + (ch || ' ').repeat(Math.max(0, w - s.length));

function seq(blocks) {
  if (!blocks.length) return wire();
  let a = blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const top = Math.max(a.mid, b.mid);
    const bot = Math.max(a.h - a.mid, b.h - b.mid);
    const lines = [];
    for (let r = 0; r < top + bot; r++) {
      const ia = r - (top - a.mid), ib = r - (top - b.mid);
      const la = ia >= 0 && ia < a.h ? pad(a.lines[ia], a.w, r === top ? '-' : ' ') : ' '.repeat(a.w);
      const lb = ib >= 0 && ib < b.h ? pad(b.lines[ib], b.w, r === top ? '-' : ' ') : ' '.repeat(b.w);
      lines.push(la + (r === top ? '-' : ' ') + lb);
    }
    a = blk(lines, top);
  }
  return a;
}
function par(blocks) {
  if (blocks.length === 1) return blocks[0];
  const W = blocks.reduce((m, b) => Math.max(m, b.w), 0);
  const rows = [], mids = [];
  for (const b of blocks) {
    mids.push(rows.length + b.mid);
    b.lines.forEach((l, i) => rows.push(pad(l, W, i === b.mid ? '-' : ' ')));
  }
  const first = mids[0], last = mids[mids.length - 1];
  const lines = rows.map((l, r) => {
    const c = mids.includes(r) ? '+' : (r > first && r < last ? '|' : ' ');
    return c + l + c;
  });
  return blk(lines, first);
}

function condLeaf(n) {
  switch (n.t) {
    case 'contact': return leaf(n.neg ? '[/ ' + O.text(n.op) + ' ]' : '[ ' + O.text(n.op) + ' ]');
    case 'rtrig': return leaf('[P_TRIG ' + O.text(n.mem) + ']');
    case 'ftrig': return leaf('[N_TRIG ' + O.text(n.mem) + ']');
    case 'not': return leaf('[NOT]');
    case 'cmp': return leaf('[' + O.text(n.a) + ' ' + C.REL_SYM[n.rel] + ' ' + O.text(n.b) + ']');
    case 'ref': return leaf('[<' + n.id + '.' + n.pin + '>]');
    case 'open': return leaf('[?]');
    default: return wire();
  }
}
function condBlock(n) {
  if (n.t === 'true') return wire();
  if (n.t === 'and') return seq(n.items.map(condBlock));
  if (n.t === 'or') return par(n.items.map(condBlock));
  return condLeaf(n);
}
function paramText(P) { return P.v === 'op' ? O.text(P.op) : '<cond>'; }
function actionText(a) {
  switch (a.t) {
    case 'coil': return ({ COIL: '( ', NCOIL: '(/ ', SET: '(S ', RESET: '(R ' })[a.kind] + O.text(a.op) + ' )';
    case 'move': return '[MOVE ' + O.text(a.src) + ' => ' + a.dst.map(O.text).join(',') + ']';
    case 'math': return '[' + a.fn + ' ' + O.text(a.a) + ' ' + C.MATH_SYM[a.fn] + ' ' + O.text(a.b) + ' => ' + O.text(a.dst) + ']';
    case 'box': {
      const B = C.BOXES[a.name]; const ps = [];
      for (const k of [...B.valIn, ...B.flowIn, ...B.valOut, ...B.boolOut]) if (a.params[k]) ps.push(k + '=' + paramText(a.params[k]));
      return '[' + a.name + ' ' + O.text(a.inst) + (ps.length ? ' ' + ps.join(' ') : '') + ']';
    }
    case 'call': return '[CALL ' + a.name + (a.inst ? ' ' + O.text(a.inst) : '') + ']';
    default: return '[' + (a.label || a.t) + ']';
  }
}
function actionBlock(a) {
  const own = leaf(actionText(a));
  if (!a.next || !a.next.length) return own;
  const nx = a.next.map(flowBlock);
  return seq([own, nx.length === 1 ? nx[0] : par(nx)]);
}
function flowBlock(f) {
  const parts = [];
  if (f.cond && f.cond.t !== 'true') parts.push(condBlock(f.cond));
  const acts = f.then.map(actionBlock);
  parts.push(acts.length === 1 ? acts[0] : par(acts));
  return seq(parts);
}
function renderNetwork(flows) {
  const out = [];
  for (const f of flows) {
    const b = flowBlock(f);
    out.push(b.lines.map((l, r) => '|' + (r === b.mid ? '-' : ' ') + l).join('\n'));
  }
  return out.join('\n\n');
}

module.exports = { renderNetwork };
