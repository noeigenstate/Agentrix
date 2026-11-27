declare module '*/cli-adapters/capabilities.mjs' {
  type Result = { ok: true; via?: 'api' | 'hook' | 'screen' | 'arg'; reason?: never }
    | { ok: false; via?: never; reason: string; params?: { cli: string } };
  export const UNVERIFIED_VERSION: string;
  type Manifest = { readonly label: string; readonly supports: Readonly<Record<string, unknown>> };
  export function canLead(manifest?: Manifest): boolean;
  export function belowMinimum(version: string | null | undefined, minimum: string): boolean;
  export function support(manifest: Manifest,
    key: string, version?: string | null): Result;
}
