// Example PreToolUse/PostToolUse hook used by the tests.
// Usage: node example-hook.mjs <mode> [arg]
//   allow | deny | ask | defer       print a JSON permissionDecision
//   legacy-block                     print {"decision":"block"}
//   stop                             print {"continue":false}
//   update <json>                    print updatedInput = <json> (with allow)
//   update-only <json>               print updatedInput without a decision
//   exit2                            exit 2 with a reason on stderr
//   exit1                            exit 1
//   crash                            throw (exit 1 from node)
//   invalid                          print text that is not JSON
//   bad-decision                     print an unknown permissionDecision
//   sleep <ms>                       sleep, then allow
//   record <file>                    write stdin to <file>, print nothing
//   empty                            print nothing
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
