// Artisan::call() seam: the old /exec.run and /exec.refreshAmz routes execute
// whatever artisan command the admin types into the form. The old app's
// commands (Runner "sync", Mover, ...) are ported in Phase 5 (J1-J6), which
// registers their actions here. Unknown commands 500 the same way Laravel
// does: InvalidArgumentException('Command "x" is not defined.').

import { runSyncAction } from './actions.js';

type ArtisanCommand = (params: Record<string, string>) => Promise<number>;

const commands: Record<string, ArtisanCommand> = {
  sync: async ({ action, arg1 }) => runSyncAction(action, arg1),
};

export function registerArtisanCommand(name: string, fn: ArtisanCommand): void {
  commands[name] = fn;
}

export async function artisanCall(command: unknown, params: Record<string, string>): Promise<number> {
  const name = typeof command === 'string' ? command : '';
  const fn = commands[name];
  if (!fn) throw new Error(`Command "${name}" is not defined.`);
  return fn(params);
}
