import type { AgentProvider } from './agent-events';
import { adapterLabeled, adapterOf } from '../../electron/features/cli-adapters/registry.mjs';

export const agentShortLabel = (agent: AgentProvider) => adapterOf(agent)?.manifest.shortLabel ?? agent;
export const agentIdForLabel = (label: string) => adapterLabeled(label)?.manifest.id;
