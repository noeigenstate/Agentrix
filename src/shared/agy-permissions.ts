import { AGY_PERMISSIONS } from '../../electron/agy-permissions.mjs';

export { AGY_PERMISSIONS };
export type AgyPermissions = typeof AGY_PERMISSIONS[number];
export const isAgyPermissions = (value: unknown): value is AgyPermissions => (AGY_PERMISSIONS as readonly unknown[]).includes(value);
