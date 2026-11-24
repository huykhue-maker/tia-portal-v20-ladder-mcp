'use strict';
// Walk helpers over the Ladder AST.
//   f(op, mode, node) with mode: 'r' read, 'w' write, 'rw', 'inst' (timer/counter/FB instance), 'mem' (edge memory)
function walkCond(n, f) {
  if (!n) return;
  switch (n.t) {
    case 'contact': f(n.op, 'r', n); break;
    case 'rtrig': case 'ftrig': f(n.mem, 'mem', n); break;
    case 'cmp': f(n.a, 'r', n); f(n.b, 'r', n); break;
    case 'and': case 'or': n.items.forEach(x => walkCond(x, f)); break;
    default:
  }
}
function walkParam(P, mode, f) {
  if (!P) return;
  if (P.v === 'op') f(P.op, mode, P); else walkCond(P.cond, f);
}
function walkAction(a, f) {
  switch (a.t) {
    case 'coil': f(a.op, 'w', a); break;
    case 'move': f(a.src, 'r', a); a.dst.forEach(d => f(d, 'w', a)); break;
    case 'math': f(a.a, 'r', a); f(a.b, 'r', a); f(a.dst, 'w', a); break;
    case 'box': {
      f(a.inst, 'inst', a);
      for (const k of Object.keys(a.params)) {
        const out = ['ET', 'CV', 'Q', 'QU', 'QD'].includes(k);
        walkParam(a.params[k], out ? 'w' : 'r', f);
      }
      break;
    }
    case 'call': {
      if (a.inst) f(a.inst, 'inst', a);
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
