using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace LabelFlow.PrintAgent;

public sealed class AgentApiException : Exception
{
    public int HttpStatus { get; }
    public int BizCode { get; }
    public AgentApiException(string message, int httpStatus, int bizCode) : base(message)
    {
        HttpStatus = httpStatus;
        BizCode = bizCode;
    }
    public bool IsAuth => HttpStatus == 401 || BizCode == 401;
}

/// <summary>
/// 服务端接口客户端。只暴露代理需要的 5 个动作，全部主动出站（不监听端口、不需要公网 IP）。
///
/// 认证：走租户账号 JWT（后端 /hardware/* 是 TenantGuard + @Roles(admin, operator)）。
/// token 2h 过期 —— 这里在剩余不足 5 分钟时主动重登，避免打到一半 401 把任务卡住。
/// </summary>
public sealed class ApiClient
{
    private readonly AgentConfig _cfg;
    private readonly Logger _log;
    private readonly HttpClient _http;
    private readonly SecretStore _secrets;
    private string? _token;
    private long _tokenExpireAtUnix = 0;
    private string? _agentSecret;

    public ApiClient(AgentConfig cfg, Logger log, SecretStore secrets)
    {
        _cfg = cfg;
        _log = log;
        _secrets = secrets;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    public void LoadAgentSecret()
    {
        var dict = _secrets.Load();
        _agentSecret = dict.TryGetValue("agentSecret", out var v) ? v : null;
    }

    public bool HasAgentSecret => !string.IsNullOrEmpty(_agentSecret);

    // ------------------------------------------------------------------ 登录

    public async Task LoginAsync(CancellationToken ct = default)
    {
        var body = JsonSerializer.Serialize(new { username = _cfg.Username, password = ResolvePassword() });
        var data = await SendRawAsync(HttpMethod.Post, "/auth/login", body, signed: false, ct)
                   ?? throw new AgentApiException("登录返回为空", 500, 500);

        var token = data is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("accessToken", out var t) ? t.GetString() : null;
        if (string.IsNullOrEmpty(token)) throw new AgentApiException("登录成功但没拿到 accessToken", 500, 500);

        _token = token;
        // 后端 platform/tenant 登录默认 2h；按 110 分钟保守算，剩余不足 5 分钟就重登
        _tokenExpireAtUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 110 * 60;
        _log.Info($"登录成功：租户 {_cfg.TenantId} / {_cfg.Username}");
    }

    private string ResolvePassword()
    {
        var dict = _secrets.Load();
        if (dict.TryGetValue("password", out var saved) && saved.Length > 0) return saved;
        if (!string.IsNullOrEmpty(_cfg.Password))
        {
            dict["password"] = _cfg.Password;
            _secrets.Save(dict);
            _cfg.Password = "";
            PersistConfigWithoutPassword();
            return dict["password"];
        }
        throw new ArgumentException("没有可用密码：先运行一次 `LabelFlow.PrintAgent --set-password` 或把 password 写进配置后删除");
    }

    /// <summary>把配置里的 password 擦掉并回写（避免明文长期躺在 agent.json）</summary>
    private void PersistConfigWithoutPassword()
    {
        try
        {
            // UnsafeRelaxedJsonEscaping：否则中文名会被转成 \uXXXX，现场改配置看不懂
            var json = JsonSerializer.Serialize(_cfg, new JsonSerializerOptions
            {
                WriteIndented = true,
                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            });
            File.WriteAllText(_cfg.ConfigPath, json);
            _log.Warn("已把 agent.json 里的 password 迁移到 DPAPI 仓库并擦除明文");
        }
        catch (Exception ex)
        {
            _log.Warn($"回写配置失败（不影响运行）：{ex.Message}");
        }
    }

    private async Task EnsureTokenAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (_token == null || now >= _tokenExpireAtUnix - 300) await LoginAsync(ct);
    }

    // ------------------------------------------------------------------ 注册

    /// <summary>
    /// 注册/重新注册：服务端每次都会轮换 secret（旧 secret 立即失效），所以这里必须立刻存下来。
    /// 只在下述情况注册：本地没有 secret、或服务端返回"代理未注册"。
    /// </summary>
    public async Task RegisterAsync(CancellationToken ct = default)
    {
        await EnsureTokenAsync(ct);
        var body = JsonSerializer.Serialize(new
        {
            agentId = _cfg.AgentId,
            name = _cfg.AgentName,
            capabilities = new[] { "windows_spooler" },
            driverNames = _cfg.DriverNames,
            metadata = new
            {
                host = Environment.MachineName,
                os = OperatingSystem.IsWindows() ? "windows" : "non-windows",
                runtime = Environment.Version.ToString(),
                version = "1.0",
            },
        });
        var data = await SendRawAsync(HttpMethod.Post, "/hardware/agents/register", body, signed: false, ct);
        if (data == null) throw new AgentApiException("注册返回为空", 500, 500);

        var secret = data is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("secret", out var s) ? s.GetString() : null;
        if (string.IsNullOrEmpty(secret)) throw new AgentApiException("注册成功但没返回 secret", 500, 500);

        _agentSecret = secret;
        var dict = _secrets.Load();
        dict["agentSecret"] = secret;
        _secrets.Save(dict);
        _log.Info($"已注册代理 {_cfg.AgentId}（secret 已保存到本地 DPAPI 仓库）");
    }

    // ------------------------------------------------------------------ 心跳 / 拉取 / 回执

    public async Task<(bool ok, int pending, string? reason)> HeartbeatAsync(int load, CancellationToken ct = default)
    {
        await EnsureTokenAsync(ct);
        var body = JsonSerializer.Serialize(new
        {
            version = "1.0", load, draining = false, capabilities = new[] { "windows_spooler" },
        });
        try
        {
            var data = await SendRawAsync(HttpMethod.Post, $"/hardware/agents/{Uri.EscapeDataString(_cfg.AgentId)}/heartbeat", body, signed: true, ct);
            var pending = 0;
            if (data is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("pending", out var p) && p.ValueKind == JsonValueKind.Number)
                pending = p.GetInt32();
            return (true, pending, null);
        }
        catch (AgentApiException ex) when (ex.BizCode == 404)
        {
            return (false, 0, "代理未注册");
        }
    }

    public sealed record PulledJob(string JobKey, AgentJobEnvelope Envelope);

    public async Task<List<PulledJob>> PullAsync(CancellationToken ct = default)
    {
        await EnsureTokenAsync(ct);
        var body = JsonSerializer.Serialize(new { limit = _cfg.PullLimit });
        try
        {
            var data = await SendRawAsync(HttpMethod.Post, $"/hardware/agents/{Uri.EscapeDataString(_cfg.AgentId)}/jobs/pull", body, signed: true, ct);
            var list = new List<PulledJob>();
            if (data is not { ValueKind: JsonValueKind.Object } root) return list;
            if (!root.TryGetProperty("jobs", out var jobs) || jobs.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in jobs.EnumerateArray())
            {
                var key = item.TryGetProperty("jobKey", out var k) ? k.GetString() ?? "" : "";
                if (!item.TryGetProperty("envelope", out var envNode)) continue;
                var env = JsonSerializer.Deserialize<AgentJobEnvelope>(envNode.GetRawText(), JsonOpts.CaseInsensitive);
                if (env != null && key.Length > 0) list.Add(new PulledJob(key, env));
            }
            return list;
        }
        catch (AgentApiException ex) when (ex.BizCode == 404)
        {
            throw new AgentApiException("代理未注册，需要重新注册", ex.HttpStatus, ex.BizCode);
        }
    }

    public async Task ReceiptAsync(string jobKey, string status, int printedCount, string? error, CancellationToken ct = default)
    {
        await EnsureTokenAsync(ct);
        var body = JsonSerializer.Serialize(new
        {
            jobKey, status, printedCount,
            error = error is { Length: > 500 } ? error[..500] : error,
            // 固定毫秒精度 + UTC：MySQL datetime 只到毫秒，7 位小数会被静默截断
            at = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
        });
        await SendRawAsync(HttpMethod.Post, $"/hardware/agents/{Uri.EscapeDataString(_cfg.AgentId)}/receipts", body, signed: true, ct);
    }

    // ------------------------------------------------------------------ 底层

    /// <summary>
    /// 发请求并拆 {code,message,data} 信封；成功返回 data，失败抛 AgentApiException。
    /// 401 时不在这里重试 —— 调用方拿到的 IsAuth 由外层决定重登后重试一次（避免递归打爆）。
    /// </summary>
    private async Task<JsonElement?> SendRawAsync(HttpMethod method, string path, string bodyRaw, bool signed, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, _cfg.ServerApiBase + path);
        req.Content = new StringContent(bodyRaw, Encoding.UTF8, "application/json");
        if (_token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        if (signed && _cfg.SignatureEnabled)
        {
            if (string.IsNullOrEmpty(_agentSecret)) throw new AgentApiException("签名已启用但本地没有 secret，请重新注册", 400, 400);
            var (ts, sig) = Signer.Sign(bodyRaw, _agentSecret!);
            req.Headers.Add("x-labelflow-timestamp", ts);
            req.Headers.Add("x-labelflow-signature", sig);
        }

        HttpResponseMessage res;
        try
        {
            res = await _http.SendAsync(req, ct);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new AgentApiException($"请求超时：{path}", 0, 0);
        }
        catch (HttpRequestException ex)
        {
            throw new AgentApiException($"网络不可达：{path} | {ex.Message}", 0, 0);
        }

        var text = await res.Content.ReadAsStringAsync(ct);
        JsonElement root;
        try { root = JsonSerializer.Deserialize<JsonElement>(text); }
        catch { throw new AgentApiException($"响应不是 JSON（HTTP {res.StatusCode}）：{text[..Math.Min(text.Length, 200)]}", (int)res.StatusCode, (int)res.StatusCode); }

        var bizCode = root.TryGetProperty("code", out var c) ? c.GetInt32() : (int)res.StatusCode;
        var message = root.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
        // 后端登录是 201，其它是 200 —— 统一按 2xx 判成功，别只认 200
        if (!((int)res.StatusCode is >= 200 and < 300) || bizCode != 0)
            throw new AgentApiException(message.Length > 0 ? message : $"HTTP {res.StatusCode}", (int)res.StatusCode, bizCode);

        return root.TryGetProperty("data", out var d) ? d : null;
    }
}

public static class JsonOpts
{
    public static readonly JsonSerializerOptions CaseInsensitive = new() { PropertyNameCaseInsensitive = true };
}

/// <summary>服务端下发的任务信封（字段名与 agent-protocol.calc.ts#AgentJobEnvelope 对齐）</summary>
public sealed class AgentJobEnvelope
{
    public string Version { get; set; } = "";
    public string JobKey { get; set; } = "";
    public int TenantId { get; set; }
    public int JobId { get; set; }
    public int? PrinterId { get; set; }
    public int? TemplateId { get; set; }
    public string Capability { get; set; } = "";
    public string? DriverName { get; set; }
    public List<LabelFrame> Labels { get; set; } = new();
    public JobSettings Settings { get; set; } = new();
    public string CreatedAt { get; set; } = "";
    public List<string> RedactedFields { get; set; } = new();
}

public sealed class LabelFrame
{
    /// <summary>zpl | tspl | epl | png-base64 | pdf-base64</summary>
    public string Format { get; set; } = "";
    public string Data { get; set; } = "";
    public int Copies { get; set; } = 1;
}

public sealed class JobSettings
{
    public int Dpi { get; set; } = 203;
    public double WidthMm { get; set; }
    public double HeightMm { get; set; }
    public double OffsetXMm { get; set; }
    public double OffsetYMm { get; set; }
    public int Orientation { get; set; }
    public double GapMm { get; set; } = 2;
    public double? Density { get; set; }
    public double? Speed { get; set; }
}
