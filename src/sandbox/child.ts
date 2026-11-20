/**
 * Sandbox child process. Started by `QuickJsSandbox` for exactly one run with
 * a minimal env, then killed. It reads newline-delimited JSON from stdin
 * (`start`, then `reply`s), runs the script in a QuickJS-ng WASM VM (sync
 * build) and writes `call`, `log` and `done` messages to stdout.
 *
 * Inside the VM the script sees only standard ECMAScript built-ins, `console`
 * and the async bindings. Each binding call creates a QuickJS deferred promise
 * that this process settles when the parent replies; pending jobs are then
 * drained until the script's promise settles.
 *
 * This file has no runtime import of other project files (only `import type`),
 * so Node can run it from source with type stripping during tests.
 */
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSSyncVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import * as variantModule from '@jitl/quickjs-ng-wasmfile-release-sync';
import { writeSync } from 'node:fs';
import { z } from 'zod';
import type { ChildMessage, SandboxLimits, StartMessage } from './protocol.js';

/** File name the script is compiled under; stack frames of the script carry it. */
const SCRIPT_FILE = 'script.js';
const SHIM_FILE = 'shim.js';
const MAX_ERROR_CHARS = 10_000;
const WASM_PAGE_BYTES = 64 * 1024;

/** The part of the WebAssembly API this file uses (the project's `lib` has no WebAssembly types). */
interface WasmMemory {
  grow(deltaPages: number): number;
}
declare const WebAssembly: { readonly Memory: new (descriptor: { initial: number; maximum: number }) => WasmMemory };
/** Initial memory of the WASM build (its INITIAL_MEMORY, 16 MiB). */
const INITIAL_PAGES = 256;
/** Largest memory the WASM build declares (2 GiB). */
const MAX_PAGES = 32_768;
/**
 * Exit code that tells the parent the engine ran out of memory. The child exits with it from inside
 * the refused memory growth, so no message can follow; must equal `OOM_EXIT_CODE` in protocol.ts.
 */
const OOM_EXIT_CODE = 86;
/**
 * Sizes the Emscripten glue tries per growth request before the allocation fails (its `_emscripten_resize_heap`
 * retries with 20%, 10% and 5% of overgrowth); a success in between means the request was served.
 */
const GROW_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Incoming messages (from the parent). Validated even though the parent is the
// trusted side: a malformed message ends the process.
// ---------------------------------------------------------------------------

const int = z.number().int().positive();
const LimitsSchema = z.strictObject({
  memoryBytes: int,
  stackBytes: int,
  maxCalls: int,
  maxLogBytes: int,
  maxLogLineChars: int,
  maxResultChars: int,
  maxArgsChars: int,
  maxPendingOutputBytes: int,
});
const BindingErrorSchema = z.strictObject({
  name: z.enum(['PermissionDenied', 'ToolError']),
  message: z.string(),
  code: z.string(),
  source: z.string().optional(),
});
const ParentMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start'), code: z.string(), timeoutMs: z.number().positive(), limits: LimitsSchema }),
  z.strictObject({
    type: z.literal('reply'),
    id: int,
    reply: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), value: z.unknown() }),
      z.strictObject({ ok: z.literal(false), error: BindingErrorSchema }),
    ]),
  }),
]);
type IncomingMessage = z.infer<typeof ParentMessageSchema>;

const retryWait = new Int32Array(new SharedArrayBuffer(4));

/**
 * Writes one message to stdout and returns only once the pipe holds all of it. No message ever waits in this
 * process, so exiting at any point, even from inside a refused memory growth, loses none written before. While the
 * parent does not read, the child blocks here instead of queuing; the parent's deadline still ends the run.
 */
function writeMessage(message: ChildMessage): void {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EAGAIN')) fatal(`could not write to the parent: ${err instanceof Error ? err.message : String(err)}`);
      Atomics.wait(retryWait, 0, 0, 1);
    }
  }
}

/** Writes the final message and exits. */
function exitWith(outcome: DoneOutcome): void {
  writeMessage({ type: 'done', outcome });
  process.exit(0);
}

function fatal(message: string): never {
  process.stderr.write(`sandbox child: ${message}\n`);
  process.exit(70);
}

// ---------------------------------------------------------------------------
// In-VM shim. Evaluated before the script; its completion value is a function
// that receives the host natives (never exposed as globals), installs the
// bindings and `console`, and returns the runner. It captures the intrinsics
// it uses first, so a script that overrides `JSON.stringify` or
// `Promise.prototype.then` only breaks its own values.
// ---------------------------------------------------------------------------

const SHIM = String.raw`(function (hostCall, hostLog, hostDone, maxResultChars, maxLogLineChars) {
  'use strict';
  var G = globalThis;
  var stringify = JSON.stringify, parse = JSON.parse;
  var apply = Reflect.apply;
  var defineProperty = Object.defineProperty, getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var objectKeys = Object.keys, isArray = Array.isArray, numberIsFinite = Number.isFinite, objectIs = Object.is;
  var promiseThen = Promise.prototype.then, promiseResolve = Promise.resolve, promiseReject = Promise.reject, PromiseCtor = Promise;
  var ErrorCtor = Error, TypeErrorCtor = TypeError, StringCtor = String;
  var symbolToString = Symbol.prototype.toString, stringSlice = String.prototype.slice, arrayJoin = Array.prototype.join;
  var dateToISOString = Date.prototype.toISOString, DateCtor = Date, RegExpCtor = RegExp, MapCtor = Map, SetCtor = Set;
  var regexpToString = RegExp.prototype.toString;
  var mapForEach = Map.prototype.forEach, setForEach = Set.prototype.forEach;
  var mapSize = getOwnPropertyDescriptor(Map.prototype, 'size').get, setSize = getOwnPropertyDescriptor(Set.prototype, 'size').get;
  var identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/, regexpTest = RegExp.prototype.test;

  // Not ECMAScript: removed so the script sees only the standard library.
  var extras = ['performance', 'DOMException', 'queueMicrotask'];
  for (var x = 0; x < extras.length; x++) { try { delete G[extras[x]]; } catch (e) { /* keep going */ } }

  function push(list, item) { list[list.length] = item; }
  function join(list, sep) { return apply(arrayJoin, list, [sep]); }
  function cut(text, max) { return text.length > max ? apply(stringSlice, text, [0, max]) + '... [truncated]' : text; }
  function isError(v) { try { return v instanceof ErrorCtor; } catch (e) { return false; } }
  function safeString(v) { try { return StringCtor(v); } catch (e) { return '[unprintable value]'; } }
  function fnName(f) {
    try { var n = f.name; return typeof n === 'string' && n !== '' ? n : 'anonymous'; } catch (e) { return 'anonymous'; }
  }
  function messageOf(e) { try { return isError(e) ? safeString(e.message) : safeString(e); } catch (x) { return 'unknown error'; } }
  function define(name, value) { defineProperty(G, name, { value: value, writable: true, enumerable: false, configurable: true }); }

  // ---- console: Node-like formatting, without running getters --------------
  function inspect(v, depth, seen, top) {
    switch (typeof v) {
      case 'string': return top ? v : "'" + v + "'";
      case 'number': return objectIs(v, -0) ? '-0' : StringCtor(v);
      case 'bigint': return StringCtor(v) + 'n';
      case 'boolean': case 'undefined': return StringCtor(v);
      case 'symbol': return apply(symbolToString, v, []);
      case 'function': return '[Function: ' + fnName(v) + ']';
    }
    if (v === null) return 'null';
    try {
      for (var s = 0; s < seen.length; s++) if (seen[s] === v) return '[Circular]';
      if (isError(v)) return safeString(v.name) + ': ' + safeString(v.message);
      if (v instanceof DateCtor) { try { return apply(dateToISOString, v, []); } catch (e) { return 'Invalid Date'; } }
      if (v instanceof RegExpCtor) return apply(regexpToString, v, []);
      var parts = [];
      push(seen, v);
      if (v instanceof MapCtor) {
        if (depth > 2) { seen.length--; return '[Map]'; }
        apply(mapForEach, v, [function (val, key) { push(parts, inspect(key, depth + 1, seen, false) + ' => ' + inspect(val, depth + 1, seen, false)); }]);
        seen.length--;
        return 'Map(' + apply(mapSize, v, []) + ') {' + (parts.length ? ' ' + join(parts, ', ') + ' ' : '') + '}';
      }
      if (v instanceof SetCtor) {
        if (depth > 2) { seen.length--; return '[Set]'; }
        apply(setForEach, v, [function (val) { push(parts, inspect(val, depth + 1, seen, false)); }]);
        seen.length--;
        return 'Set(' + apply(setSize, v, []) + ') {' + (parts.length ? ' ' + join(parts, ', ') + ' ' : '') + '}';
      }
      if (isArray(v)) {
        if (depth > 2) { seen.length--; return '[Array]'; }
        var n = v.length, shown = n > 100 ? 100 : n;
        for (var i = 0; i < shown; i++) {
          var item = getOwnPropertyDescriptor(v, i);
          push(parts, item === undefined ? 'undefined' : 'value' in item ? inspect(item.value, depth + 1, seen, false) : '[Getter/Setter]');
        }
        if (n > shown) push(parts, '... ' + (n - shown) + ' more items');
        seen.length--;
        return parts.length ? '[ ' + join(parts, ', ') + ' ]' : '[]';
      }
      if (depth > 2) { seen.length--; return '[Object]'; }
      var keys = objectKeys(v), shownKeys = keys.length > 100 ? 100 : keys.length;
      for (var k = 0; k < shownKeys; k++) {
        var key = keys[k], d = getOwnPropertyDescriptor(v, key);
        var label = apply(regexpTest, identifier, [key]) ? key : "'" + key + "'";
        var shownValue = d === undefined ? 'undefined' : 'value' in d ? inspect(d.value, depth + 1, seen, false) : '[Getter/Setter]';
        push(parts, label + ': ' + shownValue);
      }
      if (keys.length > shownKeys) push(parts, '... ' + (keys.length - shownKeys) + ' more properties');
      seen.length--;
      return parts.length ? '{ ' + join(parts, ', ') + ' }' : '{}';
    } catch (e) {
      return '[uninspectable: ' + messageOf(e) + ']';
    }
  }
  function logger(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) push(parts, inspect(arguments[i], 0, [], true));
      // JSON text: the native side reads strings up to the first NUL character.
      hostLog(level, stringify(cut(join(parts, ' '), maxLogLineChars)));
    };
  }
  define('console', { log: logger('log'), info: logger('info'), warn: logger('warn'), error: logger('error') });

  // ---- bindings -----------------------------------------------------------
  function bindingError(text) {
    var info;
    try { info = parse(text); } catch (e) { info = { name: 'ToolError', message: 'invalid binding error', code: 'tool-error' }; }
    var err = new ErrorCtor(safeString(info.message));
    defineProperty(err, 'name', { value: safeString(info.name), writable: true, enumerable: false, configurable: true });
    defineProperty(err, 'code', { value: safeString(info.code), writable: true, enumerable: true, configurable: true });
    if (info.source !== undefined) {
      defineProperty(err, 'source', { value: safeString(info.source), writable: true, enumerable: true, configurable: true });
      defineProperty(err, 'reason', { value: safeString(info.message), writable: true, enumerable: true, configurable: true });
    }
    return err;
  }
  function invoke(tool, arg) {
    var json;
    try { json = stringify(arg); } catch (e) {
      return apply(promiseReject, PromiseCtor, [new TypeErrorCtor(tool + ': the argument is not JSON-serializable: ' + messageOf(e))]);
    }
    if (json === undefined) json = 'null';
    return apply(promiseThen, hostCall(tool, json), [function (text) { return parse(text); }, function (text) { throw bindingError(text); }]);
  }
  var bindings = {
    bash: function bash(arg) { return invoke('bash', typeof arg === 'string' ? { command: arg } : arg); },
    read: function read(arg) { return invoke('read', arg); },
    write: function write(arg) { return invoke('write', arg); },
    edit: function edit(arg) { return invoke('edit', arg); },
    grep: function grep(arg) { return invoke('grep', arg); },
    glob: function glob(arg) { return invoke('glob', arg); },
  };
  var names = objectKeys(bindings);
  for (var b = 0; b < names.length; b++) define(names[b], bindings[names[b]]);

  // ---- return value: JSON, with non-JSON values described -----------------
  var tooLarge = {};
  function serialize(root) {
    var out = [], size = 0, stack = [];
    function emit(text) {
      size += text.length;
      if (size > maxResultChars) throw tooLarge;
      push(out, text);
    }
    function value(v, key, inArray, depth) {
      try {
        if (v !== null && (typeof v === 'object' || typeof v === 'bigint') && typeof v.toJSON === 'function') v = v.toJSON(key);
      } catch (e) {
        if (e === tooLarge) throw e;
        emit(stringify('[toJSON threw: ' + messageOf(e) + ']'));
        return;
      }
      switch (typeof v) {
        case 'string': emit(stringify(v)); return;
        case 'number': emit(numberIsFinite(v) ? stringify(v) : stringify(StringCtor(v))); return;
        case 'boolean': emit(v ? 'true' : 'false'); return;
        case 'undefined': emit(inArray || depth === 0 ? 'null' : '"[undefined]"'); return;
        case 'bigint': emit(stringify(StringCtor(v) + 'n')); return;
        case 'symbol': emit(stringify(apply(symbolToString, v, []))); return;
        case 'function': emit(stringify('[Function: ' + fnName(v) + ']')); return;
      }
      if (v === null) { emit('null'); return; }
      for (var s = 0; s < stack.length; s++) if (stack[s] === v) { emit('"[Circular]"'); return; }
      if (depth >= 200) { emit('"[Too deep]"'); return; }
      try {
        if (isError(v)) { emit(stringify(safeString(v.name) + ': ' + safeString(v.message))); return; }
        push(stack, v);
        if (isArray(v)) {
          emit('[');
          for (var i = 0, n = v.length; i < n; i++) {
            if (i > 0) emit(',');
            var item;
            try { item = v[i]; } catch (e) { if (e === tooLarge) throw e; item = '[threw: ' + messageOf(e) + ']'; }
            value(item, StringCtor(i), true, depth + 1);
          }
          emit(']');
        } else {
          var keys = objectKeys(v), first = true;
          emit('{');
          for (var k = 0; k < keys.length; k++) {
            var prop;
            try { prop = v[keys[k]]; } catch (e) { if (e === tooLarge) throw e; prop = '[threw: ' + messageOf(e) + ']'; }
            if (prop === undefined) continue;
            if (!first) emit(',');
            first = false;
            emit(stringify(keys[k]) + ':');
            value(prop, keys[k], false, depth + 1);
          }
          emit('}');
        }
        stack.length--;
      } catch (e) {
        if (e === tooLarge) throw e;
        throw new TypeErrorCtor('the return value cannot be serialized: ' + messageOf(e));
      }
    }
    value(root, '', false, 0);
    return join(out, '');
  }

  // ---- runner ---------------------------------------------------------------
  function readProp(o, key, fallback) { try { return o[key]; } catch (x) { return fallback; } }
  function errorInfo(e) {
    var info;
    if (isError(e)) {
      var stack = readProp(e, 'stack', undefined);
      info = { name: safeString(readProp(e, 'name', 'Error')), message: safeString(readProp(e, 'message', '[unreadable message]')) };
      if (typeof stack === 'string') info.stack = stack;
    } else {
      info = { name: 'Error', message: typeof e === 'string' ? e : 'Uncaught ' + inspect(e, 0, [], false) };
    }
    return stringify(info);
  }
  return function run(fn) {
    var started;
    try { started = typeof fn === 'function' ? fn() : fn; } catch (e) { hostDone('E' + errorInfo(e)); return; }
    apply(promiseThen, apply(promiseResolve, PromiseCtor, [started]), [
      function (v) {
        var text;
        try { text = serialize(v); } catch (e) {
          if (e === tooLarge) {
            hostDone('E' + stringify({ name: 'ResultTooLarge', message: 'the return value is larger than ' + maxResultChars + ' characters of JSON; return less data' }));
            return;
          }
          hostDone('E' + errorInfo(e));
          return;
        }
        hostDone('R' + text);
      },
      function (e) { hostDone('E' + errorInfo(e)); },
    ]);
  };
})`;

// ---------------------------------------------------------------------------
// One run.
// ---------------------------------------------------------------------------

type DoneOutcome = Extract<ChildMessage, { type: 'done' }>['outcome'];

interface ErrorInfo {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

const LooseErrorSchema = z.object({ name: z.string(), message: z.string(), stack: z.string().optional() });

/** Keeps only the stack frames of the script itself. */
function trimStack(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const frames = stack.split('\n').filter((line) => line.includes(`${SCRIPT_FILE}:`));
  return frames.length > 0 ? frames.join('\n').slice(0, MAX_ERROR_CHARS) : undefined;
}

function toErrorInfo(raw: unknown): ErrorInfo {
  const parsed = LooseErrorSchema.safeParse(raw);
  if (!parsed.success) return { name: 'Error', message: typeof raw === 'string' ? raw.slice(0, MAX_ERROR_CHARS) : 'unknown error' };
  const stack = trimStack(parsed.data.stack);
  const base = { name: parsed.data.name.slice(0, 200), message: parsed.data.message.slice(0, MAX_ERROR_CHARS) };
  return stack === undefined ? base : { ...base, stack };
}

function isOutOfMemory(info: ErrorInfo): boolean {
  return /out of memory/i.test(info.message);
}

/**
 * The variant package's types describe its CommonJS entry, while Node loads
 * its ESM entry, whose default export is the variant itself. Checked at
 * runtime instead of cast.
 */
function syncVariant(candidate: unknown): QuickJSSyncVariant {
  if (typeof candidate === 'object' && candidate !== null && 'type' in candidate && candidate.type === 'sync' && 'importFFI' in candidate && 'importModuleLoader' in candidate) {
    if (typeof candidate.importFFI === 'function' && typeof candidate.importModuleLoader === 'function') return candidate as QuickJSSyncVariant;
  }
  if (typeof candidate === 'object' && candidate !== null && 'default' in candidate) return syncVariant(candidate.default);
  throw new Error('the QuickJS variant package did not load as expected');
}

/**
 * Makes running out of memory fatal for the run. QuickJS-ng's own accounting (`runtime.setMemoryLimit`) undercounts
 * in this WASM build because `malloc_usable_size` is unavailable, so the hard limit is the maximum of the WebAssembly
 * memory itself. When every size the glue tries for one growth request is refused,
 * the allocation is about to fail and the engine would throw into the script (an InternalError, or `null` when it
 * cannot even build one). Instead the process exits right here, inside the refused growth: control never returns to
 * the WASM code, so no catch, finally or later statement of the script runs. QuickJS's interrupt handler cannot do
 * this: the engine polls it once every 10,000 interrupt points, long after a catch block has run.
 */
function exitOnRefusedGrowth(memory: WasmMemory): void {
  const grow = memory.grow.bind(memory);
  let refused = 0;
  memory.grow = (deltaPages) => {
    try {
      const previous = grow(deltaPages);
      refused = 0;
      return previous;
    } catch (err) {
      refused++;
      if (refused >= GROW_ATTEMPTS) process.exit(OOM_EXIT_CODE);
      throw err;
    }
  };
}

/** Pages of WASM memory a run may use: all of it, initial memory included, fits in `memoryBytes`. */
function memoryPages(memoryBytes: number): number {
  return Math.min(MAX_PAGES, Math.floor(memoryBytes / WASM_PAGE_BYTES));
}

class VmRun {
  readonly #rt: QuickJSRuntime;
  readonly #ctx: QuickJSContext;
  readonly #limits: SandboxLimits;
  readonly #deadline: number;
  readonly #pending = new Map<number, QuickJSDeferredPromise>();
  readonly #timer: NodeJS.Timeout;
  #nextId = 1;
  #logBytes = 0;
  #logCapped = false;
  #done = false;

  constructor(qjs: QuickJSWASMModule, start: StartMessage) {
    this.#limits = start.limits;
    this.#deadline = Date.now() + start.timeoutMs;
    this.#rt = qjs.newRuntime();
    this.#rt.setMemoryLimit(start.limits.memoryBytes);
    this.#rt.setMaxStackSize(start.limits.stackBytes);
    // Also stops a script that keeps running after the run ended, so the final message can flush.
    this.#rt.setInterruptHandler(() => this.#done || Date.now() > this.#deadline);
    this.#ctx = this.#rt.newContext();
    this.#timer = setTimeout(() => this.#finish({ ok: false, kind: 'timeout', error: { name: 'Timeout', message: `the script did not finish within ${start.timeoutMs} ms` } }), start.timeoutMs);
  }

  begin(code: string): void {
    try {
      this.#begin(code);
    } catch (err) {
      this.#hostFailure(err);
    }
  }

  #begin(code: string): void {
    const ctx = this.#ctx;
    const shim = ctx.evalCode(SHIM, SHIM_FILE, { type: 'global' });
    if (shim.error) return this.#fail(shim.error);
    const natives = [this.#callNative(), this.#logNative(), this.#doneNative(), ctx.newNumber(this.#limits.maxResultChars), ctx.newNumber(this.#limits.maxLogLineChars)];
    const runner = ctx.callFunction(shim.value, ctx.undefined, natives);
    shim.value.dispose();
    for (const handle of natives) handle.dispose();
    if (runner.error) return this.#fail(runner.error);

    const compiled = ctx.evalCode(`(async function () {${code}\n})`, SCRIPT_FILE, { type: 'global' });
    if (compiled.error) {
      runner.value.dispose();
      return this.#fail(compiled.error);
    }
    const started = ctx.callFunction(runner.value, ctx.undefined, compiled.value);
    runner.value.dispose();
    compiled.value.dispose();
    if (started.error) return this.#fail(started.error);
    started.value.dispose();
    this.#drain();
  }

  reply(message: Extract<IncomingMessage, { type: 'reply' }>): void {
    try {
      this.#reply(message);
    } catch (err) {
      this.#hostFailure(err);
    }
  }

  #reply(message: Extract<IncomingMessage, { type: 'reply' }>): void {
    if (this.#done) return;
    const deferred = this.#pending.get(message.id);
    if (!deferred) return;
    this.#pending.delete(message.id);
    const { reply } = message;
    const text = (reply.ok ? JSON.stringify(reply.value) : JSON.stringify(reply.error)) ?? 'null';
    const handle = this.#ctx.newString(text);
    if (reply.ok) deferred.resolve(handle);
    else deferred.reject(handle);
    handle.dispose();
    deferred.dispose();
    this.#drain();
  }

  #callNative(): QuickJSHandle {
    const ctx = this.#ctx;
    return ctx.newFunction('call', (toolHandle, argsHandle) => {
      const tool = ctx.getString(toolHandle);
      const args = ctx.getString(argsHandle);
      const deferred = ctx.newPromise();
      const handle = deferred.handle.dup();
      if (this.#done) {
        this.#refuse(deferred, 'cancelled', 'the run has ended');
      } else if (this.#nextId > this.#limits.maxCalls) {
        this.#refuse(deferred, 'tool-error', `binding call limit reached: a run may make at most ${this.#limits.maxCalls} calls`);
      } else if (args.length > this.#limits.maxArgsChars) {
        this.#refuse(deferred, 'invalid-args', `the arguments of ${tool} are larger than ${this.#limits.maxArgsChars} characters of JSON`);
      } else {
        const id = this.#nextId++;
        this.#pending.set(id, deferred);
        writeMessage({ type: 'call', id, tool, args });
      }
      return handle;
    });
  }

  #refuse(deferred: QuickJSDeferredPromise, code: string, message: string): void {
    const handle = this.#ctx.newString(JSON.stringify({ name: 'ToolError', code, message }));
    deferred.reject(handle);
    handle.dispose();
    deferred.dispose();
  }

  #logNative(): QuickJSHandle {
    const ctx = this.#ctx;
    return ctx.newFunction('log', (levelHandle, textHandle) => {
      if (this.#logCapped || this.#done) return;
      const rawLevel = ctx.getString(levelHandle);
      const level = rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error' ? rawLevel : 'log';
      let decoded: unknown;
      try {
        decoded = JSON.parse(ctx.getString(textHandle));
      } catch {
        return;
      }
      if (typeof decoded !== 'string') return;
      let text = decoded;
      if (text.length > this.#limits.maxLogLineChars) text = `${text.slice(0, this.#limits.maxLogLineChars)}... [truncated]`;
      const bytes = Buffer.byteLength(text, 'utf8') + 1;
      if (this.#logBytes + bytes > this.#limits.maxLogBytes) {
        this.#logCapped = true;
        writeMessage({ type: 'log', level: 'warn', text: `[console output truncated: the limit of ${this.#limits.maxLogBytes} bytes was reached]` });
        return;
      }
      this.#logBytes += bytes;
      writeMessage({ type: 'log', level, text });
    });
  }

  #doneNative(): QuickJSHandle {
    const ctx = this.#ctx;
    return ctx.newFunction('done', (textHandle) => {
      const text = ctx.getString(textHandle);
      if (text.startsWith('R')) {
        const value = text.slice(1);
        if (value.length > this.#limits.maxResultChars) {
          return this.#finish({ ok: false, kind: 'error', error: { name: 'ResultTooLarge', message: `the return value is larger than ${this.#limits.maxResultChars} characters of JSON; return less data` } });
        }
        return this.#finish({ ok: true, value });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text.slice(1));
      } catch {
        raw = 'the script failed with an unreadable error';
      }
      const info = toErrorInfo(raw);
      // An explicit memory error with no refused growth behind it (e.g. one allocation over the QuickJS limit).
      if (info.name === 'InternalError' && isOutOfMemory(info)) return this.#finish({ ok: false, kind: 'oom', error: info });
      this.#finish({ ok: false, kind: 'error', error: info });
    });
  }

  #drain(): void {
    if (this.#done) return;
    const jobs = this.#rt.executePendingJobs();
    if (jobs.error) return this.#fail(jobs.error);
    jobs.dispose();
    if (!this.#done && this.#pending.size === 0 && !this.#rt.hasPendingJob()) {
      this.#finish({
        ok: false,
        kind: 'error',
        error: { name: 'Deadlock', message: 'the script is waiting for a promise that nothing can settle (there are no timers and no pending binding calls)' },
      });
    }
  }

  /** The VM threw past the shim: an interrupt (deadline), out of memory, a syntax error or a shim failure. */
  #fail(errorHandle: QuickJSHandle): void {
    let raw: unknown;
    try {
      raw = this.#ctx.dump(errorHandle);
    } catch {
      raw = 'out of memory';
    }
    try {
      errorHandle.dispose();
    } catch {
      // The process exits after the run; a leaked handle does not matter then.
    }
    const info = toErrorInfo(raw);
    if (Date.now() > this.#deadline || info.message === 'interrupted') {
      return this.#finish({ ok: false, kind: 'timeout', error: { name: 'Timeout', message: 'the script did not finish within its time limit' } });
    }
    this.#finish({ ok: false, kind: isOutOfMemory(info) ? 'oom' : 'error', error: info });
  }

  /** A host-side exception (e.g. a WASM trap when an allocation inside the bindings layer fails). */
  #hostFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // Deep recursion that outruns the Node stack before QuickJS's own check: the run ends, as a script error.
    if (err instanceof RangeError && /call stack/i.test(message)) {
      return this.#finish({ ok: false, kind: 'error', error: { name: 'RangeError', message: 'Maximum call stack size exceeded' } });
    }
    const oom = /out of memory/i.test(message);
    this.#finish({ ok: false, kind: oom ? 'oom' : 'error', error: { name: oom ? 'InternalError' : 'SandboxError', message: oom ? 'out of memory' : message.slice(0, MAX_ERROR_CHARS) } });
  }

  /**
   * Sends the outcome and exits. The runtime is not disposed: the process
   * ends here, and disposing a runtime with live objects aborts the WASM
   * module instead of returning.
   */
  #finish(outcome: DoneOutcome): void {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.#timer);
    exitWith(outcome);
  }
}

// ---------------------------------------------------------------------------
// Main: read stdin lines, start on the first `start`, route replies.
// ---------------------------------------------------------------------------

let run: VmRun | undefined;
let started = false;
const early: Extract<IncomingMessage, { type: 'reply' }>[] = [];
let buffered = '';

function onMessage(message: IncomingMessage): void {
  if (message.type === 'start') {
    if (started) fatal('received a second start message');
    started = true;
    const pages = memoryPages(message.limits.memoryBytes);
    if (pages < INITIAL_PAGES) {
      return exitWith({ ok: false, kind: 'oom', error: { name: 'InternalError', message: `memoryBytes ${message.limits.memoryBytes} is below the ${INITIAL_PAGES * WASM_PAGE_BYTES} bytes the QuickJS build needs` } });
    }
    const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: pages });
    exitOnRefusedGrowth(memory);
    newQuickJSWASMModuleFromVariant(newVariant(syncVariant(variantModule), { wasmMemory: memory })).then(
      (qjs) => {
        run = new VmRun(qjs, message);
        run.begin(message.code);
        for (const reply of early.splice(0)) run.reply(reply);
      },
      (err: unknown) => fatal(`could not load QuickJS: ${err instanceof Error ? err.message : String(err)}`),
    );
    return;
  }
  if (run) run.reply(message);
  else early.push(message);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffered += chunk;
  let nl = buffered.indexOf('\n');
  while (nl !== -1) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line.trim() !== '') {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        fatal('received a message that is not JSON');
      }
      const parsed = ParentMessageSchema.safeParse(raw);
      if (!parsed.success) fatal('received an invalid message');
      onMessage(parsed.data);
    }
    nl = buffered.indexOf('\n');
  }
});
// The parent went away: nothing can reply any more.
process.stdin.on('end', () => process.exit(0));
