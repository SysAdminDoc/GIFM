using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    const int DefaultPort = 4174;
    const string DefaultHost = "127.0.0.1";

    [STAThread]
    static int Main(string[] args)
    {
        return Run(args);
    }

    static int Run(string[] args)
    {
        var importFile = args.FirstOrDefault(arg => !arg.StartsWith('-') && File.Exists(arg));
        var appDir = AppContext.BaseDirectory;
        var dataDir = Path.Combine(appDir, "data");
        var logPath = Path.Combine(dataDir, "gifm-server.log");
        var webViewDataDir = Path.Combine(dataDir, "webview2");
        var nodePath = Path.Combine(appDir, "node", "node.exe");
        var serverPath = Path.Combine(appDir, "server", "index.js");
        var port = ParsePositiveInteger(Environment.GetEnvironmentVariable("GIFM_PORT"), DefaultPort);
        var host = NormalizeHost(Environment.GetEnvironmentVariable("GIFM_HOST"));
        var url = $"http://{HostForUrl(host)}:{port}";
        var smokeMode = Environment.GetEnvironmentVariable("GIFM_LAUNCHER_SMOKE") == "1";

        Directory.CreateDirectory(dataDir);
        Directory.CreateDirectory(webViewDataDir);

        using var logWriter = TextWriter.Synchronized(OpenSharedLog(logPath));
        Log(logWriter, $"GIFM desktop starting from {appDir}");

        Process? server = null;
        var startedServer = false;

        try
        {
            if (!IsHealthy(url))
            {
                if (!File.Exists(nodePath))
                {
                    return Fatal(smokeMode, logWriter, $"Bundled Node runtime was not found: {nodePath}");
                }

                if (!File.Exists(serverPath))
                {
                    return Fatal(smokeMode, logWriter, $"GIFM server entry point was not found: {serverPath}");
                }

                server = StartServer(nodePath, serverPath, appDir, host, port, logWriter);
                startedServer = true;

                if (!WaitForHealthy(url, TimeSpan.FromSeconds(20)))
                {
                    return Fatal(smokeMode, logWriter, $"GIFM did not become ready at {url}. See {logPath}");
                }
            }

            Log(logWriter, $"GIFM ready at {url}");

            if (importFile is not null)
            {
                ImportLocalFile(url, importFile, logWriter);
            }

            if (smokeMode)
            {
                return 0;
            }

            EnsureWebView2Runtime(appDir, logWriter);
            ApplicationConfiguration.Initialize();
            return RunDesktopShell(url, webViewDataDir, logWriter, server, startedServer);
        }
        catch (Exception error)
        {
            Log(logWriter, $"Fatal launcher error: {error}");
            if (!smokeMode)
            {
                MessageBox.Show(
                  $"GIFM could not start.\n\n{error.Message}\n\nDetails were written to:\n{logPath}",
                  "GIFM",
                  MessageBoxButtons.OK,
                  MessageBoxIcon.Error);
            }

            return 1;
        }
        finally
        {
            if (startedServer && server is not null)
            {
                StopServer(server);
            }
        }
    }

    static void EnsureWebView2Runtime(string appDir, TextWriter logWriter)
    {
        try
        {
            var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (!string.IsNullOrEmpty(version))
            {
                Log(logWriter, $"WebView2 runtime {version} detected.");
                return;
            }
        }
        catch (Exception error)
        {
            Log(logWriter, $"WebView2 runtime not detected: {error.Message}");
        }

        var bootstrapper = Path.Combine(appDir, "MicrosoftEdgeWebview2Setup.exe");
        if (!File.Exists(bootstrapper))
        {
            Log(logWriter, "WebView2 runtime missing and no bundled bootstrapper was found; the desktop shell may fail to load.");
            return;
        }

        try
        {
            Log(logWriter, "Installing the Microsoft Edge WebView2 Runtime via the bundled bootstrapper...");
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = bootstrapper,
                Arguments = "/silent /install",
                UseShellExecute = true
            });
            if (process is not null)
            {
                process.WaitForExit(180000);
                Log(logWriter, process.HasExited ? $"WebView2 bootstrapper exited with {process.ExitCode}." : "WebView2 bootstrapper timed out.");
            }
        }
        catch (Exception error)
        {
            Log(logWriter, $"WebView2 bootstrapper failed: {error.Message}");
        }
    }

    static int RunDesktopShell(string url, string webViewDataDir, TextWriter logWriter, Process? server, bool startedServer)
    {
        using var form = new Form
        {
            Text = "GIFM v0.4.0",
            StartPosition = FormStartPosition.CenterScreen,
            BackColor = Color.FromArgb(11, 15, 20),
            ForeColor = Color.FromArgb(229, 235, 246),
            Width = 1280,
            Height = 860,
            MinimumSize = new Size(1024, 700)
        };

        var loadingLabel = new Label
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            Text = "Starting GIFM...",
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 12F, FontStyle.Regular, GraphicsUnit.Point),
            ForeColor = Color.FromArgb(189, 198, 214),
            BackColor = Color.FromArgb(11, 15, 20)
        };

        var webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(11, 15, 20)
        };

        form.Controls.Add(webView);
        form.Controls.Add(loadingLabel);
        loadingLabel.BringToFront();

        if (startedServer && server is not null)
        {
            server.EnableRaisingEvents = true;
            server.Exited += (_, _) =>
            {
                Log(logWriter, $"GIFM server exited with code {server.ExitCode}");
                if (form.IsDisposed || !form.IsHandleCreated) return;
                form.BeginInvoke(() =>
        {
                  MessageBox.Show(
            "GIFM's local processing service stopped unexpectedly. Relaunch GIFM to start a fresh session.",
            "GIFM",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
                  form.Close();
              });
            };
        }

        form.Shown += async (_, _) =>
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: webViewDataDir);
                await webView.EnsureCoreWebView2Async(environment);
                webView.CoreWebView2.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("GIFM_DEVTOOLS") == "1";
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NavigationStarting += (_, eventArgs) =>
          {
                if (IsAllowedNavigation(url, eventArgs.Uri)) return;
                eventArgs.Cancel = true;
                OpenExternal(eventArgs.Uri, logWriter);
            };
                webView.CoreWebView2.ProcessFailed += (_, eventArgs) =>
          {
                Log(logWriter, $"WebView2 process failed: {eventArgs.ProcessFailedKind}");
            };
                webView.CoreWebView2.NavigationCompleted += (_, eventArgs) =>
          {
                if (eventArgs.IsSuccess)
                {
                    loadingLabel.Visible = false;
                    webView.BringToFront();
                    return;
                }

                loadingLabel.Text = "GIFM could not load the desktop interface. Relaunch GIFM to retry.";
                Log(logWriter, $"WebView2 navigation failed: {eventArgs.WebErrorStatus}");
            };
                Log(logWriter, "WebView2 initialized");
                webView.CoreWebView2.Navigate(url);
            }
            catch (Exception error)
            {
                Log(logWriter, $"WebView2 startup failed: {error}");
                MessageBox.Show(
            "GIFM needs the Microsoft Edge WebView2 Runtime to open as a desktop app.\n\nInstall WebView2 Runtime, then relaunch GIFM.",
            "GIFM",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
                form.Close();
            }
        };

        Application.Run(form);
        return 0;
    }

    static Process StartServer(string nodePath, string serverPath, string appDir, string host, int port, TextWriter logWriter)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = appDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        startInfo.ArgumentList.Add(serverPath);
        startInfo.Environment["GIFM_PORT"] = port.ToString();
        startInfo.Environment["GIFM_HOST"] = host;

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };
        process.OutputDataReceived += (_, eventArgs) => WriteServerLine(logWriter, eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => WriteServerLine(logWriter, eventArgs.Data);

        if (!process.Start())
        {
            throw new InvalidOperationException("GIFM server process did not start.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    static void WriteServerLine(TextWriter logWriter, string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        Log(logWriter, line);
    }

    static bool WaitForHealthy(string url, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (IsHealthy(url)) return true;
            Thread.Sleep(300);
        }
        return false;
    }

    static void ImportLocalFile(string url, string filePath, TextWriter logWriter)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
            var payload = JsonSerializer.Serialize(new { path = Path.GetFullPath(filePath) });
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var response = client.PostAsync($"{url}/api/import-local", content).GetAwaiter().GetResult();
            Log(logWriter, $"Shell import of '{filePath}' -> {(int)response.StatusCode}");
        }
        catch (Exception error)
        {
            Log(logWriter, $"Shell import failed for '{filePath}': {error.Message}");
        }
    }

    static bool IsHealthy(string url)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = client.GetAsync($"{url}/api/health").GetAwaiter().GetResult();
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    static void OpenExternal(string url, TextWriter logWriter)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch (Exception error)
        {
            Log(logWriter, $"Could not open external URL {url}: {error.Message}");
        }
    }

    static void StopServer(Process server)
    {
        try
        {
            if (!server.HasExited)
            {
                server.Kill(entireProcessTree: true);
                server.WaitForExit(5000);
            }
        }
        catch
        {
            // The process may already be exiting.
        }
    }

    static int Fatal(bool smokeMode, TextWriter logWriter, string message)
    {
        Log(logWriter, message);
        if (!smokeMode)
        {
            MessageBox.Show(message, "GIFM", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        return 1;
    }

    static void Log(TextWriter logWriter, string message)
    {
        logWriter.WriteLine($"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}] {message}");
    }

    static StreamWriter OpenSharedLog(string logPath)
    {
        var stream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        return new StreamWriter(stream) { AutoFlush = true };
    }

    static int ParsePositiveInteger(string? value, int fallback)
    {
        return int.TryParse(value, out var number) && number > 0 ? number : fallback;
    }

    static string NormalizeHost(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? DefaultHost : value.Trim();
    }

    static string HostForUrl(string host)
    {
        if (host is "0.0.0.0" or "::") return DefaultHost;
        return host.Contains(':') && !host.StartsWith('[') ? $"[{host}]" : host;
    }

    static bool IsAllowedNavigation(string appUrl, string requestedUrl)
    {
        return Uri.TryCreate(appUrl, UriKind.Absolute, out var appUri)
          && Uri.TryCreate(requestedUrl, UriKind.Absolute, out var requestedUri)
          && string.Equals(appUri.Scheme, requestedUri.Scheme, StringComparison.OrdinalIgnoreCase)
          && string.Equals(appUri.Host, requestedUri.Host, StringComparison.OrdinalIgnoreCase)
          && appUri.Port == requestedUri.Port;
    }
}
