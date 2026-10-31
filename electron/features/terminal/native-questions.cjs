const { object } = require('./native-approvals.cjs');
const MAX_FIELDS = 32, MAX_OPTIONS = 128, MAX_TEXT = 8192;
const text = value => typeof value === 'string' && value.length <= MAX_TEXT;
const name = value => text(value) && value.length > 0;
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const unique = values => new Set(values).size === values.length;
const count = value => Number.isSafeInteger(value) && value >= 0;
const optional = (value, check) => value == null || check(value);

function options(values, titled = false) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_OPTIONS) return null;
  const result = values.map(value => titled
    ? only(value, ['const', 'title']) && name(value.const) && text(value.title) ? { value: value.const, label: value.title } : null
    : name(value) ? { value, label: value } : null);
  return result.every(Boolean) && unique(result.map(option => option.value)) ? result : null;
}

// Compile only schemas we can render and validate completely. Unknown keywords never lose their constraints.
function formQuestion(schema, title) {
  if (!only(schema, ['$schema', 'type', 'properties', 'required', 'additionalProperties', 'title', 'description']) || schema.type !== 'object'
    || !object(schema.properties) || !optional(schema.$schema, text) || !optional(schema.title, text) || !optional(schema.description, text)
    || schema.additionalProperties != null && schema.additionalProperties !== false) return null;
  const entries = Object.entries(schema.properties), required = schema.required ?? [];
  if (entries.length > MAX_FIELDS || !Array.isArray(required) || !required.every(name) || !unique(required) || required.some(id => !Object.hasOwn(schema.properties, id))) return null;
  const fields = [];
  for (const [id, s] of entries) {
    if (!name(id) || !object(s) || !optional(s.title, text) || !optional(s.description, text)) return null;
    const common = ['type', 'title', 'description', 'default'];
    const field = { id, label: s.title || id, type: s.type, required: required.includes(id) };
    if (s.description) field.description = s.description;
    if (s.type === 'string') {
      if (!only(s, [...common, 'enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format'])) return null;
      if (!optional(s.minLength, count) || !optional(s.maxLength, count) || s.minLength > MAX_TEXT || s.minLength != null && s.maxLength != null && s.minLength > s.maxLength) return null;
      if (!optional(s.format, value => ['email', 'uri', 'date', 'date-time'].includes(value))) return null;
      if (s.enum != null || s.oneOf != null) {
        if (s.enum != null && s.oneOf != null) return null;
        field.options = options(s.enum ?? s.oneOf, s.oneOf != null);
        if (!field.options || !optional(s.enumNames, value => Array.isArray(value) && value.length === field.options.length && value.every(text))) return null;
        if (s.enumNames) field.options.forEach((option, index) => { option.label = s.enumNames[index]; });
        field.type = 'single';
      } else if (s.enumNames != null) return null;
      for (const key of ['minLength', 'maxLength', 'format']) if (s[key] != null) field[key] = s[key];
    } else if (s.type === 'number' || s.type === 'integer') {
      if (!only(s, [...common, 'minimum', 'maximum']) || !optional(s.minimum, Number.isFinite) || !optional(s.maximum, Number.isFinite)
        || s.minimum != null && s.maximum != null && s.minimum > s.maximum) return null;
      for (const key of ['minimum', 'maximum']) if (s[key] != null) field[key] = s[key];
    } else if (s.type === 'boolean') {
      if (!only(s, common)) return null;
    } else if (s.type === 'array') {
      if (!only(s, [...common, 'items', 'minItems', 'maxItems', 'uniqueItems']) || !object(s.items)
        || !optional(s.minItems, count) || !optional(s.maxItems, count) || !optional(s.uniqueItems, value => typeof value === 'boolean')
        || s.minItems > MAX_OPTIONS || s.minItems != null && s.maxItems != null && s.minItems > s.maxItems) return null;
      const item = s.items;
      if (only(item, ['type', 'enum']) && item.type === 'string') field.options = options(item.enum);
      else if (only(item, ['anyOf'])) field.options = options(item.anyOf, true);
      if (!field.options) return null;
      field.type = 'multi';
      for (const key of ['minItems', 'maxItems']) if (s[key] != null) field[key] = s[key];
    } else return null;
    if (s.default != null) {
      if (!validValue(field, s.default)) return null;
      field.default = s.default;
    }
    fields.push(field);
  }
  return { title, fields };
}

function questionFields(questions, provider) {
  if (!Array.isArray(questions) || !questions.length || questions.length > (provider === 'claude' ? 4 : MAX_FIELDS)) return null;
  const fields = [];
  for (const q of questions) {
    const claude = provider === 'claude', id = claude ? q?.question : q?.id;
    const keys = claude ? ['question', 'header', 'options', 'multiSelect'] : ['id', 'header', 'question', 'options', 'isOther', 'isSecret'];
    if (!only(q, keys) || !name(id) || !name(q.question) || !text(q.header)
      || !optional(q.multiSelect, value => typeof value === 'boolean') || !optional(q.isOther, value => typeof value === 'boolean')
      || !optional(q.isSecret, value => typeof value === 'boolean')) return null;
    const field = { id, label: q.question, description: q.header, type: 'string', required: true, minLength: 1, secret: q.isSecret === true };
    if (q.options != null) {
      if (!Array.isArray(q.options) || !q.options.length || q.options.length > (claude ? 4 : MAX_OPTIONS) || claude && q.options.length < 2) return null;
      field.options = [];
      for (const option of q.options) {
        if (!only(option, claude ? ['label', 'description', 'preview'] : ['label', 'description']) || !name(option.label) || !text(option.description) || !optional(option.preview, text)) return null;
        field.options.push({ value: option.label, label: option.label, description: option.description, ...(option.preview != null ? { preview: option.preview } : {}) });
      }
      if (!unique(field.options.map(option => option.value))) return null;
      field.type = q.multiSelect ? 'multi' : 'single';
      if (q.multiSelect) field.minItems = 1;
      // Claude's own AskUserQuestion schema declares an automatic Other option; Codex declares isOther.
      field.allowOther = claude || q.isOther === true;
    } else if (claude) return null;
    fields.push(field);
  }
  return unique(fields.map(field => field.id)) ? { title: provider === 'claude' ? 'AskUserQuestion' : 'request_user_input', fields } : null;
}

function validFormat(value, format) {
  if (format === 'email') return /^[^\s@]+@[^\s@]+$/.test(value);
  if (format === 'uri') { try { return !!new URL(value).protocol; } catch { return false; } }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value); return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  }
  if (format === 'date-time') {
    const parts = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.exec(value);
    return !!parts && validFormat(parts[1], 'date') && Number(parts[2]) < 24 && Number(parts[3]) < 60 && Number(parts[4]) < 60 && Number.isFinite(Date.parse(value));
  }
  return true;
}

function validValue(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number' || field.type === 'integer') return Number.isFinite(value) && (field.type !== 'integer' || Number.isSafeInteger(value))
    && (field.minimum == null || value >= field.minimum) && (field.maximum == null || value <= field.maximum);
  if (field.type === 'multi') return Array.isArray(value) && value.length <= MAX_OPTIONS && unique(value) && value.every(name)
    && (field.minItems == null || value.length >= field.minItems) && (field.maxItems == null || value.length <= field.maxItems)
    && value.filter(item => !field.options.some(option => option.value === item)).length <= (field.allowOther ? 1 : 0);
  return text(value) && (field.minLength == null || [...value].length >= field.minLength)
    && (field.maxLength == null || [...value].length <= field.maxLength) && validFormat(value, field.format)
    && (field.type !== 'single' || field.allowOther || field.options.some(option => option.value === value));
}

function validateValues(question, values) {
  if (question.unsupported || !object(values) || Object.keys(values).some(id => !question.fields.some(field => field.id === id))
    || question.fields.some(field => Object.hasOwn(values, field.id) ? !validValue(field, values[field.id]) : field.required)) throw new Error('Invalid native question fields');
  return Object.fromEntries(question.fields.filter(field => Object.hasOwn(values, field.id)).map(field => [field.id, values[field.id]]));
}

function codexQuestion(method, params) {
  if (method === 'item/tool/requestUserInput') {
    if (!only(params, ['threadId', 'turnId', 'itemId', 'isBlocking', 'autoResolutionMs', 'questions']) || typeof params.isBlocking !== 'boolean'
      || !optional(params.autoResolutionMs, count)) return null;
    const question = questionFields(params.questions, 'codex');
    if (!question) return null;
    return { question, decisions: ['submit', 'cancel'], response: (decision, id, values) => ({ id, result: { answers: decision === 'cancel' ? {}
      : Object.fromEntries(Object.entries(validateValues(question, values)).map(([key, value]) => [key, { answers: Array.isArray(value) ? value : [value] }])) } }) };
  }
  if (params.mode !== 'form' || !only(params, ['threadId', 'turnId', 'serverName', 'mode', 'message', 'requestedSchema', '_meta']) || !text(params.message)) return null;
  const question = formQuestion(params.requestedSchema, params.message);
  if (!question) return null;
  return { question, decisions: ['submit', 'decline', 'cancel'], response: (decision, id, values) => ({ id, result: {
    action: decision === 'submit' ? 'accept' : decision, ...(decision === 'submit' ? { content: validateValues(question, values) } : {}),
  } }) };
}

function claudeQuestion(params) {
  let question;
  if (params.subtype === 'can_use_tool' && params.tool_name === 'AskUserQuestion') question = questionFields(params.input.questions, 'claude');
  else if (params.subtype === 'elicitation' && (params.mode == null || params.mode === 'form') && text(params.message)) question = formQuestion(params.requested_schema, params.message);
  // SDK-managed Claude has no operable TUI. Keep an explicit native cancellation even for unknown schemas/modes.
  question ||= { title: text(params.message) ? params.message : params.tool_name || 'elicitation', fields: [], unsupported: true };
  const ask = params.subtype === 'can_use_tool', input = ask ? JSON.parse(JSON.stringify(params.input)) : null;
  const decisions = ask ? question.unsupported ? ['cancel'] : ['submit', 'cancel'] : question.unsupported ? ['decline', 'cancel'] : ['submit', 'decline', 'cancel'];
  return { question, decisions, response: (decision, id, values) => {
    const answers = decision === 'submit' ? validateValues(question, values) : null;
    return { type: 'control_response', response: { subtype: 'success', request_id: id, response: ask
      ? answers ? { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) } }
        : { behavior: 'deny', message: 'Question cancelled by user in Agentrix' }
      : { action: decision === 'submit' ? 'accept' : decision, ...(answers ? { content: answers } : {}) } } };
  } };
}

module.exports = { codexQuestion, claudeQuestion, formQuestion, validateValues };
