import type { AgentProvider } from '../../../src/shared/agent-events';

type Capability = true | { readonly via: 'api' | 'hook' | 'screen' | 'arg'; readonly verified?: readonly [string, string] } | { readonly unsupported: string };
type Manifest = Readonly<{
  id: AgentProvider;
  label: string;
  command: string;
  install: Readonly<{ npm: string; versionPattern: RegExp; minVersion: string; label: string }>;
  models: Readonly<{ match: RegExp; efforts: readonly string[]; ultracodeLead?: boolean }>;
  words: Readonly<{ utilities: readonly string[]; harmless: readonly string[]; print?: readonly string[] }>;
  supports: Readonly<Partial<Record<string, Capability>>>;
}>;
type Adapter = Readonly<{ manifest: Manifest }>;

export function adapters(): readonly Adapter[];
export function adapterOf(id: string): Adapter | undefined;
export function adapterOfModel(model: string): Adapter;
export function agentOfModel(model: string): AgentProvider;
