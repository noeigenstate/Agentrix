// Compiled only into an isolated smoke directory. No installed provider executable is used.
const source = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
public class FakeProvider {
  static string Quote(string arg) {
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { slashes++; continue; }
      b.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); b.Append(c); slashes = 0;
    }
    b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
  }
  public static int Main(string[] args) {
    string mode = Path.GetFileNameWithoutExtension(System.Reflection.Assembly.GetExecutingAssembly().Location);
    var command = Quote(Environment.GetEnvironmentVariable("AGENTRIX_FAKE_CLI")) + " " + mode;
    foreach (string arg in args) command += " " + Quote(arg);
    var p = Process.Start(new ProcessStartInfo(Environment.GetEnvironmentVariable("AGENTRIX_FAKE_NODE"), command) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
    });
    var input = new Thread(() => { try { string line; while ((line = Console.ReadLine()) != null) p.StandardInput.WriteLine(line); p.StandardInput.Close(); } catch {} });
    input.IsBackground = true; input.Start();
    var errors = new Thread(() => { try { p.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); } catch {} });
    errors.IsBackground = true; errors.Start();
    p.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); p.WaitForExit(); return p.ExitCode;
  }
}`;
module.exports = { source };
