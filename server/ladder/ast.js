'use strict';
// Walk helpers over the Ladder AST.
//   f(op, mode, node) with mode: 'r' read, 'w' write, 'rw', 'inst' (timer/counter/FB instance), 'mem' (edge memory)
const C = require('./catalog');

function walkOp(op, mode, node, f) {
  if (!op) return;
  if (op.idx) {
    for (const dims of Object.values(op.idx)) {
      for (const idxOp of (dims || [])) walkOp(idxOp, 'r', node, f);
    }
  }
  f(op, mode, node);
}

function walkCond(n, f) {
  if (!n) return;
  switch (n.t) {
    case 'contact': walkOp(n.op, 'r', n, f); break;
    case 'rtrig': case 'ftrig': walkOp(n.mem, 'mem', n, f); break;
    case 'cmp': walkOp(n.a, 'r', n, f); walkOp(n.b, 'r', n, f); break;
    case 'and': case 'or': n.items.forEach(x => walkCond(x, f)); break;
    default:
  }
}
function walkParam(P, mode, f) {
  if (!P) return;
  if (P.v === 'op') walkOp(P.op, mode, P, f); else walkCond(P.cond, f);
}
function walkAction(a, f) {
  switch (a.t) {
    case 'coil': walkOp(a.op, 'w', a, f); break;
    case 'move': walkOp(a.src, 'r', a, f); a.dst.forEach(d => walkOp(d, 'w', a, f)); break;
    case 'math': walkOp(a.a, 'r', a, f); walkOp(a.b, 'r', a, f); walkOp(a.dst, 'w', a, f); break;
    case 'unary': walkOp(a.src, 'r', a, f); walkOp(a.dst, 'w', a, f); break;
    case 'conv': a.ins.forEach(x => walkOp(x, 'r', a, f)); walkOp(a.out, 'w', a, f); break;
    case 'box': {
      walkOp(a.inst, 'inst', a, f);
      for (const k of Object.keys(a.params)) {
        const out = ['ET', 'CV', 'Q', 'QU', 'QD'].includes(k) || C.MOTION_OUT_PINS.has(k);
        const mode = k === 'Axis' ? 'rw' : (out ? 'w' : 'r');
        walkParam(a.params[k], mode, f);
      }
      break;
    }
    case 'call': {
      if (a.inst) walkOp(a.inst, 'inst', a, f);
      for (const k of Object.keys(a.args)) walkParam(a.args[k], 'rw', f);
      break;
    }
    default:
  }
  for (const fl of (a.next || [])) walkFlow(fl, f);
}
function walkFlow(fl, f) {
  walkCond(fl.cond, f);
  fl.then.forEach(a => walkAction(a, f));
}
function walkFlows(flows, f) { flows.forEach(fl => walkFlow(fl, f)); }

module.exports = { walkFlows, walkFlow, walkCond, walkAction };
