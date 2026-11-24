using System.Text;

namespace LabelFlow.PrintAgent;

/// <summary>
/// 极简日志：控制台 + 文件（按大小滚动 10MB，保留 2 个历史）。
/// 为什么不用 Serilog/NLog：代理是"装到客户机器上就没人管"的程序，
/// 依赖越少越好，出问题时客户只需要发一个 agent.log 回来。
/// </summary>
public sealed class Logger
{
    private readonly object _gate = new();
    private readonly string _path;
    private const long MaxBytes = 10 * 1024 * 1024;

    public Logger(string dataDir)
    {
        Directory.CreateDirectory(dataDir);
        _path = Path.Combine(dataDir, "agent.log");
    }

    public void Info(string message) => Write("INFO ", message);
    public void Warn(string message) => Write("WARN ", message);
    public void Error(string message, Exception? ex = null)
        => Write("ERROR", ex == null ? message : $"{message} | {ex.GetType().Name}: {ex.Message}");

    private void Write(string level, string message)
    {
        var line = $"{DateTimeOffset.Now:yyyy-MM-ddTHH:mm:ss.fff+08:00} [{level}] {message}";
        lock (_gate)
        {
            Console.WriteLine(line);
            try
            {
                RotateIfNeeded();
                File.AppendAllText(_path, line + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
                // 日志写失败（磁盘满/权限）不能让代理停摆
            }
        }
    }

    private void RotateIfNeeded()
    {
        var fi = new FileInfo(_path);
        if (!fi.Exists || fi.Length < MaxBytes) return;
        var bak = _path + ".1";
        if (File.Exists(bak)) File.Delete(bak);
        File.Move(_path, bak);
    }
}
