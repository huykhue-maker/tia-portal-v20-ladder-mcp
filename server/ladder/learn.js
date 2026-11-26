'use strict';
// Harvest real signatures from exported blocks so the generator mirrors what THIS TIA Portal writes.
const X = require('./xml');

function emptyLearned() { return { parts: {}, calls: {}, version: 1 }; }

function learnFlgNet(flg, learned) {
  const partsEl = X.kid(flg, 'Parts');
  if (!partsEl) return;
  for (const el of partsEl.children) {
    if (el.name === 'Part') {
      const name = el.attrs.Name;
      const templates = X.kids(el, 'TemplateValue').map(t => ({ name: t.attrs.Name, type: t.attrs.Type, value: X.textOf(t) }));
      learned.parts[name] = { version: el.attrs.Version, templates, instance: !!X.kid(el, 'Instance'), seen: ((learned.parts[name] || {}).seen || 0) + 1 };
    } else if (el.name === 'Call') {
      const ci = X.kid(el, 'CallInfo');
      if (!ci || !ci.attrs.Name) continue;
      const entry = {
        blockType: ci.attrs.BlockType,
        version: ci.attrs.Version,
        params: X.kids(ci, 'Parameter').map(p => ({ name: p.attrs.Name, section: p.attrs.Section, type: p.attrs.Type })),
        source: 'network',
      };
      const previous = learned.calls[ci.attrs.Name];
      learned.calls[ci.attrs.Name] = previous && previous.source === 'interface'
        ? { ...previous, version: entry.version || previous.version }
        : entry;
    }
  }
}

// Interface of an FB/FC block -> call catalog entry
function callEntryFromInterface(blockType, iface) {
  const params = [];
  const sections = blockType === 'FC' ? ['Input', 'Output', 'InOut', 'Return'] : ['Input', 'Output', 'InOut'];
  for (const sec of sections) {
    for (const m of (iface[sec] || [])) {
      if (!m.name.includes('.') && (sec !== 'Return' || (m.type && !/^Void$/i.test(m.type)))) {
        params.push({ name: m.name, section: sec, type: m.type });
      }
    }
  }
  return { blockType, params, source: 'interface' };
}

function rememberCallInterface(calls, name, blockType, iface) {
  const entry = callEntryFromInterface(blockType, iface);
  if (calls[name] && calls[name].version) entry.version = calls[name].version;
  calls[name] = entry;
  return entry;
}

function lookupCall(calls, name) {
  if (!calls) return null;
  if (Object.prototype.hasOwnProperty.call(calls, name)) return calls[name];
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(calls, lower)) return calls[lower];
  const key = Object.keys(calls).find(k => k.toLowerCase() === lower);
  return key === undefined ? null : calls[key];
}

module.exports = { emptyLearned, learnFlgNet, callEntryFromInterface, rememberCallInterface, lookupCall };
