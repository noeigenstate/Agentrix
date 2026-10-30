// What the reading view knows about the agent's own terminal screen (see terminal-screen.ts for the rows and
// agent-screen.ts for the parser). Everything is read from text the CLI drew; null means "not on screen".

export type ScreenAgent = 'codex' | 'claude';

// The CLI's welcome lines: "Claude Code v2.1.293 / Opus 5.5 with high effort · Claude Max / C:\work\demo-app",
// or ">_ OpenAI Codex (v0.161.0) / C:\work\demo-app" with the model from Codex's footer.
export type ScreenBanner = {
  product: string;            // "Claude Code" | "OpenAI Codex"
  version: string | null;     // "2.1.293", "0.161.0"
  model: string | null;       // "Opus 5.5", "GPT-6.1-Sol"
  effort: string | null;      // "high"
  plan: string | null;        // "Claude Max"
  directory: string | null;   // as printed
};

// The footer under the input box: Claude "⏺ Opus 5.5 · demo-app · ctx 4%  ● high · /effort" and
// "⏸ manual mode on · ← for agents" / "⏵⏵ bypass permissions on (shift+tab to cycle)";
// Codex "GPT-6.1-Sol high · C:\work\demo-app · 828K wi…" and "? for shortcuts   ⚠ 1 warning · f2 to view".
export type ScreenStatus = {
  model: string | null;       // "Opus 5.5" / "GPT-6.1-Sol"
  effort: string | null;      // "high"
  context: string | null;     // "ctx 4%", "828K wi…" as printed
  mode: string | null;        // "manual mode on", "bypass permissions on", "accept edits on", "plan mode on" (Claude)
  notes: string[];            // other footer text worth showing as is, e.g. "⚠ 1 warning · f2 to view"
  fast?: boolean;             // Codex prints "fast" after the effort while fast mode is on
};

// A list the CLI is asking the user to pick from: a permission prompt or a menu such as /model.
export type ScreenOption = {
  number: number;             // the option's printed number (1-based)
  label: string;              // "Yes", "Yes, proceed", "Opus 5.5 ✔"
  detail: string;             // the rest of the option text, continuation rows joined with a space
  hotkey: string | null;      // Codex "(y)", "(p)", "(a)", "(esc)" → "y", "p", "a", "esc"; null when none is printed
  selected: boolean;          // the row with the CLI's cursor (Claude "❯", Codex "›")
  // Questions only: what the option does ('answer'; 'input' types an own answer; 'chat' is Claude's "Chat about this"
  // under the rule) and, in a multi-select question, whether it is ticked ("[✔]").
  role?: 'answer' | 'input' | 'chat';
  checked?: boolean;
};
// A question the agent asked with options: Claude Code's AskUserQuestion or Codex's request_user_input (Plan mode).
export type ScreenQuestion = {
  agent: ScreenAgent;
  tabs: { label: string; answered: boolean }[]; // Claude's question tabs in order ("☐ 回收站", "☒ 清理目录"); [] for one
  position: { index: number; count: number } | null; // Codex "Question 1/2"
  multi: boolean;                       // several options can be ticked, then submitted with Claude's Submit row
  submit: { selected: boolean } | null; // Claude's "Submit" row under multi-select options
  notes: { open: boolean; text: string } | null; // Codex's notes on the highlighted option (Tab); null for Claude
  review: { question: string; answer: string }[] | null; // Claude's last page: "Review your answers"
};
export type ScreenChoice = {
  // Added by terminal-screen, never inferred by the text parser. instance is a local observed incarnation;
  // stamp is the backend raw-output epoch. Neither is a native CLI request ID.
  approval?: { instance: number; stamp: import('../../shared/types').ApprovalStamp | null };
  kind: 'permission' | 'menu' | 'question';
  title: string;              // "Do you want to create hello.txt?", "Would you like to run the following command?",
                              // "Select model", "Select Model and Effort"
  context: string[];          // rows between the title area and the options worth showing (command, reason, file name)
  options: ScreenOption[];
  hint: string | null;        // "Esc to cancel · Tab to amend", "Press enter to confirm or esc to cancel", "enter select · esc back"
  question?: ScreenQuestion;  // kind 'question': the title is the question itself
  // What Esc does when it does not cancel: Codex's resume list started by "codex resume" starts a new conversation
  // ('new'); the one /resume opens goes back to the conversation ('back').
  escape?: 'new' | 'back' | null;
};

export type AgentScreen = {
  banner: ScreenBanner | null;
  status: ScreenStatus;
  choice: ScreenChoice | null;
  // The CLI's own popups over its input; the reading view has its own for "/" and "@", so these only tell it to
  // stay out of the way: 'slash' (command list), 'mention' (@ list), 'shortcuts' ("?" help), or none.
  overlay: 'none' | 'slash' | 'mention' | 'shortcuts';
  // The CLI is waiting for the user's choice on a screen the parser could not turn into a card (a dialog a CLI update
  // added, or one clipped by the window): the reading view shows a generic card that opens the terminal instead.
  // title is the dialog's own heading when one was read. Absent or null when nothing waits or choice holds the card.
  waiting?: { title: string | null } | null;
};
