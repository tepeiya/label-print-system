using System.Security.Cryptography;
using System.Runtime.Versioning;
using System.Text;

namespace LabelFlow.PrintAgent;

/// <summary>
/// 本地敏感信息仓库：登录密码与代理签名 secret。
///
/// Windows 上走 DPAPI **LocalMachine** 范围：代理通常以计划任务/服务（SYSTEM）身份运行，
/// 而 --set-password 是管理员手工跑的，CurrentUser 范围两边对不上、服务会解不开。
/// 机器范围意味着"本机管理员可解"——这是可接受的边界（文件本身还在受 ACL 保护的程序目录里）。
/// </summary>
public sealed class SecretStore
{
    private readonly string _path;
    private readonly Logger _log;

    public SecretStore(string dataDir, Logger log)
    {
        _log = log;
        Directory.CreateDirectory(dataDir);
        _path = Path.Combine(dataDir, "secrets.dat");
    }

    public Dictionary<string, string> Load()
    {
        if (!File.Exists(_path)) return new Dictionary<string, string>();
        try
        {
            var raw = File.ReadAllBytes(_path);
            var text = OperatingSystem.IsWindows() ? Encoding.UTF8.GetString(UnprotectWindows(raw)) : Encoding.UTF8.GetString(raw);
            var dict = new Dictionary<string, string>();
            foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var i = line.IndexOf('=');
                if (i <= 0) continue;
                dict[line[..i]] = line[(i + 1)..];
            }
            return dict;
        }
        catch (Exception ex)
        {
            _log.Warn($"secrets.dat 读取失败（按空仓库处理）：{ex.Message}");
            return new Dictionary<string, string>();
        }
    }

    public void Save(Dictionary<string, string> dict)
    {
        var text = string.Join("\n", dict.Select(kv => $"{kv.Key}={kv.Value}"));
        var bytes = OperatingSystem.IsWindows() ? ProtectWindows(Encoding.UTF8.GetBytes(text)) : Encoding.UTF8.GetBytes(text);
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, _path, overwrite: true);
    }

    [SupportedOSPlatform("windows")]
    private static byte[] ProtectWindows(byte[] plain)
        => ProtectedData.Protect(plain, null, DataProtectionScope.LocalMachine);

    [SupportedOSPlatform("windows")]
    private static byte[] UnprotectWindows(byte[] cipher)
        => ProtectedData.Unprotect(cipher, null, DataProtectionScope.LocalMachine);
}
