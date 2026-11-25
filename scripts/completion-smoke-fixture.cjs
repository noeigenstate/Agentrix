// The agent a terminal runs is Claude Code (Codex opens in native mode: native-session-smoke). Its stand-in is the shared
// restore fixture, which only logs keys. This smoke also needs a live composer, Claude Code's input box, without
// acknowledging images.
function completionFixtureSource(source) {
  const ready = 'Console.WriteLine("RESTORE_FIXTURE_READY");';
  if (!source.includes(ready)) throw new Error('The completion fixture is missing its ready marker');
  return source.replace(ready, String.raw`${ready}
        Console.WriteLine("\u2500\u2500\u2500\u2500\r\n\u276F \r\n\u2500\u2500\u2500\u2500\r\n  \u23F8 manual mode on");`);
}
module.exports = { completionFixtureSource };
