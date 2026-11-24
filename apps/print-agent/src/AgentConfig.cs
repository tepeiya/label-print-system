using System.Text.Json;
using System.Text.Json.Serialization;

namespace LabelFlow.PrintAgent;

/// <summary>
/// 代理配置（%PROGRAMDATA%\LabelFlow\agent.json）。
/// 密码不落在这里的明文里：首次启动交互输入或用 --password 传参，随后写进 secret 仓库（DPAPI）。
/// </summary>
public sealed class AgentConfig
{
    /// <summary>服务端根地址，不带 /api/v1（客户端自己拼）。例：https://labelflow.example.com</summary>
    public string ServerBaseUrl { get; set; } = "http://127.0.0.1:3200";

    /// <summary>租户 ID（注册与所有接口都要求显式租户，后端 TenantGuard 靠它定位）</summary>
    public int TenantId { get; set; }

    /// <summary>代理用的租户账号，建议单独开一个 operator 账号，不要用 admin</summary>
    public string Username { get; set; } = "";

    /// <summary>仅首次配置时用；落盘前会被擦掉并转存到 secret 仓库</summary>
    public string Password { get; set; } = "";

    /// <summary>代理唯一标识：3~64 位字母数字/._:-，以字母数字开头</summary>
    public string AgentId { get; set; } = "";

    public string AgentName { get; set; } = "LabelFlow 本地打印代理";

    /// <summary>
    /// 本机 Windows 打印队列名，必须与服务端该打印机配置里的 driverName 完全一致。
    /// 信封里只下发 driverName（connection 的 host/密码已被服务端白名单脱敏），所以这里是唯一线索。
    /// </summary>
    public List<string> DriverNames { get; set; } = new();

    /// <summary>拉取间隔（毫秒），默认 2000</summary>
    public int PollIntervalMs { get; set; } = 2000;

    /// <summary>心跳间隔（毫秒），默认 25000。服务端 90s 无心跳判离线，不再派任务</summary>
    public int HeartbeatIntervalMs { get; set; } = 25_000;

    /// <summary>数据目录（日志、幂等账本、secret）</summary>
    public string DataDir { get; set; } = DefaultDataDir();

    /// <summary>单次拉取上限（服务端还会再夹一次），默认 1 —— 串行打印更稳，不容易超认领租约</summary>
    public int PullLimit { get; set; } = 1;

    /// <summary>是否启用 HMAC 签名头（与服务端 HARDWARE_AGENT_SIGNATURE_REQUIRED 保持一致）</summary>
    public bool SignatureEnabled { get; set; } = false;

    /// <summary>
    /// 演练模式：只走完"拉取 → 回执"，不出纸。装机时先用它验证链路，再关掉真正打印。
    /// </summary>
    public bool DryRun { get; set; } = false;

    /// <summary>是否把整条信封写进日志（排查"打出来和预览不一样"时很有用，默认开）</summary>
    public bool LogEnvelope { get; set; } = true;

    [JsonIgnore]
    public string ServerApiBase => ServerBaseUrl.TrimEnd('/') + "/api/v1";

    public static string DefaultDataDir()
    {
        if (OperatingSystem.IsWindows())
        {
            var programData = Environment.GetEnvironmentVariable("PROGRAMDATA") ?? @"C:\ProgramData";
            return Path.Combine(programData, "LabelFlow");
        }
        // 非 Windows（仅用于本地跑逻辑/冒烟）落到用户目录，避免写 /var
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".labelflow-agent");
    }

    /// <summary>
    /// 读取配置：--config 指定路径（默认 DataDir 下的 agent.json；
    /// 首次运行若不存在则报错并给出示例，不在代码里造默认账号）。
    /// </summary>
    public static AgentConfig Load(string[] args)
    {
        var configPath = GetArg(args, "--config");
        var probe = new AgentConfig();
        if (!string.IsNullOrWhiteSpace(configPath)) probe.DataDir = Path.GetDirectoryName(Path.GetFullPath(configPath!)) ?? probe.DataDir;
        else configPath = Path.Combine(probe.DataDir, "agent.json");

        if (!File.Exists(configPath))
            throw new FileNotFoundException(
                $"找不到配置文件 {configPath}。先复制 agent.example.json 到该位置，填好服务器地址/租户/账号/打印队列名。");

        var json = File.ReadAllText(configPath);
        var cfg = JsonSerializer.Deserialize<AgentConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                  ?? throw new InvalidOperationException("配置解析失败");

        // 命令行参数可覆盖关键项（装机脚本/临时排查用）
        var tenant = GetArg(args, "--tenant");
        if (tenant != null) cfg.TenantId = int.Parse(tenant);
        var agentId = GetArg(args, "--agent-id");
        if (agentId != null) cfg.AgentId = agentId;
        if (args.Contains("--dry-run")) cfg.DryRun = true;

        // 校验：宁愿启动失败，也不要带着半截配置连服务端产生脏注册
        if (cfg.TenantId <= 0) throw new ArgumentException("tenantId 必须 > 0");
        if (string.IsNullOrWhiteSpace(cfg.AgentId)) throw new ArgumentException("agentId 不能为空");
        if (string.IsNullOrWhiteSpace(cfg.Username)) throw new ArgumentException("username 不能为空");
        if (cfg.DriverNames.Count == 0) throw new ArgumentException("driverNames 至少要有一个本地打印队列名");

        Directory.CreateDirectory(cfg.DataDir);
        cfg.ConfigPath = configPath;
        return cfg;
    }

    [JsonIgnore]
    public string ConfigPath { get; private set; } = "";

    private static string? GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (args[i] == name) return args[i + 1];
        return null;
    }
}
