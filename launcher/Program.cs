using System.Diagnostics;
using System.Net.Http;

const int DefaultPort = 4174;
const string DefaultHost = "127.0.0.1";

var appDir = AppContext.BaseDirectory;
var dataDir = Path.Combine(appDir, "data");
var logPath = Path.Combine(dataDir, "gifm-server.log");
var nodePath = Path.Combine(appDir, "node", "node.exe");
var serverPath = Path.Combine(appDir, "server", "index.js");
var port = ParsePositiveInteger(Environment.GetEnvironmentVariable("GIFM_PORT"), DefaultPort);
var host = NormalizeHost(Environment.GetEnvironmentVariable("GIFM_HOST"));
var url = $"http://{HostForUrl(host)}:{port}";
var openBrowser = Environment.GetEnvironmentVariable("GIFM_OPEN_BROWSER") != "0";
var smokeMode = Environment.GetEnvironmentVariable("GIFM_LAUNCHER_SMOKE") == "1";

Directory.CreateDirectory(dataDir);
using var logWriter = TextWriter.Synchronized(OpenSharedLog(logPath));
Log(logWriter, $"GIFM launcher starting from {appDir}");

if (await IsHealthy(url))
{
  Console.WriteLine($"GIFM is already running at {url}");
  if (openBrowser) OpenBrowser(url);
  return 0;
}

if (!File.Exists(nodePath))
{
  Console.Error.WriteLine($"Bundled Node runtime was not found: {nodePath}");
  return 1;
}

if (!File.Exists(serverPath))
{
  Console.Error.WriteLine($"GIFM server entry point was not found: {serverPath}");
  return 1;
}

using var server = StartServer(nodePath, serverPath, appDir, host, port, logWriter);
Console.CancelKeyPress += (_, eventArgs) =>
{
  eventArgs.Cancel = true;
  StopServer(server);
};

if (!await WaitForHealthy(url, TimeSpan.FromSeconds(20)))
{
  Console.Error.WriteLine($"GIFM did not become ready at {url}. See {logPath}");
  StopServer(server);
  return 1;
}

Console.WriteLine($"GIFM is running at {url}");
Console.WriteLine("Close this window or press Ctrl+C to stop GIFM.");
if (openBrowser) OpenBrowser(url);

if (smokeMode)
{
  StopServer(server);
  return 0;
}

await server.WaitForExitAsync();
return server.ExitCode;

static Process StartServer(string nodePath, string serverPath, string appDir, string host, int port, TextWriter logWriter)
{
  var startInfo = new ProcessStartInfo
  {
    FileName = nodePath,
    WorkingDirectory = appDir,
    UseShellExecute = false,
    RedirectStandardOutput = true,
    RedirectStandardError = true,
    CreateNoWindow = false
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
  Console.WriteLine(line);
  Log(logWriter, line);
}

static async Task<bool> WaitForHealthy(string url, TimeSpan timeout)
{
  var deadline = DateTimeOffset.UtcNow + timeout;
  while (DateTimeOffset.UtcNow < deadline)
  {
    if (await IsHealthy(url)) return true;
    await Task.Delay(300);
  }
  return false;
}

static async Task<bool> IsHealthy(string url)
{
  try
  {
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    using var response = await client.GetAsync($"{url}/api/health");
    return response.IsSuccessStatusCode;
  }
  catch
  {
    return false;
  }
}

static void OpenBrowser(string url)
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
    Console.Error.WriteLine($"Could not open browser: {error.Message}");
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
