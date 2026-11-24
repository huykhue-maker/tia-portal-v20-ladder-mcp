'use strict';
// Static knowledge about LAD instructions (pins, DSL names, default XML templates).
// Defaults can be overridden by "learned" signatures harvested from real exported blocks
// (see learn.js) so the generator follows what THIS TIA Portal installation really writes.

const REL = { EQ: 'Eq', NE: 'Ne', GT: 'Gt', LT: 'Lt', GE: 'Ge', LE: 'Le' };
const REL_FROM_PART = { Eq: 'EQ', Ne: 'NE', Gt: 'GT', Lt: 'LT', Ge: 'GE', Le: 'LE' };
const REL_SYM = { EQ: '==', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=' };

const MATH = { ADD: 'Add', SUB: 'Sub', MUL: 'Mul', DIV: 'Div', MOD: 'Mod', MIN: 'Min', MAX: 'Max' };
const MATH_FROM_PART = { Add: 'ADD', Sub: 'SUB', Mul: 'MUL', Div: 'DIV', Mod: 'MOD', Min: 'MIN', Max: 'MAX' };
const MATH_SYM = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: 'MOD', MIN: 'MIN', MAX: 'MAX' };

// Unary math & trig: FN(in, out[, Type]) -> <Part Name="..."><TemplateValue Name="SrcType" Type="Type">...</TemplateValue></Part>
const UNARY_MATH = {
  SIN: 'Sin', COS: 'Cos', TAN: 'Tan', ASIN: 'ASin', ACOS: 'ACos', ATAN: 'ATan',
  SQRT: 'Sqrt', SQR: 'Sqr', ABS: 'Abs', EXP: 'Exp', LN: 'Ln',
  TRUNC: 'Trunc', ROUND: 'Round', CEIL: 'Ceil', FLOOR: 'Floor',
};
const UNARY_FROM_PART = {};
for (const [k, v] of Object.entries(UNARY_MATH)) UNARY_FROM_PART[v] = k;

// Conversion & scaling instructions
const CONV_OPS = {
  CONV: { part: 'Convert', ins: ['in'], outs: ['out'], dualType: true, defSrc: 'Int', defDest: 'Real' },
  NORM_X: { part: 'Normalize', ins: ['min', 'value', 'max'], outs: ['out'], dualType: true, defSrc: 'Int', defDest: 'Real' },
  SCALE_X: { part: 'Scale_X', ins: ['min', 'value', 'max'], outs: ['out'], dualType: true, defSrc: 'Real', defDest: 'Real' },
  LIMIT: { part: 'Limit', ins: ['mn', 'in', 'mx'], outs: ['out'], dualType: false, defSrc: 'Real' },
};
const CONV_FROM_PART = {};
for (const [k, v] of Object.entries(CONV_OPS)) CONV_FROM_PART[v.part] = k;

const COILS = {
  COIL: { part: 'Coil', neg: false, sym: '( )' },
  NCOIL: { part: 'Coil', neg: true, sym: '(/)' },
  SET: { part: 'SCoil', neg: false, sym: '(S)' },
  RESET: { part: 'RCoil', neg: false, sym: '(R)' },
};

// Timers / counters / Motion Control technology boxes: Part + Instance
const BOXES = {
  TON: { main: 'IN', flowIn: [], valIn: ['PT'], optIn: [], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  TOF: { main: 'IN', flowIn: [], valIn: ['PT'], optIn: [], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  TP: { main: 'IN', flowIn: [], valIn: ['PT'], optIn: [], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  TONR: { main: 'IN', flowIn: ['R'], valIn: ['PT'], optIn: [], valOut: ['ET'], boolOut: ['Q'], flowOut: 'Q', kind: 'timer', defType: 'Time', posParams: ['PT'] },
  CTU: { main: 'CU', flowIn: ['R'], valIn: ['PV'], optIn: [], valOut: ['CV'], boolOut: ['QU'], flowOut: 'QU', kind: 'counter', defType: 'Int', posParams: ['PV'] },
  CTD: { main: 'CD', flowIn: ['LD'], valIn: ['PV'], optIn: [], valOut: ['CV'], boolOut: ['QD'], flowOut: 'QD', kind: 'counter', defType: 'Int', posParams: ['PV'] },
  CTUD: { main: 'CU', flowIn: ['CD', 'R', 'LD'], valIn: ['PV'], optIn: [], valOut: ['CV'], boolOut: ['QU', 'QD'], flowOut: 'QU', kind: 'counter', defType: 'Int', posParams: ['PV'] },

  // Siemens S7-1200 / S7-1500 Motion Control Technology Instructions (V7.0 default in TIA V20)
  MC_POWER: {
    partName: 'MC_Power', main: 'en', flowIn: ['Enable'], valIn: ['Axis'], optIn: ['StartMode', 'StopMode'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['Status', 'Busy', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_Power',
  },
  MC_RESET: {
    partName: 'MC_Reset', main: 'en', flowIn: ['Execute'], valIn: ['Axis'], optIn: ['Restart'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['Done', 'Busy', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_Reset',
  },
  MC_HOME: {
    partName: 'MC_Home', main: 'en', flowIn: ['Execute'], valIn: ['Axis'], optIn: ['Position', 'Mode'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['Done', 'Busy', 'CommandAborted', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_Home',
  },
  MC_MOVEABSOLUTE: {
    partName: 'MC_MoveAbsolute', main: 'en', flowIn: ['Execute'], valIn: ['Axis'], optIn: ['Position', 'Velocity', 'Direction'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['Done', 'Busy', 'CommandAborted', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_MoveAbsolute',
  },
  MC_MOVERELATIVE: {
    partName: 'MC_MoveRelative', main: 'en', flowIn: ['Execute'], valIn: ['Axis'], optIn: ['Distance', 'Velocity'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['Done', 'Busy', 'CommandAborted', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_MoveRelative',
  },
  MC_MOVEVELOCITY: {
    partName: 'MC_MoveVelocity', main: 'en', flowIn: ['Execute'], valIn: ['Axis'], optIn: ['Velocity', 'Direction', 'Current'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['InVelocity', 'Busy', 'CommandAborted', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_MoveVelocity',
  },
  MC_MOVEJOG: {
    partName: 'MC_MoveJog', main: 'en', flowIn: ['JogForward', 'JogBackward'], valIn: ['Axis'], optIn: ['Velocity', 'PositionControlled'],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['InVelocity', 'Busy', 'CommandAborted', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_MoveJog',
  },
  MC_HALT: {
    partName: 'MC_Halt', main: 'en', flowIn: ['Execute'], valIn: ['Axis'], optIn: [],
    valOut: ['ErrorID', 'ErrorInfo'], boolOut: ['Done', 'Busy', 'CommandAborted', 'Error'], flowOut: 'eno', kind: 'motion', defType: 'Void', posParams: ['Axis'], instType: 'MC_Halt',
  },
};

const BOX_FROM_PART = {};
for (const [k, v] of Object.entries(BOXES)) BOX_FROM_PART[v.partName || k] = k;

function boxInstanceType(name, type) {
  const b = BOXES[name];
  if (!b) return name;
  if (b.instType) return b.instType;
  if (b.kind === 'timer') return name + '_' + (type === 'LTime' ? 'LTIME' : 'TIME');
  return name + '_' + String(type || 'Int').toUpperCase();
}

const COND_FUNCS = new Set(['NO', 'NC', 'NOT', 'RTRIG', 'FTRIG', 'TRUE', 'EQ', 'NE', 'GT', 'LT', 'GE', 'LE']);
const ACTION_FUNCS = new Set([
  'COIL', 'NCOIL', 'SET', 'RESET', 'MOVE', 'CALL',
  ...Object.keys(MATH),
  ...Object.keys(UNARY_MATH),
  ...Object.keys(CONV_OPS),
  ...Object.keys(BOXES),
]);

// Pin direction knowledge for reading unknown/known parts
const MOTION_OUT_PINS = new Set(['Status', 'Done', 'Busy', 'Error', 'ErrorID', 'ErrorInfo', 'CommandAborted', 'InVelocity']);
const OUT_PIN = /^(out\d*|eno|Q|ET|QU|QD|CV|ret_val)$/i;
function isOutputPin(pin, partName) {
  if (OUT_PIN.test(pin)) return true;
  if (partName && BOX_FROM_PART[partName] && MOTION_OUT_PINS.has(pin)) return true;
  return false;
}

const PART_KIND = {
  Contact: 'cond', PBox: 'cond', NBox: 'cond', Not: 'cond', O: 'cond',
  Eq: 'cond', Ne: 'cond', Gt: 'cond', Lt: 'cond', Ge: 'cond', Le: 'cond',
  Coil: 'action', SCoil: 'action', RCoil: 'action', Move: 'action',
  Add: 'action', Sub: 'action', Mul: 'action', Div: 'action', Mod: 'action', Min: 'action', Max: 'action',
  TON: 'action', TOF: 'action', TP: 'action', TONR: 'action', CTU: 'action', CTD: 'action', CTUD: 'action',
};
for (const part of Object.values(UNARY_MATH)) PART_KIND[part] = 'action';
for (const info of Object.values(CONV_OPS)) PART_KIND[info.part] = 'action';
for (const info of Object.values(BOXES)) PART_KIND[info.partName || ''] = 'action';
delete PART_KIND[''];

const COND_FLOW_IN = { Contact: 'in', PBox: 'in', NBox: 'in', Not: 'in', Eq: 'pre', Ne: 'pre', Gt: 'pre', Lt: 'pre', Ge: 'pre', Le: 'pre' };
const ACTION_FLOW_IN = {
  Coil: 'in', SCoil: 'in', RCoil: 'in', Move: 'en',
  Add: 'en', Sub: 'en', Mul: 'en', Div: 'en', Mod: 'en', Min: 'en', Max: 'en',
};
for (const part of Object.values(UNARY_MATH)) ACTION_FLOW_IN[part] = 'en';
for (const info of Object.values(CONV_OPS)) ACTION_FLOW_IN[info.part] = 'en';

// Default XML templates (overridable by learned data)
// Note: In TIA Portal V20, Sub/Div/Mod do NOT take a Card template (only Add, Mul, Min, Max, Move, O do).
const DEFAULT_TEMPLATES = {
  O: [['Card', 'Cardinality']],
  Eq: [['SrcType', 'Type']], Ne: [['SrcType', 'Type']], Gt: [['SrcType', 'Type']], Lt: [['SrcType', 'Type']], Ge: [['SrcType', 'Type']], Le: [['SrcType', 'Type']],
  Move: [['Card', 'Cardinality']],
  Add: [['Card', 'Cardinality'], ['SrcType', 'Type']],
  Sub: [['SrcType', 'Type']],
  Mul: [['Card', 'Cardinality'], ['SrcType', 'Type']],
  Div: [['SrcType', 'Type']],
  Mod: [['SrcType', 'Type']],
  Min: [['Card', 'Cardinality'], ['SrcType', 'Type']],
  Max: [['Card', 'Cardinality'], ['SrcType', 'Type']],
  Convert: [['SrcType', 'Type'], ['DestType', 'DestType']],
  Normalize: [['SrcType', 'Type'], ['DestType', 'DestType']],
  Scale_X: [['SrcType', 'Type'], ['DestType', 'DestType']],
  Limit: [['SrcType', 'Type']],
  CTU: [['value_type', 'Type']], CTD: [['value_type', 'Type']], CTUD: [['value_type', 'Type']],
};
for (const part of Object.values(UNARY_MATH)) DEFAULT_TEMPLATES[part] = [['SrcType', 'Type']];

const DEFAULT_VERSION = {
  TON: '1.0', TOF: '1.0', TP: '1.0', TONR: '1.0', CTU: '1.0', CTD: '1.0', CTUD: '1.0',
  MC_Power: '7.0', MC_Reset: '7.0', MC_Home: '7.0', MC_MoveAbsolute: '7.0',
  MC_MoveRelative: '7.0', MC_MoveVelocity: '7.0', MC_MoveJog: '7.0', MC_Halt: '7.0',
};

// Parts that never carry a Card template in TIA Portal V20 FlgNet.
// Sub/Div/Mod are fixed 2-input boxes; emitting Card makes the import fail.
const NO_CARD_PARTS = new Set(['Sub', 'Div', 'Mod']);

function templatesFor(partName, ctx, learned) {
  const L = learned && learned.parts && learned.parts[partName];
  let defs;
  if (L && L.templates && L.templates.length) {
    // Mirror what this TIA installation really writes, but never propagate a
    // Card template onto fixed-arity Sub/Div/Mod parts (a learned Card there
    // is a stale signature and breaks XML import).
    defs = L.templates
      .filter(t => !(NO_CARD_PARTS.has(partName) && t.name === 'Card'))
      .map(t => [t.name, t.type, t.value]);
    if (NO_CARD_PARTS.has(partName) && !defs.some(d => d[0] === 'SrcType')) defs.push(['SrcType', 'Type']);
  } else {
    defs = DEFAULT_TEMPLATES[partName] || [];
  }
  return defs.map(d => {
    const [name, type, value] = d;
    let v = value;
    if (name === 'DestType' || type === 'DestType') v = ctx.destType || ctx.type;
    else if (type === 'Type') v = ctx.type;
    else if (type === 'Cardinality') v = String(ctx.card !== undefined ? ctx.card : (value || '1'));
    return { name, type: type === 'DestType' ? 'Type' : type, value: v };
  });
}
function versionFor(partName, learned) {
  const L = learned && learned.parts && learned.parts[partName];
  if (L && L.version !== undefined) return L.version;
  return DEFAULT_VERSION[partName];
}

module.exports = {
  REL, REL_FROM_PART, REL_SYM,
  MATH, MATH_FROM_PART, MATH_SYM,
  UNARY_MATH, UNARY_FROM_PART,
  CONV_OPS, CONV_FROM_PART,
  COILS, BOXES, BOX_FROM_PART, MOTION_OUT_PINS, boxInstanceType,
  COND_FUNCS, ACTION_FUNCS, isOutputPin, PART_KIND, COND_FLOW_IN, ACTION_FLOW_IN, templatesFor, versionFor,
};
