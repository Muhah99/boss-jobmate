﻿using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("boss-jobmate")]
[assembly: AssemblyProduct("boss-jobmate")]
[assembly: AssemblyDescription("boss-jobmate portable launcher")]
[assembly: AssemblyVersion("0.5.2.128")]
[assembly: AssemblyFileVersion("0.5.2.128")]
[assembly: AssemblyInformationalVersion("0.5.2")]

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "runtime", "launch.mjs");
            string node = Path.Combine(root, "runtime", "node", "node.exe");
            if (!File.Exists(node)) throw new FileNotFoundException("运行组件不完整，请完整解压软件包（缺少 runtime/node/node.exe）。");
            if (!File.Exists(script))
                throw new FileNotFoundException("\u542f\u52a8\u6587\u4ef6\u4e0d\u5b8c\u6574\uff0c\u8bf7\u5b8c\u6574\u89e3\u538b ZIP \u540e\u91cd\u8bd5\uff08\u7f3a\u5c11 runtime/launch.mjs\uff09\u3002");

            var start = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "\"" + script + "\" open",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            using (Process child = Process.Start(start))
            {
                var output = child.StandardOutput.ReadToEndAsync();
                var error = child.StandardError.ReadToEndAsync();
                child.WaitForExit();
                string details = error.Result.Trim();
                output.Wait();
                if (child.ExitCode != 0)
                    throw new InvalidOperationException(details.Length > 0 ? details : "\u8bf7\u67e5\u770b\u672c\u5305 data\\logs\\web-error.log\u3002");
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("\u672a\u80fd\u6253\u5f00 boss-jobmate\u3002\n\n" + error.Message,
                "boss-jobmate", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
