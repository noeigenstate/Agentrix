declare module '*electron/features/skills/role-rules.mjs' {
  type TeamRole = import('../../shared/types').TeamRole;
  type RoleConfig = import('../../shared/types').RoleConfig;
  type RoleRuleCode = import('../../shared/types').RoleRuleCode;
  type TextField = 'name' | 'duty' | 'outputs';
  export const MAX_CUSTOM_ROLES: number;
  export const MAX_ENABLED_ROLES: number;
  export const ROLE_TEXT_LIMITS: Readonly<Record<TextField, readonly [number, number]>>;
  export function nextRoleId(from: string, taken: Iterable<string>): string;
  export function roleLocks(kind: TeamRole['kind'], source: TeamRole['source']): TeamRole['locked'];
  export function normalizeRoleText(field: TextField, value: unknown): string | null;
  export function validateCustomRole(id: string, config: RoleConfig, sources: readonly string[]): { code: RoleRuleCode; role: string; field?: TextField } | null;
  export function checkTeamRules(roles: readonly TeamRole[], reservedNames?: readonly string[]): { code: RoleRuleCode; role?: string; field?: TextField } | null;
  export function authorIdentityConflict<T extends { model: string; rank: number; available: boolean }>(
    reviewer: string, authors: Readonly<Record<string, string>>, catalog: readonly T[], identity: (id: string) => string,
  ): { hit: string[]; alternatives: T[] } | null;
}
