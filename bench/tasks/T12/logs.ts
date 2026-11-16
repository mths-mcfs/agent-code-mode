import type { Tree } from '../../fixture/generate.ts';
import { Rng } from '../../lib/rng.ts';

/**
 * T12 log set: 5 services x 16 days of plain-text logs (about 1.3 MB). Exactly one ERROR with code
 * PAYMENT_TIMEOUT is logged by payments on the target day; the service that sent that request is only
 * in the caller's own log (`call=payments req=<id>`). Decoys: the same code as WARN that day, as ERROR
 * on other days, and other ERROR codes that day. Deterministic for a seed.
 */

export const T12_SERVICES = ['api', 'auth', 'inventory', 'payments', 'shipping'] as const;
export const T12_DAY = '2026-03-14';
const DAYS = Array.from({ length: 16 }, (_v, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
const CALLERS = ['api', 'inventory', 'shipping'] as const;
const LINES_PER_FILE = 120;

export interface T12Logs {
  readonly files: Tree;
  readonly requestId: string;
  readonly upstream: string;
}

interface Line {
  readonly ms: number;
  readonly text: string;
}

export function generateLogs(seed: number): T12Logs {
  const rng = new Rng(seed * 31 + 12);
  const used = new Set<string>();
  const reqId = (): string => {
    for (;;) {
      const id = `r-${rng.int(0, 0xffffff).toString(16).padStart(6, '0')}${rng.int(0, 0xff).toString(16).padStart(2, '0')}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const files: Tree = new Map();
  let requestId = '';
  let upstream = '';
  for (const day of DAYS) {
    const logs = new Map<string, Line[]>(T12_SERVICES.map((s) => [s, []]));
    const at = (ms: number): string => `${day}T${new Date(ms).toISOString().slice(11, 23)}Z`;
    const push = (service: string, ms: number, level: string, rest: string): void => {
      logs.get(service)?.push({ ms, text: `${at(ms)} ${level.padEnd(5)} ${service} ${rest}` });
    };
    const payment = (ms: number, level: string, outcome: string): string => {
      const id = reqId();
      const caller = rng.pick(CALLERS);
      push(caller, ms, 'INFO', `req=${id} call=payments path=/v1/charges amount=${rng.int(100, 99_999)}`);
      push('payments', ms + rng.int(3, 40), level, `req=${id} ${outcome}`);
      return `${id} ${caller}`;
    };
    // Ordinary traffic until every file has about LINES_PER_FILE lines.
    for (let n = 0; n < LINES_PER_FILE * 3; n++) {
      const ms = rng.int(0, 86_399_000);
      const roll = rng.next();
      if (roll < 0.35) payment(ms, 'INFO', `status=200 ms=${rng.int(20, 900)}`);
      else if (roll < 0.55) push('auth', ms, 'INFO', `req=${reqId()} token=refresh user=u${rng.int(1000, 9999)}`);
      else if (roll < 0.7) push('inventory', ms, 'INFO', `req=${reqId()} sku=SKU-${rng.pick(['APPLE', 'BREAD', 'EGGS', 'HONEY'])} reserved=${rng.int(1, 9)}`);
      else if (roll < 0.85) push('shipping', ms, 'INFO', `req=${reqId()} label=created zone=${rng.pick(['domestic', 'nearby', 'international'])}`);
      else push('api', ms, rng.next() < 0.1 ? 'WARN' : 'INFO', `req=${reqId()} route=/orders status=${rng.pick([200, 200, 201, 404])}`);
    }
    // Decoys every day: other payment errors, and the target code as a retried WARN.
    payment(rng.int(0, 86_399_000), 'ERROR', `code=CARD_DECLINED status=402`);
    payment(rng.int(0, 86_399_000), 'WARN', `code=PAYMENT_TIMEOUT attempt=1 retrying=true`);
    if (day === T12_DAY) {
      payment(rng.int(0, 86_399_000), 'ERROR', `code=GATEWAY_UNAVAILABLE status=503`);
      payment(rng.int(0, 86_399_000), 'WARN', `code=PAYMENT_TIMEOUT attempt=2 retrying=true`);
      const [id, caller] = payment(rng.int(30_000_000, 70_000_000), 'ERROR', `code=PAYMENT_TIMEOUT attempt=3 retrying=false status=504`).split(' ');
      requestId = id ?? '';
      upstream = caller ?? '';
    } else if (rng.next() < 0.5) {
      payment(rng.int(0, 86_399_000), 'ERROR', `code=PAYMENT_TIMEOUT attempt=3 retrying=false status=504`);
    }
    for (const [service, lines] of logs) files.set(`logs/${service}/${day}.log`, `${lines.sort((a, b) => a.ms - b.ms).map((l) => l.text).join('\n')}\n`);
  }
  return { files, requestId, upstream };
}

export function addLogs(tree: Tree, seed: number): Tree {
  const out = new Map(tree);
  for (const [file, text] of generateLogs(seed).files) out.set(file, text);
  return out;
}
