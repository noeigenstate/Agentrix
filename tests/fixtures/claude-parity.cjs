const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { NATIVE_CONTEXT, IDENTITY_CONTEXT } = require('../../electron/features/claude-sdk/query.cjs');

// CLI 2.1.318, paired requests from one offline server. Pin BOTH bytes at each
// transport-dependent leaf: a new change in a known field must also fail.
const leaves = {
  // SDK describes explicit background control; the TUI backgrounds Agent automatically.
  'Agent.description': ['7b71db769cc7f1d9038945224682197b4a2aeb67dc804b13a046ee6fcec00805', '9cf7e5f441985192d9de302674f695766e00c86b111b898f2c10c93549ebec9a'],
  'Agent.input_schema.properties.run_in_background': ['8948f47e20fb7afd5e865a19cc0e274b82ea912ee21ec73ef9cefbb6d53255e2', 'eb045d78d273107348b0300c01d29b7552d622abbc6faf81b3ec55359aa9950c'],
  // CLI transport-specific question presentation and detached-shell guidance.
  'AskUserQuestion.description': ['da1cea925a37fea0dc511324852fe8dd7ed088e04a406d2937ed877b0363900d', 'befd4026b90274dc5ceca8ad3990a241d85ad8a39f8d04bf174522874e4b406a'],
  'Bash.description': ['cd708e574cce8d81981cbed3f5217c911e8a539cb70ce0529b2de37b1158af85', 'd4bb79534dc62f6b2ec4036c33b1e4eb2d9a9e7ae2d9f85c05717a608dfaedbf'],
  'Bash.input_schema.properties.run_in_background.description': ['5d2850b8b1c68a06daf7646d32557efeedd5be218a30adc064fad6134fbdf98f', 'd1fd3b8715e2ad40c13e87a3e03499dec8456ca956aa1390577d3e65e8b3fc19'],
};
const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
function compareTools(sdk, tui) {
  assert.deepEqual(sdk.map(tool => tool.name), tui.map(tool => tool.name));
  const differences = [];
  function compare(a, b, name) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${name}.${key}`);
    } else if (!leaves[name] || hash(a) !== leaves[name][0] || hash(b) !== leaves[name][1]) differences.push({ name, sdk: hash(a), tui: hash(b) });
  }
  for (const tool of sdk) compare(tool, tui.find(row => row.name === tool.name), tool.name);
  assert.deepEqual(differences, [], 'new tool/schema differences need a real paired investigation');
}
function compareSystem(sdk, tui, { sdkOwner = 'gui', tuiOwner = null } = {}) {
  const append = owner => owner === 'gui' ? NATIVE_CONTEXT : owner === 'dispatch' ? IDENTITY_CONTEXT : null;
  const normalize = (blocks, owner) => blocks.map((block, index) => {
    let text = block.text;
    if (index === 0) {
      assert.match(text, /^x-anthropic-billing-header: cc_version=2\.1\.318\.[a-f\d]+; cc_entrypoint=(?:sdk-ts|cli);$/);
      text = 'BILLING_HEADER'; // CLI-generated entrypoint and prompt fingerprint, never an agent instruction.
    } else {
      // Only the exact owner-specific append is admitted. Workers have no
      // interactive owner shell or concurrent user chat; GUI capabilities do.
      if (append(owner)) text = text.replace('\n\n' + append(owner), '');
      text = text.replace("You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", "You are Claude Code, Anthropic's official CLI for Claude.")
        .replace('If you need the user to run a shell command themselves (e.g., an interactive login like `gcloud auth login`), suggest they type `! <command>` in the prompt — the `!` prefix runs the command in this session so its output lands directly in the conversation.\n - ', '')
        .replace(', runs in the background,', '')
        .replace(' — so you can keep chatting with the user while it works', '');
    }
    return { ...block, text };
  });
  // Hashes keep a failure readable and prevent printing the entire preset into CI logs.
  assert.equal(hash(normalize(sdk, sdkOwner)), hash(normalize(tui, tuiOwner)), 'unexpected system-prompt difference');
}
module.exports = { compareTools, compareSystem };
