import type { ThemeId } from './themes';
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type AgentCommand = { name: string; description: string; source: 'builtin' | 'project' | 'user' | 'skill'; view: 'terminal' | 'reading' };
// messages is exact within 256 KiB, estimated from record density for larger transcripts.
export type AgentSession = { id: string; updatedAt: number; title: string; messages: number };
export type ProjectImageMode = 'auto' | 'custom' | 'number';
export type ProjectImageCandidate = { path: string; source: 'icon' | 'readme' | 'asset'; image: string };
export type ProjectImageCandidates = { candidates: ProjectImageCandidate[]; unavailable?: 'ssh' };
export type ProjectLocation = { kind: 'external' } | { kind: 'file' | 'directory'; path: string };
export type Project = {
  id: string; name: string; path: string; branch: string; unread: number; image?: string; imageMode?: ProjectImageMode;
  kind: 'local' | 'ssh'; ssh: { host: string; configFile: string | null } | null;
  lastCompletedAt: number | null;
  sessionId: string | null; status: 'stopped' | 'starting' | 'shell' | 'codex' | 'exited';
  action: AgentActionBrief | null;
  codexActive: boolean; agent: 'codex' | 'claude' | null; codexActivity: 'unknown' | 'working' | 'complete' | 'interrupted'; shellReady: boolean; codexAvailable: boolean | null; error: string | null;
  terminals: ProjectTerminal[];
};
// A document, page or video an agent wrote, as its card in the reading view shows it.
export type FileCard = { kind: 'markdown'; path: string; excerpt: string; outside?: boolean } | { kind: 'html'; path: string; picture: string | null } | { kind: 'video'; path: string; url: string } | { kind: 'image'; path: string; picture: string; remote?: boolean };
// The model, effort and fast mode an agent's records show (electron/features/agents/agent-settings.cjs); null: not shown yet.
export type AgentSettings = { model: string | null; effort: string | null; fast: boolean | null };
// What an agent spends, as its records show (electron/features/agents/agent-usage.cjs): the service its model is reached
// through, the context it fills, the tokens of this round and of the conversation, and the plan's limits (Codex only).
// input counts the cached part, output the reasoning; null: not known (yet).
export type AgentTokens = { input: number; cached: number; output: number };
// limitsAt: the latest account snapshot; resets: actual reset counts from Codex's official read,
// null when unknown. resetQuery describes the bounded, automatically retried Codex background read.
export type AgentCall = { agent: 'Claude Code' | 'Codex'; provider: string | null; model: string; effort: string | null; fast: boolean | null; preparing: number; running: number; reviewing: number; tasks: string[]; items: { state: 'preparing' | 'running' | 'reviewing'; role: string; title: string }[] };
export type AgentUsage = { provider: string | null; context: { used: number; window: number } | null; round: AgentTokens | null; total: AgentTokens | null; limits: { minutes: number | null; percent: number; resetsAt: number | null }[]; limitsAt?: number | null; limitsFrom?: string | null; resets?: { left: number | null; total: number | null } | null; resetQuery?: { state: 'loading' | 'ready' | 'unavailable' | 'error'; reason?: string; at?: number }; calls?: AgentCall[] };
export type ProjectTerminal = { agentStarting?: boolean; nativeMode?: 'codex-native' | 'claude-sdk' | null; nativeApprovals?: NativeApproval[]; nativeMessages?: { role: string; text: string }[]; nativeReady?: boolean; agentStartedAt?: number | null; agentSettings?: AgentSettings | null; agentUsage?: AgentUsage | null; agentCommand?: string | null; action: AgentActionBrief | null; task: string; taskTitle?: string; prompts: PendingPrompt[]; id: string; title: string; shell: 'powershell' | 'cmd' | 'bash' | 'zsh'; sessionId: string | null; status: Project['status']; codexActive: boolean; agent: Project['agent']; codexActivity: Project['codexActivity']; needsInput: string | null; shellReady: boolean; codexAvailable: boolean | null; lastActivityAt: number | null; lastCompletedAt: number | null; error: string | null };
export type Settings = { startView: 'decisions' | 'workspace'; surface: 'glass' | 'solid'; glassBackground: 'theme' | 'desktop'; glassTransparency: number | null; terminalRenderer: 'gpu' | 'dom'; autoSave: boolean; activityPane: boolean; notifications: boolean; sound: boolean; closeToTray: boolean; explorerCollapsed: boolean; hideTreeNoise: boolean; fontSize: number; terminalFontWeight: 400 | 500 | 600; terminalFontFamily: string; terminalCjkFontFamily: string; userAvatar: string; restoreSessions: boolean; focusAnimation: 'smooth' | 'system' | 'off'; language: 'zh' | 'en'; theme: ThemeId; shortcuts: Partial<Record<'search' | 'addProject' | 'voice' | 'overview' | 'decisions' | 'explorer' | 'settings' | 'nextProject' | 'previousProject' | 'projectAbove' | 'projectBelow' | 'maximize' | 'fullscreen' | 'newTerminal' | 'removeProject', string>>; guideVersion: string; shell: 'powershell' | 'cmd' | 'bash' | 'zsh'; voiceModel: string };
export type RecentProject = { path: string; name: string; lastOpenedAt: number; exists: boolean };
export type RecentSSH = { host: string; path: string; name: string; lastOpenedAt: number };
export type SSHInfo = { hosts: string[]; configFile: string; configExists: boolean; sshPath: string; source: string };
export type SSHAuthPrompt = { id: string; host: string; message: string; kind: 'secret' | 'confirm' };
export type Workspace = { desktopGlass?: { supported: boolean; compatibility: boolean; active: boolean; restart: boolean; failed: boolean }; projects: Project[]; settings: Settings; warning: string | null; platform: string; version: string; guide: boolean; autoHideTitlebar: boolean;
  // Linux: the shell new local terminals use and whether zsh is installed.
  localShell: { kind: 'bash' | 'zsh'; zsh: boolean } | null };
// A backend observation epoch; no native Claude Code/Codex approval request ID is exposed by terminal mode.
export type ApprovalStamp = { sessionId: string; revision: number };
export type NativeApproval = { provider: 'codex' | 'claude'; projectId: string; terminalId: string; sessionId: string; token: string; requestId: string | number; method: string; params: Record<string, unknown>; decisions: string[]; at: number };
export type ApprovalResult = { mode: 'terminal-only'; reason: 'native-request-identity-unavailable' };
type TerminalSnapshot = { sessionId: string | null; seq: number; data: string; approval?: ApprovalStamp };
export type TerminalPacket = TerminalSnapshot & { id: string };
export type FileEntry = { name: string; path: string; kind: 'directory' | 'file' | 'link' };
export type FileProgress = { projectId: string; text: string } | null;
// One offline recognizer: downloaded (ready), downloading, paused (missing) or failed (error).
type VoiceModel = { id: string; label: string; downloadBytes: number; phase: 'missing' | 'downloading' | 'ready' | 'error'; percent: number; error: string | null };
// phase, percent and error describe the model in use (active), or the chosen one before any is downloaded.
export type VoiceState = { phase: 'missing' | 'downloading' | 'ready' | 'transcribing' | 'error'; ready: boolean; percent: number; error: string | null; model: string; downloadBytes: number; choice: string; active: string | null; models: VoiceModel[] };
export type DirectoryListing = { path: string; entries: FileEntry[]; total: number; nextOffset: number | null };
export type MentionFile = { path: string; kind: 'file' | 'dir' };
export type GitChange = { path: string; index: string; worktree: string; originalPath: string | null; submodule: boolean; conflict: boolean; untracked: boolean };
export type GitStatus = { repository: boolean; branch: string; head: string; detached: boolean; unborn: boolean; upstream: string | null; ahead: number | null; behind: number | null; files: GitChange[]; total: number; staged: number; unstaged: number; conflicts: number; truncated: boolean };
export type GitCommit = { hash: string; parents: string[]; author: string; date: string; refs: string; subject: string };
export type GitHistory = { commits: GitCommit[]; nextOffset: number | null };
// One step an agent took (a tool call). The card shows the brief form; a review card reads the whole list for its checks.
type AgentActionKind = 'edit' | 'command' | 'read' | 'search' | 'web' | 'skill' | 'mcp' | 'agent' | 'other';
export type AgentActionBrief = { kind: AgentActionKind; tool: string; target: string; detail: string; done: boolean; phrase?: string; object?: string; written?: string[] };
export type PendingPrompt = { id: string; text: string; summary: string; state: 'queued' | 'working'; at: number };
export type AgentAction = AgentActionBrief & { id: string; at: number; description: string; failed: boolean; server?: string; files?: { path: string; change: 'add' | 'update' | 'delete' | 'write' }[] };
// One message or tool call of an agent's conversation, for the reading view.
// queued: a message Claude Code holds in its queue until it takes it up, never shown as a message itself.
// cancelled: a retired queue receipt, hidden but still used to cancel its renderer echo.
// receivedAt: a queued message's confirmed handoff, separate from the time it was sent.
export type ConversationEntry = { id: string; at: number; receivedAt?: number; role: 'user' | 'assistant' | 'tool'; text?: string; original?: string; answer?: boolean; queued?: boolean; cancelled?: boolean; images?: string[]; generated?: { path: string; prompt: string }; tool?: AgentActionBrief & { failed: boolean } };
export type ConversationPacket = { id: string; list?: ConversationEntry[]; changes?: ConversationEntry[] };
type GitDiffLine = { type: ' ' | '+' | '-' | '\\'; text: string };
export type GitHunk = { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: GitDiffLine[]; patch: string };
export type GitDiff = { repository: boolean; binary: boolean; text: boolean; added: number; removed: number; hunks: GitHunk[]; patch: string };
export type GitCommitFiles = { files: { path: string; status: string; originalPath: string | null }[]; total: number; truncated: boolean };
type TextPage = { index: number; count: number; byteStart: number; byteEnd: number; encoding: string };
export type Distribution = 'development' | 'installed' | 'portable' | 'macos' | 'linux';
export type AppUpdateState = { supported: boolean; currentVersion: string; distribution: Distribution; status: 'unavailable' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error'; version: string | null; percent: number; error: string | null };
export type AgentsState = { codex: { installed: boolean }; claude: { installed: boolean }; npm: boolean; installing: 'codex' | 'claude' | null; message: string; error: string };
export type FilePreview = { path: string; name: string; size: number; modifiedAt: number; revision: string } & (
  { kind: 'text'; content: string; page: TextPage } | { kind: 'unsupported'; reason: string }
  | { kind: 'image' | 'video'; mimeType: string; url: string; previewId: string }
  | { kind: 'html' | 'markdown'; content: string; page: TextPage; url: string; previewId: string }
);
type Bridge = {
  getState(): Promise<Result<Workspace>>;
  getAgents(): Promise<Result<AgentsState>>;
  installAgent(agent: 'codex' | 'claude'): Promise<Result<AgentsState>>;
  openNode(): Promise<Result<void>>;
  onAgents(callback: (state: AgentsState) => void): () => void;
  getUpdateState(): Promise<Result<AppUpdateState>>;
  checkForUpdates(): Promise<Result<AppUpdateState>>;
  installUpdate(): Promise<Result<boolean>>;
  openDownloadPage(): Promise<Result<void>>;
  openProjectPage(page: 'releases' | 'docs' | 'license' | 'notices' | 'repository'): Promise<Result<void>>;
  onUpdateState(callback: (state: AppUpdateState) => void): () => void;
  addProjects(): Promise<Result<string[]>>;
  getRecentProjects(): Promise<Result<RecentProject[]>>;
  addRecentProject(folder: string): Promise<Result<string>>;
  forgetRecentProject(folder: string): Promise<Result<RecentProject[]>>;
  clearRecentProjects(): Promise<Result<RecentProject[]>>;
  getRecentSSH(): Promise<Result<RecentSSH[]>>;
  forgetRecentSSH(host: string, folder: string): Promise<Result<RecentSSH[]>>;
  clearRecentSSH(): Promise<Result<RecentSSH[]>>;
  addSSHProject(input: { host: string; path: string; name?: string }): Promise<Result<string>>;
  getSSHInfo(): Promise<Result<SSHInfo>>;
  getSSHAuth(): Promise<Result<SSHAuthPrompt[]>>;
  answerSSHAuth(id: string, answer: string | null): Promise<Result<void>>;
  onSSHAuth(callback: (prompts: SSHAuthPrompt[]) => void): () => void;
  // ask: confirm even with no terminal running (a removal by shortcut).
  removeProject(id: string, ask?: boolean): Promise<Result<boolean>>;
  reorderProjects(ids: string[]): Promise<Result<void>>;
  setProjectImage(projectId: string, image: string, mode?: ProjectImageMode): Promise<Result<void>>;
  listProjectImageCandidates(projectId: string): Promise<Result<ProjectImageCandidates>>;
  reorderTerminals(projectId: string, ids: string[]): Promise<Result<void>>;
  acknowledge(id: string): Promise<Result<void>>;
  settings(patch: Partial<Settings>): Promise<Result<void>>;
  listDirectory(id: string, relativePath?: string, offset?: number): Promise<Result<DirectoryListing>>;
  findFiles(projectId: string, query: string): Promise<Result<MentionFile[]>>;
  gitStatus(id: string): Promise<Result<GitStatus>>;
  gitHistory(id: string, offset?: number): Promise<Result<GitHistory>>;
  gitFiles(id: string, hash: string): Promise<Result<GitCommitFiles>>;
  gitDiff(id: string, path: string, options?: { staged?: boolean; untracked?: boolean }): Promise<Result<GitDiff>>;
  gitApply(id: string, patch: string, options?: { path?: string; reverse?: boolean; cached?: boolean }): Promise<Result<{ applied: boolean }>>;
  confirmGitRevert(id: string, path: string, count: number): Promise<Result<boolean>>;
  createEntry(id: string, directory: string, name: string, kind: 'file' | 'directory'): Promise<Result<{ path: string; kind: string }>>;
  renameEntry(id: string, relative: string, name: string): Promise<Result<{ path: string }>>;
  deleteEntries(id: string, paths: string[]): Promise<Result<{ deleted: string[] }>>;
  copyEntries(id: string, paths: string[]): Promise<Result<{ count: number; superseded?: boolean }>>;
  copyPaths(id: string, paths: string[], format: 'absolute' | 'relative'): Promise<Result<{ count: number; superseded?: boolean }>>;
  revealEntry(id: string, path: string): Promise<Result<void>>;
  revealPath(id: string, path: string): Promise<Result<void>>;
  pasteEntries(id: string, directory: string): Promise<Result<{ pasted: string[] }>>;
  fileTreeFocus(id: string, focused: boolean): void;
  getFileProgress(): Promise<Result<FileProgress>>;
  onFileProgress(callback: (progress: FileProgress) => void): () => void;
  cancelFileOperation(): Promise<Result<void>>;
  getVoiceState(): Promise<Result<VoiceState>>;
  prepareVoice(): Promise<Result<VoiceState>>;
  warmVoice(): Promise<Result<void>>;
  transcribe(audio: ArrayBuffer): Promise<Result<string>>;
  onVoiceState(callback: (state: VoiceState) => void): () => void;
  pasteTerminal(id: string, text: string, sessionId: string): Promise<Result<void>>;
  onTerminalPaste(callback: (packet: { id: string; sessionId: string; text: string; lineBreak: string | null }) => void): () => void;
  readFile(id: string, relativePath: string, pageIndex?: number): Promise<Result<FilePreview>>;
  saveFile(id: string, relativePath: string, pageIndex: number, revision: string, content: string): Promise<Result<FilePreview>>;
  confirmEditorClose(filename: string): Promise<Result<'save' | 'discard' | 'cancel'>>;
  editorDirty(dirty: boolean, id?: string, filename?: string): void;
  onEditorClose(callback: (id: string) => void): () => void;
  editorCloseResult(id: string, accepted: boolean): void;
  closePreview(id: string): Promise<Result<void>>;
  openLink(id: string, target: string): Promise<Result<ProjectLocation>>;
  openVideo(id: string, relativePath: string): Promise<Result<void>>;
  revealProject(id: string): Promise<Result<ProjectLocation>>;
  startTerminal(id: string): Promise<Result<void>>;
  addTerminal(id: string, start?: boolean): Promise<Result<string>>;
  closeTerminal(id: string): Promise<Result<boolean>>;
  restartTerminal(id: string): Promise<Result<boolean>>;
  attachTerminal(id: string): Promise<Result<TerminalSnapshot>>;
  terminalCommands(id: string): Promise<Result<AgentCommand[]>>;
  agentImage(file: string): Promise<Result<{ url: string; width: number; height: number }>>;
  // A copy of a generated picture to where the reader picks in a save dialog: the path written, null when dismissed.
  saveImageAs(file: string): Promise<Result<string | null>>;
  agentDocument(projectId: string, file: string): Promise<Result<{ content: string; truncated: boolean }>>;
  saveImage(terminalId: string, bytes: ArrayBuffer, type: string): Promise<Result<string>>;
  clipboardImage(terminalId: string): Promise<Result<string | null>>;
  fileCard(id: string, file: string): Promise<Result<FileCard>>;
  agentHistory(id: string): Promise<Result<{ claude: { id: string; at: number } | null; codex: { id: string; at: number } | null }>>;
  agentLaunch(id: string, agent: 'claude' | 'codex', mode: 'new' | 'continue' | 'native'): Promise<Result<boolean>>;
  answerNativeApproval(id: string, answer: { token: string; decision: string }): Promise<Result<{ mode: 'native'; requestId: string | number }>>;
  managedPrompt(id: string, sessionId: string, text: string): Promise<Result<boolean>>;
  agentSessions(id: string): Promise<Result<AgentSession[]>>;
  followAgentSession(id: string, sessionId: string): Promise<Result<boolean>>;
  writeTerminal(id: string, data: string): void;
  writeApproval(id: string, key: string, stamp: ApprovalStamp, actionId: string): Promise<Result<ApprovalResult>>;
  answerTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  copy(text: string): Promise<Result<void>>;
  readClipboard(): Promise<Result<string>>;
  terminalFocus(id: string, focused: boolean): void;
  onState(callback: (state: Workspace) => void): () => void;
  onTerminalData(callback: (packet: TerminalPacket) => void): () => void;
  onFocusProject(callback: (id: string) => void): () => void;
  notifyDecision(projectId: string, title: string, kind: string): Promise<Result<boolean>>;
  onDecisionShow(callback: () => void): () => void;
  onError(callback: (message: string) => void): () => void;
  minimize(): void; maximize(): void; toggleFullScreen(): void; isFullScreen(): Promise<Result<boolean>>; onFullScreen(callback: (fullScreen: boolean) => void): () => void; terminalActions(id: string): Promise<Result<AgentAction[]>>; terminalConversation(id: string): Promise<Result<ConversationEntry[]>>; onTerminalConversation(callback: (packet: ConversationPacket) => void): () => void; close(): void;
  quit(): Promise<Result<boolean>>;
};
declare global { interface Window { agentrix: Bridge; } }
