'use strict';
const B = require('./ladder/block');

const memberProperties = {
  name: { type: 'string' },
  type: { type: 'string' },
  comment: { type: 'string' },
  startValue: { type: ['string', 'number', 'boolean'], description: 'Initial value in TIA syntax. Prefer a string for typed literals and exact formatting.' },
  retain: { type: 'boolean', description: 'Emit Remanence="Retain" when true.' },
  members: { type: 'array', description: 'Nested member definitions when type is "Struct".', items: { type: 'object' } },
};
const interfaceMembers = { type: 'array', items: { type: 'object', required: ['name', 'type'], properties: memberProperties } };

function toolAnnotations(readOnlyHint, destructiveHint = false, idempotentHint = readOnlyHint, openWorldHint = false) {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

// ------------------------------------------------------------------ Tool Definitions
const TOOLS = [
  // --- Group 1: Session & Project ---
  {
    name: 'tia_status',
    annotations: toolAnnotations(true),
    description: 'Check the selected TIA Portal version, Windows Siemens TIA Openness group membership, running processes, and open project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tia_connect',
    annotations: toolAnnotations(false),
    description: 'Attach to a running TIA Portal window or launch an instance of the configured version (UI or Headless). Stays alive cleanly across tool calls.',
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
    annotations: toolAnnotations(false, true),
    description: 'Open a project for the configured TIA Portal version (.ap16 or .ap20). Supports full Unicode/Vietnamese paths. Auto-connects if not connected.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to the .ap16 or .ap20 file, e.g. D:\\Kì 7\\Đồ án 2\\Do_an2_cnc_V20\\Do_an2_cnc_V20.ap20' },
        mode: { type: 'string', enum: ['auto', 'attach', 'ui', 'headless'], description: 'Connection mode if not yet connected (default: auto).' },
        closeCurrent: { type: 'boolean', description: 'Close currently open project if different (default: false).' },
        upgrade: { type: 'boolean', description: 'Open with upgrade from an older TIA Portal version (default: false).' },
      },
    },
  },
  {
    name: 'tia_save_project',
    annotations: toolAnnotations(false, true),
    description: 'Save the currently open TIA Portal project (or Save As to a new directory).',
    inputSchema: {
      type: 'object',
      properties: {
        saveAsDirectory: { type: 'string', description: 'Optional target directory for Save As (omit to save in place).' },
      },
    },
  },
  {
    name: 'tia_close_project',
    annotations: toolAnnotations(false, true),
    description: 'Close the currently open TIA Portal project and optionally disconnect.',
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
    annotations: toolAnnotations(true),
    description: 'One-shot comprehensive overview of a TIA Portal project: CPU/devices, all blocks (OB/FB/FC/DB) with language & consistency, PLC Tag Tables, UDTs, Technological Objects (e.g. CNC axes), and automatically learns block interfaces and UDTs for CALL and type validation.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string', description: 'Optional PLC name if multiple PLCs exist.' },
        group: { type: 'string', description: 'Optional block folder group prefix filter (e.g. "Motion" or "Engineering/Logic").' },
        learnInterfaces: { type: 'boolean', description: 'Export FB/FC/GlobalDB/UDT headers to learn CALL signatures and DB/UDT member types (default: true).' },
        maxLearnBlocks: { type: 'integer', minimum: 0, description: 'Optional cap on how many FB/FC/GlobalDB/UDT headers are exported during learning on large projects.' },
      },
    },
  },
  {
    name: 'tia_list_blocks',
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(false, true),
    description: 'Create or update one or more PLC tags in a PLC Tag Table.',
    inputSchema: {
      type: 'object',
      properties: {
        plcName: { type: 'string' },
        table: { type: 'string', description: 'Target tag table name (default: Default tag table).' },
        delete: { type: 'array', items: { type: 'string' }, description: 'Exact tag names to delete from this PLC/table.' },
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
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(false, true),
    description: 'Create or edit a GlobalDB, InstanceDB, or PLC Data Type (UDT) (automatically backs up XML before re-importing on edit).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        action: { type: 'string', enum: ['edit', 'create', 'delete'], description: 'Default: edit. Delete creates a verified XML backup first.' },
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
            properties: memberProperties,
          },
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Member names to remove.' },
      },
    },
  },

  // --- Group 3: Optimized Ladder (LAD) Reading, Surgical Patching, Creating, Analysis ---
  {
    name: 'tia_read_ladder',
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(false, true),
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
    annotations: toolAnnotations(false, true),
    description: 'Add or remove interface members in an OB, FB, or FC, including Constant and typed FC Return (auto-backups before re-importing).',
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
              section: { type: 'string', enum: ['Input', 'Output', 'InOut', 'Static', 'Temp', 'Constant', 'Return'] },
              ...memberProperties,
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
    annotations: toolAnnotations(false, true),
    description: 'Create a brand-new LAD block (FB, FC, or OB) from interface specification and Ladder DSL networks, generate version-specific SimaticML XML, and import it into TIA Portal (or save offline). V16 generation supports simple contacts and coils.',
    inputSchema: {
      type: 'object',
      required: ['type', 'name'],
      properties: {
        type: { type: 'string', enum: ['FB', 'FC', 'OB'] },
        portalVersion: { type: 'string', enum: ['16', '20'], description: 'XML output version. Defaults to the configured TIA Portal version.' },
        secondaryType: { type: 'string', enum: ['ProgramCycle', 'Startup', 'CyclicInterrupt'], description: 'OB event class (default ProgramCycle).' },
        name: { type: 'string' },
        number: { type: 'integer', description: 'Optional block number (omit for AutoNumber).' },
        plcName: { type: 'string' },
        group: { type: 'string', description: 'Optional destination folder group in TIA Portal.' },
        title: { type: 'string' },
        comment: { type: 'string' },
        memoryLayout: { type: 'string', enum: ['Optimized', 'Standard'] },
        interface: {
          type: 'object',
          description: 'Map of interface sections to member arrays. Use Return for a typed FC result.',
          properties: Object.fromEntries(B.SECTION_ORDER.filter(s => s !== 'None').map(s => [s, interfaceMembers])),
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
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(false, true),
    description: 'List available XML backups or restore a block in TIA Portal from a previous auto-backup.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'restore', 'delete'], description: 'Default: list. Delete backs up the online block/UDT first.' },
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
    annotations: toolAnnotations(false, true),
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
    annotations: toolAnnotations(true),
    description: 'Analyze offline LAD XML, DBs, UDTs and PLC tags and run named regression scenarios. Set strictSymbols in the suite JSON to validate symbol paths and scenario values. Optionally compare watched signals with a baseline XML directory. Paths are relative to the suite file. Returns text, JSON or JUnit.',
    inputSchema: {
      type: 'object', required: ['manifestPath'],
      properties: {
        manifestPath: { type: 'string', description: 'Path to the suite JSON file.' },
        baselineBlockDir: { type: 'string', minLength: 1, description: 'Run the same cases against this baseline XML directory. Each case requires a watch list.' },
        format: { type: 'string', enum: ['text', 'json', 'junit'] },
        targetSymbol: { type: 'string', description: 'Exact variable/tag to assess before changing.' },
        targetBlock: { type: 'string', description: 'Block signature to assess before changing.' },
      },
    },
  },
  {
    name: 'tia_dry_run_ladder',
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(false, true),
    description: 'Compile PLC Software (and optionally Hardware) in the configured TIA Portal version. Enables "Support simulation during block compilation" by default and returns detailed compiler errors & warnings.',
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
    annotations: toolAnnotations(false, true),
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
    annotations: toolAnnotations(false, true, false, true),
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
    annotations: toolAnnotations(false, true),
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
    annotations: toolAnnotations(false),
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
    annotations: toolAnnotations(false, true),
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
    annotations: toolAnnotations(true),
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
    annotations: toolAnnotations(false, true),
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
    annotations: toolAnnotations(false, true),
    description: 'Inspect subnets/PROFINET interfaces, set device/PLC IP address/subnet mask/router, connect a device to a subnet, create or connect to a PROFINET IO system, or toggle OPC UA server settings.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['inspect', 'set_ip', 'connect_subnet', 'connect_io_system', 'opcua'] },
        plcName: { type: 'string' },
        deviceName: { type: 'string', description: 'Exact device name for set_ip/connect_subnet/connect_io_system when the target is not a PLC.' },
        interfaceName: { type: 'string', description: 'Optional network interface name filter.' },
        ipAddress: { type: 'string' },
        subnetMask: { type: 'string' },
        routerAddress: { type: 'string' },
        subnetName: { type: 'string', description: 'Subnet to create/connect (default: PN/IE_1).' },
        createIoSystem: { type: 'boolean', description: 'Create an IO system when connecting (default: false).' },
        ioSystemName: { type: 'string', description: 'Exact PROFINET IO System name for action="connect_io_system".' },
        pnDeviceName: { type: 'string', description: 'Optional PROFINET device name to assign during action="connect_io_system".' },
        enableServer: { type: 'boolean', description: 'Enable/disable OPC UA server.' },
        port: { type: 'integer', description: 'OPC UA port (default: 4840).' },
      },
    },
  },
  {
    name: 'tia_plcsim_runtime',
    annotations: toolAnnotations(false, true, false, true),
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
    annotations: toolAnnotations(false, true, false, true),
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

module.exports = { TOOLS, toolAnnotations, memberProperties, interfaceMembers };
