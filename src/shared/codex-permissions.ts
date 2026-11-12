// The three permissions a native Codex session can run with, in the order they are offered; electron/codex-permissions.cjs holds the same names
// for the main process (tests/codex-permissions.test.cjs keeps them equal).
export const CODEX_PERMISSIONS = ['full', 'config', 'ask'] as const;
export type CodexPermissions = typeof CODEX_PERMISSIONS[number];
export const isCodexPermissions = (value: unknown): value is CodexPermissions => (CODEX_PERMISSIONS as readonly unknown[]).includes(value);
