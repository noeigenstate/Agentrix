const { randomUUID } = require('node:crypto');

const line = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const reject = reason => ({ status: 'rejected', reason });

function validFrame(frame) {
  return ['question', 'plan', 'permission'].includes(frame?.kind)
    && line(frame.title, 512) && line(frame.identity, 8192) && Array.isArray(frame.options)
    && frame.options.length >= 2 && frame.options.length <= 20
    && frame.options.every((option, index) => option?.number === index + 1 && line(option.label, 512))
    && typeof frame.navigable === 'boolean'
    && (frame.selected === null ? !frame.navigable : Number.isInteger(frame.selected) && frame.selected >= 1 && frame.selected <= frame.options.length);
}

function available(frame) {
  if (frame.kind === 'question') return frame.options.filter(option => option.role === 'answer');
  // The captured ExitPlanMode menu's affirmative choice leaves plan mode. Only its rejection is safe.
  if (frame.kind === 'plan' && frame.title !== 'Exit plan mode?') return [];
  const deny = frame.options.filter(option => /^(?:No|No, deny|Deny)$/.test(option.label));
  return deny.length === 1 ? deny : [];
}

const RETRY_MS = 1000;

function createWorkerMenu({ waiting, write, refused, now, retryAfter }) {
  let current, ownerTouched = false;
  function send(menu, target) {
    const offset = target.number - menu.frame.selected;
    const keys = (offset < 0 ? '\x1b[A' : '\x1b[B').repeat(Math.abs(offset)) + '\r';
    menu.answeredAt = now();
    retryAfter(RETRY_MS);
    try { write(keys); } catch { return reject('delivery_unknown'); }
    waiting(null);
    return { status: 'delivered' };
  }
  return {
    get active() { return !!current; },
    get answered() { return current?.answeredAt !== undefined && now() - current.answeredAt < RETRY_MS; },
    ownerInput() { ownerTouched = true; },
    clear() {
      if (current) waiting(null);
      current = undefined;
      ownerTouched = false;
    },
    frame(frame, seq, action) {
      if (!validFrame(frame)) {
        if (current && current.answeredAt === undefined) waiting(null);
        if (current?.answeredAt !== undefined) ownerTouched = false;
        current = undefined;
        return;
      }
      const same = current?.frame.identity === frame.identity && current.frame.kind === frame.kind;
      const retry = same && current.answeredAt !== undefined && now() - current.answeredAt >= RETRY_MS && !current.retried;
      const menu = retry || !same ? { id: randomUUID(), retried: retry } : current;
      if (retry) ownerTouched = false;
      Object.assign(menu, { frame, seq, options: available(frame) });
      const changed = current !== menu;
      current = menu;
      if (menu.answeredAt !== undefined) return;
      if (changed || menu.navigable !== frame.navigable) waiting({ id: menu.id, kind: frame.kind, title: frame.title, answerable: frame.kind !== 'permission'
          && frame.navigable && menu.options.length > 0,
        options: (frame.kind === 'permission' ? frame.options : menu.options).map(({ number, label }) => ({ number, label })) });
      menu.navigable = frame.navigable;
      if (!menu.retried && frame.kind === 'permission' && frame.navigable && !ownerTouched && menu.options.length === 1 && send(menu, menu.options[0]).status === 'delivered') {
        refused({ reason: 'needs approval', action });
      }
    },
    answer({ wait, choice }, seq) {
      if (!current) return reject('not_waiting');
      if (current.id !== wait || current.seq !== seq || current.answeredAt !== undefined) return reject('stale_wait');
      if (current.frame.kind === 'permission') return reject('permission_prompt');
      if (ownerTouched) return reject('owner_has_input');
      if (!current.frame.navigable) return reject('unsupported_menu');
      const matches = current.options.filter(option => choice === option.number || choice === option.label);
      if (matches.length !== 1) return reject('invalid_choice');
      return send(current, matches[0]);
    },
  };
}

module.exports = { createWorkerMenu };
