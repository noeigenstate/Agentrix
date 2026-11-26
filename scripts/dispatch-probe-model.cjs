const instructionsOf = data => [data.instructions, data.system,
  ...(Array.isArray(data.input) ? data.input : []).filter(item => ['system', 'developer'].includes(item.role)),
  ...(data.messages || []).filter(item => ['system', 'developer'].includes(item.role))].filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');

module.exports = { instructionsOf };
