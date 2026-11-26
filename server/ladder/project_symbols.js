'use strict';

const O = require('./operand');
const X = require('./xml');

const arrayType = /^Array\s*\[([^\]]+)\]\s*of\s+(.+)$/i;
const unquote = type => type.trim().replace(/^"|"$/g, '');
const fold = name => name.toLowerCase();

function membersOf(sections, insensitive = false) {
  const root = new Map();
  for (const member of Object.values(sections).flat()) {
    let children = root;
    const path = member.name.split('.');
    for (const [i, name] of path.entries()) {
      const key = insensitive ? fold(name) : name;
      if (!children.has(key)) children.set(key, { name, children: new Map() });
      const node = children.get(key);
      if (i === path.length - 1) Object.assign(node, member, { name });
      children = node.children;
    }
  }
  return root;
}

function readTags(table) {
  return X.descendants(table, 'SW.Tags.PlcTag').map(tag => {
    const attr = name => X.textOf(X.path(tag, 'AttributeList/' + name)).trim();
    const name = attr('Name');
    const type = attr('DataTypeName') || attr('DataType');
    if (!name || !type) throw new Error('PLC tag requires Name and DataTypeName');
    return { name, type };
  });
}

function add(map, name, value, label) {
  if (!name) throw new Error('Missing ' + label + ' name');
  const key = fold(name);
  if (map.has(key)) throw new Error('Duplicate ' + label + ': ' + name);
  map.set(key, value);
}

function createSymbols() {
  const globals = new Map();
  const udts = new Map();

  function resolve(op, locals) {
    if (op.k === 'abs') return { type: op.type, op };
    if (op.k !== 'local' && op.k !== 'global') return {};
    const global = op.k === 'global';
    let children = global ? globals : locals;
    let inherited;
    let node;
    let type;
    let indexed = false;
    let inheritedStart;
    const names = [];
    for (const [i, name] of op.path.entries()) {
      const base = inherited?.get(fold(name));
      const own = children?.get(global ? fold(name) : name);
      if (!base && !own) {
        const timer = /^(TON|TOF|TP|TONR)(?:_|$)/i.test(type || '');
        const counter = /^(CTU|CTD|CTUD)(?:_|$)/i.test(type || '');
        const pins = timer ? { Q: 'Bool', IN: 'Bool', PT: 'Time', ET: 'Time' } : counter ? { QU: 'Bool', QD: 'Bool', CV: 'DInt', PV: 'DInt' } : {};
        if (i === op.path.length - 1 && !op.idx?.[i] && !op.slice && Object.hasOwn(pins, name)) return { type: pins[name], op };
        return { error: 'Unknown ' + (i ? 'member' : global ? 'global' : 'local') };
      }
      node = base && own ? { ...base, ...own } : own || base;
      inheritedStart = base?.startValue;
      names.push(node.name);
      if (!node.type) return { error: 'Missing member type' };
      type = node.type;
      const array = arrayType.exec(type.trim());
      const indices = op.idx?.[i];
      indexed = !!indices;
      if (indices) {
        if (!array) return { error: 'Cannot index ' + type };
        const dims = array[1].split(',').map(dim => /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(dim));
        if (dims.length !== indices.length) return { error: 'Expected ' + dims.length + ' array indices' };
        for (const [d, index] of indices.entries()) {
          if (index.k !== 'lit') continue;
          const radix = /^(2|8|16)#([\da-f_]+)$/i.exec(index.value);
          const value = radix ? parseInt(radix[2].replaceAll('_', ''), Number(radix[1])) : Number(index.value.replaceAll('_', ''));
          if (!Number.isSafeInteger(value)) return { error: 'Array index must be an integer' };
          if (dims[d] && (value < Number(dims[d][1]) || value > Number(dims[d][2]))) {
            return { error: 'Array index ' + value + ' outside ' + dims[d][1] + '..' + dims[d][2] };
          }
        }
        type = array[2];
      } else if (array && i < op.path.length - 1) {
        return { error: 'Array member access requires indices' };
      }
      children = own?.children;
      const declaredType = udts.get(fold(unquote(type)));
      if (!declaredType && /^".*"$/.test(type.trim())) return { error: 'Missing UDT ' + type + ' for' };
      inherited = declaredType || base?.children;
    }
    const aggregate = (!indexed && arrayType.test(type)) || !!(children?.size || inherited?.size) || /^Struct$/i.test(type);
    let start = aggregate || indexed ? undefined : (node.startValue ?? inheritedStart);
    if (op.slice) {
      const width = { BYTE: 8, SINT: 8, USINT: 8, WORD: 16, INT: 16, UINT: 16, DWORD: 32, DINT: 32, UDINT: 32 }[type.toUpperCase()];
      const slice = O.parseSlice(op.slice);
      const bits = { X: 1, B: 8, W: 16, D: 32 }[slice.kind];
      if (!width || (slice.index + 1) * bits > width) return { error: 'Invalid slice for ' + type };
      type = O.sliceType(op.slice);
      start = undefined;
    }
    return { type, aggregate, start, op: global ? O.global(names, op.idx, op.slice) : op };
  }

  return {
    addDb(name, sections) { add(globals, name, { name, type: 'Struct', children: membersOf(sections, true) }, 'global'); },
    addUdt(name, sections) { add(udts, name, membersOf(sections, true), 'UDT'); },
    addTags(table) { for (const tag of readTags(table)) add(globals, tag.name, tag, 'global'); },
    resolve,
  };
}

function validateOperand(op, resolve, where, allowAggregate = false) {
  for (const indices of Object.values(op.idx || {})) {
    for (const index of indices) {
      if (index.k === 'lit') continue;
      const type = validateOperand(index, resolve, where);
      if (!/^(?:U?(?:S|D|L)?Int|Byte|(?:D|L)?Word)$/i.test(type)) throw new Error(where + ': non-integer index ' + O.text(index));
    }
  }
  const found = resolve(op);
  const message = found.error || (!found.type ? 'Expected a variable' : null) ||
    (found.aggregate && !allowAggregate ? 'Expected a scalar member' : null);
  if (message) throw new Error(where + ': ' + message + ' ' + O.text(op));
  return found.type;
}

const integerRanges = {
  sint: [-128, 127], usint: [0, 255], byte: [0, 255],
  int: [-32768, 32767], uint: [0, 65535], word: [0, 65535],
  dint: [-2147483648, 2147483647], udint: [0, 4294967295], dword: [0, 4294967295],
};

function acceptsValue(type, value, parseTime) {
  const kind = type.toLowerCase();
  if (kind === 'bool') return typeof value === 'boolean' || value === 0 || value === 1;
  if (/^(time|ltime|s5time)$/.test(kind)) return (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && /^(?:T|LT|TIME|LTIME|S5T|S5TIME)#/i.test(value) && parseTime(value) !== null);
  if (/^(?:w?string|w?char)(?:\[|$)/.test(kind)) return typeof value === 'string';
  const range = Object.hasOwn(integerRanges, kind) && integerRanges[kind];
  if (range) return Number.isInteger(value) && value >= range[0] && value <= range[1];
  if (/^(l?real)$/.test(kind)) return typeof value === 'number' && Number.isFinite(value);
  if (/^(u?lint|lword)$/.test(kind)) return Number.isSafeInteger(value) && (kind === 'lint' || value >= 0);
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';
}

module.exports = { createSymbols, membersOf, validateOperand, acceptsValue };
