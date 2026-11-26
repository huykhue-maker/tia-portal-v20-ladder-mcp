'use strict';
// Operand model shared by the DSL, the XML generator, the reader, the analyzer and the simulator.
//   local  : #Var / #Struct.Member / #Arr[#i]   -> Access Scope="LocalVariable"
//   global : "Tag" / "DB".Member / "DB".Arr[0]  -> Access Scope="GlobalVariable"
//   abs    : %I0.0 %QW64 %MB10 %IW10:Int        -> Access Scope="Address"
//   lit    : TRUE 5 2.5 T#3s 16#FF              -> Access Scope="LiteralConstant"

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fmtName = n => (SIMPLE.test(n) ? n : '"' + n + '"');

const SLICE_LIMITS = { X: 63, B: 7, W: 3, D: 1 };
const SLICE_TYPES = { X: 'Bool', B: 'Byte', W: 'Word', D: 'DWord' };
function parseSlice(raw) {
  if (!raw) return null;
  const m = /^([XBWD])(\d+)$/i.exec(String(raw).trim());
  if (!m) return null;
  const kind = m[1].toUpperCase(), index = parseInt(m[2], 10);
  if (index < 0 || index > SLICE_LIMITS[kind]) return null;
  return { kind, index, text: kind + index };
}
function sliceType(raw) {
  const s = parseSlice(raw);
  return s ? SLICE_TYPES[s.kind] : null;
}

function local(path, idx, slice) {
  const op = { k: 'local', path: Array.isArray(path) ? path : [path] };
  if (idx && Object.keys(idx).length) op.idx = idx;
  const s = parseSlice(slice);
  if (s) op.slice = s.text;
  return op;
}
function global(path, idx, slice) {
  const op = { k: 'global', path: Array.isArray(path) ? path : [path] };
  if (idx && Object.keys(idx).length) op.idx = idx;
  const s = parseSlice(slice);
  if (s) op.slice = s.text;
  return op;
}
const lit = (type, value) => ({ k: 'lit', type, value: String(value) });
function abs(area, type, bitOffset) { return { k: 'abs', area, type, bitOffset }; }

const AREA_LETTER = { Input: 'I', Output: 'Q', Memory: 'M', PeripheryInput: 'I', PeripheryOutput: 'Q' };
const WIDTH_OF = { Bool: 'X', Byte: 'B', USInt: 'B', SInt: 'B', Char: 'B', Word: 'W', Int: 'W', UInt: 'W', WChar: 'W', DWord: 'D', DInt: 'D', UDInt: 'D', Real: 'D', Time: 'D' };
const DEFAULT_TYPE_OF_WIDTH = { X: 'Bool', B: 'Byte', W: 'Word', D: 'DWord' };

function fmtComp(name, i, idxMap, isFirstGlobal) {
  const base = isFirstGlobal ? '"' + name + '"' : fmtName(name);
  const dims = idxMap && idxMap[i];
  if (!dims || !dims.length) return base;
  return base + '[' + dims.map(text).join(', ') + ']';
}

function text(op) {
  if (!op) return '?';
  switch (op.k) {
    case 'local':
      return '#' + op.path.map((p, i) => fmtComp(p, i, op.idx, false)).join('.') + (op.slice ? '.%' + op.slice : '');
    case 'global':
      return op.path.map((p, i) => fmtComp(p, i, op.idx, i === 0)).join('.') + (op.slice ? '.%' + op.slice : '');
    case 'abs': {
      const w = WIDTH_OF[op.type] || 'W';
      const letter = AREA_LETTER[op.area] || '?';
      const byte = Math.floor(op.bitOffset / 8), bit = op.bitOffset % 8;
      let s = '%' + letter + (w === 'X' ? '' : w) + byte + (w === 'X' ? '.' + bit : '');
      if (w !== 'X' && DEFAULT_TYPE_OF_WIDTH[w] !== op.type) s += ':' + op.type;
      return s;
    }
    case 'lit': return op.value;
    case 'raw': return op.value;
    default: return '?';
  }
}
function key(op) { return text(op); }
function isLocal(op) { return op && op.k === 'local'; }

// Infer a basic type from a literal (null when not a literal)
function literalType(op) {
  if (!op || op.k !== 'lit') return null;
  if (op.type && op.type !== 'auto') return op.type;
  return null;
}

module.exports = { local, global, lit, abs, text, key, isLocal, literalType, fmtName, parseSlice, sliceType, WIDTH_OF, DEFAULT_TYPE_OF_WIDTH, AREA_LETTER };
