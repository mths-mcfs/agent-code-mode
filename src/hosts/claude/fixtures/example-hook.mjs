import { writeFileSync } from 'node:fs';

const [mode, arg] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');

const decide = (permissionDecision, extra = {}) =>
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `example ${permissionDecision}`, ...extra } }));

switch (mode) {
  case 'allow':
  case 'deny':
  case 'ask':
  case 'defer':
    decide(mode);
    break;
  case 'legacy-block':
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'legacy block' }));
    break;
  case 'stop':
    process.stdout.write(JSON.stringify({ continue: false, stopReason: 'stop requested' }));
    break;
  case 'update':
    decide('allow', { updatedInput: JSON.parse(arg) });
    break;
  case 'update-only':
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: JSON.parse(arg) } }));
    break;
  case 'exit2':
    process.stderr.write('blocked by example hook');
    process.exit(2);
    break;
  case 'exit1':
    process.exit(1);
    break;
  case 'crash':
    throw new Error('example hook crashed');
  case 'invalid':
    process.stdout.write('this is not json');
    break;
  case 'bad-decision':
    decide('maybe');
    break;
  case 'sleep':
    await new Promise((r) => setTimeout(r, Number(arg)));
    decide('allow');
    break;
  case 'record':
    writeFileSync(arg, input);
    break;
  case 'empty':
    break;
  default:
    process.stderr.write(`unknown mode ${mode}`);
    process.exit(1);
}
