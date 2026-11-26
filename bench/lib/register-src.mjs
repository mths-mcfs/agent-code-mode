// `node --import` hook for the bench: src/ imports name their `.ts` siblings with a `.js` extension (the
// build's output names), so a `.js` import that does not exist under src/ resolves to its `.ts` source.
import { registerHooks } from 'node:module';

const SRC = new URL('../../src/', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const parent = context.parentURL ?? '';
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js') || !new URL(specifier, parent).href.startsWith(SRC)) throw err;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
