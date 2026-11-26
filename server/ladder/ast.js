'use strict';
// Walk helpers over the Ladder AST.
//   f(op, mode, node) with mode: 'r' read, 'w' write, 'rw', 'inst' (timer/counter/FB instance), 'mem' (edge memory)
const C = require('./catalog');
const L = require('./learn');

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
    case 'edgeContact': walkOp(n.op, 'r', n, f); walkOp(n.mem, 'mem', n, f); break;
    case 'range': n.inputs.forEach(op => walkOp(op, 'r', n, f)); break;
    case 'cmp': walkOp(n.a, 'r', n, f); walkOp(n.b, 'r', n, f); break;
    case 'and': case 'or': n.items.forEach(x => walkCond(x, f)); break;
    default:
  }
}
function walkParam(P, mode, f) {
  if (!P) return;
  if (P.v === 'op') walkOp(P.op, mode, P, f); else walkCond(P.cond, f);
}
function walkAction(a, f, calleeMap) {
  switch (a.t) {
    case 'coil': walkOp(a.op, 'w', a, f); break;
    case 'move': walkOp(a.src, 'r', a, f); a.dst.forEach(d => walkOp(d, 'w', a, f)); break;
    case 'math': C.mathInputs(a).forEach(op => walkOp(op, 'r', a, f)); walkOp(a.dst, 'w', a, f); break;
    case 'shift': walkOp(a.src, 'r', a, f); walkOp(a.count, 'r', a, f); walkOp(a.dst, 'w', a, f); break;
    case 'select': walkParam(a.gate, 'r', f); a.inputs.forEach(op => walkOp(op, 'r', a, f)); walkOp(a.dst, 'w', a, f); break;
    case 'latch': walkParam(a.secondary, 'r', f); walkOp(a.op, 'rw', a, f); walkOp(a.out, 'w', a, f); break;
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
      const params = L.lookupCall(calleeMap, a.name)?.params || a.params;
      const args = Object.entries(a.args).map(([name, value]) => {
        const pin = params?.find(p => p.name.toLowerCase() === name.toLowerCase());
        const mode = pin ? ({ Input: 'r', Output: 'w', Return: 'w', InOut: 'rw' })[pin.section] : (params ? 'r' : 'rw');
        return { value, mode: mode || 'rw' };
      });
      for (const { value, mode } of args) if (mode !== 'w') walkParam(value, mode, f);
      for (const { value, mode } of args) if (mode === 'w') walkParam(value, mode, f);
      break;
    }
    default:
  }
  for (const fl of (a.next || [])) walkFlow(fl, f, calleeMap);
}
function walkFlow(fl, f, calleeMap) {
  walkCond(fl.cond, f);
  fl.then.forEach(a => walkAction(a, f, calleeMap));
}
function walkFlows(flows, f, calleeMap) { flows.forEach(fl => walkFlow(fl, f, calleeMap)); }

module.exports = { walkFlows, walkFlow, walkCond, walkAction };
