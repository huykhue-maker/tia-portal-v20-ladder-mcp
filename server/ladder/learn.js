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
      learned.calls[ci.attrs.Name] = {
        blockType: ci.attrs.BlockType,
        version: ci.attrs.Version,
        params: X.kids(ci, 'Parameter').map(p => ({ name: p.attrs.Name, section: p.attrs.Section, type: p.attrs.Type })),
        source: 'network',
      };
    }
  }
}

// Interface of an FB/FC block -> call catalog entry
function callEntryFromInterface(blockType, iface) {
  const params = [];
  for (const sec of ['Input', 'Output', 'InOut']) {
    for (const m of (iface[sec] || [])) if (!m.name.includes('.')) params.push({ name: m.name, section: sec, type: m.type });
  }
  return { blockType, params, source: 'interface' };
}

module.exports = { emptyLearned, learnFlgNet, callEntryFromInterface };
