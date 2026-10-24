export type SyncAction = (arg1?: string) => Promise<number>;

export const actions = new Map<string, SyncAction>();

export function registerSyncAction(name: string, action: SyncAction): void {
  actions.set(name, action);
}

export async function runSyncAction(action: string, arg1?: string): Promise<number> {
  const handler = actions.get(action);
  // Runner.php has no final else: unknown actions log then succeed silently.
  return handler ? handler(arg1) : 0;
}
