const finished = status => typeof status === 'object' && status !== null ? Object.keys(status).some(finished)
  : /^(?:completed|complete|failed|killed|stopped|shutdown|errored|idle|not_found)$/.test(status || '');

module.exports = { finished };
