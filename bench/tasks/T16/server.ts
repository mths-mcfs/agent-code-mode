import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CUSTOMER_PAGE_SIZE, ORDER_PAGE_SIZE, t16Data, type Order } from './data.ts';

const SeedArgs = z.tuple([z.literal('--seed'), z.string().regex(/^\d+$/)]);
const parsedArgs = SeedArgs.safeParse(process.argv.slice(2));
if (!parsedArgs.success) {
  process.stderr.write('usage: node server.ts --seed <non-negative integer>\n');
  process.exit(2);
}
const data = t16Data(Number(parsedArgs.data[1]));

const page = z.number().int().min(1).max(1_000).default(1);
const ListCustomersArgs = z.strictObject({ page });
const ListOrdersArgs = z.strictObject({ customer_id: z.string().min(1).max(40), page });
const GetOrderArgs = z.strictObject({ order_id: z.string().min(1).max(40) });

const TOOLS = [
  {
    name: 'list_customers',
    description: `List customers, ${CUSTOMER_PAGE_SIZE} per page, with their profile, contacts and billing details.`,
    inputSchema: { type: 'object', properties: { page: { type: 'integer', minimum: 1, description: 'Page number, from 1.' } }, additionalProperties: false },
  },
  {
    name: 'list_orders',
    description: `List the orders of one customer, ${ORDER_PAGE_SIZE} per page, newest first: items, status, shipping and history. Refund details are not included; use get_order.`,
    inputSchema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer id, e.g. C-0123.' }, page: { type: 'integer', minimum: 1, description: 'Page number, from 1.' } },
      required: ['customer_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_order',
    description: 'One order with everything: items, payments, refunds (each with its own date, amount and status) and history.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string', description: 'Order id, e.g. O-1042.' } }, required: ['order_id'], additionalProperties: false },
  },
] as const;

function listView(o: Order): Record<string, unknown> {
  const { refunds: _refunds, payments: _payments, events, ...rest } = o;
  return { ...rest, events: events.filter((e) => !e.type.startsWith('refund')) };
}

function paged<T>(items: readonly T[], n: number, size: number): { page: number; pageCount: number; nextPage: number | null; total: number; items: T[] } {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  return { page: n, pageCount, nextPage: n < pageCount ? n + 1 : null, total: items.length, items: items.slice((n - 1) * size, n * size) };
}

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (value: unknown): Reply => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): Reply => ({ content: [{ type: 'text', text: message }], isError: true });

function call(name: string, raw: unknown): Reply {
  switch (name) {
    case 'list_customers': {
      const a = ListCustomersArgs.safeParse(raw ?? {});
      if (!a.success) return fail(`invalid arguments: ${a.error.issues.map((i) => i.message).join('; ')}`);
      const { items, ...meta } = paged(data.customers, a.data.page, CUSTOMER_PAGE_SIZE);
      return ok({ ...meta, customers: items });
    }
    case 'list_orders': {
      const a = ListOrdersArgs.safeParse(raw ?? {});
      if (!a.success) return fail(`invalid arguments: ${a.error.issues.map((i) => i.message).join('; ')}`);
      if (!data.customers.some((c) => c.id === a.data.customer_id)) return fail(`no customer ${a.data.customer_id}`);
      const mine = data.orders.filter((o) => o.customerId === a.data.customer_id).sort((x, y) => (x.orderDate < y.orderDate ? 1 : x.orderDate > y.orderDate ? -1 : x.id.localeCompare(y.id)));
      const { items, ...meta } = paged(mine, a.data.page, ORDER_PAGE_SIZE);
      return ok({ customerId: a.data.customer_id, ...meta, orders: items.map(listView) });
    }
    case 'get_order': {
      const a = GetOrderArgs.safeParse(raw ?? {});
      if (!a.success) return fail(`invalid arguments: ${a.error.issues.map((i) => i.message).join('; ')}`);
      const order = data.orders.find((o) => o.id === a.data.order_id);
      return order === undefined ? fail(`no order ${a.data.order_id}`) : ok(order);
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}

const server = new Server({ name: 'orders', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map((t) => ({ ...t })) }));
server.setRequestHandler(CallToolRequestSchema, (request) => call(request.params.name, request.params.arguments));
await server.connect(new StdioServerTransport());
