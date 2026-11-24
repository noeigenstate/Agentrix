declare module '*/cli-adapters/capabilities.mjs' {
  type Result = { ok: true; via?: 'api' | 'hook' | 'screen' | 'arg'; reason?: never }
    | { ok: false; via?: never; reason: string; params?: { cli: string } };
  export const UNVERIFIED_VERSION: string;
  export function support(manifest: { readonly label: string; readonly supports: Readonly<Record<string, unknown>> },
    key: string, version?: string | null): Result;
}
