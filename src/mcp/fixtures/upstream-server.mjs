// A stdio MCP server for tests. Appends one JSON line per event to $FIXTURE_LOG (start, each tools/call).
// Tools: echo, hang (never answers), big (FIXTURE_BIG characters of text), crash (exits), bad (an invalid result),
// env (whether FIXTURE_SECRET is set). With FIXTURE_NO_INIT it never answers initialize.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (line) => process.env.FIXTURE_LOG && appendFileSync(process.env.FIXTURE_LOG, `${JSON.stringify({ pid: process.pid, ...line })}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
log({ event: 'start' });
const tools = ['echo', 'hang', 'big', 'crash', 'bad', 'env'].map((name) => ({ name, inputSchema: { type: 'object' } }));
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      if (process.env.FIXTURE_NO_INIT) return;
      return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } });
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      log({ event: 'call', tool: name, args });
      if (name === 'echo') return reply({ content: [{ type: 'text', text: 'echo' }], structuredContent: { echoed: args ?? {} } });
      if (name === 'big') return reply({ content: [{ type: 'text', text: 'x'.repeat(Number(process.env.FIXTURE_BIG ?? 10)) }] });
      if (name === 'crash') process.exit(3);
      if (name === 'bad') return reply({ content: 'not a list' });
      if (name === 'env') return reply({ content: [{ type: 'text', text: process.env.FIXTURE_SECRET ? 'set' : 'unset' }] });
      return undefined; // hang
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
