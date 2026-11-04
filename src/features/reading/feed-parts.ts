// The parts around a conversation feed that a view without a terminal draws the way the reading view does: the speakers' timeline steps, the
// messages not yet in the conversation, the agent at work, the latest round's result, the quoted message and the scroll that follows the newest step.
export { AgentMark, TimelineStep } from './Timeline';
export { PendingPromptEntries, UserImages } from './PendingPromptEntries';
export { ResultActions, ResultStatus, WorkingLine } from './ResultCard';
export { latestResult } from './result-round';
export { useStickToBottom } from './useStickToBottom';
export type { PendingPrompt } from './pending-prompts';
export { QuoteChip } from './ReadingQuote';
export { quoteExcerpt, withQuote, type MessageQuote } from './message-quote';
