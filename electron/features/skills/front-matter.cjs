// Keep scalar decoding shared between user skills, strict built-ins and activity descriptions.
const MAX_BYTES = 512 * 1024;

function frontMatter(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES || text.includes('\0')) throw new Error('技能文件过大或格式无效。');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const [, key, raw] of match[1].matchAll(/^([\w-]+):[ \t]*(.*(?:\r?\n[ \t]+.*)*)$/gm)) {
    if (Object.hasOwn(fields, key)) continue;
    let value = raw.trim();
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    fields[key] = value;
  }
  return { fields, raw: match[1], body: text.slice(match[0].length) };
}

module.exports = { MAX_BYTES, frontMatter };
