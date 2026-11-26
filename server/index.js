'use strict';
// TIA Portal V20 MCP Server (Stdio JSON-RPC 2.0, zero external npm dependencies).
// Combines TiaBridge.exe (C# .NET 4.8 TIA Openness V20) with the 2-way Ladder Engine,
// Static Analyzer and In-RAM PLC Scan-Cycle Simulator.

const fs = require('fs');
const path = require('path');
const { BridgeClient, EXPORTS_DIR, ensureDir } = require('./bridge_client');
const { OnlineBackups } = require('./online_backups');
const B = require('./ladder/block');
const { readFlgNet } = require('./ladder/reader');
const D = require('./ladder/dsl');
const L = require('./ladder/learn');
const A = require('./ladder/analyzer');
const S = require('./ladder/simulator');
const project = require('./ladder/project');
const X = require('./ladder/xml');

const SERVER_INFO = { name: 'tia-portal-v20-mcp', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOL_VERSION = '2025-11-25';

const bridge = new BridgeClient();
const onlineBackups = new OnlineBackups(bridge);

// ------------------------------------------------------------------ Helpers
function getLadderCtx(extra) {
  return Object.assign({
    callCatalog: bridge.learned.calls || {},
    learned: bridge.learned,
    tags: bridge.tagsCache,
    dbs: bridge.dbsCache,
  }, extra || {});
}

async function refreshTagCache(plcName) {
  const data = await bridge.call('list_tags', plcName ? { plcName } : {});
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
  const outPath = bridge.exportFilePath(blockName, '.xml');
  const res = await bridge.call('export_block', { blockName, plcName: plcName || '', outPath, format: 'xml' });
  const xml = fs.readFileSync(res.path, 'utf8');
  return { xml, meta: res };
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
    return new Map(B.parseBlock(xml).networks.map(n =>
      [n.id, { network: n, raw: xml.slice(n.el.start, n.el.end) }]));
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
        const read = readFlgNet(n.flg);
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

// ------------------------------------------------------------------ Tool Definitions
const TOOLS = [
  // --- Group 1: Session & Project ---
  {
    name: 'tia_status',
    description: 'Check TIA Portal V20 connection status, Windows "Siemens TIA Openness" group membership, running TIA V20 and S7-PLCSIM V20 processes, and open project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tia_connect',
    description: 'Attach to a running TIA Portal V20 window or launch a new TIA Portal V20 instance (UI or Headless). Stays alive cleanly across tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'attach', 'ui', 'headless'], description: 'auto=attach if running else open UI; attach=attach running; ui=launch with GUI; headless=launch without GUI (fast).' },
        processId: { type: 'integer', description: 'Optional specific TIA Portal process ID when attaching.' },
      },
    },
  },
  {
    name: 'tia_open_project',
    description: 'Open a TIA Portal V20 project (.ap20). Supports full Unicode/Vietnamese paths. Auto-connects if not connected.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to the .ap20 file, e.g. D:\\Kì 7\\Đồ án 2\\Do_an2_cnc_V20\\Do_an2_cnc_V20.ap20' },
        mode: { type: 'string', enum: ['auto', 'attach', 'ui', 'headless'], description: 'Connection mode if not yet connected (default: auto).' },
        closeCurrent: { type: 'boolean', description: 'Close currently open project if different (default: false).' },
        upgrade: { type: 'boolean', description: 'Open with upgrade from an older TIA Portal version (default: false).' },
      },
    },
  },
  {
    name: 'tia_save_project',
    description: 'Save the currently open TIA Portal V20 project (or Save As to a new directory).',
    inputSchema: {
      type: 'object',
      properties: {
        saveAsDirectory: { type: 'string', description: 'Optional target directory for Save As (omit to save in place).' },
      },
    },
  },
  {
    name: 'tia_close_project',
    description: 'Close the currently open TIA Portal V20 project and optionally disconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        disconnect: { type: 'boolean', description: 'Also disconnect from TIA Portal session (default: false).' },
        closeTia: { type: 'boolean', description: 'Also close the TIA Portal application itself if launched by us (default: false).' },
      },
    },
  },

  // --- Group 2: Project Blueprint, Blocks, Tags, DBs/UDTs ---
  {
    name: 'tia_project_blueprint',
    description: 'One-shot comprehensive overview of a (half-finished) TIA Portal V20 project: CPU/devices, all blocks (OB/FB/FC/DB) with language & consistency, PLC Tag Tables, UDTs, Technological Objects (e.g. CNC axes), and automatically learns block interfaces for CALL validation.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string', description: 'Optional PLC name if multiple PLCs exist.' },
        learnInterfaces: { type: 'boolean', description: 'Export FB/FC/GlobalDB headers to learn CALL signatures and DB member types (default: true).' },
      },
    },
  },
  {
    name: 'tia_list_blocks',
    description: 'List PLC program blocks (OB, FB, FC, GlobalDB, InstanceDB) with block number, language, group folder, and consistency.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string' },
        type: { type: 'string', description: 'Filter by type: OB, FB, FC, GlobalDB, InstanceDB' },
        language: { type: 'string', description: 'Filter by language: LAD, FBD, SCL, STL, DB' },
      },
    },
  },
  {
    name: 'tia_read_tags',
    description: 'Read PLC Tag Tables (name, logical address %I/%Q/%M, data type, comment) and refresh the tag cache used to annotate Ladder views.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string' },
        table: { type: 'string', description: 'Optional tag table name filter.' },
        search: { type: 'string', description: 'Optional substring search on tag name, address, or comment.' },
      },
    },
  },
  {
    name: 'tia_upsert_tags',
    description: 'Create or update one or more PLC tags in a PLC Tag Table.',
    inputSchema: {
      type: 'object',
      required: ['tags'],
      properties: {
        plcName: { type: 'string' },
        table: { type: 'string', description: 'Target tag table name (default: Default tag table).' },
        tags: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', description: 'IEC type: Bool, Int, DInt, Real, Word, Time...' },
              address: { type: 'string', description: 'e.g. %I0.0, %Q0.1, %M10.0, %MW20' },
              comment: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'tia_read_db_udt',
    description: 'Read the structured fields/members and data types of a GlobalDB or PLC Data Type (UDT).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Name of the GlobalDB or UDT.' },
        kind: { type: 'string', enum: ['db', 'udt'], description: 'Whether to read a Data Block (db) or PLC Data Type (udt). Default: db.' },
        plcName: { type: 'string' },
      },
    },
  },
  {
    name: 'tia_edit_db_udt',
    description: 'Create or edit a GlobalDB, InstanceDB, or PLC Data Type (UDT) (automatically backs up XML before re-importing on edit).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        action: { type: 'string', enum: ['edit', 'create'], description: 'Default: edit. Use "create" to create a new GlobalDB, InstanceDB, or UDT.' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['db', 'instance_db', 'udt'], description: 'Default: db. Use "instance_db" when creating an FB instance DB.' },
        instanceOf: { type: 'string', description: 'For action="create", kind="instance_db": FB name (e.g. "FB_TrafficLight").' },
        instanceOfType: { type: 'string', description: 'For action="create", kind="instance_db": default "FB".' },
        number: { type: 'integer', description: 'Optional block number for action="create" (omit for AutoNumber).' },
        memoryLayout: { type: 'string', enum: ['Optimized', 'Standard'], description: 'For action="create", kind="db" (default: Optimized).' },
        plcName: { type: 'string' },
        group: { type: 'string', description: 'Optional block group path if DB is inside a folder.' },
        add: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              comment: { type: 'string' },
            },
          },
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Member names to remove.' },
      },
    },
  },

  // --- Group 3: Optimized Ladder (LAD) Reading, Surgical Patching, Creating, Analysis ---
  {
    name: 'tia_read_ladder',
    description: 'Read a LAD block (from live TIA Portal OR an offline XML file) as ultra-compact Ladder DSL + optional ASCII ladder diagram + Tag annotations (~90% smaller than raw XML). Marks each network {editable} or {READ-ONLY}.',
    inputSchema: {
      type: 'object',
      properties: {
        blockName: { type: 'string', description: 'Block name in TIA Portal (e.g. Main, FB_AxisX).' },
        xmlPath: { type: 'string', description: 'Optional offline XML file path instead of exporting from TIA Portal.' },
        plcName: { type: 'string' },
        format: { type: 'string', enum: ['dsl', 'ascii', 'both'], description: 'Output format (default: both).' },
        networks: { type: 'array', items: { type: 'integer' }, description: 'Optional list of 1-based network numbers to read.' },
      },
    },
  },
  {
    name: 'tia_patch_ladder_network',
    description: 'Surgically edit, insert, append, delete, or rename specific Ladder networks using compact Ladder DSL. Preserves ALL untouched networks byte-for-byte (safe for CNC Motion Control blocks), auto-declares Static timer/counter/edge instances, auto-backups XML, and re-imports into TIA Portal (or writes offline XML).',
    inputSchema: {
      type: 'object',
      required: ['ops'],
      properties: {
        blockName: { type: 'string', description: 'Block name in TIA Portal.' },
        xmlPath: { type: 'string', description: 'Optional offline XML path (edits file in-place instead of TIA import).' },
        previewOnly: { type: 'boolean', description: 'Preview changes in memory without applying them.' },
        compact: { type: 'boolean', description: 'Report only changed networks after applying.' },
        plcName: { type: 'string' },
        group: { type: 'string', description: 'Block folder path if block is in a user group.' },
        declare: {
          type: 'array',
          description: 'Optional extra local variables to declare in the block interface.',
          items: {
            type: 'object',
            required: ['section', 'name', 'type'],
            properties: {
              section: { type: 'string', enum: ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'] },
              name: { type: 'string' },
              type: { type: 'string' },
              comment: { type: 'string' },
            },
          },
        },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            required: ['op'],
            properties: {
              op: { type: 'string', enum: ['replace', 'insert', 'append', 'delete', 'set_text'] },
              nw: { type: 'integer', description: '1-based network index (required for replace, delete, set_text, insert).' },
              dsl: { type: 'string', description: 'Ladder DSL, e.g. "(NO(#Start) | NO(#Run)) & NC(#Stop) => COIL(#Run)" or "NO(#Run) => TON(#T1, PT=T#3s) => COIL(#Ready)"' },
              title: { type: 'string' },
              comment: { type: 'string' },
              force: { type: 'boolean', description: 'Allow replacing a non-LAD network.' },
            },
          },
        },
        compileAfter: { type: 'boolean', description: 'Run tia_compile automatically after import (default: false).' },
      },
    },
  },
  {
    name: 'tia_edit_block_interface',
    description: 'Add or remove Input/Output/InOut/Static/Temp/Constant variables in an OB, FB, or FC (auto-backups before re-importing).',
    inputSchema: {
      type: 'object',
      properties: {
        blockName: { type: 'string' },
        xmlPath: { type: 'string', description: 'Optional offline XML path.' },
        plcName: { type: 'string' },
        group: { type: 'string' },
        add: {
          type: 'array',
          items: {
            type: 'object',
            required: ['section', 'name', 'type'],
            properties: {
              section: { type: 'string', enum: ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant'] },
              name: { type: 'string' },
              type: { type: 'string' },
              comment: { type: 'string' },
            },
          },
        },
        remove: {
          type: 'array',
          items: {
            type: 'object',
            required: ['section', 'name'],
            properties: {
              section: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'tia_create_ladder_block',
    description: 'Create a brand-new LAD block (FB, FC, or OB) from interface specification and Ladder DSL networks, generate valid V20 SimaticML XML, and import it into TIA Portal (or save offline).',
    inputSchema: {
      type: 'object',
      required: ['type', 'name'],
      properties: {
        type: { type: 'string', enum: ['FB', 'FC', 'OB'] },
        name: { type: 'string' },
        number: { type: 'integer', description: 'Optional block number (omit for AutoNumber).' },
        plcName: { type: 'string' },
        group: { type: 'string', description: 'Optional destination folder group in TIA Portal.' },
        title: { type: 'string' },
        comment: { type: 'string' },
        memoryLayout: { type: 'string', enum: ['Optimized', 'Standard'] },
        interface: {
          type: 'object',
          description: 'Map of section name (Input, Output, InOut, Static, Temp, Constant) to array of {name, type, comment}.',
        },
        networks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              comment: { type: 'string' },
              dsl: { type: 'string' },
            },
          },
        },
        outXmlPath: { type: 'string', description: 'If set (and importToTia is false), write XML to this path without connecting to TIA.' },
        importToTia: { type: 'boolean', description: 'Import into open TIA Portal project (default: true unless outXmlPath is given).' },
        autoCreateInstanceDbs: { type: 'boolean', description: 'When importing into TIA Portal, automatically create missing FB InstanceDBs referenced by CALL (default: true).' },
      },
    },
  },
  {
    name: 'tia_analyze_ladder',
    description: 'Run static verification on one or more LAD blocks (live from TIA or offline XML files): detects Double Coils, Coil+Set/Reset conflicts, Set without Reset, Timer/Edge memory reuse, undeclared/unused variables, multi-block writes, and symbol Cross-Reference.',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'array', items: { type: 'string' }, description: 'List of block names in TIA Portal to analyze.' },
        xmlPaths: { type: 'array', items: { type: 'string' }, description: 'Optional list of offline XML file paths to analyze.' },
        plcName: { type: 'string' },
        symbol: { type: 'string', description: 'Optional variable/tag name to generate Cross-Reference for.' },
        targetSymbol: { type: 'string', description: 'Exact variable/tag whose change should be assessed.' },
        targetBlock: { type: 'string', description: 'Block whose signature is changing; lists CALL sites and transitive callers.' },
        manifestPath: { type: 'string', description: 'Optional suite.json path for suggested regression cases.' },
      },
    },
  },
  {
    name: 'tia_rollback_block',
    description: 'List available XML backups or restore a block in TIA Portal from a previous auto-backup.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'restore'], description: 'Default: list.' },
        blockName: { type: 'string', description: 'Online object name. Required to restore.' },
        kind: { type: 'string', enum: ['block', 'udt'], description: 'Online object category. Use block for DBs.' },
        backupFile: { type: 'string', description: 'Exact filename listed for this target. Online restore defaults to its latest scoped backup.' },
        xmlPath: { type: 'string', description: 'List or restore backups for this existing offline XML file. Restore requires backupFile.' },
        plcName: { type: 'string' },
        group: { type: 'string' },
      },
    },
  },
  {
    name: 'tia_export_raw',
    description: 'Export a block to raw SimaticML XML or V20 SIMATIC SD (.s7dcl/.s7res) and return its path and contents (useful for SCL or complex non-LAD blocks).',
    inputSchema: {
      type: 'object',
      required: ['blockName'],
      properties: {
        blockName: { type: 'string' },
        format: { type: 'string', enum: ['xml', 's7dcl'], description: 'Default: xml.' },
        plcName: { type: 'string' },
        maxChars: { type: 'integer', description: 'Max characters to return in text preview (default: 12000).' },
      },
    },
  },

  // --- Group 4: Instant Scan-Cycle Dry-Run Simulator, Compile, PLCSIM V20, Download & Online ---
  {
    name: 'tia_test_ladder_project',
    description: 'Analyze a directory of offline LAD XML blocks and run named regression scenarios. Paths in the suite JSON are relative to that file. Returns text, JSON or JUnit.',
    inputSchema: {
      type: 'object', required: ['manifestPath'],
      properties: {
        manifestPath: { type: 'string', description: 'Path to the suite JSON file.' },
        format: { type: 'string', enum: ['text', 'json', 'junit'] },
        targetSymbol: { type: 'string', description: 'Exact variable/tag to assess before changing.' },
        targetBlock: { type: 'string', description: 'Block signature to assess before changing.' },
      },
    },
  },
  {
    name: 'tia_dry_run_ladder',
    description: 'Run an instant in-RAM PLC Scan-Cycle Simulation on LAD blocks (live from TIA, offline XML files, or inline DSL snippets!). Tests contacts, latches, edges, TON/TOF/TP/TONR timers, CTU/CTD/CTUD counters, comparisons, math, MOVE, and FC/FB sub-calls across multi-step scenarios with assertions & change timeline.',
    inputSchema: {
      type: 'object',
      required: ['entry', 'scenario'],
      properties: {
        entry: { type: 'string', description: 'Entry block name to scan each cycle (e.g. Main or FB_Spindle).' },
        blocks: { type: 'array', items: { type: 'string' }, description: 'Block names to export from TIA Portal for simulation.' },
        xmlPaths: { type: 'array', items: { type: 'string' }, description: 'Offline XML files to load for simulation.' },
        inlineBlocks: {
          type: 'array',
          description: 'Inline LAD blocks defined directly via DSL for instant testing before importing to TIA.',
          items: {
            type: 'object',
            required: ['name', 'networks'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['OB', 'FB', 'FC'] },
              interface: { type: 'object' },
              networks: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        plcName: { type: 'string' },
        scenario: {
          type: 'object',
          properties: {
            scanMs: { type: 'integer', minimum: 1, description: 'Simulated scan cycle time in ms (default: 10).' },
            init: { type: 'object', description: 'Initial variable values, e.g. {"#Stop": 0, "\"E_Stop\"": 0}.' },
            watch: { type: 'array', items: { type: 'string' }, description: 'Variables to record in timeline & final snapshot.' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  set: { type: 'object', description: 'Variables to assign before running this step.' },
                  run: { description: 'Number of scan cycles (integer) or duration string (e.g. "T#3s", "500ms").' },
                  until: { type: 'object', minProperties: 1, maxProperties: 1, description: 'Check one {var: value} now and after each whole scan up to the deadline.' },
                  timeout: { type: 'string', description: 'Non-negative simulated duration for until (default "10s"). A zero timeout checks only the current state.' },
                  expect: { type: 'object', description: 'Assertions {var: expectedValue} checked after step.' },
                  tolerance: { type: 'number', minimum: 0, description: 'Absolute tolerance for floating-point comparisons (default 0.001). Use 0 for an exact comparison.' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'tia_compile',
    description: 'Compile PLC Software (and optionally Hardware) in TIA Portal V20. Enables "Support simulation during block compilation" by default and returns detailed compiler errors & warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string' },
        enableSimulation: { type: 'boolean', description: 'Set IsSimulationDuringBlockCompilationEnabled=true (default: true).' },
        includeHardware: { type: 'boolean', description: 'Also compile PLC hardware (default: false).' },
      },
    },
  },
  {
    name: 'tia_sim_prepare',
    description: 'Launch S7-PLCSIM V20 detached AND optionally generate a ready-to-import SIM Table CSV file from PLC tags or custom signals.',
    inputSchema: {
      type: 'object',
      properties: {
        launchPlcsim: { type: 'boolean', description: 'Launch S7PLCSIMV20.exe if not already running (default: true).' },
        generateSimTable: { type: 'boolean', description: 'Generate SIM Table CSV in exports/ (default: true).' },
        tableName: { type: 'string', description: 'Output SIM table filename prefix.' },
        plcName: { type: 'string' },
        signals: {
          type: 'array',
          description: 'Optional custom signals to include (otherwise uses project PLC Tags).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: { type: 'string' },
              type: { type: 'string' },
              modifyValue: { type: 'string' },
              comment: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'tia_download_and_online',
    description: 'Inspect connection interfaces, download Software/Hardware to S7-PLCSIM V20 or physical PLC, upload a station from a physical PLC, and switch TIA Portal Online/Offline.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list_connections', 'download', 'station_upload', 'go_online', 'go_offline', 'online_status'] },
        plcName: { type: 'string' },
        mode: { type: 'string', description: 'Connection mode (default: PN/IE).' },
        pcInterface: { type: 'string', description: 'Exact PC interface name; required for download.' },
        targetAddress: { type: 'string', description: 'Optional target PLC IP address (e.g. 192.168.0.1); required for station_upload.' },
        targetInterfaceIndex: { type: 'integer', description: 'Index of target interface (default: 0).' },
        includeHardware: { type: 'boolean', description: 'Download Hardware + Software (default: false).' },
        startAfterDownload: { type: 'boolean', description: 'Start CPU modules after download (default: false).' },
        allowStopModules: { type: 'boolean', description: 'Permit stopping running CPU modules during download (default: false).' },
        allowDifferentTargetConfiguration: { type: 'boolean', description: 'Explicitly accept a detected target hardware/configuration difference (default: false).' },
      },
    },
  },

  // --- Group 5: Watch & Force Tables, SCL External Sources, Cross-Reference, GUI Focus ---
  {
    name: 'tia_watch_table',
    description: 'Create, read, update, delete, export or import PLC Watch Tables (and list Force Tables) in TIA Portal V20. Can auto-create the table and open it in the TIA Portal editor with ShowInEditor.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'upsert', 'create', 'delete', 'export', 'import'], description: 'Default: list.' },
        name: { type: 'string', description: 'Watch table name (default: Watch_Table_MCP).' },
        plcName: { type: 'string' },
        entries: {
          type: 'array',
          description: 'Entries for upsert/create. Address is written before Name on V20 CPUs.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Symbolic tag name or DB member.' },
              address: { type: 'string', description: 'Absolute address, e.g. %I0.0, %QW10, %DB1.DBX0.0.' },
              displayFormat: { type: 'string', description: 'Bool, Float, Hex, Bin, Dec, Signed, Unsigned, Time, Date, String...' },
              modifyValue: { type: 'string', description: 'Optional modify value.' },
              comment: { type: 'string' },
            },
          },
        },
        clearExisting: { type: 'boolean', description: 'Delete and recreate the table before upsert (default: false).' },
        showInEditor: { type: 'boolean', description: 'Call ShowInEditor after create/read/import (default: false).' },
        path: { type: 'string', description: 'XML path for export/import. Export defaults to exports/<name>.xml.' },
      },
    },
  },
  {
    name: 'tia_show_in_editor',
    description: 'Open a block, watch table, tag table, PLC data type, device, network or topology view in the TIA Portal V20 GUI.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['block', 'watch_table', 'tag_table', 'type', 'device', 'network', 'topology'], description: 'Default: block.' },
        name: { type: 'string', description: 'Object name (omit for the default tag table or device view).' },
        plcName: { type: 'string' },
      },
    },
  },
  {
    name: 'tia_scl_source',
    description: 'Export a block/DB/UDT as SCL/DB/UDT external text source, or import SCL source code/file to generate blocks (with optional group placement and keeping the external source).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['export', 'read', 'import', 'write'], description: 'export/read = generate source; import/write = compile source into blocks.' },
        plcName: { type: 'string' },
        blockName: { type: 'string', description: 'Block to export (must support source generation).' },
        typeName: { type: 'string', description: 'PLC data type (UDT) to export.' },
        outPath: { type: 'string', description: 'Optional output path for export (default: exports/<name>.scl or .udt).' },
        withDependencies: { type: 'boolean', description: 'Include dependent objects in generated source (default: false).' },
        maxChars: { type: 'integer', description: 'Max source characters to return (default: 20000).' },
        sourceCode: { type: 'string', description: 'SCL/DB/UDT source text for import/write.' },
        filePath: { type: 'string', description: 'Existing source file for import/write (alternative to sourceCode).' },
        sourceName: { type: 'string', description: 'External source name (default: MCP_Generated_Source).' },
        group: { type: 'string', description: 'Destination block group for generated blocks.' },
        keepExternalSource: { type: 'boolean', description: 'Keep the external source after generation (default: false).' },
      },
    },
  },
  {
    name: 'tia_cross_reference',
    description: 'Query project-wide or block-level TIA Portal Cross-Reference: where each tag/DB/UDT is read or written, with source paths and locations.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string' },
        filter: { type: 'string', enum: ['used', 'all', 'unused', 'without_references'], description: 'Default: used (objects with references).' },
        symbol: { type: 'string', description: 'Optional substring filter on symbol name or address.' },
        blockName: { type: 'string', description: 'Optional block to scope the cross-reference to.' },
        limit: { type: 'integer', description: 'Max source objects (default: 200).' },
      },
    },
  },

  // --- Group 6: Hardware/Network, PLCSIM Runtime, Universal Escape Hatch ---
  {
    name: 'tia_hardware_config',
    description: 'Zero-to-project hardware configuration: create a new TIA project, list presets, search the hardware catalog, add a PLC/device, plug modules, set CPU memory/startup/PUT-GET properties, or create a technological object.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['presets', 'create_project', 'search_catalog', 'add_plc', 'add_device', 'plug_module', 'cpu_properties', 'create_tech_object'] },
        directory: { type: 'string', description: 'Target folder for action="create_project".' },
        mode: { type: 'string', enum: ['auto', 'attach', 'ui', 'headless'], description: 'Connection mode if not yet connected (for create_project).' },
        closeCurrent: { type: 'boolean', description: 'Close currently open project before create_project (default: false).' },
        plcName: { type: 'string' },
        stationName: { type: 'string' },
        typeIdentifier: { type: 'string', description: 'Preset key (e.g. CPU_1214C_DC_DC_DC) or order number / TypeIdentifier.' },
        query: { type: 'string', description: 'Hardware catalog search text (default: 6ES7 214).' },
        filter: { type: 'string', description: 'Optional catalog result filter.' },
        limit: { type: 'integer' },
        moduleName: { type: 'string' },
        slot: { type: 'integer', description: 'Slot number (S7-1200 expansion slots start at 2; Signal Board 1; Comm modules 101-103).' },
        enableSystemMemory: { type: 'boolean' },
        systemMemoryAddress: { type: 'integer' },
        enableClockMemory: { type: 'boolean' },
        clockMemoryAddress: { type: 'integer' },
        permitPutGet: { type: 'boolean' },
        disableSecurity: { type: 'boolean', description: 'Explicitly configure full-access CPU protection and unprotect confidential configuration data (default: false; intended only for authorized simulation projects).' },
        accessControl: { type: 'string', description: 'S7-1500 PlcAccessControlConfiguration enum, e.g. Disabled, EnabledWithAccessControl.' },
        accessLevel: { type: 'string', description: 'S7-1200 PlcProtectionAccessLevel enum, e.g. FullAccess, ReadAccess, HMIAccess, NoAccess.' },
        protectConfigData: { type: 'boolean', description: 'Whether confidential PLC configuration data uses a password (false calls Unprotect()).' },
        masterSecretPassword: { type: 'string', description: 'Password for confidential PLC configuration data (when protectConfigData is true/set).' },
        oldMasterSecretPassword: { type: 'string' },
        accessLevelPassword: { type: 'string', description: 'Optional password when setting accessLevel.' },
        attributes: { type: 'object', description: 'Raw CPU attribute overrides for cpu_properties.' },
        name: { type: 'string', description: 'Technological object name (default: Axis_1).' },
        type: { type: 'string', description: 'Technological object type (default: TO_PositioningAxis).' },
        version: { type: 'string', description: 'Technological object version (default: 8.0).' },
        parameters: { type: 'object', description: 'Technological object parameter values.' },
      },
    },
  },
  {
    name: 'tia_network_config',
    description: 'Inspect subnets/PROFINET interfaces, set PLC IP address/subnet mask/router, connect a PLC to a subnet, create an IO system, or toggle OPC UA server settings.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['inspect', 'set_ip', 'connect_subnet', 'opcua'] },
        plcName: { type: 'string' },
        interfaceName: { type: 'string', description: 'Optional network interface name filter.' },
        ipAddress: { type: 'string' },
        subnetMask: { type: 'string' },
        routerAddress: { type: 'string' },
        subnetName: { type: 'string', description: 'Subnet to create/connect (default: PN/IE_1).' },
        createIoSystem: { type: 'boolean', description: 'Create an IO system when connecting (default: false).' },
        enableServer: { type: 'boolean', description: 'Enable/disable OPC UA server.' },
        port: { type: 'integer', description: 'OPC UA port (default: 4840).' },
      },
    },
  },
  {
    name: 'tia_plcsim_runtime',
    description: 'S7-PLCSIM Advanced Runtime API control. Requires a running Advanced Runtime Manager; the regular S7-PLCSIM V20 GUI does not expose this API. Inspect/register virtual PLC instances, control RUN/STOP, read/write signals, and run timed assertions.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'register', 'control', 'list_tags', 'read', 'write', 'run_sequence'] },
        instanceName: { type: 'string' },
        articleNumber: { type: 'string', description: 'CPU article number for register (alternative to cpuType).' },
        cpuType: { type: 'string', description: 'ECPUType name for register (default: CPU1500_Unspecified).' },
        powerOn: { type: 'boolean', description: 'Power on after register (default: true).' },
        run: { type: 'boolean', description: 'Run CPU after register (default: false).' },
        ipAddress: { type: 'string' },
        subnetMask: { type: 'string' },
        gateway: { type: 'string' },
        operation: { type: 'string', enum: ['power_on', 'power_off', 'run', 'stop', 'memory_reset', 'unregister'], description: 'For action=control.' },
        timeoutMs: { type: 'integer', description: 'Operation timeout in ms (default: 30000).' },
        search: { type: 'string', description: 'Tag name filter for list_tags.' },
        limit: { type: 'integer', description: 'Max tags (default: 200).' },
        refreshTagList: { type: 'boolean', description: 'Refresh the tag list before read/write.' },
        signals: { type: 'array', items: { type: 'string' }, description: 'Signals to read, e.g. ["%I0.0", "\\"MyTag\\""].' },
        values: { type: 'object', description: 'Signals to write: { "%Q0.0": true, "\\"Speed\\"": 12.5 }.' },
        watch: { type: 'array', items: { type: 'string' }, description: 'Signals sampled during run_sequence.' },
        steps: {
          type: 'array',
          description: 'Timed steps for run_sequence.',
          items: {
            type: 'object',
            properties: {
              write: { type: 'object' },
              pulse: { type: 'string', description: 'Signal to pulse true then false.' },
              pulseMs: { type: 'integer' },
              waitMs: { type: 'integer' },
              expect: { type: 'object' },
              tolerance: { type: 'number' },
            },
          },
        },
        sampleIntervalMs: { type: 'integer', description: 'Sampling interval for run_sequence (default: 50).' },
      },
    },
  },
  {
    name: 'tia_escape_hatch',
    description: 'Universal Openness reflection escape hatch: inspect attributes/compositions/services/methods on any project object, get/set attributes, invoke methods, and manage object handles (obj:N).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['inspect', 'get', 'set', 'invoke', 'list_handles', 'release_handles'] },
        target: { type: 'string', description: 'project, tia, cpu, device, software, block:<Name>, to:<Name>, watch:<Name>, tagtable:<Name>, type:<Name>, or obj:N. Default: project.' },
        plcName: { type: 'string' },
        filter: { type: 'string', description: 'Attribute name filter for inspect.' },
        includeValues: { type: 'boolean', description: 'Read attribute values during inspect (default: true).' },
        attribute: { type: 'string' },
        value: { description: 'Value for set (number, boolean, string, or obj:N handle).' },
        attributes: { type: 'object', description: 'Multiple attributes to set.' },
        composition: { type: 'string', description: 'Composition to enumerate for get.' },
        findName: { type: 'string', description: 'Find a composition child by Name.' },
        index: { type: 'integer', description: 'Find a composition child by index.' },
        service: { type: 'string', description: 'Service type full name or short name to resolve.' },
        method: { type: 'string', description: 'Method name for invoke.' },
        methodArgs: { type: 'array', items: {}, description: 'Positional method arguments for invoke.' },
        handle: { type: 'string', description: 'Handle to release (obj:N) or empty to release all.' },
      },
    },
  },
];

// ------------------------------------------------------------------ Tool Execution
async function handleTool(name, args) {
  args = args || {};
  switch (name) {
    case 'tia_status': {
      const s = await bridge.call('status');
      const lines = [
        'USER: ' + s.user + ' | In "Siemens TIA Openness" group: ' + s.inOpennessGroup,
        'CONNECTED: ' + s.connected + ' (mode: ' + s.mode + ', attachedExisting: ' + s.attachedExisting + ')',
        'PROJECT: ' + (s.projectOpen ? s.projectName + ' (' + s.projectPath + ')' : 'none'),
        'OPENNESS ACCESSIBLE: ' + s.opennessAccessible + (s.opennessError ? ' — ' + s.opennessError : ''),
        'RUNNING TIA V20 PROCESSES: ' + (s.runningTiaProcesses.length ? s.runningTiaProcesses.map(p => 'PID ' + p.id + ' [' + p.mode + '] ' + (p.projectPath || '(no project)')).join('; ') : 'none'),
        'S7-PLCSIM V20 RUNNING: ' + s.plcsimV20Running + (s.plcsimV20Pids.length ? ' (PID ' + s.plcsimV20Pids.join(',') + ')' : ''),
      ];
      if (!s.inOpennessGroup) {
        lines.push('ACTION NEEDED: Run in Administrator PowerShell: net localgroup "Siemens TIA Openness" "' + s.user.split('\\').pop() + '" /add  (then sign out & sign in once).');
      }
      return { text: lines.join('\n'), json: s };
    }

    case 'tia_connect': {
      const s = await bridge.call('connect', { mode: args.mode || 'auto', processId: args.processId || 0 });
      return { text: 'Connected to TIA Portal V20 (mode: ' + s.mode + ', project: ' + (s.projectName || 'none') + ').', json: s };
    }

    case 'tia_open_project': {
      const s = await bridge.call('open_project', {
        path: args.path,
        mode: args.mode || 'auto',
        closeCurrent: !!args.closeCurrent,
        upgrade: !!args.upgrade,
      });
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
      return { text: 'Closed project "' + r.project + '".', json: r };
    }

    case 'tia_project_blueprint': {
      const plcName = args.plcName || '';
      const devices = await bridge.call('list_devices');
      const blocks = await bridge.call('list_blocks', { plcName });
      const tags = await refreshTagCache(plcName);
      const types = await bridge.call('list_types', { plcName });
      const tos = await bridge.call('list_tech_objects', { plcName });

      const learnInterfaces = args.learnInterfaces !== false;
      const callEntries = {};
      const dbSummaries = [];
      if (learnInterfaces) {
        for (const blk of blocks.blocks) {
          if (blk.isKnowHowProtected) continue;
          if (!['FB', 'FC', 'GlobalDB'].includes(blk.type)) continue;
          try {
            const { xml } = await exportBlockXml(blk.name, plcName);
            const parsed = parseDbOrUdtXml(xml);
            if (blk.type === 'GlobalDB') {
              bridge.dbsCache[blk.name] = parsed.interface;
              const members = (parsed.interface.Static || []).map(m => m.name + ':' + m.type);
              dbSummaries.push('  DB "' + blk.name + '" (#' + blk.number + '): ' + (members.slice(0, 15).join(', ') || '(empty)') + (members.length > 15 ? ' ... +' + (members.length - 15) : ''));
            } else {
              const entry = L.callEntryFromInterface(blk.type, parsed.interface);
              bridge.learned.calls[blk.name] = entry;
              callEntries[blk.name] = entry;
              // also harvest LAD network signatures if LAD
              if (blk.language === 'LAD') {
                const pb = B.parseBlock(xml);
                for (const nw of pb.networks) if (nw.flg) L.learnFlgNet(nw.flg, bridge.learned);
              }
            }
          } catch { /* skip non-exportable blocks */ }
        }
        bridge.saveLearned();
      }

      const lines = [];
      lines.push('=== PROJECT BLUEPRINT: ' + devices.project + ' ===');
      lines.push('DEVICES:');
      for (const d of devices.devices) {
        const plcs = d.items.filter(i => i.isPlc).map(i => i.name + ' [' + i.typeIdentifier + ']');
        lines.push('  - ' + d.name + (d.group ? ' (' + d.group + ')' : '') + (plcs.length ? ' -> PLC: ' + plcs.join(', ') : ''));
      }
      lines.push('');
      lines.push('BLOCKS (' + blocks.blocks.length + ') on ' + blocks.plc + ':');
      for (const b of blocks.blocks) {
        const sig = callEntries[b.name] ? ' (' + callEntries[b.name].params.map(p => p.section[0] + ':' + p.name + ':' + p.type).join(', ') + ')' : '';
        lines.push('  - ' + b.type.padEnd(10) + ' "' + b.name + '" #' + b.number + ' [' + b.language + ']' + (b.group ? ' @' + b.group : '') + (!b.isConsistent ? ' [NEEDS COMPILE]' : '') + sig);
      }
      if (dbSummaries.length) {
        lines.push('');
        lines.push('GLOBAL DB STRUCTURES:');
        lines.push(...dbSummaries);
      }
      if (types.types.length) {
        lines.push('');
        lines.push('PLC DATA TYPES (UDT): ' + types.types.map(t => t.name).join(', '));
      }
      if (tos.technologicalObjects.length) {
        lines.push('');
        lines.push('TECHNOLOGICAL OBJECTS (Motion/CNC/PID): ' + tos.technologicalObjects.map(t => t.name + ' (DB' + t.number + ')').join(', '));
      }
      const totalTags = tags.tables.reduce((s, t) => s + t.tags.length, 0);
      lines.push('');
      lines.push('PLC TAGS (' + totalTags + ' across ' + tags.tables.length + ' table(s)):');
      for (const tbl of tags.tables) {
        if (!tbl.tags.length) continue;
        lines.push('  [' + tbl.table + ']');
        for (const t of tbl.tags.slice(0, 60)) {
          lines.push('    "' + t.name + '" : ' + t.type + (t.address ? ' @ ' + t.address : '') + (t.comment ? ' // ' + t.comment : ''));
        }
        if (tbl.tags.length > 60) lines.push('    ... (+' + (tbl.tags.length - 60) + ' more; use tia_read_tags)');
      }
      return { text: lines.join('\n') };
    }

    case 'tia_list_blocks': {
      const data = await bridge.call('list_blocks', { plcName: args.plcName || '' });
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
      const r = await bridge.call('upsert_tags', {
        plcName: args.plcName || '',
        table: args.table || 'Default tag table',
        tags: args.tags,
      });
      await refreshTagCache(args.plcName || '');
      return { text: 'Updated tag table "' + r.table + '":\n  ' + r.changes.join('\n  '), json: r };
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
      return { text: p.kind + ' "' + p.name + '" ' + (p.number ? '#' + p.number + ' ' : '') + '(' + p.memoryLayout + ')\n' + B.interfaceText(p.interface), json: p };
    }

    case 'tia_edit_db_udt': {
      const action = args.action || 'edit';
      const kind = args.kind || 'db';
      if (action === 'create') {
        const dbKind = kind === 'instance_db' ? 'InstanceDB' : (kind === 'udt' ? 'UDT' : 'GlobalDB');
        const xml = B.createDbXml({
          kind: dbKind,
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
        return {
          text: 'Created ' + dbKind + ' "' + args.name + '"' + (args.instanceOf ? ' (instance of ' + args.instanceOf + ')' : '') + '.\n' + B.interfaceText(p.interface),
          json: p,
        };
      }
      const sec = kind === 'udt' ? 'None' : 'Static';
      const { backup, result } = await onlineBackups.edit(args, kind === 'udt' ? 'udt' : 'block', xml => {
        if (args.remove && args.remove.length) xml = B.removeMembers(xml, args.remove.map(name => ({ section: sec, name })));
        if (args.add && args.add.length) xml = B.addMembers(xml, args.add.map(m => ({ section: sec, name: m.name, type: m.type, comment: m.comment })));
        return { xml };
      });
      const p = parseDbOrUdtXml(result.xml);
      if (kind === 'db') bridge.dbsCache[p.name] = p.interface;
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
        bridge.learned.calls[parsed.name] = L.callEntryFromInterface(parsed.kind, parsed.interface);
      }
      return { text: 'Updated interface of "' + parsed.name + '" (backup: ' + path.basename(backup) + '):\n' + B.interfaceText(parsed.interface) };
    }

    case 'tia_create_ladder_block': {
      const created = B.createBlockXml({
        type: args.type,
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

      const shouldImport = args.importToTia !== undefined ? args.importToTia : !args.outXmlPath;
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
            const dbXml = B.createDbXml({ kind: 'InstanceDB', name: d.name, instanceOf: d.type, instanceOfType: 'FB' });
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
        bridge.learned.calls[args.name] = L.callEntryFromInterface(args.type, preview.interface);
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
      const res = A.analyze(reads, { symbol: args.symbol, targetSymbol: args.targetSymbol, targetBlock: args.targetBlock, cases: suite.cases, entry: suite.entry });
      return { text: A.formatAnalysis(res), json: res };
    }

    case 'tia_rollback_block': {
      const action = args.action || 'list';
      if (!['list', 'restore'].includes(action)) throw new Error('Expected list or restore.');
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
      const report = project.runProject(args.manifestPath, { targetSymbol: args.targetSymbol, targetBlock: args.targetBlock });
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
          '\nFile: ' + r.filePath,
        json: r,
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
          lines.push('  - ' + it.name + ' [' + it.typeIdentifier + ']' + (it.isPlc ? ' (PLC software: ' + it.plcSoftwareName + ')' : ''));
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
        return { text: 'Plugged "' + r.name + '" into slot ' + r.slot + ' (' + r.typeIdentifier + ').', json: r };
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
        interfaceName: args.interfaceName || '',
        ipAddress: args.ipAddress || '',
        subnetMask: args.subnetMask || '',
        routerAddress: args.routerAddress || '',
        subnetName: args.subnetName || '',
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
      const lines = ['PLC "' + r.plc + '" via interface "' + r.interface + '":'];
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

// ------------------------------------------------------------------ MCP Stdio Protocol Loop
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  try {
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      try {
        const out = await handleTool(toolName, toolArgs);
        const result = { content: [{ type: 'text', text: out.text }] };
        if (out.json && typeof out.json === 'object' && !Array.isArray(out.json)) {
          result.structuredContent = out.json;
        }
        send({
          jsonrpc: '2.0',
          id,
          result,
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'ERROR (' + toolName + '): ' + (err && err.message ? err.message : String(err)) }],
          },
        });
      }
      return;
    }
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message || String(err) } });
    }
  }
}

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inBuf += chunk;
  let idx;
  while ((idx = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, idx).trim();
    inBuf = inBuf.slice(idx + 1);
    if (!line || line.startsWith('Content-Length:')) continue;
    try {
      const msg = JSON.parse(line);
      onMessage(msg);
    } catch { /* ignore non-JSON lines */ }
  }
});

process.on('SIGINT', () => { bridge.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { bridge.shutdown(); process.exit(0); });
process.on('exit', () => { bridge.shutdown(); });
