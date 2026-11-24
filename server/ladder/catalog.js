'use strict';
// Static knowledge about LAD instructions (pins, DSL names, default XML templates).
// Defaults can be overridden by "learned" signatures harvested from real exported blocks
// (see learn.js) so the generator follows what THIS TIA Portal installation really writes.

const REL = { EQ: 'Eq', NE: 'Ne', GT: 'Gt', LT: 'Lt', GE: 'Ge', LE: 'Le' };
const REL_FROM_PART = { Eq: 'EQ', Ne: 'NE', Gt: 'GT', Lt: 'LT', Ge: 'GE', Le: 'LE' };
const REL_SYM = { EQ: '==', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=' };
const MATH = { ADD: 'Add', SUB: 'Sub', MUL: 'Mul', DIV: 'Div', MOD: 'Mod' };
const MATH_FROM_PART = { Add: 'ADD', Sub: 'SUB', Mul: 'MUL', Div: 'DIV', Mod: 'MOD' };
const MATH_SYM = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: 'MOD' };

const COILS = {
  COIL: { part: 'Coil', neg: false, sym: '( )' },
  NCOIL: { part: 'Coil', neg: true, sym: '(/)' },
  SET: { part: 'SCoil', neg: false, sym: '(S)' },
  RESET: { part: 'RCoil', neg: false, sym: '(R)' },
};

// Timers / counters: Part + Instance
const BOXES = {
  TON: { main: 'IN', flowIn: [], valIn: ['PT'], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  TOF: { main: 'IN', flowIn: [], valIn: ['PT'], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  TP: { main: 'IN', flowIn: [], valIn: ['PT'], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  TONR: { main: 'IN', flowIn: ['R'], valIn: ['PT'], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  CTU: { main: 'CU', flowIn: ['R'], valIn: ['PV'], valOut: ['CV'], boolOut: ['QU'], flowOut: 'QU', kind: 'counter', defType: 'Int', posParams: ['PV'] },
  CTD: { main: 'CD', flowIn: ['LD'], valIn: ['PV'], valOut: ['CV'], boolOut: ['QD'], flowOut: 'QD', kind: 'counter', defType: 'Int', posParams: ['PV'] },
  CTUD: { main: 'CU', flowIn: ['CD', 'R', 'LD'], valIn: ['PV'], valOut: ['CV'], boolOut: ['QU', 'QD'], flowOut: 'QU', kind: 'counter', defType: 'Int', posParams: ['PV'] },
};
function boxInstanceType(name, type) {
  const b = BOXES[name];
  if (b.kind === 'timer') return name + '_' + (type === 'LTime' ? 'LTIME' : 'TIME');
  return name + '_' + String(type || 'Int').toUpperCase();
}

const COND_FUNCS = new Set(['NO', 'NC', 'NOT', 'RTRIG', 'FTRIG', 'TRUE', 'EQ', 'NE', 'GT', 'LT', 'GE', 'LE']);
const ACTION_FUNCS = new Set(['COIL', 'NCOIL', 'SET', 'RESET', 'MOVE', 'CALL', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'TON', 'TOF', 'TP', 'TONR', 'CTU', 'CTD', 'CTUD']);

// Pin direction knowledge for reading unknown/known parts
const OUT_PIN = /^(out\d*|eno|Q|ET|QU|QD|CV|ret_val)$/i;
function isOutputPin(pin) { return OUT_PIN.test(pin); }

const PART_KIND = {
  Contact: 'cond', PBox: 'cond', NBox: 'cond', Not: 'cond',
  Eq: 'cond', Ne: 'cond', Gt: 'cond', Lt: 'cond', Ge: 'cond', Le: 'cond',
  Coil: 'action', SCoil: 'action', RCoil: 'action', Move: 'action',
  Add: 'action', Sub: 'action', Mul: 'action', Div: 'action', Mod: 'action',
  TON: 'action', TOF: 'action', TP: 'action', TONR: 'action', CTU: 'action', CTD: 'action', CTUD: 'action',
};
const COND_FLOW_IN = { Contact: 'in', PBox: 'in', NBox: 'in', Not: 'in', Eq: 'pre', Ne: 'pre', Gt: 'pre', Lt: 'pre', Ge: 'pre', Le: 'pre' };
const ACTION_FLOW_IN = { Coil: 'in', SCoil: 'in', RCoil: 'in', Move: 'en', Add: 'en', Sub: 'en', Mul: 'en', Div: 'en', Mod: 'en' };

// Default XML templates (overridable by learned data)
const DEFAULT_TEMPLATES = {
  Eq: [['SrcType', 'Type']], Ne: [['SrcType', 'Type']], Gt: [['SrcType', 'Type']], Lt: [['SrcType', 'Type']], Ge: [['SrcType', 'Type']], Le: [['SrcType', 'Type']],
  Move: [['Card', 'Cardinality']],
  Add: [['Card', 'Cardinality'], ['SrcType', 'Type']], Sub: [['Card', 'Cardinality'], ['SrcType', 'Type']],
  Mul: [['Card', 'Cardinality'], ['SrcType', 'Type']], Div: [['SrcType', 'Type']], Mod: [['SrcType', 'Type']],
  CTU: [['value_type', 'Type']], CTD: [['value_type', 'Type']], CTUD: [['value_type', 'Type']],
};
const DEFAULT_VERSION = { TON: '1.0', TOF: '1.0', TP: '1.0', TONR: '1.0', CTU: '1.0', CTD: '1.0', CTUD: '1.0' };

function templatesFor(partName, ctx, learned) {
  const L = learned && learned.parts && learned.parts[partName];
  let defs;
  if (L && L.templates) defs = L.templates.map(t => [t.name, t.type, t.value]);
  else defs = DEFAULT_TEMPLATES[partName] || [];
  return defs.map(d => {
    const [name, type, value] = d;
    let v = value;
    if (type === 'Type') v = ctx.type;
    else if (type === 'Cardinality') v = String(ctx.card !== undefined ? ctx.card : (value || '1'));
    return { name, type, value: v };
  });
}
function versionFor(partName, learned) {
  const L = learned && learned.parts && learned.parts[partName];
  if (L && L.version !== undefined) return L.version;
  return DEFAULT_VERSION[partName];
}

module.exports = {
  REL, REL_FROM_PART, REL_SYM, MATH, MATH_FROM_PART, MATH_SYM, COILS, BOXES, boxInstanceType,
  COND_FUNCS, ACTION_FUNCS, isOutputPin, PART_KIND, COND_FLOW_IN, ACTION_FLOW_IN, templatesFor, versionFor,
};
