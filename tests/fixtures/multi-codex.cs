// Offline fixture: distinct interactive identities, no model requests.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class MultiCodexFixture {
    static void Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length > 0 && args[0] == "app-server") {
            var driver = Environment.GetEnvironmentVariable("AGENTRIX_GUI_CODEX_RPC");
            var node = Environment.GetEnvironmentVariable("AGENTRIX_FAKE_NODE");
            if (String.IsNullOrEmpty(driver) || String.IsNullOrEmpty(node)) throw new Exception("GUI Codex protocol fixture was not injected");
            var start = new System.Diagnostics.ProcessStartInfo(node, "\"" + driver + "\" " + String.Join(" ", args));
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (var child = System.Diagnostics.Process.Start(start)) {
                var input = new Thread(() => { try { var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)); var writer = new StreamWriter(child.StandardInput.BaseStream, new UTF8Encoding(false)); writer.AutoFlush = true; string line; while ((line = reader.ReadLine()) != null) writer.WriteLine(line); writer.Close(); } catch {} });
                input.IsBackground = true; input.Start();
                var errors = new Thread(() => { try { child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()); } catch {} });
                errors.IsBackground = true; errors.Start();
                child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()); child.WaitForExit(); Environment.ExitCode = child.ExitCode;
            }
            return;
        }
        var id = Guid.NewGuid().ToString();
        for (int i = 0; i + 1 < args.Length; i++) {
            Guid candidate;
            if (args[i] == "resume" && Guid.TryParse(args[i + 1], out candidate)) id = candidate.ToString();
        }
        var folder = Path.Combine(Environment.GetEnvironmentVariable("CODEX_HOME"), "sessions");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "rollout-" + id + ".jsonl");
        var json = new JavaScriptSerializer();
        if (!File.Exists(file)) File.WriteAllText(file, json.Serialize(new { type = "session_meta", payload = new { id = id, cwd = Directory.GetCurrentDirectory(), source = "cli" } }) + "\n", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(folder, id + "-receipt.json"), json.Serialize(new { args = args }), new UTF8Encoding(false));
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.Write("\x1b]0;" + id + "\x07");
        Console.WriteLine("MULTI_FIXTURE_READY " + id);
        while (true) Console.ReadKey(true);
    }
}
