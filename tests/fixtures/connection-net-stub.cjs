// The connection test's model list, answered offline. Main sends it through Electron net (`netRequest(electronNet)`
// in electron/main.cjs), so the stub replaces net.request. The packaged smoke runs it inside main through
// app.evaluate, so it uses nothing from this file's scope.
function stubModelListNet(electron) {
  const { EventEmitter } = process.getBuiltinModule('events'), { PassThrough } = process.getBuiltinModule('stream');
  electron.net.request = ({ url }) => {
    if (url !== 'https://api.anthropic.com/v1/models?limit=100') throw new Error('Unexpected offline connection request');
    const request = new EventEmitter();
    request.abort = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = 200; request.emit('response', response);
      response.end('{"data":[{"id":"fake-claude"}]}');
    });
    return request;
  };
}
module.exports = { stubModelListNet };
