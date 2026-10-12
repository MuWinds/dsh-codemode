#!/usr/bin/env node
/**
 * Minimal MCP stdio server used to verify codemode end to end without network
 * access: three deterministic tools in one namespace (`fake`), spoken over
 * newline-delimited JSON-RPC on stdio.
 *
 * Not part of the plugin: it exists so the verification run can assert exact
 * counts ("3 hidden tools, namespace fake") instead of depending on a remote
 * MCP server.
 */

const TOOLS = [
  {
    name: 'get_ticker',
    description: 'Get the latest ticker 行情快照 for one instrument',
    inputSchema: {
      type: 'object',
      properties: { instId: { type: 'string', description: 'Instrument id, e.g. BTC-USDT' } },
      required: ['instId'],
    },
  },
  {
    name: 'place_order',
    description: 'Place a spot order on the exchange',
    inputSchema: {
      type: 'object',
      properties: { instId: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, size: { type: 'number' } },
      required: ['instId', 'side', 'size'],
    },
  },
  {
    name: 'account_balance',
    description: 'Read the trading account balance',
    inputSchema: { type: 'object', properties: { ccy: { type: 'string' } } },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function handle(request) {
  const { id, method, params } = request;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-codemode-mcp', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return fail(-32602, `unknown tool: ${String(name)}`);
      const args = params?.arguments ?? {};
      return reply({
        content: [{ type: 'text', text: `fake:${name} ${JSON.stringify(args)}` }],
        structuredContent: { ok: true, tool: name, args, source: 'fake-codemode-mcp' },
      });
    }
    default:
      return id === undefined ? undefined : fail(-32601, `method not found: ${String(method)}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed frames; the client owns the protocol */
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
