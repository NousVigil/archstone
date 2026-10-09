// Types for script-database.mjs, so the TypeScript test support can import it under `strict`.

export interface ScriptDatabase {
  /** The runtime role's DSN, for the `${ENV_VAR}` a binding names. */
  dsn: string;
  /** The script's own (un-renamed) name for the role the DSN connects as. */
  runtimeRole: string;
  /** Run SQL as the admin, inside the script's database. */
  admin(sql: string): Promise<void>;
  teardown(): Promise<void>;
}

export function rolesCreatedBy(sql: string): string[];
export function renameRoles(sql: string, rename: (role: string) => string): string;
export function createScriptDatabase(opts: {
  pg: unknown;
  adminUrl: string | undefined;
  sql: string;
  runtimeRole?: string;
}): Promise<ScriptDatabase>;
