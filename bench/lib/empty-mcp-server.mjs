#!/usr/bin/env node
// A minimal MCP stdio server with no tools, resources, prompts or instructions. The benchmark adds it
// to the Codex arms that have no other MCP server, because Codex adds its MCP resource tools
// (list_mcp_resources, list_mcp_resource_templates, read_mcp_resource) whenever any MCP server is
// configured: with it, every Codex arm sees the same non-file tools.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const EMPTY = { 'tools/list': { tools: [] }, 'resources/list': { resources: [] }, 'resources/templates/list': { resourceTemplates: [] }, 'prompts/list': { prompts: [] }, ping: {} };

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== 'object' || msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') {
    const version = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: version, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'bench-empty', version: '1.0.0' } } });
  } else if (msg.method in EMPTY) {
    send({ jsonrpc: '2.0', id: msg.id, result: EMPTY[msg.method] });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
