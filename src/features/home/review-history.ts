// Grading a project's work like homework: the assignment and what you sent back since you last passed it. The next
// time it hands in, the review keeps the assignment's name (not your notes, its latest message), shows which submission
// this is and your last notes, so you can see whether they were addressed. Passing it starts over. Kept in this
// window's storage, by project.
import type { DeliveryGrade } from '../../shared/types';

type History = { task?: string; notes: { at: number; text: string }[] };
const key = (projectId: string) => `agentrix.review.${projectId}`;
function read(projectId: string): History {
  try { const value = JSON.parse(localStorage.getItem(key(projectId)) || 'null') as History | null; return value && Array.isArray(value.notes) ? value : { notes: [] }; } catch { return { notes: [] }; }
}
function write(projectId: string, history: History) {
  try { if (history.notes.length) localStorage.setItem(key(projectId), JSON.stringify(history)); else localStorage.removeItem(key(projectId)); } catch { /* a convenience */ }
}

// Which submission this is (1 for the first), and the notes sent back before it, oldest first.
export function reviewHistory(projectId: string) {
  const { task, notes } = read(projectId);
  return { submission: notes.length + 1, notes, task: notes.length ? task : undefined };
}
export function sentBack(projectId: string, task: string | undefined, text: string) {
  const history = read(projectId);
  write(projectId, { task: history.task || task, notes: [...history.notes, { at: Date.now(), text }].slice(-20) });
}
export function passed(projectId: string) { write(projectId, { notes: [] }); }

// Your call also goes to the dashboard's records (the main process adds the model from the terminal's session). It is
// a record, not part of the review: it is never awaited, and a failure of any kind changes nothing.
export function reportGrade(grade: DeliveryGrade) {
  try { void Promise.resolve(window.agentrix.gradeDelivery(grade)).catch(() => undefined); } catch { /* a record only */ }
}

// Deliveries accepted today, kept in this window's storage for the home page's line about the day.
const ACCEPTED_KEY = 'agentrix.decisions.accepted';
function acceptedDates() {
  const today = new Date().toDateString();
  return (JSON.parse(localStorage.getItem(ACCEPTED_KEY) || '[]') as number[]).filter(at => new Date(at).toDateString() === today);
}
export function recordAccepted() {
  try { localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...acceptedDates(), Date.now()])); } catch { /* the count is a convenience */ }
}
export function acceptedToday() {
  try { return acceptedDates().length; } catch { return 0; }
}
