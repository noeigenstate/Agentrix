import {
  BookOpen, Browser, ClipboardText, Code, Cpu, Database, Desktop, FileText, Flask, Gauge, GitBranch, HardDrives,
  Infinity as InfinityIcon, MagnifyingGlass, PencilSimple, Person, ShieldCheck, Stack, User,
} from '@phosphor-icons/react';

// Each built-in and library role's mark, shared by the routing dialog's role cards and the Agent tab's role groups; a custom role takes the person.
const ROLE_ICONS = { orchestrator: GitBranch, product: ClipboardText, architect: Stack, designer: PencilSimple, developer: Code,
  reviewer: MagnifyingGlass, qa: Flask, researcher: BookOpen, devops: InfinityIcon, security: ShieldCheck,
  frontend: Browser, backend: HardDrives, desktop: Desktop, database: Database, ai: Cpu, docs: FileText, performance: Gauge, a11y: Person };

export const roleIconOf = (id: string) => ROLE_ICONS[id as keyof typeof ROLE_ICONS] ?? User;
