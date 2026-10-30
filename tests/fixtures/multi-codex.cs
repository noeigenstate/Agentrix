// Offline fixture: distinct interactive identities, no model requests.
using System;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

class MultiCodexFixture {
    static void Main(string[] args) {
        if (args.Length > 0 && args[0] == "app-server") return;
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
