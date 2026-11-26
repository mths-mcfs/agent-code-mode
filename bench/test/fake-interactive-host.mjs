// Stands in for an interactive Claude Code session in the tmux driver test: it draws the ready screen, takes
// the pasted prompt and records it, then writes a recorded Code Mode transcript where the driver reads it.
// Modes: `finish` answers at once, `deny` first shows a permission prompt, `hang` never answers.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [transcript, fixture, mode] = process.argv.slice(2);
mkdirSync(path.dirname(transcript), { recursive: true });
writeFileSync(`${transcript}.env`, `${JSON.stringify(Object.keys(process.env).sort())}\n`);

const rule = '─'.repeat(40);
const draw = (lines) => process.stdout.write(`\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`);
const ready = () => draw(['⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on', rule, '❯ ', rule, '  ? for shortcuts']);
const answer = () => {
  appendFileSync(transcript, readFileSync(fixture, 'utf8'));
  ready();
};

process.stdout.write('\x1b[?2004h');
ready();
process.stdin.setRawMode(true);
let state = 'ready';
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
  const enterAfter = (marker) => input.includes(marker) && input.slice(input.indexOf(marker)).includes('\r');
  if (state === 'ready' && enterAfter('\x1b[201~')) {
    const prompt = input.slice(input.indexOf('\x1b[200~') + 6, input.indexOf('\x1b[201~'));
    input = '';
    if (mode !== 'hang') appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    if (mode === 'deny') {
      state = 'permission';
      draw([rule, ' Bash command', ' rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow access to <dir> from this project', '   3. No', ' Esc to cancel · Tab to amend']);
    } else if (mode === 'hang') {
      state = 'done';
    } else {
      state = 'done';
      answer();
    }
  } else if (state === 'permission' && enterAfter('\t')) {
    writeFileSync(`${transcript}.keys`, JSON.stringify(input));
    input = '';
    state = 'done';
    answer();
  } else if (state === 'done' && enterAfter('/exit')) {
    process.exit(0);
  }
});
