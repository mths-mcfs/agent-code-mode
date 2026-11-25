/** Rooted file operations refuse on Windows (`src/tools/rooted.ts`) until a Windows backend lands (#28). */
export const ROOTED_OPS_REFUSED = process.platform === 'win32';
