'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXPORTS_DIR, ensureDir } = require('./bridge_client');
const B = require('./ladder/block');
const { readFlgNet } = require('./ladder/reader');
const D = require('./ladder/dsl');
const L = require('./ladder/learn');
const A = require('./ladder/analyzer');
const S = require('./ladder/simulator');
const project = require('./ladder/project');
const X = require('./ladder/xml');
const { portalVersion, V16_UNAVAILABLE_TOOLS } = require('./tia_profile');

function createToolHandler({ bridge, onlineBackups }) {
const version = portalVersion(bridge.portalVersion);
// ------------------------------------------------------------------ Helpers
function getLadderCtx(extra) {
  return Object.assign({
    callCatalog: bridge.learned.calls || {},
    learned: bridge.learned,
    tags: bridge.tagsCache,
    dbs: bridge.dbsCache,
    udts: bridge.udtsCache,
  }, extra || {});
}

async function refreshTagCache(plcName) {
  const data = await bridge.call('list_tags', plcName ? { plcName } : {});
  if (!plcName) bridge.resolveDefaultPlc(data.plc);
  else bridge.setScope(undefined, data.plc || plcName);
  const map = {};
  for (const tbl of (data.tables || [])) {
    for (const t of (tbl.tags || [])) {
      map[t.name] = Object.assign({}, t, { table: tbl.table });
    }
  }
  bridge.tagsCache = map;
  return data;
}

async function exportBlockXml(blockName, plcName) {
  const outPath = bridge.uniqueExportPath(blockName, '.xml');
  try {
    const res = await bridge.call('export_block', { blockName, plcName: plcName || '', outPath, format: 'xml' });
    return { xml: fs.readFileSync(res.path, 'utf8'), meta: res };
  } finally { try { fs.unlinkSync(outPath); } catch { } }
}

async function editLadderXml(args, transform, preview = false) {
  if (!args.xmlPath) return onlineBackups.edit(args, 'block', transform, preview);
  const xml = fs.readFileSync(args.xmlPath, 'utf8');
  const result = transform(xml);
  if (preview) return { xml, result };
  const backup = bridge.saveBackup(bridge.offlineBackupLabel(args.xmlPath), xml);
  fs.writeFileSync(args.xmlPath, result.xml, 'utf8');
  return { xml, result, backup };
}

function patchSummary(original, patch) {
  function units(xml) {
    const block = B.parseBlock(xml);
    const fcReturn = B.fcReturnBinding(block);
    return new Map(block.networks.map(n =>
      [n.id, { network: n, raw: xml.slice(n.el.start, n.el.end), fcReturn }]));
  }
  const before = units(original);
  const after = units(patch.xml);
  const lines = [...patch.changes, ...patch.warnings];
  for (const db of patch.dbInstances) lines.push('DB: ' + db.name + ' (' + db.type + ')');
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const next = after.get(id);
    if (old && next && old.raw === next.raw) continue;
    for (const [label, item] of [['Before', old], ['After', next]]) {
      if (!item) continue;
      const n = item.network;
      lines.push(label + ' NW' + n.index + ': ' + n.title);
      if (n.comment) lines.push(n.comment);
      if (n.flg) {
        const read = readFlgNet(n.flg, { fcReturn: item.fcReturn });
        lines.push(read.dsl, ...(read.notes || []));
      } else lines.push(n.lang);
    }
  }
  return lines.join('\n');
}

function fmtValue(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function plural(n, singular, pluralForm) {
  return n + ' ' + (n === 1 ? singular : (pluralForm || singular + 's'));
}

function annotateTags(text, tagsMap) {
  if (!tagsMap || !Object.keys(tagsMap).length) return text;
  const used = new Set();
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (tagsMap[m[1]]) used.add(m[1]);
  }
  if (!used.size) return text;
  const lines = ['', 'TAGS REFERENCED:'];
  for (const name of [...used].sort()) {
    const t = tagsMap[name];
    lines.push('  "' + name + '" : ' + t.type + (t.address ? ' @ ' + t.address : '') + (t.comment ? ' // ' + t.comment : ''));
  }
  return text + '\n' + lines.join('\n');
}

function parseDbOrUdtXml(xml) {
  const root = X.parse(xml);
  const el = root.children.find(c => /^SW\./.test(c.name));
  if (!el) throw new Error('No SW.* element found in XML');
  const al = X.kid(el, 'AttributeList');
  const name = X.textOf(X.kid(al, 'Name'));
  const number = X.textOf(X.kid(al, 'Number'));
  const memoryLayout = X.textOf(X.kid(al, 'MemoryLayout'));
  const iface = B.parseInterface(el);
  return { kind: el.name, name, number, memoryLayout, interface: iface };
}

function hardwareIoText(item) {
  const details = [];
  const ids = item.hardwareIdentifiers?.length ? item.hardwareIdentifiers : [item.hardwareIdentifier];
  if (ids[0] !== undefined && ids[0] !== null) details.push('HwID ' + ids.join(', '));
  for (const addr of (item.addresses || [])) {
    const area = { Input: 'I', Output: 'Q' }[addr.ioType];
    if (!area || addr.startAddress < 0 || addr.length <= 0) continue;
    const bit = addr.bitOffset ?? 0;
    const end = bit + addr.length - 1;
    const startText = '%' + area + addr.startAddress + '.' + bit;
    const endText = '%' + area + (addr.startAddress + Math.floor(end / 8)) + '.' + (end % 8);
    const word = bit === 0 && addr.length >= 16 ? ', %' + area + 'W' + addr.startAddress : '';
    details.push(startText + (end > bit ? '–' + endText : '') + word);
  }
  return details.length ? ' (' + details.join('; ') + ')' : '';
}

// ------------------------------------------------------------------ Tool Execution
async function handleTool(name, args) {
  bridge.setScope(undefined, args && args.plcName || '');
  args = args || {};
  if (version === '16' && V16_UNAVAILABLE_TOOLS.has(name)) throw new Error(name + ' is unavailable in the TIA V16 profile.');
  switch (name) {
    case 'tia_status': {
      const s = await bridge.call('status');
      bridge.setScope(s.projectPath || '', args.plcName || '');
      const lines = [
        'USER: ' + s.user + ' | In "Siemens TIA Openness" group: ' + s.inOpennessGroup,
        'CONNECTED: ' + s.connected + ' (mode: ' + s.mode + ', attachedExisting: ' + s.attachedExisting + ')',
        'PROJECT: ' + (s.projectOpen ? s.projectName + ' (' + s.projectPath + ')' : 'none'),
        'OPENNESS ACCESSIBLE: ' + s.opennessAccessible + (s.opennessError ? ' — ' + s.opennessError : ''),
        'RUNNING TIA V' + version + ' PROCESSES: ' + (s.runningTiaProcesses.length ? s.runningTiaProcesses.map(p => 'PID ' + p.id + ' [' + p.mode + '] ' + (p.projectPath || '(no project)')).join('; ') : 'none'),
      ];
      if (version === '20') lines.push('S7-PLCSIM V20 RUNNING: ' + s.plcsimV20Running + (s.plcsimV20Pids?.length ? ' (PID ' + s.plcsimV20Pids.join(',') + ')' : ''));
      if (!s.inOpennessGroup) {
        lines.push('ACTION NEEDED: Run in Administrator PowerShell: net localgroup "Siemens TIA Openness" "' + s.user.split('\\').pop() + '" /add  (then sign out & sign in once).');
      }
      return { text: lines.join('\n'), json: s };
    }

    case 'tia_connect': {
      const s = await bridge.call('connect', { mode: args.mode || 'auto', processId: args.processId || 0 });
      bridge.clearProjectScope(); bridge.setScope(s.projectPath || '', '');
      return { text: 'Connected to TIA Portal V' + version + ' (mode: ' + s.mode + ', project: ' + (s.projectName || 'none') + ').', json: s };
    }

    case 'tia_open_project': {
      if (version === '16' && (typeof args.path !== 'string' || path.extname(args.path).toLowerCase() !== '.ap16' || args.upgrade)) {
        throw new Error('The TIA V16 profile opens native .ap16 projects. Select a matching project and omit upgrade.');
      }
      const s = await bridge.call('open_project', {
        path: args.path,
        mode: args.mode || 'auto',
        closeCurrent: !!args.closeCurrent,
        upgrade: !!args.upgrade,
      });
      bridge.clearProjectScope(); bridge.setScope(s.projectPath || '', '');
      return { text: 'Opened project "' + s.projectName + '" (' + s.projectPath + ').', json: s };
    }

    case 'tia_save_project': {
      const r = await bridge.call('save_project', {
        saveAsDirectory: args.saveAsDirectory || '',
      });
      return {
        text: r.savedAs ? 'Saved project "' + r.project + '" as "' + r.path + '".' : 'Saved project "' + r.project + '".',
        json: r,
      };
    }

    case 'tia_close_project': {
      const r = await bridge.call('close_project');
      if (args.disconnect || args.closeTia) {
        await bridge.call('disconnect', { closeTia: !!args.closeTia });
      }
      bridge.clearProjectScope();
      return { text: r.closed ? 'Closed project "' + r.project + '".' : 'No project was open; session ' + (args.disconnect || args.closeTia ? 'disconnected.' : 'remains connected.'), json: r };
    }

    case 'tia_project_blueprint': {
      const plcName = args.plcName || '';
      const devices = await bridge.call('list_devices');
      const blocks = await bridge.call('list_blocks', { plcName });
      if (!plcName && blocks.plc) bridge.resolveDefaultPlc(blocks.plc);
      const tags = await refreshTagCache(plcName);
      const types = await bridge.call('list_types', { plcName });
      const tos = await bridge.call('list_tech_objects', { plcName });

      const groupFilter = args.group ? String(args.group).replace(/\\/g, '/').replace(/^\/|\/$/g, '') : '';
      const groupLower = groupFilter.toLowerCase();
      const filteredBlocks = groupFilter
        ? (blocks.blocks || []).filter(b => {
          const g = String(b.group || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '').toLowerCase();
          return g === groupLower || g.startsWith(groupLower + '/');
        })
        : (blocks.blocks || []);

      const learnInterfaces = args.learnInterfaces !== false;
      const maxLearn = args.maxLearnBlocks !== undefined && Number.isInteger(args.maxLearnBlocks) && args.maxLearnBlocks >= 0
        ? args.maxLearnBlocks : Infinity;
      const callEntries = {};
      const dbSummaries = [];
      let learnedBlocksCount = 0;
      if (learnInterfaces && maxLearn > 0) {
        for (const blk of filteredBlocks) {
          if (learnedBlocksCount >= maxLearn) break;
          if (blk.isKnowHowProtected) continue;
          if (!['FB', 'FC', 'GlobalDB'].includes(blk.type)) continue;
          try {
            const { xml } = await exportBlockXml(blk.name, plcName);
            const parsed = parseDbOrUdtXml(xml);
            learnedBlocksCount++;
            if (blk.type === 'GlobalDB') {
              bridge.dbsCache[blk.name] = parsed.interface;
              const members = (parsed.interface.Static || []).map(m => m.name + ':' + m.type);
              dbSummaries.push('  DB "' + blk.name + '" (#' + blk.number + '): ' + (members.slice(0, 15).join(', ') || '(empty)') + (members.length > 15 ? ' ... +' + (members.length - 15) : ''));
            } else {
              const entry = L.rememberCallInterface(bridge.learned.calls, blk.name, blk.type, parsed.interface);
              callEntries[blk.name] = entry;
              if (blk.language === 'LAD') {
                const pb = B.parseBlock(xml);
                for (const nw of pb.networks) if (nw.flg) L.learnFlgNet(nw.flg, bridge.learned);
              }
            }
          } catch { /* skip non-exportable blocks */ }
        }
        for (const t of (types.types || [])) {
          if (learnedBlocksCount >= maxLearn) break;
          const outPath = bridge.uniqueExportPath('UDT_' + t.name, '.xml');
          try {
            const res = await bridge.call('export_type', { typeName: t.name, outPath, plcName });
            const parsed = parseDbOrUdtXml(fs.readFileSync(res.path, 'utf8'));
            bridge.udtsCache[t.name] = parsed.interface;
            learnedBlocksCount++;
          } catch { /* skip non-exportable UDTs */ }
          finally { try { fs.unlinkSync(outPath); } catch { } }
        }
        bridge.saveLearned();
      }

      const lines = [];
      lines.push('=== PROJECT BLUEPRINT: ' + devices.project + ' ===');
      lines.push('DEVICES:');
      for (const d of (devices.devices || [])) {
        const plcs = (d.items || []).filter(i => i.isPlc).map(i => i.name + ' [' + i.typeIdentifier + ']');
        lines.push('  - ' + d.name + (d.group ? ' (' + d.group + ')' : '') + (plcs.length ? ' -> PLC: ' + plcs.join(', ') : ''));
        for (const item of (d.items || [])) {
          const io = hardwareIoText(item);
          if (io) lines.push('    ' + item.name + io);
        }
      }
      lines.push('');
      lines.push('BLOCKS (' + filteredBlocks.length + (groupFilter ? ' in @' + groupFilter + ' of ' + (blocks.blocks || []).length : '') + ') on ' + blocks.plc + ':');
      for (const b of filteredBlocks) {
        const sig = callEntries[b.name] ? ' (' + callEntries[b.name].params.map(p => p.section[0] + ':' + p.name + ':' + p.type).join(', ') + ')' : '';
        lines.push('  - ' + b.type.padEnd(10) + ' "' + b.name + '" #' + b.number + ' [' + b.language + ']' + (b.group ? ' @' + b.group : '') + (!b.isConsistent ? ' [NEEDS COMPILE]' : '') + sig);
      }
      if (dbSummaries.length) {
        lines.push('');
        lines.push('GLOBAL DB STRUCTURES:');
        lines.push(...dbSummaries);
      }
      if ((types.types || []).length) {
        lines.push('');
        lines.push('PLC DATA TYPES (UDT): ' + types.types.map(t => t.name).join(', '));
      }
      if (tos.enumerationSupported === false) lines.push('Technological object enumeration is unavailable in the TIA V16 profile.');
      if ((tos.technologicalObjects || []).length) {
        lines.push('');
        lines.push('TECHNOLOGICAL OBJECTS (Motion/CNC/PID): ' + tos.technologicalObjects.map(t => t.name + ' (DB' + t.number + ')').join(', '));
      }
      const totalTags = (tags.tables || []).reduce((s, t) => s + t.tags.length, 0);
      lines.push('');
      lines.push('PLC TAGS (' + totalTags + ' across ' + (tags.tables || []).length + ' table(s)):');
      for (const tbl of (tags.tables || [])) {
        if (!tbl.tags.length) continue;
        lines.push('  [' + tbl.table + ']');
        for (const t of tbl.tags.slice(0, 60)) {
          lines.push('    "' + t.name + '" : ' + t.type + (t.address ? ' @ ' + t.address : '') + (t.comment ? ' // ' + t.comment : ''));
        }
        if (tbl.tags.length > 60) lines.push('    ... (+' + (tbl.tags.length - 60) + ' more; use tia_read_tags)');
      }
      return {
        text: lines.join('\n'),
        json: {
          project: devices.project,
          plc: blocks.plc,
          devices: devices.devices,
          blocksCount: filteredBlocks.length,
          totalBlocksCount: (blocks.blocks || []).length,
          tagsCount: totalTags,
          udts: (types.types || []).map(t => t.name),
          techObjects: (tos.technologicalObjects || []).map(t => ({ name: t.name, number: t.number })),
          ...(tos.enumerationSupported === false && { techObjectsSupported: false }),
          learnedBlocksCount,
          groupFilter: groupFilter || null,
        },
      };
    }

    case 'tia_list_blocks': {
      const data = await bridge.call('list_blocks', { plcName: args.plcName || '' });
      if (!args.plcName) bridge.resolveDefaultPlc(data.plc);
      let list = data.blocks;
      if (args.type) list = list.filter(b => b.type.toLowerCase() === args.type.toLowerCase());
      if (args.language) list = list.filter(b => b.language.toLowerCase() === args.language.toLowerCase());
      const lines = ['PLC "' + data.plc + '" — ' + list.length + ' block(s):'];
      for (const b of list) {
        lines.push('  ' + b.type.padEnd(10) + ' "' + b.name + '" #' + b.number + ' [' + b.language + ']' + (b.group ? ' @' + b.group : '') + (!b.isConsistent ? ' [INCONSISTENT]' : ''));
      }
      return { text: lines.join('\n'), json: { plc: data.plc, blocks: list } };
    }

    case 'tia_read_tags': {
      const data = await refreshTagCache(args.plcName || '');
      const q = (args.search || '').toLowerCase();
      const lines = ['PLC "' + data.plc + '" TAGS:'];
      for (const tbl of data.tables) {
        if (args.table && tbl.table.toLowerCase() !== args.table.toLowerCase()) continue;
        const rows = tbl.tags.filter(t => !q || t.name.toLowerCase().includes(q) || (t.address || '').toLowerCase().includes(q) || (t.comment || '').toLowerCase().includes(q));
        if (!rows.length && q) continue;
        lines.push('[' + tbl.table + '] (' + rows.length + ')');
        for (const t of rows) {
          lines.push('  "' + t.name + '" : ' + t.type + (t.address ? ' @ ' + t.address : '') + (t.comment ? ' // ' + t.comment : ''));
        }
      }
      return { text: lines.join('\n') };
    }

    case 'tia_upsert_tags': {
      if ((!args.tags || !args.tags.length) && (!args.delete || !args.delete.length)) throw new Error('Provide tags[] to upsert or delete[] with exact tag names.');
      const r = await bridge.call('upsert_tags', {
        plcName: args.plcName || '',
        table: args.table || 'Default tag table',
        tags: args.tags || [],
        delete: args.delete || [],
      });
      await refreshTagCache(args.plcName || '');
      return { text: 'Updated tag table "' + r.table + '":\n  ' + r.changes.join('\n  ') + ((r.warnings || []).length ? '\nWARNINGS: ' + r.warnings.join('; ') : ''), json: r };
    }

    case 'tia_read_db_udt': {
      const kind = args.kind || 'db';
      let xml;
      if (kind === 'udt') {
        const outPath = bridge.exportFilePath('UDT_' + args.name, '.xml');
        const res = await bridge.call('export_type', { typeName: args.name, outPath, plcName: args.plcName || '' });
        xml = fs.readFileSync(res.path, 'utf8');
      } else {
        xml = (await exportBlockXml(args.name, args.plcName)).xml;
      }
      const p = parseDbOrUdtXml(xml);
      if (kind === 'db') bridge.dbsCache[p.name] = p.interface;
      else if (kind === 'udt') bridge.udtsCache[p.name] = p.interface;
      return { text: p.kind + ' "' + p.name + '" ' + (p.number ? '#' + p.number + ' ' : '') + '(' + p.memoryLayout + ')\n' + B.interfaceText(p.interface), json: p };
    }

    case 'tia_edit_db_udt': {
      const action = args.action || 'edit';
      const kind = args.kind || 'db';
      if (action === 'delete') {
        const backup = await onlineBackups.backupOnly({ ...args, blockName: args.name }, kind === 'udt' ? 'udt' : 'block');
        const r = kind === 'udt'
          ? await bridge.call('delete_type', { typeName: args.name, plcName: args.plcName || '' })
          : await bridge.call('delete_block', { blockName: args.name, plcName: args.plcName || '' });
        bridge.invalidateObject(args.name);
        return { text: 'Deleted ' + kind + ' "' + r.deleted + '" (backup: ' + backup + ').', json: { ...r, backup } };
      }
      if (action === 'create') {
        const dbKind = kind === 'instance_db' ? 'InstanceDB' : (kind === 'udt' ? 'UDT' : 'GlobalDB');
        const xml = B.createDbXml({
          kind: dbKind,
          portalVersion: version,
          name: args.name,
          instanceOf: args.instanceOf,
          instanceOfType: args.instanceOfType || 'FB',
          number: args.number,
          memoryLayout: args.memoryLayout,
          members: args.add || [],
        });
        const outPath = bridge.exportFilePath((kind === 'udt' ? 'UDT_' : '') + args.name, '.xml');
        fs.writeFileSync(outPath, xml, 'utf8');
        if (kind === 'udt') {
          await bridge.call('import_type', { xmlPath: outPath, plcName: args.plcName || '' });
        } else {
          await bridge.call('import_block', { xmlPath: outPath, plcName: args.plcName || '', group: args.group || '' });
        }
        const p = parseDbOrUdtXml(xml);
        if (kind === 'db') bridge.dbsCache[p.name] = p.interface;
        else if (kind === 'udt') bridge.udtsCache[p.name] = p.interface;
        return {
          text: 'Created ' + dbKind + ' "' + args.name + '"' + (args.instanceOf ? ' (instance of ' + args.instanceOf + ')' : '') + '.\n' + B.interfaceText(p.interface),
          json: p,
        };
      }
      const sec = kind === 'udt' ? 'None' : 'Static';
      const { backup, result } = await onlineBackups.edit(args, kind === 'udt' ? 'udt' : 'block', xml => {
        if (args.remove && args.remove.length) xml = B.removeMembers(xml, args.remove.map(name => ({ section: sec, name })));
        if (args.add && args.add.length) xml = B.addMembers(xml, args.add.map(m => ({ ...m, section: sec })));
        return { xml };
      });
      const p = parseDbOrUdtXml(result.xml);
      if (kind === 'db') bridge.dbsCache[p.name] = p.interface;
      else if (kind === 'udt') bridge.udtsCache[p.name] = p.interface;
      return { text: 'Updated ' + kind.toUpperCase() + ' "' + args.name + '" (backup: ' + path.basename(backup) + ').\n' + B.interfaceText(p.interface) };
    }

    case 'tia_read_ladder': {
      let xml;
      if (args.xmlPath) {
        xml = fs.readFileSync(args.xmlPath, 'utf8');
      } else {
        if (!args.blockName) throw new Error('Provide blockName or xmlPath.');
        xml = (await exportBlockXml(args.blockName, args.plcName)).xml;
      }
      const r = B.readBlock(xml, {
        format: args.format || 'both',
        networks: args.networks,
        ctx: getLadderCtx(),
      });
      bridge.saveLearned();
      const formatted = annotateTags(B.formatBlock(r), bridge.tagsCache);
      return { text: formatted };
    }

    case 'tia_patch_ladder_network': {
      const offline = !!args.xmlPath;
      const { xml, result: patched, backup } = await editLadderXml(args,
        original => B.patchNetworks(original, args.ops, getLadderCtx({ declare: args.declare })), args.previewOnly);
      const summary = args.previewOnly || args.compact ? patchSummary(xml, patched) : '';
      if (args.previewOnly) return { text: 'PREVIEW\n' + summary };
      const importMsg = offline ? 'Wrote patched XML offline to ' + args.xmlPath : 'Imported back into TIA Portal: ' + args.blockName;
      const lines = [
        'PATCH OK — ' + patched.changes.join('; '),
        'BACKUP: ' + backup,
        importMsg,
      ];
      if (patched.dbInstances.length) {
        lines.push('NOTE (Global DB instances referenced): ' + patched.dbInstances.map(d => '"' + d.name + '" (' + d.type + ')').join(', '));
      }
      for (const w of patched.warnings) lines.push('! ' + w);
      if (!offline && args.compileAfter) {
        const comp = await bridge.call('compile', { plcName: args.plcName || '', enableSimulation: true });
        lines.push('COMPILE: ' + comp.software.state + ' (' + comp.software.errorCount + ' error(s), ' + comp.software.warningCount + ' warning(s))');
        for (const m of comp.software.messages) {
          if (m.state === 'Error' || m.state === 'Warning') lines.push('  [' + m.state + '] ' + (m.path ? m.path + ': ' : '') + m.description);
        }
      }
      lines.push('');
      lines.push(args.compact ? summary : B.formatBlock(B.readBlock(patched.xml, { format: 'dsl', ctx: getLadderCtx() })));
      return { text: lines.join('\n') };
    }

    case 'tia_edit_block_interface': {
      const { result, backup } = await editLadderXml(args, xml => {
        if (args.remove && args.remove.length) xml = B.removeMembers(xml, args.remove);
        if (args.add && args.add.length) xml = B.addMembers(xml, args.add);
        return { xml };
      });
      const parsed = B.parseBlock(result.xml);
      if (parsed.kind === 'FB' || parsed.kind === 'FC') {
        L.rememberCallInterface(bridge.learned.calls, parsed.name, parsed.kind, parsed.interface);
      }
      return { text: 'Updated interface of "' + parsed.name + '" (backup: ' + path.basename(backup) + '):\n' + B.interfaceText(parsed.interface) };
    }

    case 'tia_create_ladder_block': {
      const shouldImport = args.importToTia !== undefined ? args.importToTia : !args.outXmlPath;
      const xmlVersion = portalVersion(args.portalVersion === undefined ? version : args.portalVersion);
      if (shouldImport && xmlVersion !== version) throw new Error('XML version V' + xmlVersion + ' does not match the V' + version + ' bridge.');
      const created = B.createBlockXml({
        type: args.type,
        portalVersion: xmlVersion,
        secondaryType: args.secondaryType,
        name: args.name,
        number: args.number,
        title: args.title,
        comment: args.comment,
        memoryLayout: args.memoryLayout,
        interface: args.interface,
        networks: args.networks,
      }, getLadderCtx());

      const outPath = args.outXmlPath || bridge.exportFilePath(args.name, '.xml');
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, created.xml, 'utf8');

      let statusLine = 'Generated LAD XML at ' + outPath;
      const createdDbs = [];
      if (shouldImport) {
        const fbInsts = created.dbInstances.filter(d => d.fb && d.name);
        if (args.autoCreateInstanceDbs !== false && fbInsts.length) {
          const list = await bridge.call('list_blocks', { plcName: args.plcName || '' });
          const existing = new Set((list.blocks || []).map(b => String(b.name || '').toLowerCase()));
          const seen = new Set();
          for (const d of fbInsts) {
            const key = d.name.toLowerCase();
            if (existing.has(key) || seen.has(key)) continue;
            seen.add(key);
            const dbXml = B.createDbXml({ kind: 'InstanceDB', portalVersion: xmlVersion, name: d.name, instanceOf: d.type, instanceOfType: 'FB' });
            const dbPath = bridge.exportFilePath(d.name, '.xml');
            ensureDir(path.dirname(dbPath));
            fs.writeFileSync(dbPath, dbXml, 'utf8');
            await bridge.call('import_block', { xmlPath: dbPath, plcName: args.plcName || '', group: args.group || '' });
            createdDbs.push(d.name + ':' + d.type);
          }
        }
        const imp = await bridge.call('import_block', {
          xmlPath: outPath,
          plcName: args.plcName || '',
          group: args.group || '',
        });
        statusLine = 'Created & imported into TIA Portal: ' + (imp.blocks || []).join(', ') +
          (createdDbs.length ? '\nAuto-created InstanceDB(s): ' + createdDbs.join(', ') : '');
      }
      const preview = B.readBlock(created.xml, { format: 'both', ctx: getLadderCtx() });
      if (args.type === 'FB' || args.type === 'FC') {
        L.rememberCallInterface(bridge.learned.calls, args.name, args.type, preview.interface);
      }
      return { text: statusLine + '\n\n' + B.formatBlock(preview) };
    }

    case 'tia_analyze_ladder': {
      const reads = [];
      for (const p of (args.xmlPaths || [])) {
        reads.push(B.readBlock(fs.readFileSync(p, 'utf8'), { format: 'dsl', ctx: getLadderCtx() }));
      }
      for (const bn of (args.blocks || [])) {
        const { xml } = await exportBlockXml(bn, args.plcName);
        reads.push(B.readBlock(xml, { format: 'dsl', ctx: getLadderCtx() }));
      }
      if (!reads.length) throw new Error('Provide blocks[] or xmlPaths[] to analyze.');
      let suite = {};
      if (args.manifestPath) suite = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      const callCatalog = args.blocks?.length ? getLadderCtx().callCatalog : undefined;
      const res = A.analyze(reads, { callCatalog, symbol: args.symbol, targetSymbol: args.targetSymbol, targetBlock: args.targetBlock, cases: suite.cases, entry: suite.entry });
      return { text: A.formatAnalysis(res), json: res };
    }

    case 'tia_rollback_block': {
      const action = args.action || 'list';
      if (!['list', 'restore', 'delete'].includes(action)) throw new Error('Expected list, restore or delete.');
      if (action === 'delete') {
        if (!args.blockName || args.xmlPath) throw new Error('Online delete requires blockName and no xmlPath.');
        const kind = args.kind || 'block';
        const backup = await onlineBackups.backupOnly(args, kind);
        const r = kind === 'udt'
          ? await bridge.call('delete_type', { typeName: args.blockName, plcName: args.plcName || '' })
          : await bridge.call('delete_block', { blockName: args.blockName, plcName: args.plcName || '' });
        bridge.invalidateObject(args.blockName);
        return { text: 'Deleted "' + r.deleted + '" (backup: ' + backup + ').', json: { ...r, backup } };
      }
      if (!args.xmlPath && action === 'restore') {
        const file = await onlineBackups.rollback(args, action);
        return { text: 'Restored from backup "' + file + '" -> imported: ' + args.blockName };
      }
      const list = args.xmlPath ? bridge.listBackups(bridge.offlineBackupLabel(args.xmlPath))
        : args.blockName ? await onlineBackups.rollback(args, action) : bridge.listBackups();
      if (action === 'list') {
        if (!list.length) return { text: 'No backups found' + (args.blockName ? ' for "' + args.blockName + '"' : '') + '.' };
        return { text: 'BACKUPS (' + list.length + '):\n' + list.slice(0, 30).map(b => '  ' + b.file + ' (' + b.size + ' B, ' + b.mtime + ')').join('\n') };
      }
      const backup = list.find(item => item.file === args.backupFile);
      if (!backup) throw new Error('Select a backupFile listed for this xmlPath.');
      const target = fs.realpathSync.native(args.xmlPath);
      const dir = fs.mkdtempSync(path.join(path.dirname(target), '.tia-restore-'));
      try {
        const staged = path.join(dir, 'restore.xml');
        fs.copyFileSync(backup.path, staged);
        fs.renameSync(staged, target);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { text: 'Restored ' + backup.file + ' to ' + target };
    }

    case 'tia_export_raw': {
      const fmt = args.format || 'xml';
      const outPath = fmt === 's7dcl' ? path.join(EXPORTS_DIR, 's7dcl') : bridge.exportFilePath(args.blockName, '.xml');
      const res = await bridge.call('export_block', { blockName: args.blockName, plcName: args.plcName || '', outPath, format: fmt });
      const maxChars = args.maxChars || 12000;
      if (fmt === 's7dcl') {
        const parts = ['Exported SIMATIC SD (' + res.state + '):'];
        for (const f of (res.files || [])) {
          const content = fs.readFileSync(f, 'utf8');
          parts.push('--- ' + path.basename(f) + ' ---\n' + content.slice(0, maxChars));
        }
        return { text: parts.join('\n') };
      }
      const xml = fs.readFileSync(res.path, 'utf8');
      return { text: 'Exported to ' + res.path + ' (' + xml.length + ' chars):\n' + xml.slice(0, maxChars) + (xml.length > maxChars ? '\n... (truncated)' : '') };
    }

    case 'tia_test_ladder_project': {
      const report = project.runProject(args.manifestPath, { targetSymbol: args.targetSymbol, targetBlock: args.targetBlock, baselineBlockDir: args.baselineBlockDir });
      return { text: project.formatReport(report, args.format), json: report };
    }
    case 'tia_dry_run_ladder': {
      const reads = [];
      for (const p of (args.xmlPaths || [])) {
        reads.push(B.readBlock(fs.readFileSync(p, 'utf8'), { format: 'dsl', ctx: getLadderCtx() }));
      }
      for (const bn of (args.blocks || [])) {
        const { xml } = await exportBlockXml(bn, args.plcName);
        reads.push(B.readBlock(xml, { format: 'dsl', ctx: getLadderCtx() }));
      }
      for (const ib of (args.inlineBlocks || [])) {
        const networks = (ib.networks || []).map((dsl, idx) => ({
          index: idx + 1,
          dsl,
          flows: D.parseNetwork(dsl).flows,
        }));
        reads.push({
          block: { name: ib.name, type: ib.type || 'FB' },
          interface: ib.interface || {},
          networks,
        });
      }
      if (!reads.length) throw new Error('Provide blocks[], xmlPaths[], or inlineBlocks[] for simulation.');
      const prog = S.buildProgram(reads, args.entry);
      const res = S.runScenario(prog, args.scenario || {});
      return { text: S.formatResults(res), json: res };
    }

    case 'tia_compile': {
      const r = await bridge.call('compile', {
        plcName: args.plcName || '',
        enableSimulation: args.enableSimulation !== false,
        includeHardware: !!args.includeHardware,
      });
      const lines = [
        'COMPILE PLC "' + r.plc + '" (SimulationEnabled=' + r.simulationSupported + ')',
        'SOFTWARE: ' + r.software.state + ' — ' + r.software.errorCount + ' error(s), ' + r.software.warningCount + ' warning(s)',
      ];
      for (const m of r.software.messages) {
        lines.push('  [' + m.state + '] ' + (m.path ? m.path + ': ' : '') + m.description);
      }
      if (r.hardware) {
        lines.push('HARDWARE: ' + r.hardware.state + ' — ' + r.hardware.errorCount + ' error(s), ' + r.hardware.warningCount + ' warning(s)');
        for (const m of r.hardware.messages) {
          lines.push('  [' + m.state + '] ' + (m.path ? m.path + ': ' : '') + m.description);
        }
      }
      return { text: lines.join('\n'), json: r };
    }

    case 'tia_sim_prepare': {
      if (version === '16' && args.launchPlcsim !== false) throw new Error('PLCSIM launch is unavailable in the V16 profile. Set launchPlcsim:false to generate only the CSV.');
      const lines = [];
      if (args.launchPlcsim !== false) {
        const sim = await bridge.call('sim_launch', {});
        lines.push(sim.alreadyRunning
          ? 'S7-PLCSIM V20 is already running (PID ' + sim.pids.join(',') + ').'
          : 'Launched S7-PLCSIM V20 (PID ' + sim.pid + ').');
      }
      if (args.generateSimTable !== false) {
        let rows = args.signals;
        if (!rows || !rows.length) {
          const tagData = await refreshTagCache(args.plcName || '');
          rows = [];
          for (const tbl of tagData.tables) {
            for (const t of tbl.tags) rows.push(t);
          }
        }
        const csvPath = bridge.writeSimTableCsv(args.tableName || 'PLC', rows);
        lines.push('Generated SIM Table CSV (' + rows.length + ' signal(s)): ' + csvPath);
        lines.push('Tip: In S7-PLCSIM V20, open SIM View -> Import SIM Table -> select this CSV, or use tia_download_and_online(action="download") after starting a virtual CPU instance.');
      }
      return { text: lines.join('\n') };
    }

    case 'tia_download_and_online': {
      const act = args.action;
      if (act === 'list_connections') {
        const r = await bridge.call('list_connections', { plcName: args.plcName || '' });
        const lines = ['CONNECTION INTERFACES for "' + r.plc + '":'];
        for (const m of r.modes) {
          lines.push('  Mode: ' + m.name);
          for (const pc of m.pcInterfaces) {
            const parts = [];
            if ((pc.targetInterfaces || []).length) parts.push('targets: [' + pc.targetInterfaces.join(', ') + ']');
            if ((pc.subnets || []).length) parts.push('subnets: [' + pc.subnets.join(', ') + ']');
            lines.push('    - ' + pc.name + (parts.length ? ' -> ' + parts.join('; ') : ''));
          }
        }
        return { text: lines.join('\n'), json: r };
      }
      if (act === 'download') {
        if (!args.plcName || !args.pcInterface) throw new Error('Download requires explicit plcName and exact pcInterface. Use list_connections first.');
        if (!/PLCSIM/i.test(args.pcInterface) && !args.targetAddress) throw new Error('Physical PLC download requires targetAddress.');
        if (args.targetInterfaceIndex !== undefined && (!Number.isInteger(args.targetInterfaceIndex) || args.targetInterfaceIndex < 0)) throw new Error('targetInterfaceIndex must be a non-negative integer.');
        const r = await bridge.call('download', {
          plcName: args.plcName || '',
          mode: args.mode || 'PN/IE',
          pcInterface: args.pcInterface,
          targetAddress: args.targetAddress || '',
          targetInterfaceIndex: args.targetInterfaceIndex ?? 0,
          includeHardware: args.includeHardware === true,
          startAfterDownload: args.startAfterDownload === true,
          allowStopModules: args.allowStopModules === true,
          allowDifferentTargetConfiguration: args.allowDifferentTargetConfiguration === true,
        });
        const lines = [
          'DOWNLOAD to "' + r.plc + '" via ' + r.pcInterface + ' (' + r.targetInterface +
            (r.targetAddress ? ' @ ' + r.targetAddress : '') + '): ' + r.state,
          'Errors: ' + r.errorCount + ', Warnings: ' + r.warningCount,
          'Scope: ' + r.scope + '; startAfterDownload=' + r.startAfterDownload + '; allowStopModules=' + r.allowStopModules + '; allowDifferentTargetConfiguration=' + r.allowDifferentTargetConfiguration,
        ];
        for (const entry of (r.configLog || [])) lines.push('  CONFIG: ' + entry);
        for (const m of r.messages) lines.push('  [' + m.state + '] ' + m.message);
        return { text: lines.join('\n'), json: r };
      }
      if (act === 'station_upload') {
        if (!args.targetAddress) throw new Error('targetAddress (e.g. "192.168.0.1") is required for station_upload.');
        const r = await bridge.call('station_upload', {
          mode: args.mode || 'PN/IE',
          pcInterface: args.pcInterface || '',
          targetAddress: args.targetAddress,
        }, 180000);
        const lines = [
          'STATION UPLOAD from ' + args.targetAddress + ': ' + r.state +
            (r.uploadedStation ? ' -> "' + r.uploadedStation + '"' : ''),
          'Errors: ' + r.errorCount + ', Warnings: ' + r.warningCount,
        ];
        for (const l of (r.configLog || [])) lines.push('  ' + l);
        return { text: lines.join('\n'), json: r };
      }
      const onlineAct = act === 'online_status' ? 'status' : act;
      if (onlineAct === 'go_online' && args.pcInterface !== undefined && !args.pcInterface) throw new Error('go_online pcInterface must be an exact non-empty name from list_connections.');
      const r = await bridge.call('online', {
        plcName: args.plcName || '',
        action: onlineAct,
        mode: args.mode || 'PN/IE',
        pcInterface: args.pcInterface || '',
      });
      return { text: 'PLC "' + r.plc + '" Online State: ' + r.state, json: r };
    }

    case 'tia_watch_table': {
      const action = args.action || 'list';
      const tableName = args.name || 'Watch_Table_MCP';
      const payload = {
        action,
        plcName: args.plcName || '',
        name: tableName,
        clearExisting: !!args.clearExisting,
        showInEditor: !!args.showInEditor,
      };
      if (args.entries) payload.entries = args.entries;
      if (action === 'export') payload.path = args.path || bridge.exportFilePath(tableName, '.xml');
      if (action === 'import') {
        if (!args.path) throw new Error('path is required for watch_table action="import".');
        payload.path = args.path;
      }

      const r = await bridge.call('watch_table', payload);
      if (action === 'list') {
        const lines = ['PLC "' + r.plc + '" WATCH/FORCE TABLES:'];
        lines.push('  WATCH TABLES (' + (r.watchTables || []).length + '):');
        if (!r.watchTables || !r.watchTables.length) lines.push('    (none)');
        for (const w of (r.watchTables || [])) {
          lines.push('    "' + w.name + '"' + (w.group ? ' @' + w.group : '') + ' — ' + plural(w.entryCount, 'entry', 'entries') + (w.isConsistent ? '' : ' [INCONSISTENT]'));
        }
        lines.push('  FORCE TABLES (' + (r.forceTables || []).length + '):');
        if (!r.forceTables || !r.forceTables.length) lines.push('    (none)');
        for (const f of (r.forceTables || [])) {
          lines.push('    "' + f.name + '"' + (f.group ? ' @' + f.group : '') + ' — ' + plural(f.entryCount, 'entry', 'entries'));
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'read') {
        const lines = ['WATCH TABLE "' + r.table + '" — ' + plural(r.entryCount, 'entry', 'entries')];
        for (const e of (r.entries || [])) {
          lines.push('  ' + (e.name || '(no name)') + (e.address ? ' @ ' + e.address : '') + ' [' + e.displayFormat + ']' +
            (e.modifyValue ? ' modify=' + e.modifyValue : '') + (e.comment ? ' // ' + e.comment : ''));
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'delete') {
        return { text: 'Deleted watch table "' + r.deleted + '".', json: r };
      }
      if (action === 'export') {
        return { text: 'Exported watch table "' + r.table + '" to ' + r.path, json: r };
      }
      if (action === 'import') {
        return {
          text: 'Imported watch table(s): ' + ((r.imported || []).join(', ') || '(none)') + (r.shownInEditor ? ' (shown in editor)' : ''),
          json: r,
        };
      }
      const lines = ['Watch table "' + r.table + '" now has ' + plural(r.entryCount, 'entry', 'entries') + (r.shownInEditor ? ' (shown in editor)' : '')];
      for (const c of (r.changes || [])) lines.push('  ' + c);
      if ((r.warnings || []).length) {
        lines.push('WARNINGS:');
        for (const w of r.warnings) lines.push('  ! ' + w);
      }
      return { text: lines.join('\n'), json: r };
    }

    case 'tia_show_in_editor': {
      const r = await bridge.call('show_in_editor', {
        plcName: args.plcName || '',
        kind: args.kind || 'block',
        name: args.name || '',
      });
      const kind = r.kind || r.view || 'object';
      return { text: 'Opened ' + kind + ' "' + r.shown + '" in the TIA Portal editor.', json: r };
    }

    case 'tia_scl_source': {
      const action = args.action || 'export';
      const payload = {
        action,
        plcName: args.plcName || '',
        blockName: args.blockName || '',
        typeName: args.typeName || '',
        outPath: args.outPath || '',
        withDependencies: !!args.withDependencies,
        filePath: args.filePath || '',
        sourceName: args.sourceName || 'MCP_Generated_Source',
        group: args.group || '',
        keepExternalSource: !!args.keepExternalSource,
      };
      if (args.sourceCode !== undefined) payload.sourceCode = args.sourceCode;

      if (action === 'export' || action === 'read') {
        if (!args.blockName && !args.typeName) throw new Error('Provide blockName or typeName for SCL export.');
        if (!payload.outPath) {
          const label = args.blockName || args.typeName;
          payload.outPath = bridge.exportFilePath(label, args.typeName ? '.udt' : '.scl');
        }
      } else if (action === 'import' || action === 'write') {
        if (!args.sourceCode && !args.filePath) throw new Error('Provide sourceCode or filePath for SCL import.');
      }

      let priorSourceBackup = null;
      if (action === 'import' || action === 'write') {
        const sourceText = args.sourceCode || fs.readFileSync(args.filePath, 'utf8');
        const declared = /\b(?:FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK)\s+"?([A-Za-z_][\w]*)"?/i.exec(sourceText);
        const targetName = args.blockName || (declared && declared[1]);
        if (targetName) {
          const blocks = await bridge.call('list_blocks', { plcName: args.plcName || '' });
          if ((blocks.blocks || []).some(b => b.name === targetName)) {
            const exportPath = bridge.uniqueExportPath(targetName, '.scl');
            try {
              const previous = await bridge.call('scl_source', { action: 'export', blockName: targetName, plcName: args.plcName || '', outPath: exportPath });
              const label = 'scl_' + crypto.createHash('sha256').update(JSON.stringify([bridge.projectPath, blocks.plc, targetName])).digest('hex').slice(0, 24);
              priorSourceBackup = bridge.saveBackup(label, previous.sourceCode);
            } finally { try { fs.unlinkSync(exportPath); } catch { } }
          }
        }
      }
      const r = await bridge.call('scl_source', payload, 120000);
      if (action === 'export' || action === 'read') {
        const maxChars = args.maxChars || 20000;
        const code = r.sourceCode || '';
        return {
          text: 'Generated source "' + r.name + '" -> ' + r.path + ' (' + code.length + ' chars):\n' +
            code.slice(0, maxChars) + (code.length > maxChars ? '\n... (truncated)' : ''),
          json: { name: r.name, path: r.path, length: code.length },
        };
      }
      return {
        text: 'Imported SCL/DB/UDT source -> generated: ' + ((r.generatedObjects || []).join(', ') || '(none)') +
          '\nFile: ' + r.filePath + (priorSourceBackup ? '\nPrevious source backup: ' + priorSourceBackup : ''),
        json: { ...r, priorSourceBackup },
      };
    }

    case 'tia_cross_reference': {
      const r = await bridge.call('cross_reference', {
        plcName: args.plcName || '',
        filter: args.filter || 'used',
        symbol: args.symbol || '',
        blockName: args.blockName || '',
        limit: args.limit || 200,
      }, 120000);
      const lines = ['CROSS-REFERENCE PLC "' + r.plc + '" — filter=' + r.filter +
        (r.symbolFilter ? ' symbol~"' + r.symbolFilter + '"' : '') + ' — ' + plural(r.count, 'source object')];
      for (const s of (r.sources || [])) {
        lines.push('  "' + s.name + '"' + (s.address ? ' @ ' + s.address : '') + (s.typeName ? ' : ' + s.typeName : '') +
          ' — ' + plural(s.referenceCount, 'reference'));
        for (const ref of (s.references || [])) {
          const locs = (ref.locations || []).map(l =>
            (l.location || '') + (l.access ? ' [' + l.access + ']' : '') + (l.address ? ' @ ' + l.address : '')
          ).join('; ');
          lines.push('    <- ' + (ref.referencedIn || '(unknown)') + (ref.type ? ' (' + ref.type + ')' : '') +
            (ref.path ? ' ' + ref.path : '') + (locs ? ': ' + locs : ''));
        }
      }
      return { text: lines.join('\n'), json: r };
    }

    case 'tia_hardware_config': {
      const action = args.action || 'presets';
      const payload = {
        action,
        attributes: args.attributes || {},
        parameters: args.parameters || {},
      };
      if (args.directory) payload.directory = args.directory;
      if (args.mode) payload.mode = args.mode;
      if (args.closeCurrent !== undefined) payload.closeCurrent = !!args.closeCurrent;
      if (args.plcName) payload.plcName = args.plcName;
      if (args.typeIdentifier) payload.typeIdentifier = args.typeIdentifier;
      if (args.stationName) payload.stationName = args.stationName;
      if (args.moduleName) payload.moduleName = args.moduleName;
      if (args.slot !== undefined) payload.slot = args.slot;
      if (args.query) payload.query = args.query;
      if (args.filter) payload.filter = args.filter;
      if (args.limit !== undefined) payload.limit = args.limit;
      if (args.name) payload.name = args.name;
      if (args.type) payload.type = args.type;
      if (args.version) payload.version = args.version;
      for (const k of ['enableSystemMemory', 'systemMemoryAddress', 'enableClockMemory', 'clockMemoryAddress', 'permitPutGet', 'disableSecurity', 'accessControl', 'accessLevel', 'protectConfigData', 'masterSecretPassword', 'oldMasterSecretPassword', 'accessLevelPassword']) {
        if (args[k] !== undefined) payload[k] = args[k];
      }

      const timeout = action === 'create_project' ? 180000 : 120000;
      const r = await bridge.call('hardware_config', payload, timeout);
      if (action === 'presets') {
        const keys = Object.keys(r.presets || {}).sort();
        const lines = ['HARDWARE PRESETS (' + keys.length + '):'];
        for (const k of keys) lines.push('  ' + k.padEnd(24) + ' -> ' + r.presets[k]);
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'create_project') {
        bridge.clearProjectScope(); bridge.setScope(r.projectPath || '', '');
        return { text: 'Created project "' + r.projectName + '" (' + r.projectPath + ').', json: r };
      }
      if (action === 'search_catalog') {
        const lines = ['HARDWARE CATALOG "' + r.query + '" — ' + plural(r.count, 'entry', 'entries') + ':'];
        for (const e of (r.entries || [])) {
          lines.push('  ' + e.typeIdentifier + ' | ' + e.articleNumber + ' / ' + e.version + ' | ' + e.description);
          if (e.catalogPath) lines.push('    path: ' + e.catalogPath);
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'add_plc' || action === 'add_device') {
        const lines = ['Created station "' + r.stationName + '" with PLC "' + r.plcName + '" (' + r.typeIdentifier + ').'];
        const dev = r.device || {};
        for (const it of (dev.items || [])) {
          lines.push('  - ' + it.name + (it.typeIdentifier ? ' [' + it.typeIdentifier + ']' : '') + (it.isPlc ? ' (PLC software: ' + it.plcSoftwareName + ')' : '') + hardwareIoText(it));
        }
        if ((r.securityApplied || []).length) {
          lines.push('  Security settings applied: ' + r.securityApplied.join(', '));
        }
        if ((r.securityWarnings || []).length) {
          lines.push('  Security warnings: ' + r.securityWarnings.join('; '));
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'plug_module') {
        const items = (r.items || []).map(it => ({ name: it.name, io: hardwareIoText(it) })).filter(it => it.io);
        const details = items.map(it => '\n  ' + it.name + it.io).join('');
        return { text: 'Plugged "' + r.name + '" into slot ' + r.slot + ' (' + r.typeIdentifier + ').' + details, json: r };
      }
      if (action === 'cpu_properties') {
        const lines = ['CPU "' + r.plc + '" property changes:'];
        if (!(r.applied || []).length) lines.push('  (none)');
        for (const a of (r.applied || [])) lines.push('  ' + a);
        if ((r.warnings || []).length) {
          lines.push('WARNINGS:');
          for (const w of r.warnings) lines.push('  ! ' + w);
        }
        const keys = Object.keys(r.keyAttributes || {}).sort();
        if (keys.length) {
          lines.push('KEY ATTRIBUTES:');
          for (const k of keys) lines.push('  ' + k + ' = ' + fmtValue(r.keyAttributes[k]));
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'create_tech_object') {
        const lines = ['Technological object "' + r.name + '" #' + r.number + ' (' + r.type + ' v' + r.version + ').'];
        if (!(r.parameterChanges || []).length) lines.push('  (no parameter changes)');
        for (const p of (r.parameterChanges || [])) lines.push('  ' + p);
        if ((r.warnings || []).length) {
          lines.push('WARNINGS:');
          for (const w of r.warnings) lines.push('  ! ' + w);
        }
        return { text: lines.join('\n'), json: r };
      }
      return { text: JSON.stringify(r, null, 2), json: r };
    }

    case 'tia_network_config': {
      const action = args.action || 'inspect';
      const payload = {
        action,
        plcName: args.plcName || '',
        deviceName: args.deviceName || '',
        interfaceName: args.interfaceName || '',
        ipAddress: args.ipAddress || '',
        subnetMask: args.subnetMask || '',
        routerAddress: args.routerAddress || '',
        subnetName: args.subnetName || '',
        ioSystemName: args.ioSystemName || '',
        pnDeviceName: args.pnDeviceName || '',
      };
      if (args.createIoSystem !== undefined) payload.createIoSystem = !!args.createIoSystem;
      if (args.enableServer !== undefined) payload.enableServer = !!args.enableServer;
      if (args.port !== undefined) payload.port = args.port;

      const r = await bridge.call('network_config', payload, 120000);
      if (action === 'inspect') {
        const lines = ['SUBNETS (' + (r.subnets || []).length + '):'];
        if (!r.subnets || !r.subnets.length) lines.push('  (none)');
        for (const s of (r.subnets || [])) {
          lines.push('  "' + s.name + '" [' + s.typeIdentifier + ']' + ((s.ioSystems || []).length ? ' IO systems: ' + s.ioSystems.join(', ') : ''));
        }
        lines.push('NETWORK INTERFACES (' + (r.interfaces || []).length + '):');
        if (!r.interfaces || !r.interfaces.length) lines.push('  (none)');
        for (const i of (r.interfaces || [])) {
          lines.push('  ' + i.device + ' / ' + i.interfaceItem + ' [' + i.interfaceType + ', ' + i.operatingMode + ']');
          for (const n of (i.nodes || [])) {
            const details = [];
            if (n.Address) details.push('IP ' + n.Address);
            if (n.SubnetMask) details.push('mask ' + n.SubnetMask);
            if (n.PnDeviceName) details.push('PN name ' + n.PnDeviceName);
            const useRouter = n.UseRouter === true || n.UseRouter === 'True' || n.UseRouter === 1;
            if (useRouter) details.push('router ' + (n.RouterAddress || '?'));
            lines.push('    node "' + n.name + '" (' + n.nodeType + ')' +
              (n.connectedSubnet ? ' -> subnet "' + n.connectedSubnet + '"' : '') +
              (details.length ? ' — ' + details.join(', ') : ''));
          }
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'opcua') {
        const lines = ['OPC UA settings on PLC "' + r.plc + '":'];
        if (!(r.changes || []).length) lines.push('  (no changes)');
        for (const c of (r.changes || [])) lines.push('  ' + c);
        if ((r.warnings || []).length) {
          lines.push('WARNINGS:');
          for (const w of r.warnings) lines.push('  ! ' + w);
        }
        return { text: lines.join('\n'), json: r };
      }
      const lines = ['Device "' + (r.device || r.plc) + '" via interface "' + r.interface + '"' + (r.ioSystem ? ' -> IO System "' + r.ioSystem + '"' : '') + ':'];
      if (!(r.changes || []).length) lines.push('  (no changes)');
      for (const c of (r.changes || [])) lines.push('  ' + c);
      if ((r.warnings || []).length) {
        lines.push('WARNINGS:');
        for (const w of r.warnings) lines.push('  ! ' + w);
      }
      return { text: lines.join('\n'), json: r };
    }

    case 'tia_plcsim_runtime': {
      const action = args.action || 'status';
      const payload = {
        action,
        cpuType: args.cpuType || 'CPU1500_Unspecified',
        articleNumber: args.articleNumber || '',
        operation: args.operation || 'run',
        timeoutMs: args.timeoutMs !== undefined ? args.timeoutMs : (action === 'run_sequence' ? 120000 : 30000),
        search: args.search || '',
        limit: args.limit || 200,
        signals: args.signals || [],
        values: args.values || {},
        watch: args.watch || [],
        steps: args.steps || [],
        sampleIntervalMs: args.sampleIntervalMs !== undefined ? args.sampleIntervalMs : 50,
      };
      if (args.instanceName) payload.instanceName = args.instanceName;
      if (args.powerOn !== undefined) payload.powerOn = !!args.powerOn;
      if (args.run !== undefined) payload.run = !!args.run;
      if (args.refreshTagList !== undefined) payload.refreshTagList = !!args.refreshTagList;
      if (args.ipAddress !== undefined) payload.ipAddress = args.ipAddress;
      if (args.subnetMask !== undefined) payload.subnetMask = args.subnetMask;
      if (args.gateway !== undefined) payload.gateway = args.gateway;
      if (action === 'read' && !payload.signals.length) throw new Error('signals[] is required for plcsim_runtime action="read".');
      if (action === 'write' && !Object.keys(payload.values).length) throw new Error('values{} is required for plcsim_runtime action="write".');

      const r = await bridge.call('plcsim_runtime', payload, 300000);
      if (action === 'status') {
        const lines = ['S7-PLCSIM V20 RUNTIME STATUS:'];
        lines.push('  GUI running: ' + r.plcsimV20GuiRunning);
        lines.push('  VPLC host running: ' + r.vplcHostRunning);
        lines.push('  Runtime available: ' + r.runtimeAvailable + (r.runtimeInitialized !== undefined ? ' (initialized: ' + r.runtimeInitialized + ')' : ''));
        if (r.networkMode) lines.push('  Network mode: ' + r.networkMode);
        if (r.runtimeNote) lines.push('  NOTE: ' + r.runtimeNote);
        lines.push('  INSTANCES (' + (r.instances || []).length + '):');
        if (!r.instances || !r.instances.length) lines.push('    (none)');
        for (const i of (r.instances || [])) {
          lines.push('    - "' + i.name + '" (id ' + i.id + ')' +
            (i.operatingState ? ' state=' + i.operatingState : '') +
            (i.communicationInterface ? ' comm=' + i.communicationInterface : '') +
            (i.ips !== undefined ? ' ip=' + fmtValue(i.ips) : ''));
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'register') {
        return {
          text: 'Registered PLCSIM instance "' + r.instanceName + '" (id ' + r.id + ') state=' + r.operatingState +
            ' ip=' + fmtValue(r.ips),
          json: r,
        };
      }
      if (action === 'control') {
        if (r.unregistered) return { text: 'Unregistered PLCSIM instance.', json: r };
        return { text: 'PLCSIM instance "' + r.instanceName + '" -> ' + r.operatingState, json: r };
      }
      if (action === 'list_tags') {
        const lines = ['PLCSIM INSTANCE "' + r.instanceName + '" — ' + plural(r.count, 'tag') + ':'];
        for (const t of (r.tags || [])) {
          lines.push('  ' + t.name + ' [' + t.area + '] ' + t.dataType + ' (primitive ' + t.primitiveType + ') @ offset ' + t.offset + '.' + t.bit);
        }
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'read') {
        const lines = ['PLCSIM INSTANCE "' + r.instanceName + '" state=' + r.operatingState + ':'];
        for (const k of Object.keys(r.values || {})) lines.push('  ' + k + ' = ' + fmtValue(r.values[k]));
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'write') {
        const lines = ['PLCSIM INSTANCE "' + r.instanceName + '" written:'];
        for (const w of (r.written || [])) lines.push('  ' + w);
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'run_sequence') {
        const lines = ['PLCSIM RUN SEQUENCE on "' + r.instanceName + '" — ' + (r.passed ? 'PASS' : 'FAIL') +
          ' in ' + r.elapsedMs + ' ms, ' + plural((r.assertions || []).length, 'assertion') + ', ' + plural(r.sampleCount, 'sample') + ':'];
        if (!(r.assertions || []).length) lines.push('  (no assertions)');
        for (const a of (r.assertions || [])) {
          lines.push('  ' + (a.ok ? 'PASS' : 'FAIL') + ' step ' + a.step + ' @' + a.tMs + 'ms ' + a.signal +
            ': expected ' + fmtValue(a.expected) + ', actual ' + fmtValue(a.actual));
        }
        if ((r.warnings || []).length) {
          lines.push('WARNINGS:');
          for (const w of r.warnings) lines.push('  ! ' + w);
        }
        const samples = r.samples || [];
        if (samples.length) {
          // Print first sample, samples where watched values changed, and last sample (capped at 25 lines)
          const notable = [];
          let prevSig = null;
          for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            const sig = JSON.stringify(s.values || {});
            if (i === 0 || i === samples.length - 1 || sig !== prevSig) {
              notable.push(s);
              prevSig = sig;
            }
          }
          lines.push('WATCH TRACE (' + notable.length + ' transition(s) / ' + samples.length + ' total samples):');
          for (const s of notable.slice(0, 25)) {
            const pairs = Object.keys(s.values || {}).map(k => k + '=' + fmtValue(s.values[k])).join(', ');
            lines.push('  @' + s.tMs + 'ms: ' + pairs);
          }
          if (notable.length > 25) lines.push('  ... (+' + (notable.length - 25) + ' more transitions)');
        }
        return { text: lines.join('\n'), json: r };
      }
      return { text: JSON.stringify(r, null, 2), json: r };
    }

    case 'tia_escape_hatch': {
      const action = args.action || 'inspect';
      const payload = {
        action,
        target: args.target || 'project',
        plcName: args.plcName || '',
        filter: args.filter || '',
        includeValues: args.includeValues !== false,
        attribute: args.attribute || '',
        composition: args.composition || '',
        service: args.service || '',
        findName: args.findName || '',
        index: args.index !== undefined ? args.index : -1,
        attributes: args.attributes || {},
        method: args.method || '',
        methodArgs: args.methodArgs || [],
        handle: args.handle || '',
      };
      if (args.value !== undefined) payload.value = args.value;

      const r = await bridge.call('escape_hatch', payload, 120000);
      if (action === 'list_handles') {
        const lines = ['ESCAPE HATCH HANDLES (' + r.count + '):'];
        for (const h of (r.handles || [])) lines.push('  ' + h.handle + '  ' + (h.name || '') + '  [' + h.type + ']');
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'release_handles') {
        return {
          text: r.released !== undefined ? 'Released handle ' + r.released + '.' : 'Released all ' + r.releasedAll + ' handle(s).',
          json: r,
        };
      }
      if (action === 'inspect') {
        const lines = ['ESCAPE HATCH — ' + r.clrType + ' (' + r.handle + ')'];
        const attrs = r.attributes || [];
        lines.push('ATTRIBUTES (' + attrs.length + '):');
        for (const a of attrs.slice(0, 100)) {
          const types = (a.types || []).length ? ' {' + a.types.join('|') + '}' : '';
          lines.push('  ' + a.name + ' [' + a.access + ']' + types + (a.value !== undefined ? ' = ' + fmtValue(a.value) : ''));
        }
        if (attrs.length > 100) lines.push('  ... (+' + (attrs.length - 100) + ' more)');
        const comps = r.compositions || [];
        lines.push('COMPOSITIONS (' + comps.length + '):');
        for (const c of comps) lines.push('  ' + c.name + ' (count=' + c.count + ')');
        const services = r.services || [];
        lines.push('SERVICES (' + services.length + '):');
        for (const s of services) lines.push('  ' + s);
        const methods = r.methods || [];
        lines.push('CLR METHODS (' + methods.length + '):');
        for (const m of methods.slice(0, 40)) lines.push('  ' + m);
        if (methods.length > 40) lines.push('  ... (+' + (methods.length - 40) + ' more)');
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'get') {
        const vh = r.valueHandle ? ' [handle: ' + r.valueHandle + ']' : '';
        if (r.attribute !== undefined) return { text: r.attribute + ' = ' + fmtValue(r.value) + vh, json: r };
        if (r.property !== undefined) return { text: r.property + ' = ' + fmtValue(r.value) + vh, json: r };
        if (r.composition !== undefined) {
          const lines = ['COMPOSITION "' + r.composition + '" — ' + plural(r.count, 'item') + ':'];
          for (const it of (r.items || [])) {
            lines.push('  [' + it.index + '] ' + (it.name || '(no name)') + ' [' + it.type + '] -> ' + it.handle);
          }
          return { text: lines.join('\n'), json: r };
        }
        if (r.compositionHandle !== undefined) return { text: 'Composition handle: ' + r.compositionHandle, json: r };
        if (r.service !== undefined) return { text: 'Resolved service ' + r.service + ' -> ' + r.handle, json: r };
        if (r.handle !== undefined) return { text: 'Found "' + (r.name || '') + '" [' + (r.type || '') + '] -> ' + r.handle, json: r };
        return { text: JSON.stringify(r, null, 2), json: r };
      }
      if (action === 'set') {
        const lines = ['Updated ' + r.handle + ':'];
        if (!(r.updated || []).length) lines.push('  (no changes)');
        for (const u of (r.updated || [])) lines.push('  ' + u);
        return { text: lines.join('\n'), json: r };
      }
      if (action === 'invoke') {
        return { text: 'Invoked ' + r.invoked + ' -> ' + fmtValue(r.result), json: r };
      }
      return { text: JSON.stringify(r, null, 2), json: r };
    }

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

  return { handleTool, getLadderCtx };
}

module.exports = { createToolHandler };
