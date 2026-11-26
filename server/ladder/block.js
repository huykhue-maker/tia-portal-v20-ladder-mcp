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
const SECTION_ORDER = ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant', 'Return', 'None'];

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
    const member = { name, type: m.attrs.Datatype || '', comment: memberComment(m) };
    const startValue = X.kid(m, 'StartValue');
    if (startValue) member.startValue = X.textOf(startValue);
    if (m.attrs.Remanence !== undefined) member.retain = m.attrs.Remanence === 'Retain';
    arr.push(member);
    walkMembers(m, name + '.', arr);
    for (const section of X.kids(X.kid(m, 'Sections'), 'Section')) walkMembers(section, name + '.', arr);
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
function parseBlock(src, root = X.parse(src)) {
  if (!root) throw new Error('empty XML');
  const blockEl = root.children.find(c => /^SW\.Blocks\./.test(c.name) || c.name === 'SW.Types.PlcStruct');
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
function fcReturnBinding(block) {
  if (block.kind !== 'FC') return;
  const member = block.interface.Return?.find(m => /^Ret_Val$/i.test(m.name) && m.type && !/^Void$/i.test(m.type));
  if (member) return { blockName: block.name, member };
}

function stripArrayType(t, hasIdx) {
  if (!t || !hasIdx) return t;
  const m = /^Array\s*\[[^\]]+\]\s*of\s+(.+)$/i.exec(t.trim());
  return m ? m[1].trim().replace(/^"|"$/g, '') : t;
}
function lookupByName(map, name) {
  if (!map || !name) return null;
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const lower = String(name).toLowerCase();
  const key = Object.keys(map).find(k => k.toLowerCase() === lower);
  return key === undefined ? null : map[key];
}
function flattenSectionMembers(list, prefix, out) {
  for (const m of (list || [])) {
    const name = prefix + m.name;
    out.push({ ...m, name });
    if (Array.isArray(m.members) && m.members.length) flattenSectionMembers(m.members, name + '.', out);
  }
  return out;
}
function makeResolver(b, tags, dbs, udts) {
  const fcReturn = fcReturnBinding(b);
  const instMember = (type, pin) => {
    const t = /^(TON|TOF|TP|TONR)_/.exec(type || ''); if (t) return pin === 'ET' ? 'Time' : pin === 'Q' ? 'Bool' : null;
    const c = /^(CTU|CTD|CTUD)_(\w+)/.exec(type || ''); if (c) return pin === 'CV' ? c[2].replace(/^INT$/, 'Int').replace(/^DINT$/, 'DInt').replace(/^UINT$/, 'UInt') : /^Q/.test(pin) ? 'Bool' : null;
    return null;
  };
  const findInSections = (sections, dotted) => {
    if (!sections) return null;
    for (const sec of Object.keys(sections)) {
      const m = (sections[sec] || []).find(x => x.name === dotted || x.name.toLowerCase() === dotted.toLowerCase());
      if (m) return m.type;
    }
    return null;
  };
  const resolveNested = (sections, segs, idxMap, offset, depth) => {
    if (!sections || !segs.length || depth > 10) return null;
    const full = findInSections(sections, segs.join('.'));
    if (full) return stripArrayType(full, !!(idxMap && idxMap[offset + segs.length - 1]));
    for (let k = segs.length - 1; k >= 1; k--) {
      const baseType = findInSections(sections, segs.slice(0, k).join('.'));
      if (!baseType) continue;
      const elemType = stripArrayType(baseType, !!(idxMap && idxMap[offset + k - 1]));
      const rest = segs.slice(k);
      if (rest.length === 1) {
        const im = instMember(elemType, rest[0]);
        if (im) return im;
      }
      const udtName = String(elemType || '').trim().replace(/^"|"$/g, '');
      const udt = lookupByName(udts, udtName);
      if (udt) {
        const resolved = resolveNested(udt, rest, idxMap, offset + k, depth + 1);
        if (resolved) return resolved;
      }
    }
    return null;
  };
  return op => {
    if (op.k === 'local') {
      if (fcReturn && op.path.length === 1 && op.path[0].toLowerCase() === fcReturn.blockName.toLowerCase()) return fcReturn.member.type;
      return resolveNested(b.interface, op.path, op.idx, 0, 0);
    }
    if (op.k === 'global') {
      if (op.path.length === 1 && tags && tags[op.path[0]]) return stripArrayType(tags[op.path[0]].type, !!(op.idx && op.idx[0]));
      const db = lookupByName(dbs, op.path[0]);
      if (db && op.path.length > 1) return resolveNested(db, op.path.slice(1), op.idx, 1, 0);
      if (op.path.length > 1 && tags && tags[op.path[0]]) {
        const tagType = stripArrayType(tags[op.path[0]].type, !!(op.idx && op.idx[0]));
        const udt = lookupByName(udts, String(tagType || '').trim().replace(/^"|"$/g, ''));
        if (udt) return resolveNested(udt, op.path.slice(1), op.idx, 1, 0);
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------- reading
function genCtx(b, ctx) {
  ctx = ctx || {};
  return {
    callCatalog: ctx.callCatalog || {}, learned: ctx.learned, resolveType: makeResolver(b, ctx.tags, ctx.dbs, ctx.udts),
    fcReturn: fcReturnBinding(b),
    isLocalConstant: op => (b.interface.Constant || []).some(m => m.name === op.path.join('.')),
  };
}
function roundtrips(dsl, gctx, localCalls) {
  try {
    const flows = D.parseNetwork(dsl).flows;
    const c = { ...gctx, callCatalog: { ...gctx.callCatalog, ...localCalls } };
    const gen = G.generateFlgNet(flows, c);
    const back = R.readFlgNet(X.parse(gen.xml), { fcReturn: gctx.fcReturn });
    return back.dsl === dsl;
  } catch (e) { return false; }
}
function readBlock(src, opts) {
  opts = opts || {};
  const b = parseBlock(src, opts.root);
  const gctx = genCtx(b, opts.ctx);
  const want = opts.networks && opts.networks.length ? new Set(opts.networks) : null;
  const nets = [];
  for (const n of b.networks) {
    if (want && !want.has(n.index)) continue;
    const row = { index: n.index, title: n.title, comment: n.comment, language: n.lang };
    if (n.flg) {
      const r = R.readFlgNet(n.flg, { fcReturn: gctx.fcReturn });
      if (opts.ctx && opts.ctx.learned) L.learnFlgNet(n.flg, opts.ctx.learned);
      row.dsl = r.dsl; row.flows = r.flows; row.notes = r.notes;
      if (opts.simulationOnly) {
        row.complete = r.complete;
        nets.push(row);
        continue;
      }
      const tmp = L.emptyLearned(); L.learnFlgNet(n.flg, tmp);
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
    lines.push('  ' + s.padEnd(8) + ': ' + m.map(x => x.name + ':' + x.type
      + (x.startValue !== undefined ? ' = ' + x.startValue : '') + (x.retain ? ' [Retain]' : '')
      + (x.comment ? ' //' + x.comment : '')).join(', '));
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
  const fcReturn = fcReturnBinding(b);
  if (fcReturn) have.add(fcReturn.blockName);
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
  // Add members with optional comments, start values, and remanence.
  for (const m of add) {
    const b = parseBlock(src);
    const secs = X.path(b.blockEl, 'AttributeList/Interface/Sections');
    if (!secs) throw new Error('block has no Interface/Sections');
    const existing = (b.interface[m.section] || []).find(x => x.name === m.name);
    const secEl = X.kids(secs, 'Section').find(s => s.attrs.Name === m.section);
    if (existing) {
      if (b.kind === 'FC' && m.section === 'Return' && /^Void$/i.test(existing.type) && !/^Void$/i.test(m.type)) {
        const old = X.kids(secEl, 'Member').find(x => x.attrs.Name === m.name);
        src = splice(src, old.start, old.end, reindent(ser(mkMemberNode(m, b.culture), 0), indentOf(src, old.start)));
      }
      continue;
    }
    if (b.kind === 'FC' && m.section === 'Static') throw new G.GenError('FC has no Static section; use Temp or a global DB / FB', 'E_DECL');
    if (b.kind === 'OB' && m.section === 'Static') throw new G.GenError('OB has no Static section; use Temp or a global DB', 'E_DECL');
    const memNode = mkMemberNode(m, b.culture);
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
function defaultSections(type, secondaryType = 'ProgramCycle') {
  if (type === 'FB') return { Input: [], Output: [], InOut: [], Static: [], Temp: [], Constant: [] };
  if (type === 'FC') return { Input: [], Output: [], InOut: [], Temp: [], Constant: [], Return: [{ name: 'Ret_Val', type: 'Void' }] };
  if (type === 'OB') {
    const inputs = {
      ProgramCycle: [{ name: 'Initial_Call', type: 'Bool' }, { name: 'Remanence', type: 'Bool' }],
      Startup: [{ name: 'LostRetentive', type: 'Bool' }, { name: 'LostRTC', type: 'Bool' }],
      CyclicInterrupt: [{ name: 'Initial_Call', type: 'Bool' }, { name: 'Event_Count', type: 'Int' }],
    }[secondaryType];
    if (!inputs) throw new G.GenError('Unsupported OB secondaryType: ' + secondaryType, 'E_TYPE');
    return {
    Input: inputs.map(m => ({ ...m, informative: true })),
    Temp: [],
    Constant: [],
  }; }
  throw new G.GenError('type must be FB, FC or OB', 'E_TYPE');
}
function mkMemberNode(m, culture) {
  const attrs = { Name: m.name, Datatype: m.type };
  if (m.informative) attrs.Informative = 'true';
  if (m.retain === true) attrs.Remanence = 'Retain';
  const children = [];
  if (m.comment) children.push(E('Comment', {}, E('MultiLanguageText', { Lang: culture }, m.comment)));
  if (m.startValue !== undefined && m.startValue !== null) {
    const value = typeof m.startValue === 'boolean' ? String(m.startValue).toUpperCase() : String(m.startValue);
    children.push(E('StartValue', {}, value));
  }
  if (Array.isArray(m.members) && m.members.length) {
    for (const sub of m.members) children.push(mkMemberNode(sub, culture));
  }
  return E('Member', attrs, children);
}

function createBlockXml(spec, ctx) {
  ctx = ctx || {};
  const type = spec.type;
  const culture = spec.culture || ctx.culture || 'en-US';
  const sections = defaultSections(type, spec.secondaryType);
  for (const s of Object.keys(spec.interface || {})) {
    if (!sections[s]) sections[s] = [];
    if (type === 'FC' && s === 'Return' && spec.interface[s].length) sections[s] = [];
    sections[s].push(...spec.interface[s]);
  }
  let idn = 0; const nid = () => hex(++idn);
  // temporary block context for type resolution / local checks (flatten nested Struct members)
  const flatSections = {};
  for (const s of Object.keys(sections)) flatSections[s] = flattenSectionMembers(sections[s], '', []);
  const fakeBlock = { name: spec.name, kind: type, interface: flatSections };
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
  const secNodes = SECTION_ORDER.filter(s => sections[s]).map(s => E('Section', { Name: s }, sections[s].map(m => mkMemberNode(m, culture))));
  const attrs = [E('Interface', {}, E('Sections', { xmlns: IF_NS }, secNodes)), E('MemoryLayout', {}, spec.memoryLayout || 'Optimized'), E('Name', {}, spec.name), E('Namespace', {})];
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

function createDbXml(spec) {
  const kind = spec.kind || 'GlobalDB';
  if (!spec.name) throw new G.GenError('name is required for DB/UDT XML.', 'E_DECL');
  const culture = spec.culture || 'en-US';
  const members = (spec.members || []).map(m => mkMemberNode(m, culture));
  if (kind === 'InstanceDB') {
    if (!spec.instanceOf) throw new G.GenError('instanceOf is required for InstanceDB "' + spec.name + '".', 'E_DECL');
    const attrs = [
      E('InstanceOfName', {}, spec.instanceOf),
      E('InstanceOfType', {}, spec.instanceOfType || 'FB'),
      E('Name', {}, spec.name),
      E('Namespace', {}),
    ];
    if (spec.number) attrs.push(E('Number', {}, String(spec.number)));
    else attrs.push(E('AutoNumber', {}, 'true'));
    attrs.push(E('ProgrammingLanguage', {}, 'DB'));
    const doc = E('Document', {}, [E('Engineering', { version: 'V20' }), E('SW.Blocks.InstanceDB', { ID: '0' }, [E('AttributeList', {}, attrs)])]);
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n' + ser(doc, 0) + '\n';
    X.parse(xml);
    return xml;
  }
  const isUdt = kind === 'UDT';
  const secName = isUdt ? 'None' : 'Static';
  const attrs = [E('Interface', {}, E('Sections', { xmlns: IF_NS }, [E('Section', { Name: secName }, members)]))];
  if (!isUdt) attrs.push(E('MemoryLayout', {}, spec.memoryLayout || 'Optimized'));
  attrs.push(E('Name', {}, spec.name), E('Namespace', {}));
  if (!isUdt) {
    if (spec.number) attrs.push(E('Number', {}, String(spec.number)));
    else attrs.push(E('AutoNumber', {}, 'true'));
    attrs.push(E('ProgrammingLanguage', {}, 'DB'));
  }
  const tag = isUdt ? 'SW.Types.PlcStruct' : 'SW.Blocks.GlobalDB';
  const doc = E('Document', {}, [E('Engineering', { version: 'V20' }), E(tag, { ID: '0' }, [E('AttributeList', {}, attrs)])]);
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n' + ser(doc, 0) + '\n';
  X.parse(xml);
  return xml;
}

module.exports = {
  parseBlock, readBlock, formatBlock, interfaceText, patchNetworks, addMembers, removeMembers, createBlockXml, createDbXml,
  makeResolver, parseInterface, fcReturnBinding, SECTION_ORDER,
};
