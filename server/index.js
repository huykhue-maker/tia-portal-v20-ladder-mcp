'use strict';
// TIA Portal V20 MCP Server (Stdio JSON-RPC 2.0, zero external npm dependencies).
// Combines TiaBridge.exe (C# .NET 4.8 TIA Openness V20) with the 2-way Ladder Engine,
// Static Analyzer and In-RAM PLC Scan-Cycle Simulator.

const { BridgeClient } = require('./bridge_client');
const { OnlineBackups } = require('./online_backups');
const { TOOLS } = require('./tools');
const { createToolHandler } = require('./handlers');

const SERVER_INFO = { name: 'tia-portal-v20-mcp', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOL_VERSION = '2025-11-25';

const bridge = new BridgeClient();
const onlineBackups = new OnlineBackups(bridge);
const { handleTool } = createToolHandler({ bridge, onlineBackups });

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
          instructions: 'Read tia_project_blueprint first. Run tia_analyze_ladder and tia_dry_run_ladder before downloading. Call tia_download_and_online with action=list_connections before action=download. Confirm the target and user intent before deleting or overwriting anything.',
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
let toolQueue = Promise.resolve();
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
      if (msg.method === 'tools/call') {
        toolQueue = toolQueue.then(() => onMessage(msg), () => onMessage(msg));
      } else {
        onMessage(msg);
      }
    } catch { /* ignore non-JSON lines */ }
  }
});

process.on('SIGINT', () => { bridge.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { bridge.shutdown(); process.exit(0); });
process.on('exit', () => { bridge.shutdown(); });

