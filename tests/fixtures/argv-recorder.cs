// Offline stand-in for a command-line program. It appends one JSON line to ARGV_RECORDER_FILE with the exact
// arguments it was started with (and its piped input when --with-api-key asks for one), then exits with 7.
using System;
using System.IO;
using System.Text;

class ArgvRecorder {
    static string Json(string value) {
        var text = new StringBuilder("\"");
        foreach (char character in value) text.Append("\\u").Append(((int)character).ToString("x4"));
        return text.Append('"').ToString();
    }
    static int Main(string[] args) {
        var input = Array.IndexOf(args, "--with-api-key") < 0 ? "null"
            : Json(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd());
        File.AppendAllText(Environment.GetEnvironmentVariable("ARGV_RECORDER_FILE"),
            "{\"args\":[" + String.Join(",", Array.ConvertAll(args, Json)) + "],\"input\":" + input + "}\n");
        Console.WriteLine("ARGV_RECORDER_RAN");
        return 7;
    }
}
