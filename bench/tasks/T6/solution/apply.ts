import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FixtureFacts } from '../../../fixture/generate.ts';

const OrderSchema = z.object({ items: z.array(z.object({ qty: z.number() }).passthrough()) }).passthrough();

export async function applySolution(workspace: string, facts: FixtureFacts): Promise<string> {
  for (const rel of facts.paidOrderFiles) {
    const file = path.join(workspace, ...rel.split('/'));
    const order = OrderSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    const itemCount = order.items.reduce((n, item) => n + item.qty, 0);
    await writeFile(file, `${JSON.stringify({ ...order, itemCount }, null, 2)}\n`);
  }
  return `Added itemCount to ${facts.paidOrderFiles.length} paid orders.`;
}
