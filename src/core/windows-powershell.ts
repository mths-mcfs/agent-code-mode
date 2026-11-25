import path from 'node:path';

/**
 * The system Windows PowerShell by absolute path, run in System32, with the
 * environment minus every PowerShell variable (`PS*`, `__PS*`: module paths
 * and analysis cache, execution policy) and the module path pinned to the
 * system modules, so no workspace file, module or policy variable steers it.
 * Throws when `SystemRoot` is not a drive-qualified absolute path.
 */
export function systemPowerShell(env: Readonly<Record<string, string | undefined>>): { file: string; cwd: string; env: Record<string, string> } {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'systemroot');
  const systemRoot = key === undefined ? undefined : env[key];
  if (systemRoot === undefined || !/^[A-Za-z]:\\/.test(systemRoot)) throw new Error('SystemRoot is missing or not a drive-qualified absolute path');
  const system32 = path.win32.join(systemRoot, 'System32');
  const home = path.win32.join(system32, 'WindowsPowerShell', 'v1.0');
  return {
    file: path.win32.join(home, 'powershell.exe'),
    cwd: system32,
    env: {
      ...Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined || /^(__)?PS/i.test(name) || name.toLowerCase() === 'systemroot' ? [] : [[name, value]]))),
      SystemRoot: systemRoot,
      PSModulePath: path.win32.join(home, 'Modules'),
    },
  };
}
