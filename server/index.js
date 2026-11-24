'use strict';
// TIA Portal V20 MCP Server (Stdio JSON-RPC 2.0, zero external npm dependencies).
// Combines TiaBridge.exe (C# .NET 4.8 TIA Openness V20) with the 2-way Ladder Engine,
// Static Analyzer and In-RAM PLC Scan-Cycle Simulator.

const fs = require('fs');
const path = require('path');
const { BridgeClient, EXPORTS_DIR, ensureDir } = require('./bridge_client');
const B = require('./ladder/block');
const D = require('./ladder/dsl');
const L = require('./ladder/learn');
const A = require('./ladder/analyzer');
const S = require('./ladder/simulator');
const X = require('./ladder/xml');

const SERVER_INFO = { name: 'tia-portal-v20-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

const bridge = new BridgeClient();

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
      },
    },
  },
  {
    name: 'tia_save_project',
    description: 'Save the currently open TIA Portal V20 project.',
    inputSchema: { type: 'object', properties: {} },
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
    description: 'Add or remove members in a GlobalDB or UDT (automatically backs up XML before re-importing).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['db', 'udt'], description: 'Default: db.' },
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
        blockName: { type: 'string', description: 'Block name to filter backups or restore.' },
        backupFile: { type: 'string', description: 'Specific backup filename from backups/ (defaults to latest backup of blockName).' },
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
            scanMs: { type: 'integer', description: 'Simulated scan cycle time in ms (default: 10).' },
            init: { type: 'object', description: 'Initial variable values, e.g. {"#Stop": 0, "\"E_Stop\"": 0}.' },
            watch: { type: 'array', items: { type: 'string' }, description: 'Variables to record in timeline & final snapshot.' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  set: { type: 'object', description: 'Variables to assign before running this step.' },
                  run: { description: 'Number of scan cycles (integer) or duration string (e.g. "T#3s", "500ms").' },
                  until: { type: 'object', description: 'Run until single {var: value} matches.' },
                  timeout: { type: 'string', description: 'Timeout duration for until (default "10s").' },
                  expect: { type: 'object', description: 'Assertions {var: expectedValue} checked after step.' },
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
    description: 'Inspect connection interfaces, download Software/Hardware to S7-PLCSIM V20 or physical PLC, and switch TIA Portal Online/Offline.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list_connections', 'download', 'go_online', 'go_offline', 'online_status'] },
        plcName: { type: 'string' },
        mode: { type: 'string', description: 'Connection mode (default: PN/IE).' },
        pcInterface: { type: 'string', description: 'Substring filter for PC interface (default: PLCSIM).' },
        targetInterfaceIndex: { type: 'integer', description: 'Index of target interface (default: 0).' },
        includeHardware: { type: 'boolean', description: 'Download Hardware + Software (default: true).' },
        startAfterDownload: { type: 'boolean', description: 'Start CPU modules after download (default: true).' },
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
      });
      return { text: 'Opened project "' + s.projectName + '" (' + s.projectPath + ').', json: s };
    }

    case 'tia_save_project': {
      const r = await bridge.call('save_project');
      return { text: 'Saved project "' + r.project + '".', json: r };
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
      const kind = args.kind || 'db';
      const outPath = bridge.exportFilePath((kind === 'udt' ? 'UDT_' : '') + args.name, '.xml');
      if (kind === 'udt') await bridge.call('export_type', { typeName: args.name, outPath, plcName: args.plcName || '' });
      else await bridge.call('export_block', { blockName: args.name, outPath, plcName: args.plcName || '', format: 'xml' });

      let xml = fs.readFileSync(outPath, 'utf8');
      const backup = bridge.saveBackup((kind === 'udt' ? 'UDT_' : '') + args.name, xml);
      const sec = kind === 'udt' ? 'None' : 'Static';
      if (args.remove && args.remove.length) {
        xml = B.removeMembers(xml, args.remove.map(n => ({ section: sec, name: n })));
      }
      if (args.add && args.add.length) {
        xml = B.addMembers(xml, args.add.map(m => ({ section: sec, name: m.name, type: m.type, comment: m.comment })));
      }
      fs.writeFileSync(outPath, xml, 'utf8');
      if (kind === 'udt') await bridge.call('import_type', { xmlPath: outPath, plcName: args.plcName || '' });
      else await bridge.call('import_block', { xmlPath: outPath, plcName: args.plcName || '', group: args.group || '' });
      const p = parseDbOrUdtXml(xml);
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
      let xml, targetPath, blockLabel;
      const offline = !!args.xmlPath;
      if (offline) {
        targetPath = args.xmlPath;
        xml = fs.readFileSync(targetPath, 'utf8');
        blockLabel = path.basename(targetPath, '.xml');
      } else {
        if (!args.blockName) throw new Error('Provide blockName or xmlPath.');
        const exp = await exportBlockXml(args.blockName, args.plcName);
        xml = exp.xml;
        targetPath = exp.meta.path;
        blockLabel = args.blockName;
      }
      const backup = bridge.saveBackup(blockLabel, xml);
      const patched = B.patchNetworks(xml, args.ops, getLadderCtx({ declare: args.declare }));
      fs.writeFileSync(targetPath, patched.xml, 'utf8');

      let importMsg = 'Wrote patched XML offline to ' + targetPath;
      if (!offline) {
        const imp = await bridge.call('import_block', {
          xmlPath: targetPath,
          plcName: args.plcName || '',
          group: args.group || '',
        });
        importMsg = 'Imported back into TIA Portal: ' + (imp.blocks || []).join(', ');
      }
      const preview = B.readBlock(patched.xml, { format: 'dsl', ctx: getLadderCtx() });
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
      lines.push(B.formatBlock(preview));
      return { text: lines.join('\n') };
    }

    case 'tia_edit_block_interface': {
      let xml, targetPath, blockLabel;
      const offline = !!args.xmlPath;
      if (offline) {
        targetPath = args.xmlPath;
        xml = fs.readFileSync(targetPath, 'utf8');
        blockLabel = path.basename(targetPath, '.xml');
      } else {
        if (!args.blockName) throw new Error('Provide blockName or xmlPath.');
        const exp = await exportBlockXml(args.blockName, args.plcName);
        xml = exp.xml;
        targetPath = exp.meta.path;
        blockLabel = args.blockName;
      }
      const backup = bridge.saveBackup(blockLabel, xml);
      if (args.remove && args.remove.length) xml = B.removeMembers(xml, args.remove);
      if (args.add && args.add.length) xml = B.addMembers(xml, args.add);
      fs.writeFileSync(targetPath, xml, 'utf8');
      if (!offline) {
        await bridge.call('import_block', { xmlPath: targetPath, plcName: args.plcName || '', group: args.group || '' });
      }
      const parsed = B.parseBlock(xml);
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
      if (shouldImport) {
        const imp = await bridge.call('import_block', {
          xmlPath: outPath,
          plcName: args.plcName || '',
          group: args.group || '',
        });
        statusLine = 'Created & imported into TIA Portal: ' + (imp.blocks || []).join(', ');
      }
      const preview = B.readBlock(created.xml, { format: 'both', ctx: getLadderCtx() });
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
      const res = A.analyze(reads, { symbol: args.symbol });
      return { text: A.formatAnalysis(res), json: res };
    }

    case 'tia_rollback_block': {
      const action = args.action || 'list';
      const list = bridge.listBackups(args.blockName);
      if (action === 'list') {
        if (!list.length) return { text: 'No backups found' + (args.blockName ? ' for "' + args.blockName + '"' : '') + '.' };
        return { text: 'BACKUPS (' + list.length + '):\n' + list.slice(0, 30).map(b => '  ' + b.file + ' (' + b.size + ' B, ' + b.mtime + ')').join('\n') };
      }
      const chosen = args.backupFile
        ? list.find(b => b.file === args.backupFile) || { path: path.join(path.dirname(list[0] ? list[0].path : EXPORTS_DIR), args.backupFile), file: args.backupFile }
        : list[0];
      if (!chosen || !fs.existsSync(chosen.path)) throw new Error('Backup not found for ' + (args.blockName || args.backupFile));
      const imp = await bridge.call('import_block', {
        xmlPath: chosen.path,
        plcName: args.plcName || '',
        group: args.group || '',
      });
      return { text: 'Restored from backup "' + chosen.file + '" -> imported: ' + (imp.blocks || []).join(', ') };
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
            lines.push('    - ' + pc.name + (pc.targetInterfaces.length ? ' -> targets: [' + pc.targetInterfaces.join(', ') + ']' : ''));
          }
        }
        return { text: lines.join('\n'), json: r };
      }
      if (act === 'download') {
        const r = await bridge.call('download', {
          plcName: args.plcName || '',
          mode: args.mode || 'PN/IE',
          pcInterface: args.pcInterface || 'PLCSIM',
          targetInterfaceIndex: args.targetInterfaceIndex || 0,
          includeHardware: args.includeHardware !== false,
          startAfterDownload: args.startAfterDownload !== false,
        });
        const lines = [
          'DOWNLOAD to "' + r.plc + '" via ' + r.pcInterface + ' (' + r.targetInterface + '): ' + r.state,
          'Errors: ' + r.errorCount + ', Warnings: ' + r.warningCount,
        ];
        for (const m of r.messages) lines.push('  [' + m.state + '] ' + m.message);
        return { text: lines.join('\n'), json: r };
      }
      const onlineAct = act === 'online_status' ? 'status' : act;
      const r = await bridge.call('online', {
        plcName: args.plcName || '',
        action: onlineAct,
        mode: args.mode || 'PN/IE',
        pcInterface: args.pcInterface || 'PLCSIM',
      });
      return { text: 'PLC "' + r.plc + '" Online State: ' + r.state, json: r };
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
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
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
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: out.text }] },
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
