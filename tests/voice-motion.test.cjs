const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { easeVoiceLevel } = require('../src/features/voice/voice-level.ts');

test('voice envelope attacks quickly, releases slowly and never overshoots', () => {
  const attack = easeVoiceLevel(0, 1, 40), release = easeVoiceLevel(1, 0, 40);
  assert.ok(attack > .6 && attack < .65);
  assert.ok(release > .8 && release < .85);
  for (const dt of [0, 1, 1000 / 144, 1000 / 60, 1000 / 32, 5000]) {
    for (const [current, target] of [[0, 1], [1, 0], [.25, .7], [.7, .25], [.5, .5]]) {
      const next = easeVoiceLevel(current, target, dt);
      assert.ok(next >= Math.min(current, target) && next <= Math.max(current, target));
    }
  }
});

test('voice envelope is time based across remote and high-refresh displays', () => {
  for (const hz of [32, 60, 144, 240]) {
    for (const [from, to] of [[0, 1], [1, 0]]) {
      let level = from;
      for (let frame = 0; frame < hz; frame++) level = easeVoiceLevel(level, to, 1000 / hz);
      assert.ok(Math.abs(level - easeVoiceLevel(from, to, 1000)) < 1e-12, `${hz} Hz`);
    }
  }
  const jitter = [7, 29, 11, 85, 4, 22, 42];
  assert.ok(Math.abs(jitter.reduce((level, dt) => easeVoiceLevel(level, .7, dt), 0)
    - easeVoiceLevel(0, .7, jitter.reduce((sum, dt) => sum + dt, 0))) < 1e-12);
});

test('voice envelope contains invalid readings and clocks', () => {
  assert.equal(easeVoiceLevel(.5, 1, -1), .5);
  assert.equal(easeVoiceLevel(.5, 1, NaN), .5);
  assert.equal(easeVoiceLevel(2, 5, 10), 1);
  assert.equal(easeVoiceLevel(-2, -5, 10), 0);
  assert.ok(Number.isFinite(easeVoiceLevel(NaN, NaN, 16)));
});

test('the actual capture worklet sends one level per 4096 samples, plus the final flush', () => {
  let Processor;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/features/voice/voice-capture.worklet.js'), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: message => messages.push(message) }; },
    registerProcessor(name, constructor) { assert.equal(name, 'agentrix-voice'); Processor = constructor; },
  });
  const processor = new Processor(), quantum = new Float32Array(128).fill(.1);
  for (let i = 0; i < 31; i++) processor.process([[quantum]]);
  assert.equal(messages.length, 0);
  processor.process([[quantum]]);
  assert.equal(messages.length, 1); assert.equal(messages[0].samples.length, 4096);
  assert.ok(Math.abs(messages[0].level - .1) < 1e-7);
  assert.equal(48000 / messages[0].samples.length, 11.71875);
  assert.ok(Math.abs(44100 / messages[0].samples.length - 10.7666015625) < 1e-12);
  processor.process([[quantum]]); processor.port.onmessage({ data: 'flush' });
  assert.equal(messages[1].samples.length, 128); assert.equal(messages[2].flushed, true);
});

function voiceController() {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/voice/voice-input.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const events = new Map(), exports = {};
  let emit, notifications = 0, subscribed = false, recognize;
  const ready = { ready: true, phase: 'ready' };
  vm.runInNewContext(compiled, {
    exports, setTimeout, CSS: { escape: value => value },
    document: { addEventListener: (name, fn) => events.set(name, fn) },
    navigator: { mediaDevices: { addEventListener() {}, enumerateDevices: async () => [{ kind: 'audioinput' }] } },
    window: { agentrix: { onVoiceState() {}, getVoiceState: async () => ({ ok: true, value: ready }), warmVoice() {},
      transcribe: () => new Promise(resolve => { recognize = resolve; }) } },
    require(name) {
      if (name === 'react') return { useSyncExternalStore(subscribe, get) {
        if (!subscribed) { subscribed = true; subscribe(() => notifications++); } return get();
      } };
      if (name === './voice-audio') return { MicrophoneCapture: class {
        async open(_id, onLevel) { emit = onLevel; } async close() {} startRecording() {} async stopRecording() { return new ArrayBuffer(0); }
      } };
      if (name.endsWith('/i18n')) return { t: text => text };
      if (name.endsWith('/platform')) return {};
      if (name.endsWith('/shortcuts')) return { shortcut: () => 'Ctrl+T' };
      throw new Error(`Unexpected voice dependency: ${name}`);
    },
  });
  exports.useVoice();
  return { controller: exports, emit: value => emit(value), get notifications() { return notifications; },
    recognize: result => recognize(result), cancel() { events.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('audio messages update only the meter, keeping every useVoice snapshot stable', async () => {
  const f = voiceController(); await flush();
  await f.controller.toggleDictation('terminal', 'session', assert.fail);
  const before = f.controller.useVoice(), notifications = f.notifications;
  for (const level of [.01, .02, .08, .2]) f.emit(level);
  assert.equal(f.controller.getVoiceLevel(), 1);
  assert.equal(f.controller.useVoice(), before);
  assert.equal(f.notifications, notifications);
  f.cancel(); await flush();
  assert.equal(f.controller.getVoiceLevel(), 0); assert.equal(f.controller.useVoice().recording, null);
  f.emit(.2); assert.equal(f.controller.getVoiceLevel(), 0, 'late messages cannot revive a cancelled meter');
});

test('recognition resets the level and ignores the final audio messages while busy', async () => {
  const f = voiceController(); await flush();
  const words = [];
  f.controller.dictateInto('terminal', (text, submit) => words.push([text, submit]));
  await f.controller.toggleDictation('terminal', 'session', assert.fail);
  f.emit(.1); assert.equal(f.controller.getVoiceLevel(), .5);
  const finishing = f.controller.toggleDictation('terminal', 'session', assert.fail);
  await flush();
  assert.equal(f.controller.useVoice().busy, 'terminal'); assert.equal(f.controller.getVoiceLevel(), 0);
  f.emit(.2); assert.equal(f.controller.getVoiceLevel(), 0);
  f.recognize({ ok: true, value: 'hello' }); await finishing;
  assert.deepEqual(words, [['hello', false]]); assert.equal(f.controller.useVoice().busy, null);
});
