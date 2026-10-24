// Offline dictation benchmark. Each native model gets its own process, including TTS.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url), filename = fileURLToPath(import.meta.url);
const execute = promisify(execFile), rate = 16000;
const numThreads = Math.min(4, Math.max(1, os.availableParallelism() - 2));
const corpus = `z1 zh 拉取最新的代码，然后重新打开软件看看效果。
z2 zh 这个界面的字体还是不够清楚，需要再调亮一点。
z3 zh 把语音识别的结果实时显示在输入框里面。
z4 zh 测试的时候不要关闭正在运行的窗口。
z5 zh 每次重新打开软件的时候，第一个字母会丢失。
e1 en Please run the unit tests and push the branch to the remote.
e2 en The terminal renderer draws black boxes behind dim text.
e3 en Open a pull request and ask for a code review.
e4 en Make the glass panel fully transparent like Apple's liquid glass.
e5 en Restart the language server and check the TypeScript errors.
m1 mix 把这个 React component 里的 useEffect 改成 async function。
m2 mix 运行 npm test，然后 commit 到 main branch。
m3 mix Claude Code 和 Codex 的 slash command 都要测试一遍。
m4 mix 这个 bug 是因为 WebGL renderer 的 texture atlas 没有刷新。
m5 mix 帮我在 GitHub 上开一个 pull request，标题写 fix voice input。
m6 mix 用 FireRed ASR 和 SenseVoice 做一个 benchmark 对比一下。
m7 mix 把 catalina appearance 的 font weight 改成 semibold。
m8 mix 先 git pull 一下，再看 TypeScript 有没有 error。
m9 mix 这个 API 的 response 里面缺了 status code。
m10 mix 打开 settings 页面，把 terminal 的 font size 调小一点。
m11 mix 用 Electron 的 IPC 把 voice state 发给 renderer。
m12 mix 我觉得 Liquid Glass 的 specular highlight 太亮了。
m13 mix 在 README 里面补充一下 install 的步骤。
m14 mix 帮我 review 一下这个 diff，看看有没有 regression。`.split('\n').map(line => {
  const [, id, kind, text] = line.match(/^(\S+) (\S+) (.+)$/);
  return { id, kind, text };
});

// Field names verified against the v1.13.8 nodejs-addon-examples and native binding.
const sourceRoot = 'https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/';
const sources = {
  fireRedAsrCtc: `${sourceRoot}nodejs-addon-examples/test_asr_non_streaming_fire_red_asr_ctc.js`,
  qwen3Asr: `${sourceRoot}nodejs-addon-examples/test_asr_non_streaming_qwen3_asr.js`,
  funasrNano: `${sourceRoot}nodejs-addon-examples/test_asr_non_streaming_funasr_nano.js`,
  binding: `${sourceRoot}harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/non-streaming-asr.cc`,
};
const models = [
  { name: 'sense-voice', key: 'senseVoice', files: { model: 'model.int8.onnx' }, tokens: 'tokens.txt', options: { language: 'auto', useInverseTextNormalization: 1 } },
  { name: 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03', key: 'transducer', files: { encoder: 'encoder-epoch-99-avg-1.int8.onnx', decoder: 'decoder-epoch-99-avg-1.onnx', joiner: 'joiner-epoch-99-avg-1.int8.onnx' }, tokens: 'tokens.txt' },
  { name: 'sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25', key: 'fireRedAsrCtc', files: { model: 'model.int8.onnx' }, tokens: 'tokens.txt' },
  { name: 'sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26', key: 'fireRedAsr', files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx' }, tokens: 'tokens.txt' },
  { name: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25', key: 'qwen3Asr', files: { convFrontend: 'conv_frontend.onnx', encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokenizer: 'tokenizer' }, options: { hotwords: '' } },
  { name: 'sherpa-onnx-funasr-nano-int8-2025-12-30', key: 'funasrNano', files: { encoderAdaptor: 'encoder_adaptor.int8.onnx', llm: 'llm.int8.onnx', embedding: 'embedding.int8.onnx', tokenizer: 'Qwen3-0.6B' }, options: { language: '', itn: 1 } },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => error.message || String(error);
const notice = text => console.error(text);

function argumentsFor(args) {
  const options = { out: '.test-output/voice-bench', noise: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--noise') options.noise = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (['--models', '--out', '--only', '--tts'].includes(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = args[++i];
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.help) return options;
  if (!options.models) throw new Error('--models <dir> is required');
  for (const key of ['models', 'out', 'tts']) if (options[key]) options[key] = path.resolve(options[key]);
  if (options.only) {
    options.only = [...new Set(options.only.split(',').map(name => name.trim()).filter(Boolean))];
    if (!options.only.length) throw new Error('--only needs at least one model name');
    for (const name of options.only) if (!models.some(model => model.name === name)) throw new Error(`Unknown model: ${name}`);
  }
  return options;
}

function tokens(text) {
  return text.replace(/<\|[^<>]*\|>/g, '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '').match(/\p{Script=Han}|[\p{Script=Latin}\p{M}\p{N}]+/gu) || [];
}

function score(reference, hypothesis) {
  const ref = tokens(reference), hyp = tokens(hypothesis), width = hyp.length + 1;
  const costs = new Uint32Array((ref.length + 1) * width);
  for (let j = 0; j <= hyp.length; j++) costs[j] = j;
  for (let i = 1; i <= ref.length; i++) {
    costs[i * width] = i;
    for (let j = 1; j <= hyp.length; j++) costs[i * width + j] = Math.min(
      costs[(i - 1) * width + j - 1] + Number(ref[i - 1] !== hyp[j - 1]),
      costs[(i - 1) * width + j] + 1, costs[i * width + j - 1] + 1,
    );
  }
  const alignment = [];
  let i = ref.length, j = hyp.length;
  while (i || j) {
    const cost = costs[i * width + j];
    if (i && j && cost === costs[(i - 1) * width + j - 1] + Number(ref[i - 1] !== hyp[j - 1])) {
      alignment.push({ reference: ref[--i], hypothesis: hyp[--j], operation: ref[i] === hyp[j] ? 'match' : 'substitute' });
    } else if (i && cost === costs[(i - 1) * width + j] + 1) {
      alignment.push({ reference: ref[--i], hypothesis: null, operation: 'delete' });
    } else alignment.push({ reference: null, hypothesis: hyp[--j], operation: 'insert' });
  }
  alignment.reverse();
  const english = alignment.filter(item => item.reference && /\p{Script=Latin}/u.test(item.reference));
  const errors = costs[ref.length * width + hyp.length];
  return { errors, referenceTokens: ref.length, mer: ref.length ? errors / ref.length : null,
    englishWords: english.length, englishCorrect: english.filter(item => item.operation === 'match').length, alignment };
}

function summarize(samples) {
  const group = records => {
    const errors = records.reduce((n, item) => n + item.score.errors, 0);
    const referenceTokens = records.reduce((n, item) => n + item.score.referenceTokens, 0);
    const mixed = records.filter(item => item.kind === 'mix');
    const englishWords = mixed.reduce((n, item) => n + item.score.englishWords, 0);
    const englishCorrect = mixed.reduce((n, item) => n + item.score.englishCorrect, 0);
    return { samples: records.length, errors, referenceTokens, mer: referenceTokens ? errors / referenceTokens : null,
      englishWords, englishCorrect, mixEnglishAccuracy: englishWords ? englishCorrect / englishWords : null,
      meanRtf: records.length ? records.reduce((n, item) => n + item.rtf, 0) / records.length : null };
  };
  const kinds = records => Object.fromEntries(['zh', 'en', 'mix', 'all'].map(kind => [kind, group(kind === 'all' ? records : records.filter(item => item.kind === kind))]));
  return Object.fromEntries(['clean', 'noise'].map(condition => {
    const records = samples.filter(item => item.condition === condition && !item.error);
    return [condition, { combined: kinds(records), perVoice: Object.fromEntries([...new Set(records.map(item => item.voice))].map(voice => [voice, kinds(records.filter(item => item.voice === voice))])) }];
  }));
}

function waveBuffer(samples) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return wav;
}

function readWave(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 > wav.length) throw new Error('Invalid WAV header');
  let format, data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV');
    if (kind === 'fmt ') format = wav.subarray(start, start + size);
    if (kind === 'data') data = wav.subarray(start, start + size);
    offset = start + size + (size & 1);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== rate || format.readUInt16LE(12) !== 2 || format.readUInt16LE(14) !== 16 || !data?.length || data.length % 2) throw new Error('Expected nonempty 16 kHz mono 16-bit PCM WAV');
  return Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768);
}

function resample(samples, sampleRate) {
  if (sampleRate === rate) return samples;
  const result = new Float32Array(Math.round(samples.length * rate / sampleRate));
  for (let i = 0; i < result.length; i++) {
    const position = i * sampleRate / rate, left = Math.floor(position), fraction = position - left;
    result[i] = samples[left] * (1 - fraction) + samples[Math.min(left + 1, samples.length - 1)] * fraction;
  }
  return result;
}

function noisy(samples, key) {
  let seed = 2166136261;
  for (const char of key) seed = Math.imul(seed ^ char.codePointAt(0), 16777619) >>> 0;
  seed ||= 1;
  const noise = new Float32Array(samples.length);
  let signalPower = 0, mean = 0, noisePower = 0;
  for (let i = 0; i < samples.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    noise[i] = (seed >>> 0) / 4294967296 - 0.5; mean += noise[i];
    signalPower += samples[i] ** 2;
  }
  mean /= samples.length;
  for (let i = 0; i < noise.length; i++) { noise[i] -= mean; noisePower += noise[i] ** 2; }
  const gain = noisePower ? Math.sqrt(signalPower / (10 ** 1.5 * noisePower)) : 0;
  let peak = 1;
  for (let i = 0; i < noise.length; i++) { noise[i] = samples[i] + noise[i] * gain; peak = Math.max(peak, Math.abs(noise[i])); }
  // A common gain prevents clipping without changing the signal-to-noise ratio.
  if (peak > 1) for (let i = 0; i < noise.length; i++) noise[i] /= peak;
  return noise;
}

async function cached(file) {
  try { readWave(await fs.readFile(file)); return true; } catch { return false; }
}

async function snapshot(file) {
  const stat = await fs.stat(file);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(file);
    if (!entries.length) throw new Error(`Empty directory: ${file}`);
    return (await Promise.all(entries.sort().map(entry => snapshot(path.join(file, entry))))).join('|');
  }
  if (!stat.isFile() || !stat.size) throw new Error(`Empty or invalid file: ${file}`);
  return `${file}:${stat.size}:${stat.mtimeMs}`;
}

async function availability(files) {
  let first;
  try { first = await Promise.all(files.map(snapshot)); }
  catch (error) { return { status: 'skipped (missing files)', error: message(error) }; }
  await sleep(1000);
  try {
    const second = await Promise.all(files.map(snapshot));
    if (first.some((value, i) => value !== second[i])) return { status: 'skipped (files still growing)' };
  } catch (error) { return { status: 'skipped (missing files)', error: message(error) }; }
  return { status: 'available' };
}

function childJob(job, received = () => {}) {
  return new Promise((resolve, reject) => {
    const child = fork(filename, ['--worker'], { windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result, diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-12000); });
    child.on('message', data => {
      if (data.type === 'done') result = data.result;
      else received(data);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error([result?.error || `Native process exited (${signal || code})`, diagnostic.trim()].filter(Boolean).join('\n')));
    });
    child.send(job);
  });
}

async function worker(job) {
  const sherpa = require('sherpa-onnx-node');
  if (job.type === 'tts') {
    const tts = new sherpa.OfflineTts(job.config);
    for (const sample of job.samples) {
      try {
        const audio = tts.generate({ text: sample.text, sid: 0, speed: 1 });
        await fs.writeFile(sample.file, waveBuffer(resample(audio.samples, audio.sampleRate)));
        process.send({ type: 'synthesized', id: sample.id });
      } catch (error) { process.send({ type: 'notice', text: `MeloTTS ${sample.id}: ${message(error)}` }); }
    }
    return {};
  }
  const start = performance.now(), recognizer = new sherpa.OfflineRecognizer(job.config);
  const loadMs = performance.now() - start;
  process.send({ type: 'loaded', loadMs });
  for (const sample of job.samples) {
    const clean = readWave(await fs.readFile(sample.file));
    for (const condition of job.noise ? ['clean', 'noise'] : ['clean']) {
      const record = { ...sample, condition, durationSeconds: clean.length / rate };
      try {
        const samples = condition === 'clean' ? clean : noisy(clean, `${sample.voice}-${sample.id}`);
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: rate, samples });
        const decodeStart = performance.now();
        recognizer.decode(stream);
        record.decodeMs = performance.now() - decodeStart;
        record.hypothesis = recognizer.getResult(stream).text || '';
        record.rtf = record.decodeMs / (record.durationSeconds * 1000);
        record.score = score(sample.text, record.hypothesis);
      } catch (error) { record.error = message(error); }
      process.send({ type: 'sample', record });
    }
  }
  return { loadMs, peakRssBytes: Math.max(process.resourceUsage().maxRSS * 1024, process.memoryUsage().rss) };
}

async function powershell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

async function synthesize(options, appVoice, notices) {
  const say = text => { notices.push(text); notice(text); };
  const samples = corpus.map(item => ({ ...item, voice: 'melo', file: path.join(options.out, `melo-${item.id}.wav`) }));
  const missing = [];
  for (const sample of samples) if (!await cached(sample.file)) missing.push(sample);
  const directory = options.tts || path.join(appVoice, 'melo-tts-zh-en'), file = name => path.join(directory, name);
  if (missing.length) {
    notice(`Synthesizing ${missing.length} MeloTTS samples...`);
    try {
      await childJob({ type: 'tts', samples: missing, config: {
        model: { vits: { model: file('model.int8.onnx'), lexicon: file('lexicon.txt'), tokens: file('tokens.txt'), dictDir: file('dict') }, numThreads, provider: 'cpu', debug: 0 },
        ruleFsts: ['date.fst', 'phone.fst', 'number.fst', 'new_heteronym.fst'].map(file).join(','), maxNumSentences: 1,
      } }, data => data.type === 'notice' ? say(data.text) : notice(`  MeloTTS ${data.id}`));
    } catch (error) { say(`MeloTTS unavailable: ${message(error)}`); }
  }
  const voices = [
    { voice: 'huihui', name: 'Microsoft Huihui Desktop', sentences: corpus },
    { voice: 'zira', name: 'Microsoft Zira Desktop', sentences: corpus.filter(item => item.kind === 'en') },
  ];
  try {
    const jobs = [];
    for (const voice of voices) {
      const items = voice.sentences.map(item => ({ ...item, voice: voice.voice, file: path.join(options.out, `${voice.voice}-${item.id}.wav`) }));
      const pending = [];
      for (const sample of items) if (!await cached(sample.file)) pending.push(sample);
      jobs.push({ name: voice.name, voice: voice.voice, samples: pending });
    }
    const payload = Buffer.from(JSON.stringify(jobs), 'utf8').toString('base64');
    const result = await powershell(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$jobs = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$results = @()
try {
  $installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  foreach ($job in $jobs) {
    $available = $installed -contains $job.name
    $errors = @()
    if ($available) {
      $synth.SelectVoice($job.name)
      foreach ($sample in $job.samples) {
        try { $synth.SetOutputToWaveFile($sample.file, $format); $synth.Speak($sample.text) }
        catch { $errors += "$($sample.id): $($_.Exception.Message)" }
        finally { $synth.SetOutputToNull() }
      }
    }
    $results += @{ voice = $job.voice; name = $job.name; available = $available; errors = $errors }
  }
} finally { $synth.Dispose() }
ConvertTo-Json -InputObject $results -Depth 5 -Compress
`);
    for (const voice of result) {
      if (!voice.available) { say(`Skipping ${voice.name}: voice not installed`); continue; }
      for (const error of voice.errors) say(`${voice.name}: ${error}`);
      const definition = voices.find(item => item.voice === voice.voice);
      samples.push(...definition.sentences.map(item => ({ ...item, voice: voice.voice, file: path.join(options.out, `${voice.voice}-${item.id}.wav`) })));
    }
  } catch (error) { say(`Windows voices unavailable: ${message(error)}`); }
  const valid = [];
  for (const sample of samples) {
    if (await cached(sample.file)) valid.push(sample);
    else say(`Skipping ${sample.voice}-${sample.id}: no valid cached WAV`);
  }
  return valid;
}

function table(results, noise) {
  const percent = value => value == null ? '-' : `${(value * 100).toFixed(1)}%`;
  const columns = ['model', 'load ms', 'RTF', 'MER zh', 'MER en', 'MER mix', 'MER all', 'mix EN acc'];
  if (noise) columns.push('N RTF', 'N zh', 'N en', 'N mix', 'N all', 'N EN acc');
  const rows = results.map(result => {
    const values = [result.name, result.loadMs == null ? '-' : result.loadMs.toFixed(0)];
    for (const condition of noise ? ['clean', 'noise'] : ['clean']) {
      const scores = result.scores?.[condition]?.combined;
      values.push(scores?.all.meanRtf?.toFixed(3) || '-', ...['zh', 'en', 'mix', 'all'].map(kind => percent(scores?.[kind]?.mer)), percent(scores?.all.mixEnglishAccuracy));
    }
    if (result.status !== 'ok') values[0] += ` [${result.status}]`;
    return values;
  });
  const widths = columns.map((column, i) => Math.max(column.length, ...rows.map(row => row[i].length)));
  return [columns, ...rows].map(row => row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log('Usage: node scripts/voice-bench.mjs --models <dir> [--out <dir>] [--only name1,name2] [--noise] [--tts <dir>]'); return; }
  const appVoice = path.resolve(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Agentrix', 'voice');
  await fs.mkdir(options.out, { recursive: true });
  const report = { startedAt: new Date().toISOString(), options, sherpaVersion: require('sherpa-onnx-node/package.json').version, numThreads, corpus, sources,
    normalization: 'NFKC, lowercase, strip SenseVoice tags and punctuation/symbols; Han characters and Latin/digit words; no traditional-to-simplified conversion',
    noise: options.noise ? { snrDb: 15, prng: 'xorshift32, FNV-1a seed from voice-id; zero-mean uniform white noise, full-waveform RMS' } : null,
    timing: 'decode() only; mean of per-sample RTF; no warm-up excluded', memory: 'OS process peak RSS (resourceUsage.maxRSS), including Node and model; isolated process per model',
    notices: [], samples: [], models: [] };
  report.samples = await synthesize(options, appVoice, report.notices);
  const save = () => fs.writeFile(path.join(options.out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await save();
  if (!report.samples.length) throw new Error(`No speech samples available; see ${path.join(options.out, 'results.json')}`);
  for (const definition of models.filter(model => !options.only || options.only.includes(model.name))) {
    let directory = path.join(options.models, definition.name);
    if (definition.name === 'sense-voice') {
      try { await fs.stat(directory); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        directory = path.join(appVoice, 'sense-voice-2024-07-17');
      }
    }
    const files = Object.fromEntries(Object.entries(definition.files).map(([key, file]) => [key, path.join(directory, file)]));
    const tokensFile = definition.tokens ? path.join(directory, definition.tokens) : '';
    const config = { featConfig: { sampleRate: rate, featureDim: 80 }, modelConfig: { [definition.key]: { ...files, ...definition.options }, tokens: tokensFile, numThreads, provider: 'cpu', debug: 0 }, decodingMethod: 'greedy_search' };
    const result = { name: definition.name, directory, config, ...await availability([...Object.values(files), ...(tokensFile ? [tokensFile] : [])]), samples: [] };
    report.models.push(result);
    if (result.status === 'available') {
      notice(`Running ${definition.name} (${report.samples.length} samples${options.noise ? ', clean + 15 dB noise' : ''})...`);
      try {
        Object.assign(result, await childJob({ type: 'asr', config, samples: report.samples, noise: options.noise }, data => {
          if (data.type === 'loaded') { result.loadMs = data.loadMs; notice(`  Loaded in ${data.loadMs.toFixed(0)} ms`); }
          if (data.type === 'sample') {
            result.samples.push(data.record);
            if (result.samples.length % 12 === 0) notice(`  ${result.samples.length} decoded`);
          }
        }));
        result.status = result.samples.some(item => item.error) ? 'partial (sample errors)' : 'ok';
      } catch (error) { result.status = 'error'; result.error = message(error); notice(`${result.name}: ${result.error}`); }
    } else notice(`${result.name}: ${result.status}${result.error ? `: ${result.error}` : ''}`);
    result.scores = summarize(result.samples);
    await save();
  }
  report.finishedAt = new Date().toISOString();
  report.table = table(report.models, options.noise);
  await save();
  console.log(`\n${report.table}`);
  for (const model of report.models) {
    const errors = model.samples.filter(sample => sample.kind === 'mix' && (sample.error || sample.score.errors));
    if (!errors.length) continue;
    console.log(`\n${model.name}: mixed sentences with errors`);
    for (const sample of errors) console.log(`  ${sample.voice}/${sample.id}/${sample.condition}: ${sample.text} → ${sample.error ? `[error: ${sample.error}]` : sample.hypothesis}`);
  }
  console.log(`\nResults: ${path.join(options.out, 'results.json')}`);
  if (!report.models.some(model => model.status === 'ok' || model.status.startsWith('partial'))) process.exitCode = 1;
}

if (process.argv[2] === '--worker' && process.send) {
  process.once('message', async job => {
    try { process.send({ type: 'done', result: await worker(job) }, () => process.exit(0)); }
    catch (error) { process.send({ type: 'done', result: { error: message(error) } }, () => process.exit(1)); }
  });
} else {
  await main().catch(error => { console.error(message(error)); process.exitCode = 1; });
}
