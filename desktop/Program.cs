using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    static Mutex appMutex;

    [STAThread]
    static void Main()
    {
        bool owned = false;
        appMutex = new Mutex(false, @"Local\Mineview.Desktop");
        try
        {
            owned = appMutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            owned = true;
        }
        if (!owned)
        {
            ActivateExisting();
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Shell());
    }

    static void ActivateExisting()
    {
        for (int i = 0; i < 30; i++)
        {
            IntPtr hwnd = FindWindow(null, "Mineview");
            if (hwnd != IntPtr.Zero)
            {
                ShowWindow(hwnd, 9);
                SetForegroundWindow(hwnd);
                return;
            }
            Thread.Sleep(100);
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);
}

sealed class Shell : Form
{
    readonly WebView2 view = new WebView2();
    readonly Label status = new Label();
    readonly string appDirectory = AppDomain.CurrentDomain.BaseDirectory;
    readonly CancellationTokenSource shutdown = new CancellationTokenSource();
    Process server;
    bool ownsServer;
    string appHost = "127.0.0.1";
    int appPort = 3847;

    public Shell()
    {
        Text = "Mineview";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1024, 680);
        Size = new Size(1280, 840);
        BackColor = Color.FromArgb(16, 20, 18);
        Font = new Font("Segoe UI", 10F);
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // The window still opens if the icon cannot be read.
        }
        RestoreBoundsFromDisk();

        status.Dock = DockStyle.Fill;
        status.TextAlign = ContentAlignment.MiddleCenter;
        status.ForeColor = Color.FromArgb(232, 236, 233);
        status.BackColor = Color.FromArgb(16, 20, 18);
        status.Text = "Starting Mineview…";
        Controls.Add(status);

        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Color.FromArgb(16, 20, 18);
        view.Visible = false;
        Controls.Add(view);

        Load += ShellLoad;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int on = 1;
            DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int));
        }
        catch
        {
            // Older Windows keeps the standard title bar.
        }
    }

    async void ShellLoad(object sender, EventArgs e)
    {
        string failure = await Task.Run(new Func<string>(PrepareServer));
        if (IsDisposed) return;
        if (failure != null)
        {
            MessageBox.Show(this, failure, "Mineview");
            Close();
            return;
        }
        try
        {
            string profile = Path.Combine(appDirectory, "data", "webview");
            Directory.CreateDirectory(profile);
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.Settings.AreDevToolsEnabled = false;
            view.CoreWebView2.Settings.IsStatusBarEnabled = false;
            view.CoreWebView2.Settings.IsSwipeNavigationEnabled = false;
            view.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            view.CoreWebView2.NewWindowRequested += NewWindowRequested;
            view.CoreWebView2.NavigationStarting += NavigationStarting;
            view.CoreWebView2.NavigationCompleted += NavigationCompleted;
            view.Visible = true;
            status.Visible = false;
            view.CoreWebView2.Navigate(AppUrl());
        }
        catch (Exception ex)
        {
            if (IsDisposed) return;
            MessageBox.Show(this, "Mineview could not open its window. " + ex.Message, "Mineview");
            Close();
        }
    }

    string PrepareServer()
    {
        ReadRuntime();
        if (Health()) return null;

        string serverPath = Path.Combine(appDirectory, "MineviewServer.exe");
        if (!File.Exists(serverPath))
        {
            return "Mineview could not find MineviewServer.exe next to the application.";
        }

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = serverPath;
        start.WorkingDirectory = appDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.EnvironmentVariables.Remove("PORT");
        start.EnvironmentVariables.Remove("HOST");
        start.EnvironmentVariables.Remove("DATA_DIR");
        start.EnvironmentVariables.Remove("MINEVIEW_ROOT");
        start.EnvironmentVariables["MINEVIEW_NO_BROWSER"] = "1";
        try
        {
            server = Process.Start(start);
        }
        catch (Exception ex)
        {
            return "Mineview could not start. " + ex.Message;
        }
        ownsServer = server != null;

        DateTime deadline = DateTime.UtcNow.AddSeconds(25);
        while (DateTime.UtcNow < deadline)
        {
            if (shutdown.IsCancellationRequested) return null;
            if (Health()) return null;
            if (server != null && server.HasExited && !Health())
            {
                ownsServer = false;
                return FailureFromLog("Mineview could not start.");
            }
            Thread.Sleep(200);
        }
        return FailureFromLog("Mineview could not start.");
    }

    void ReadRuntime()
    {
        appHost = "127.0.0.1";
        appPort = 3847;
        string file = Path.Combine(appDirectory, "data", "runtime.json");
        if (!File.Exists(file)) return;
        try
        {
            string json = File.ReadAllText(file);
            string host = JsonString(json, "host");
            if (!string.IsNullOrEmpty(host) && host != "0.0.0.0") appHost = host;
            int port = JsonInt(json, "port");
            if (port > 0 && port <= 65535) appPort = port;
        }
        catch
        {
            appHost = "127.0.0.1";
            appPort = 3847;
        }
    }

    static string JsonString(string json, string key)
    {
        string marker = "\"" + key + "\"";
        int at = json.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) return null;
        int quote = json.IndexOf('"', json.IndexOf(':', at + marker.Length) + 1);
        if (quote < 0) return null;
        int end = json.IndexOf('"', quote + 1);
        if (end < 0) return null;
        return json.Substring(quote + 1, end - quote - 1);
    }

    static int JsonInt(string json, string key)
    {
        string marker = "\"" + key + "\"";
        int at = json.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) return 0;
        int colon = json.IndexOf(':', at + marker.Length);
        if (colon < 0) return 0;
        int start = colon + 1;
        while (start < json.Length && char.IsWhiteSpace(json[start])) start++;
        int end = start;
        while (end < json.Length && char.IsDigit(json[end])) end++;
        int value;
        if (int.TryParse(json.Substring(start, end - start), out value)) return value;
        return 0;
    }

    string AppUrl()
    {
        return "http://" + appHost + ":" + appPort.ToString() + "/";
    }

    bool Health()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(AppUrl() + "api/health");
            request.Method = "GET";
            request.Timeout = 1200;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                return (int)response.StatusCode >= 200 && (int)response.StatusCode < 300;
            }
        }
        catch
        {
            return false;
        }
    }

    string FailureFromLog(string fallback)
    {
        try
        {
            string file = Path.Combine(appDirectory, "data", "app.log");
            if (!File.Exists(file)) return fallback;
            string[] lines = File.ReadAllLines(file);
            if (lines.Length == 0) return fallback;
            int count = Math.Min(6, lines.Length);
            string[] tail = new string[count];
            Array.Copy(lines, lines.Length - count, tail, 0, count);
            return fallback + Environment.NewLine + Environment.NewLine + string.Join(Environment.NewLine, tail);
        }
        catch
        {
            return fallback;
        }
    }

    void NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsAppNavigation(e.Uri)) return;
        e.Cancel = true;
        OpenExternal(e.Uri);
    }

    void NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (IsAppNavigation(e.Uri)) view.CoreWebView2.Navigate(e.Uri);
        else OpenExternal(e.Uri);
    }

    void NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            status.Visible = false;
            view.Visible = true;
            return;
        }
        status.Visible = true;
        view.Visible = false;
        status.Text = "Mineview could not open.";
    }

    bool IsAppNavigation(string uri)
    {
        Uri parsed;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out parsed)) return false;
        if (parsed.Scheme == "about") return true;
        if (parsed.Port != appPort) return false;
        if (parsed.IsLoopback) return true;
        return string.Equals(parsed.Host, appHost, StringComparison.OrdinalIgnoreCase);
    }

    static void OpenExternal(string uri)
    {
        Uri parsed;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out parsed)) return;
        if (parsed.Scheme != "https" && parsed.Scheme != "http") return;
        try
        {
            Process.Start(parsed.AbsoluteUri);
        }
        catch
        {
            // Leaving the page in the app window is worse than a failed handoff.
        }
    }

    void RestoreBoundsFromDisk()
    {
        string file = Path.Combine(appDirectory, "data", "window.txt");
        if (!File.Exists(file)) return;
        try
        {
            string[] parts = File.ReadAllText(file).Split(' ');
            if (parts.Length < 5) return;
            Rectangle bounds = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
            if (bounds.Width < MinimumSize.Width || bounds.Height < MinimumSize.Height) return;
            bool visible = false;
            foreach (Screen screen in Screen.AllScreens)
            {
                if (screen.WorkingArea.IntersectsWith(bounds)) visible = true;
            }
            if (!visible) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            if (parts[4] == "1") WindowState = FormWindowState.Maximized;
        }
        catch
        {
            StartPosition = FormStartPosition.CenterScreen;
        }
    }

    void SaveBounds()
    {
        try
        {
            Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            string maximized = WindowState == FormWindowState.Maximized ? "1" : "0";
            Directory.CreateDirectory(Path.Combine(appDirectory, "data"));
            File.WriteAllText(
                Path.Combine(appDirectory, "data", "window.txt"),
                bounds.X.ToString() + " " + bounds.Y.ToString() + " " + bounds.Width.ToString() + " " + bounds.Height.ToString() + " " + maximized);
        }
        catch
        {
            // The next launch uses the default size.
        }
    }

    void StopServer()
    {
        shutdown.Cancel();
        if (!ownsServer || server == null) return;
        try
        {
            if (!server.HasExited) server.Kill();
        }
        catch
        {
            // The server process has already gone.
        }
        ownsServer = false;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        SaveBounds();
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        StopServer();
        base.OnFormClosed(e);
        Environment.Exit(0);
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
