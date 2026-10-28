const HISTORY_WINDOW = 8 * 1024 * 1024;
const LIVE_READ_LIMIT = 4 * 1024 * 1024;
const METADATA_LIMIT = 1024 * 1024;

// Recover only the first record's scope, from the same handle/identity as the
// tail. Never replay instructions, prompts, account IDs or old lifecycle events.
async function codexMetadata(file, threadId, source = null) {
  const chunk = Buffer.alloc(METADATA_LIMIT);
  const { bytesRead } = await file.read(chunk, 0, chunk.length, 0);
  const end = chunk.subarray(0, bytesRead).indexOf(10);
  if (end < 0) return null;
  try {
    const record = JSON.parse(chunk.subarray(0, end).toString('utf8')), meta = record.payload;
    if (record.type !== 'session_meta' || !meta || meta.id !== threadId || source && meta.source !== source) return null;
    return { type: 'session_meta', payload: {
      model_provider: typeof meta.model_provider === 'string' && meta.model_provider ? meta.model_provider : null,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    } };
  } catch { return null; }
}

// Seek by bytes, then discard the cut record before decoding UTF-8 or parsing JSON.
// Metadata/title lookups still read the first record separately.
function transcriptWindow(size) {
  const offset = Math.max(0, size - HISTORY_WINDOW);
  return { offset, skipping: offset > 0 };
}

module.exports = { HISTORY_WINDOW, LIVE_READ_LIMIT, transcriptWindow, codexMetadata };
