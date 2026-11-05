const { readJson, writeJson } = require('../native-session/storage.cjs');
function createCredentials({ file, safeStorage, platform = process.platform, onChange = () => {} }) {
  function secure() {
    if (!safeStorage?.isEncryptionAvailable() || platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用。');
  }
  return {
    status: () => ({ saved: typeof readJson(file, {}).encrypted === 'string' }),
    save(key) {
      if (typeof key !== 'string' || !/^sk-ant-(?!admin)[\w-]{16,500}$/.test(key)) throw new Error('请输入有效的 Anthropic API 密钥。');
      secure(); writeJson(file, { version: 1, encrypted: safeStorage.encryptString(key).toString('base64') }); onChange(); return { saved: true };
    },
    clear() { writeJson(file, { version: 1 }); onChange(); return { saved: false }; },
    read() {
      const { encrypted } = readJson(file, {}); if (!encrypted) return null;
      secure();
      try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
      catch { throw new Error('API 密钥无法解密，请重新保存。'); }
    },
  };
}
// Never mutate process.env. Remove alternative authentication and routing before selecting the key.
function apiEnvironment(env, key, owner = 'dispatch') {
  const clean = { ...env };
  for (const name of Object.keys(clean)) if (/^(ANTHROPIC_|CLAUDE_CODE_(OAUTH|USE_|API_KEY|AUTH|SESSION_ACCESS_TOKEN)|CLAUDE_(OAUTH|AUTH|API_KEY)|AGENTRIX_(SESSION|CONTROL|CAPABILITY|EVENT))/i.test(name)
    || owner === 'dispatch' && /^AGENTRIX_BOOTSTRAP$/i.test(name)) delete clean[name];
  clean.ANTHROPIC_API_KEY = key;
  for (const name of Object.keys(clean)) if (name.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT') delete clean[name];
  clean.AGENTRIX_SDK_PARENT = '1';
  clean.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = owner === 'dispatch' ? '1' : '0';
  return clean;
}
module.exports = { createCredentials, apiEnvironment };
