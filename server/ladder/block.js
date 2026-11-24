'use strict';
// Block-level operations on exported SimaticML documents: parse, read as Ladder, patch single networks
// (all untouched XML is preserved byte-for-byte), edit the interface and create new LAD blocks.

const X = require('./xml');
const D = require('./dsl');
const G = require('./gen');
const R = require('./reader');
const L = require('./learn');
const O = require('./operand');
const A = require('./ast');
const render = require('./render');
const { E, ser } = X;

const IF_NS = 'http://www.siemens.com/automation/Openness/SW/Interface/v5';
const SECTION_ORDER = ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant', 'Return'];

// ---------------------------------------------------------------- parsing
function mlText(el, composition) {
  const ol = X.kid(el, 'ObjectList'); if (!ol) return '';
  const ml = ol.children.find(c => c.name === 'MultilingualText' && c.attrs.CompositionName === composition);
  if (!ml) return '';
  const items = X.descendants(ml, 'MultilingualTextItem');
  for (const it of items) { const t = X.textOf(X.path(it, 'AttributeList/Text')); if (t) return t; }
  return '';
}
function memberComment(m) {
  const c = X.kid(m, 'Comment'); if (!c) return '';
  const t = X.kid(c, 'MultiLanguageText'); return t ? X.textOf(t) : '';
}
function walkMembers(parent, prefix, arr) {
  for (const m of X.kids(parent, 'Member')) {
    const name = prefix + m.attrs.Name;
    arr.push({ name, type: m.attrs.Datatype || '', comment: memberComment(m) });
    walkMembers(m, name + '.', arr);
  }
}
function parseInterface(blockEl) {
  const out = {};
  const secs = X.path(blockEl, 'AttributeList/Interface/Sections');
  if (!secs) return out;
  for (const s of X.kids(secs, 'Section')) { const arr = []; walkMembers(s, '', arr); out[s.attrs.Name] = arr; }
  return out;
}
function allIds(el, acc) {
  if (el.attrs && el.attrs.ID !== undefined) acc.push(el.attrs.ID);
  for (const c of el.children) allIds(c, acc);
  return acc;
}
function parseBlock(src) {
  const root = X.parse(src);
  if (!root) throw new Error('empty XML');
  const blockEl = root.children.find(c => /^SW\.Blocks\./.test(c.name));
  if (!blockEl) throw new Error('No SW.Blocks.* element in document (root is <' + root.name + '>)');
  const al = X.kid(blockEl, 'AttributeList');
  const attr = n => X.textOf(X.kid(al, n));
  const ol = X.kid(blockEl, 'ObjectList');
  const networks = [];
  for (const u of (ol ? ol.children : [])) {
    if (u.name !== 'SW.Blocks.CompileUnit') continue;
    const ual = X.kid(u, 'AttributeList');
    const ns = X.kid(ual, 'NetworkSource');
    const srcEl = ns && ns.children[0];
    networks.push({
      index: networks.length + 1, el: u, id: u.attrs.ID,
      lang: X.textOf(X.kid(ual, 'ProgrammingLanguage')) || (srcEl && srcEl.name === 'FlgNet' ? 'LAD' : (srcEl ? srcEl.name : '')),
      sourceKind: srcEl ? srcEl.name : null, flg: srcEl && srcEl.name === 'FlgNet' ? srcEl : null, nsEl: ns,
      title: mlText(u, 'Title'), comment: mlText(u, 'Comment'),
    });
  }
  const cultureEl = X.descendants(root, 'Culture')[0];
  return {
    src, root, blockEl, kind: blockEl.name.replace('SW.Blocks.', ''), name: attr('Name'), number: attr('Number'),
    language: attr('ProgrammingLanguage'), memoryLayout: attr('MemoryLayout'), interface: parseInterface(blockEl), networks, objectList: ol,
    culture: cultureEl ? X.textOf(cultureEl) : 'en-US',
    maxId: allIds(root, []).reduce((m, v) => Math.max(m, parseInt(v, 16) || 0), 0),
  };
}

// ---------------------------------------------------------------- type resolution
function makeResolver(b, tags, dbs) {
  const findLocal = nm => { for (const sec of Object.keys(b.interface)) { const m = b.interface[sec].find(x => x.name === nm); if (m) return m.type; } return null; };
  const instMember = (type, pin) => {
    const t = /^(TON|TOF|TP|TONR)_/.exec(type || ''); if (t) return pin === 'ET' ? 'Time' : pin === 'Q' ? 'Bool' : null;
    const c = /^(CTU|CTD|CTUD)_(\w+)/.exec(type || ''); if (c) return pin === 'CV' ? c[2].replace(/^INT$/, 'Int').replace(/^DINT$/, 'DInt').replace(/^UINT$/, 'UInt') : /^Q/.test(pin) ? 'Bool' : null;
    return null;
  };
  return op => {
    if (op.k === 'local') {
      const full = findLocal(op.path.join('.')); if (full) return full;
      if (op.path.length === 2) { const it = findLocal(op.path[0]); return instMember(it, op.path[1]); }
      return null;
    }
    if (op.k === 'global') {
      if (op.path.length === 1 && tags && tags[op.path[0]]) return tags[op.path[0]].type;
      const db = dbs && dbs[op.path[0]];
      if (db && op.path.length > 1) {
        const nm = op.path.slice(1).join('.');
        for (const sec of Object.keys(db)) { const m = db[sec].find(x => x.name === nm); if (m) return m.type; }
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------- reading
function genCtx(b, ctx) {
  ctx = ctx || {};
  return { callCatalog: ctx.callCatalog || {}, learned: ctx.learned, resolveType: makeResolver(b, ctx.tags, ctx.dbs) };
}
function roundtrips(dsl, gctx, localCalls) {
  try {
    const flows = D.parseNetwork(dsl).flows;
    const c = Object.assign({}, gctx, { callCatalog: Object.assign({}, gctx.callCatalog, localCalls) });
    const gen = G.generateFlgNet(flows, c);
    const back = R.readFlgNet(X.parse(gen.xml));
    return back.dsl === dsl;
  } catch (e) { return false; }
}
function readBlock(src, opts) {
  opts = opts || {};
  const b = parseBlock(src);
  const gctx = genCtx(b, opts.ctx);
  const want = opts.networks && opts.networks.length ? new Set(opts.networks) : null;
  const nets = [];
  for (const n of b.networks) {
    if (want && !want.has(n.index)) continue;
    const row = { index: n.index, title: n.title, comment: n.comment, language: n.lang };
    if (n.flg) {
      const r = R.readFlgNet(n.flg);
      if (opts.ctx && opts.ctx.learned) L.learnFlgNet(n.flg, opts.ctx.learned);
      const tmp = L.emptyLearned(); L.learnFlgNet(n.flg, tmp);
      row.dsl = r.dsl; row.flows = r.flows; row.notes = r.notes;
      row.editable = r.complete && roundtrips(r.dsl, gctx, tmp.calls);
      if (!row.editable && r.complete) row.notes = (row.notes || []).concat(['DSL does not round-trip exactly; treat as read-only or replace the whole network']);
      if (opts.format === 'ascii' || opts.format === 'both') row.ascii = render.renderNetwork(r.flows);
    } else {
      row.dsl = null; row.editable = false; row.flows = [];
      row.notes = [(n.lang || n.sourceKind || 'unknown') + ' network: not Ladder (read with tia_export_raw)'];
    }
    nets.push(row);
  }
  return { block: { name: b.name, type: b.kind, number: b.number, language: b.language, memoryLayout: b.memoryLayout }, interface: b.interface, networks: nets, culture: b.culture, doc: b };
}
function interfaceText(iface) {
  const lines = [];
  for (const s of SECTION_ORDER) {
    const m = iface[s]; if (!m || !m.length) continue;
    lines.push('  ' + s.padEnd(8) + ': ' + m.map(x => x.name + ':' + x.type + (x.comment ? ' //' + x.comment : '')).join(', '));
  }
  return lines.join('\n');
}
function formatBlock(r, opts) {
  opts = opts || {};
  const lines = [];
  lines.push('BLOCK ' + r.block.type + ' "' + r.block.name + '" #' + r.block.number + ' (' + (r.block.language || '?') + ', ' + (r.block.memoryLayout || '?') + ')');
  const it = interfaceText(r.interface); if (it) lines.push('INTERFACE\n' + it);
  for (const n of r.networks) {
    lines.push('');
    lines.push('[NW' + n.index + '] ' + (n.title || '(no title)') + (n.language !== 'LAD' ? ' {' + n.language + '}' : n.editable ? ' {editable}' : ' {READ-ONLY}'));
    if (n.comment) lines.push('  // ' + n.comment.replace(/\n/g, ' '));
    if (n.dsl !== null && n.dsl !== undefined) {
      lines.push(n.dsl.split('\n').map(l => '  ' + l).join('\n'));
      if (n.ascii) lines.push('  LAD:\n' + n.ascii.split('\n').map(l => '    ' + l).join('\n'));
    }
    for (const note of (n.notes || [])) lines.push('  ! ' + note);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- editing helpers
const splice = (s, a, b, t) => s.slice(0, a) + t + s.slice(b);
function indentOf(src, pos) {
  const ls = src.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(ls, pos)); return m ? m[0] : '';
}
const reindent = (s, pad) => s.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n');
const hex = n => n.toString(16).toUpperCase();

function mlNode(idGen, composition, culture, text) {
  return E('MultilingualText', { ID: idGen(), CompositionName: composition },
    E('ObjectList', {}, E('MultilingualTextItem', { ID: idGen(), CompositionName: 'Items' },
      E('AttributeList', {}, [E('Culture', {}, culture), E('Text', {}, text || '')]))));
}
function unitNode(idGen, flgNode, title, comment, culture) {
  return E('SW.Blocks.CompileUnit', { ID: idGen(), CompositionName: 'CompileUnits' }, [
    E('AttributeList', {}, [E('NetworkSource', {}, flgNode), E('ProgrammingLanguage', {}, 'LAD')]),
    E('ObjectList', {}, [mlNode(idGen, 'Comment', culture, comment), mlNode(idGen, 'Title', culture, title)]),
  ]);
}
function setMlText(src, unitEl, composition, text, culture) {
  const ol = X.kid(unitEl, 'ObjectList');
  const ml = ol && ol.children.find(c => c.name === 'MultilingualText' && c.attrs.CompositionName === composition);
  if (ml) {
    const items = X.descendants(ml, 'MultilingualTextItem');
    const it = items.find(i => X.textOf(X.path(i, 'AttributeList/Culture')) === culture) || items[0];
    const t = it && X.path(it, 'AttributeList/Text');
    if (t) return splice(src, t.start, t.end, '<Text>' + X.esc(text) + '</Text>');
  }
  return null;
}

// Collect declarations/validation for a set of flows against the block interface
function checkLocals(b, flows, decls, declare) {
  const have = new Set();
  for (const sec of Object.keys(b.interface)) for (const m of b.interface[sec]) { have.add(m.name.split('.')[0]); }
  for (const d of (declare || [])) have.add(d.name);
  for (const d of decls) have.add(d.name);
  const missing = new Set();
  A.walkFlows(flows, (op) => { if (op && op.k === 'local' && !have.has(op.path[0])) missing.add(op.path[0]); });
  if (missing.size) {
    const known = [...new Set(Object.values(b.interface).flat().map(m => m.name.split('.')[0]))];
    throw new G.GenError('Local variable(s) not declared in block "' + b.name + '": ' + [...missing].map(m => '#' + m).join(', ') +
      '. Declared: ' + (known.join(', ') || '(none)') + '. Add them with declare:[{section:"Temp",name:"x",type:"Bool"}] or fix the name.', 'E_UNDECLARED');
  }
}

function buildNetworkNode(b, dsl, ctx, extra) {
  const flows = dsl && dsl.trim() ? D.parseNetwork(dsl).flows : [];
  const gctx = genCtx(b, ctx);
  const gen = G.generateFlgNet(flows, gctx);
  checkLocals(b, flows, gen.decls, extra && extra.declare);
  return { flows, gen };
}

function addMembers(src, add) {
  // add: [{section,name,type,comment}] ; returns new src
  for (const m of add) {
    const b = parseBlock(src);
    const secs = X.path(b.blockEl, 'AttributeList/Interface/Sections');
    if (!secs) throw new Error('block has no Interface/Sections');
    if (b.interface[m.section] && b.interface[m.section].find(x => x.name === m.name)) continue;
    if (b.kind === 'FC' && m.section === 'Static') throw new G.GenError('FC has no Static section; use Temp or a global DB / FB', 'E_DECL');
    if (b.kind === 'OB' && m.section === 'Static') throw new G.GenError('OB has no Static section; use Temp or a global DB', 'E_DECL');
    const memNode = E('Member', { Name: m.name, Datatype: m.type }, m.comment ? [E('Comment', {}, E('MultiLanguageText', { Lang: b.culture }, m.comment))] : []);
    const secEl = X.kids(secs, 'Section').find(s => s.attrs.Name === m.section);
    if (secEl) {
      const pad = indentOf(src, secEl.start) + '  ';
      const xml = reindent(ser(memNode, 0), pad);
      if (secEl.selfClosing) {
        const open = src.slice(secEl.start, secEl.end).replace(/\s*\/>$/, '>');
        src = splice(src, secEl.start, secEl.end, open + '\n' + pad + xml + '\n' + indentOf(src, secEl.start) + '</Section>');
      } else {
        const ip = secEl.innerEnd;
        const lead = indentOf(src, secEl.innerEnd);
        src = splice(src, secEl.innerEnd, secEl.innerEnd, (/\n\s*$/.test(src.slice(secEl.innerStart, secEl.innerEnd)) ? '' : '\n') + pad + xml + '\n' + lead);
        void ip;
      }
    } else {
      const rank = SECTION_ORDER.indexOf(m.section);
      const after = X.kids(secs, 'Section').find(s => SECTION_ORDER.indexOf(s.attrs.Name) > rank);
      const secNode = E('Section', { Name: m.section }, [memNode]);
      const pad = secs.children.length ? indentOf(src, secs.children[0].start) : indentOf(src, secs.start) + '  ';
      const xml = reindent(ser(secNode, 0), pad);
      if (after) src = splice(src, after.start, after.start, xml + '\n' + pad);
      else src = splice(src, secs.innerEnd, secs.innerEnd, pad + xml + '\n' + indentOf(src, secs.start));
    }
    X.parse(src); // well-formedness check
  }
  return src;
}
function removeMembers(src, remove) {
  for (const m of remove) {
    const b = parseBlock(src);
    const secs = X.path(b.blockEl, 'AttributeList/Interface/Sections');
    const sec = secs && X.kids(secs, 'Section').find(s => s.attrs.Name === m.section);
    const mem = sec && X.kids(sec, 'Member').find(x => x.attrs.Name === m.name);
    if (!mem) throw new G.GenError('Member ' + m.section + '.' + m.name + ' not found', 'E_DECL');
    const ls = src.lastIndexOf('\n', mem.start - 1) + 1;
    const start = /^\s*$/.test(src.slice(ls, mem.start)) ? ls : mem.start;
    src = splice(src, start, mem.end + (src[mem.end] === '\n' ? 1 : (src.slice(mem.end, mem.end + 2) === '\r\n' ? 2 : 0)), '');
  }
  X.parse(src);
  return src;
}

// ---------------------------------------------------------------- network patching
// ops: [{op:'replace'|'insert'|'append'|'delete'|'set_text', nw, dsl, title, comment}]  (applied in order)
function patchNetworks(src, ops, ctx) {
  ctx = ctx || {};
  const changes = []; const warnings = []; const allDecls = []; const dbInst = [];
  for (const op of ops) {
    const b = parseBlock(src);
    const culture = ctx.culture || b.culture;
    const nid = (() => { let n = b.maxId; return () => hex(++n); })();
    const kind = op.op;
    const nw = op.nw;
    const unit = b.networks[(nw || 0) - 1];
    if (['replace', 'delete', 'set_text'].includes(kind) && !unit) throw new G.GenError('Network ' + nw + ' does not exist (block has ' + b.networks.length + ' networks)', 'E_NW');
    if (kind === 'replace') {
      if (!unit.flg && unit.sourceKind && !op.force) throw new G.GenError('Network ' + nw + ' is ' + unit.lang + ', not Ladder; refusing to overwrite (pass force:true to replace it with Ladder)', 'E_NW');
      const { gen } = buildNetworkNode(b, op.dsl, ctx, op);
      allDecls.push(...gen.decls); dbInst.push(...gen.dbInstances);
      const nsEl = unit.nsEl;
      const pad = indentOf(src, nsEl.start);
      const xml = reindent(ser(E('NetworkSource', {}, gen.node), 0), pad);
      src = splice(src, nsEl.start, nsEl.end, xml);
      let b2 = parseBlock(src);
      if (op.title !== undefined) { const s2 = setMlText(src, b2.networks[nw - 1].el, 'Title', op.title, culture); if (s2) src = s2; }
      b2 = parseBlock(src);
      if (op.comment !== undefined) { const s2 = setMlText(src, b2.networks[nw - 1].el, 'Comment', op.comment, culture); if (s2) src = s2; }
      changes.push('replaced NW' + nw);
    } else if (kind === 'insert' || kind === 'append') {
      const { gen } = buildNetworkNode(b, op.dsl, ctx, op);
      allDecls.push(...gen.decls); dbInst.push(...gen.dbInstances);
      const node = unitNode(nid, gen.node, op.title || '', op.comment || '', culture);
      const atEnd = kind === 'append' || !nw || nw > b.networks.length;
      if (b.networks.length) {
        const ref = atEnd ? b.networks[b.networks.length - 1] : b.networks[nw - 1];
        const pad = indentOf(src, ref.el.start);
        const xml = reindent(ser(node, 0), pad);
        if (atEnd) src = splice(src, ref.el.end, ref.el.end, '\n' + pad + xml);
        else src = splice(src, ref.el.start, ref.el.start, xml + '\n' + pad);
        changes.push((atEnd ? 'appended NW' + (b.networks.length + 1) : 'inserted NW' + nw));
      } else {
        const ol = b.objectList; const pad = indentOf(src, ol.start) + '  ';
        src = splice(src, ol.innerEnd, ol.innerEnd, pad + reindent(ser(node, 0), pad) + '\n' + indentOf(src, ol.start));
        changes.push('appended NW1');
      }
    } else if (kind === 'delete') {
      const el = unit.el; const ls = src.lastIndexOf('\n', el.start - 1) + 1;
      const start = /^\s*$/.test(src.slice(ls, el.start)) ? ls : el.start;
      const end = el.end + (src[el.end] === '\r' && src[el.end + 1] === '\n' ? 2 : (src[el.end] === '\n' ? 1 : 0));
      src = splice(src, start, end, '');
      changes.push('deleted NW' + nw);
    } else if (kind === 'set_text') {
      if (op.title !== undefined) { const s2 = setMlText(src, unit.el, 'Title', op.title, culture); if (s2) src = s2; else warnings.push('NW' + nw + ': no Title text slot found'); }
      const b2 = parseBlock(src);
      if (op.comment !== undefined) { const s2 = setMlText(src, b2.networks[nw - 1].el, 'Comment', op.comment, culture); if (s2) src = s2; else warnings.push('NW' + nw + ': no Comment text slot found'); }
      changes.push('updated text of NW' + nw);
    } else throw new G.GenError('Unknown op "' + kind + '" (use replace | insert | append | delete | set_text)', 'E_OP');
    X.parse(src);
  }
  // declarations required by generated networks (timers, edge memory, FB instances)
  const bFinal = parseBlock(src);
  const add = [];
  for (const d of allDecls) {
    const exists = Object.values(bFinal.interface).flat().find(m => m.name === d.name);
    if (!exists && !add.find(x => x.name === d.name)) add.push(d);
  }
  for (const d of (ctx.declare || [])) if (!Object.values(bFinal.interface).flat().find(m => m.name === d.name) && !add.find(x => x.name === d.name)) add.push(d);
  for (const op of ops) for (const d of (op.declare || [])) if (!Object.values(bFinal.interface).flat().find(m => m.name === d.name) && !add.find(x => x.name === d.name)) add.push(d);
  if (add.length) { src = addMembers(src, add); changes.push('declared ' + add.map(d => d.section + '.' + d.name + ':' + d.type).join(', ')); }
  return { xml: src, changes, warnings, declared: add, dbInstances: dbInst };
}

// ---------------------------------------------------------------- creating blocks
function defaultSections(type) {
  if (type === 'FB') return { Input: [], Output: [], InOut: [], Static: [], Temp: [], Constant: [] };
  if (type === 'FC') return { Input: [], Output: [], InOut: [], Temp: [], Constant: [], Return: [{ name: 'Ret_Val', type: 'Void' }] };
  if (type === 'OB') return { Input: [{ name: 'Initial_Call', type: 'Bool', comment: 'Initial call of this OB' }, { name: 'Remanence', type: 'Bool', comment: 'True, if remanent data are available' }], Temp: [], Constant: [] };
  throw new G.GenError('type must be FB, FC or OB', 'E_TYPE');
}
function createBlockXml(spec, ctx) {
  ctx = ctx || {};
  const type = spec.type;
  const culture = spec.culture || ctx.culture || 'en-US';
  const sections = defaultSections(type);
  for (const s of Object.keys(spec.interface || {})) {
    if (!sections[s]) sections[s] = [];
    for (const m of spec.interface[s]) sections[s].push({ name: m.name, type: m.type, comment: m.comment });
  }
  let idn = 0; const nid = () => hex(++idn);
  // temporary block context for type resolution / local checks
  const fakeBlock = { name: spec.name, kind: type, interface: sections };
  const nodes = []; const decls = []; const dbInst = [];
  for (const n of (spec.networks || [])) {
    const flows = n.dsl && n.dsl.trim() ? D.parseNetwork(n.dsl).flows : [];
    const gen = G.generateFlgNet(flows, genCtx(fakeBlock, ctx));
    decls.push(...gen.decls); dbInst.push(...gen.dbInstances);
    checkLocals(fakeBlock, flows, gen.decls, spec.declare);
    nodes.push({ gen, n });
  }
  for (const d of decls) {
    if (Object.values(sections).flat().find(m => m.name === d.name)) continue;
    if (!sections[d.section]) throw new G.GenError(type + ' cannot hold ' + d.section + ' member #' + d.name + ' (' + d.type + '). Use an FB, or a global instance DB.', 'E_DECL');
    sections[d.section].push({ name: d.name, type: d.type });
  }
  for (const d of (spec.declare || [])) if (!Object.values(sections).flat().find(m => m.name === d.name)) { (sections[d.section] = sections[d.section] || []).push(d); }
  const memberNode = m => E('Member', { Name: m.name, Datatype: m.type }, m.comment ? [E('Comment', {}, E('MultiLanguageText', { Lang: culture }, m.comment))] : []);
  const secNodes = SECTION_ORDER.filter(s => sections[s]).map(s => E('Section', { Name: s }, sections[s].map(memberNode)));
  const attrs = [E('Interface', {}, E('Sections', { xmlns: IF_NS }, secNodes)), E('MemoryLayout', {}, spec.memoryLayout || 'Optimized'), E('Name', {}, spec.name)];
  if (spec.number) attrs.push(E('Number', {}, String(spec.number))); else attrs.push(E('AutoNumber', {}, 'true'));
  attrs.push(E('ProgrammingLanguage', {}, 'LAD'));
  if (type === 'OB') attrs.push(E('SecondaryType', {}, spec.secondaryType || 'ProgramCycle'));
  const objs = [mlNode(nid, 'Comment', culture, spec.comment || ''), mlNode(nid, 'Title', culture, spec.title || '')];
  for (const { gen, n } of nodes) objs.push(unitNode(nid, gen.node, n.title || '', n.comment || '', culture));
  if (!nodes.length) objs.push(unitNode(nid, E('FlgNet', { xmlns: G.FLG_NS }, [E('Parts', {})]), '', '', culture));
  const doc = E('Document', {}, [E('Engineering', { version: 'V20' }), E('SW.Blocks.' + type, { ID: '0' }, [E('AttributeList', {}, attrs), E('ObjectList', {}, objs)])]);
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n' + ser(doc, 0) + '\n';
  X.parse(xml);
  return { xml, dbInstances: dbInst, declared: decls };
}

module.exports = {
  parseBlock, readBlock, formatBlock, interfaceText, patchNetworks, addMembers, removeMembers, createBlockXml,
  makeResolver, parseInterface, SECTION_ORDER,
};
