const { createHash, randomUUID } = require('node:crypto');
const { turnItems } = require('./events.cjs');
const { readActualModel, transcriptOffset } = require('./models.cjs');
const { errorWithCode } = require('./session.cjs');

const MAX_QUEUE = 32;
const MAX_RECEIPTS = 256;
const TURN_TIMEOUT = 30 * 60 * 1000;
const STOP_STATUS = new Map([['end_turn', 'completed'], ['cancelled', 'interrupted']]);
const errorCode = error => typeof error.code === 'string' ? error.code : error.message;

function promptContent(text, images) {
  const content = text ? [{ type: 'text', text }] : [];
  for (const value of images || []) {
    const image = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!image) throw errorWithCode('invalid_image');
    content.push({ type: 'image', mimeType: image[1], data: image[2] });
  }
  if (!content.length) throw errorWithCode('empty_input');
  return content;
}

class TurnQueue {
  queue = [];
  receipts = new Map();
  active = null;
  stopped = false;

  constructor({ events, now, owner, setState, onModel, onDisconnect, beforeTurn }) {
    Object.assign(this, { events, now, owner, setState, onModel, onDisconnect, beforeTurn });
  }

  bind({ rpc, requests, profile, sessionId, turnTimeoutMs = TURN_TIMEOUT }) {
    Object.assign(this, { rpc, requests, profile, sessionId, turnTimeoutMs });
  }

  awaitingApproval() {
    const turn = this.active;
    return !!turn && !turn.cancelling && !turn.settling;
  }

  update(update) {
    if (!this.active?.settling) this.active?.items.update(update);
  }

  receipt(entry, status) {
    entry.status = status;
    if (['consumed', 'rejected', 'unknown'].includes(status)) {
      delete entry.content;
      delete entry.text;
    }
    this.events.publish('input.receipt', { clientMessageId: entry.id, status });
    return { clientMessageId: entry.id, status };
  }

  settle(turn, outcome, delivery, result) {
    if (!turn || this.active !== turn || turn.settling) return;
    turn.settling = true;
    this.requests.clear();
    this.receipt(turn.entry, delivery);
    turn.items.finish(outcome.status);
    const tokens = this.events.tokens(result?.usage);
    this.events.publish('turn.completed', { ...outcome, durationMs: Math.max(0, this.now() - turn.startedAt), tokens });
    this.active = null;
  }

  complete(turn, result) {
    const terminalReason = result?.stopReason ?? 'missing_stop_reason', status = STOP_STATUS.get(terminalReason) || 'failed';
    this.settle(turn, { status, terminalReason, error: status === 'failed' ? terminalReason : null }, 'consumed', result);
  }

  async run(turn) {
    const { entry } = turn;
    try {
      const offset = await transcriptOffset(this.profile, this.sessionId);
      if (this.active !== turn || turn.cancelling) return;
      turn.submitted = true;
      turn.result = await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: entry.content }, this.turnTimeoutMs, {
        timeoutFromWrite: true, onWritten: () => {
          turn.written = true;
          this.receipt(entry, 'delivered');
        },
      });
      const actual = await readActualModel(this.profile, this.sessionId, offset);
      if (this.active !== turn) return;
      this.onModel(actual);
      this.complete(turn, turn.result);
    } catch (error) {
      if (this.active !== turn) return;
      const code = errorCode(error);
      if (error.uncertain) this.onDisconnect(code);
      else this.settle(turn, { status: 'failed', terminalReason: code, error: code }, 'rejected');
    } finally {
      if (!this.active && !this.stopped) this.pump();
    }
  }

  pump() {
    if (this.active || this.stopped || this.beforeTurn()) return;
    const entry = this.queue.shift();
    if (!entry) { this.setState('idle'); return; }
    const turnId = randomUUID();
    const turn = { entry, items: turnItems(this.events, turnId), startedAt: this.now() };
    this.active = turn;
    this.events.turn(turnId);
    if (this.owner) this.events.beginRound();
    this.onModel(null);
    this.events.publish('turn.started', { origin: 'user', clientMessageId: entry.id });
    if (this.active !== turn) return;
    this.setState('running');
    if (this.active !== turn) return;
    this.events.publish('item.upsert', { kind: 'user-message', status: 'completed', content: { text: entry.text, clientMessageId: entry.id } },
      { itemId: `${turnId}:input` });
    void this.run(turn);
  }

  async send(input, available) {
    const id = input?.clientMessageId, text = input?.text ?? '';
    if (typeof id !== 'string' || !id || typeof text !== 'string') throw errorWithCode('invalid_input');
    const content = promptContent(text, input.images);
    const previous = this.receipts.get(id), key = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    if (previous) {
      if (previous.key !== key) throw errorWithCode('input_id_conflict');
      return { clientMessageId: id, status: previous.status };
    }
    if (!available || this.stopped || this.queue.length >= MAX_QUEUE) return { clientMessageId: id, status: 'rejected' };
    const entry = { id, content, text, key };
    this.receipts.set(id, entry);
    if (this.receipts.size > MAX_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value);
    this.queue.push(entry);
    const accepted = this.receipt(entry, 'queued');
    this.pump();
    return accepted;
  }

  async interrupt() {
    const turn = this.active;
    if (this.stopped || !this.awaitingApproval()) return;
    turn.cancelling = true;
    if (turn.submitted) {
      // A backpressured prompt may still be waiting to write. Cancel follows it on the wire.
      try { this.rpc.notify('session/cancel', { sessionId: this.sessionId }); }
      finally { this.requests.clear(); }
    } else {
      this.settle(turn, { status: 'interrupted', terminalReason: 'cancelled', error: null }, 'rejected');
      this.pump();
    }
  }

  end(status, terminalReason) {
    if (this.stopped) return;
    this.stopped = true;
    const turn = this.active;
    if (status === 'interrupted' && turn?.written && !turn.cancelling && !turn.result) {
      try { this.rpc.notify('session/cancel', { sessionId: this.sessionId }); } catch {}
    }
    for (const entry of this.queue.splice(0)) this.receipt(entry, 'rejected');
    if (turn?.result) this.complete(turn, turn.result);
    else this.settle(turn, { status, terminalReason, error: status === 'unknown' ? terminalReason : null }, turn?.written ? 'unknown' : 'rejected');
  }
}

module.exports = { TurnQueue };
