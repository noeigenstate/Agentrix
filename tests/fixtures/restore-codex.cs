// Offline desktop fixture. It never invokes Codex or sends model requests.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class RestoreCodexFixture {
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
        Console.OutputEncoding = new UTF8Encoding(false);
        var receipt = new { cwd = Directory.GetCurrentDirectory(), args = args };
        File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(), "resume-receipt.json"), new JavaScriptSerializer().Serialize(receipt), new UTF8Encoding(false));
        Console.WriteLine("COPY_SAMPLE_START");
        for (int i = 0; i < 150; i++) Console.WriteLine("scrollback line " + i);
        Console.WriteLine("COPY_SAMPLE_END 中文可复制");
        Console.WriteLine("RESTORE_FIXTURE_READY");
        while (true) {
            var key = Console.ReadKey(true);
            File.AppendAllText(Path.Combine(Directory.GetCurrentDirectory(), "key-receipt.jsonl"), new JavaScriptSerializer().Serialize(new { key = key.Key.ToString(), character = (int)key.KeyChar, modifiers = key.Modifiers.ToString() }) + "\n", new UTF8Encoding(false));
        }
    }
}
