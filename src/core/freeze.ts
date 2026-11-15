/**
 * Recursively freezes objects and arrays in place and returns the value.
 * It descends into objects that are already frozen too: a shallow
 * `Object.freeze` on the outside says nothing about what is inside.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze<unknown>(descriptor.value, seen);
  }
  return value;
}

/**
 * A deep-frozen structured clone of `value`, owned by the caller: whoever
 * produced `value` keeps no reference into the copy. Throws on values that
 * cannot be cloned (functions, symbols).
 */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
