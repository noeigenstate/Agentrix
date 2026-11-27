import type { AgentProvider } from '../../../src/shared/agent-events';

type Capability = true | { readonly via: 'api' | 'hook' | 'screen' | 'arg'; readonly verified?: readonly [string, string] } | { readonly unsupported: string };
type Manifest = Readonly<{
  id: AgentProvider;
  label: string;
  shortLabel: string;
  brand?: 'anthropic' | 'openai' | 'antigravity';
  command: string;
  usage?: Readonly<{ label?: string; showUnavailable?: boolean; apiSpend?: boolean; resetCredits?: boolean; provider?: string;
    inputExcludesCache?: boolean; quotaUnavailable?: string; hideWithoutUsage?: boolean;
    quotaGroup?: (model: string) => string; quotaGroups?: Readonly<Record<string, string>> }>;
  install: Readonly<{
    npm?: string; page: string; versionPattern: RegExp; minVersion: string; label: string; diagnostics?: 'split-install' | 'drive-scan';
    commands?: Readonly<{ windows: string; unix: string }>;
  }>;
  models: Readonly<{
    match: RegExp;
    efforts: readonly string[];
    ultracodeLead?: boolean;
    prefix: string;
    fallback: string | null;
    preferred: RegExp | null;
    fastDefault: boolean;
    fastNotes?: Readonly<{ billing: string; retry?: string }>;
    defaultRoles?: readonly string[];
    catalogBackground?: boolean;
    remoteCatalog?: boolean;
    fileEfforts: readonly string[];
    catalogAge: Readonly<{ startup: number | null; dialog: number; manual: number }>;
    aliases: readonly string[];
  }>;
  words: Readonly<{ utilities: readonly string[]; harmless?: readonly string[]; print?: readonly string[]; welcome?: readonly string[] }>;
  supports: Readonly<Partial<Record<string, Capability>>>;
}>;
type Adapter = Readonly<{ manifest: Manifest }>;

export function adapters(): readonly Adapter[];
export function agentIds(): AgentProvider[];
export function adapterOf(id: string): Adapter | undefined;
export function adapterLabeled(label: string): Adapter | undefined;
export function adapterOfModel(model: string): Adapter;
export function agentOfModel(model: string): AgentProvider;
export function localModel(model: string): string;
export function modelKey(model: string, manifest: Manifest): string;
export function canonicalModelId(model: string): string;
