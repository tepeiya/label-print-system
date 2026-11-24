using System.Drawing.Printing;

namespace LabelFlow.PrintAgent;

/// <summary>
/// LabelFlow 本地打印代理（Windows）。
///
/// 用法：
///   LabelFlow.PrintAgent --set-password     交互输入密码，存到 DPAPI 仓库（不落明文）
///   LabelFlow.PrintAgent --doctor           体检：配置、登录、打印队列是否就绪（不打印）
///   LabelFlow.PrintAgent --register         强制重新注册（会轮换 secret，旧 secret 立刻失效）
///   LabelFlow.PrintAgent --once --dry-run   拉一轮任务但不出纸，验证链路
///   LabelFlow.PrintAgent                     常驻运行（推荐注册成 Windows 服务，见 install/）
/// </summary>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            var cfg = AgentConfig.Load(args);
            var log = new Logger(cfg.DataDir);
            var secrets = new SecretStore(cfg.DataDir, log);
            log.Info($"LabelFlow 打印代理启动：agentId={cfg.AgentId} tenant={cfg.TenantId} server={cfg.ServerBaseUrl}");

            // --set-password-stdin：给一行命令安装用（PowerShell 管道喂密码），不落命令行历史
            if (args.Contains("--set-password-stdin"))
            {
                var piped = Console.In.ReadLine();
                if (string.IsNullOrEmpty(piped)) throw new ArgumentException("标准输入没有读到密码");
                var d0 = secrets.Load();
                d0["password"] = piped;
                secrets.Save(d0);
                Console.WriteLine("已保存到本地 DPAPI 仓库。");
                return 0;
            }

            if (args.Contains("--set-password"))
            {
                Console.Write($"请输入 {cfg.Username} 的密码：");
                var pwd = ReadPassword();
                var dict = secrets.Load();
                dict["password"] = pwd;
                secrets.Save(dict);
                Console.WriteLine("\n已保存到本地 DPAPI 仓库（agent.json 里的 password 字段可以删掉）。");
                return 0;
            }

            var client = new ApiClient(cfg, log, secrets);
            client.LoadAgentSecret();

            if (args.Contains("--doctor")) return await DoctorAsync(cfg, client, log, secrets);

            if (!client.HasAgentSecret || args.Contains("--register"))
                await client.RegisterAsync();

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

            if (args.Contains("--once"))
            {
                await HeartbeatLoopOnceAsync(cfg, client, log, cts.Token);
                await PollOnceAsync(cfg, client, log, secrets, cts.Token);
                return 0;
            }

            // 常驻：心跳与拉取分开跑，任何一边失败都不拖死另一边
            var hb = HeartbeatLoopAsync(cfg, client, log, cts.Token);
            var poll = PollLoopAsync(cfg, client, log, secrets, cts.Token);
            await Task.WhenAll(hb, poll);
            log.Info("代理已停止");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"启动失败：{ex.Message}");
            return 1;
        }
    }

    // ------------------------------------------------------------------ 心跳

    private static async Task HeartbeatLoopAsync(AgentConfig cfg, ApiClient client, Logger log, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var (ok, pending, reason) = await client.HeartbeatAsync(load: 0, ct);
                if (!ok)
                {
                    log.Warn($"心跳被拒：{reason}，尝试重新注册");
                    await client.RegisterAsync(ct);
                }
                else if (pending > 0)
                {
                    log.Info($"服务端待打任务 {pending} 条");
                }
            }
            catch (AgentApiException ex) when (ex.IsAuth)
            {
                log.Warn("心跳 401，重新登录");
                await TryLoginAsync(client, log, ct);
            }
            catch (Exception ex)
            {
                log.Warn($"心跳失败（{cfg.HeartbeatIntervalMs}ms 后重试）：{ex.Message}");
            }
            await SafeDelay(cfg.HeartbeatIntervalMs, ct);
        }
    }

    private static async Task HeartbeatLoopOnceAsync(AgentConfig cfg, ApiClient client, Logger log, CancellationToken ct)
    {
        try
        {
            var (ok, pending, reason) = await client.HeartbeatAsync(0, ct);
            log.Info(ok ? $"心跳正常，待打任务 {pending} 条" : $"心跳被拒：{reason}");
        }
        catch (Exception ex)
        {
            log.Error("心跳失败", ex);
        }
    }

    // ------------------------------------------------------------------ 拉取与打印

    private static async Task PollLoopAsync(AgentConfig cfg, ApiClient client, Logger log, SecretStore secrets, CancellationToken ct)
    {
        var printer = new SpoolerPrinter(log);
        var ledger = new JobLedger(cfg.DataDir, log);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var jobs = await client.PullAsync(ct);
                foreach (var job in jobs)
                {
                    if (ct.IsCancellationRequested) break;
                    await HandleJobAsync(cfg, client, log, printer, ledger, job, ct);
                }
            }
            catch (AgentApiException ex) when (ex.IsAuth)
            {
                log.Warn("拉取 401，重新登录");
                await TryLoginAsync(client, log, ct);
            }
            catch (AgentApiException ex) when (ex.BizCode == 404)
            {
                log.Warn("代理未注册，自动注册");
                try { await client.RegisterAsync(ct); } catch (Exception e) { log.Error("自动注册失败", e); }
            }
            catch (Exception ex)
            {
                log.Warn($"拉取失败：{ex.Message}");
            }
            await SafeDelay(cfg.PollIntervalMs, ct);
        }
    }

    private static async Task PollOnceAsync(AgentConfig cfg, ApiClient client, Logger log, SecretStore secrets, CancellationToken ct)
    {
        var printer = new SpoolerPrinter(log);
        var ledger = new JobLedger(cfg.DataDir, log);
        var jobs = await client.PullAsync(ct);
        log.Info($"拉到 {jobs.Count} 条任务");
        foreach (var job in jobs) await HandleJobAsync(cfg, client, log, printer, ledger, job, ct);
    }

    private static async Task HandleJobAsync(
        AgentConfig cfg, ApiClient client, Logger log, SpoolerPrinter printer, JobLedger ledger,
        ApiClient.PulledJob job, CancellationToken ct)
    {
        var env = job.Envelope;
        log.Info($"收到任务 jobKey={job.JobKey} jobId={env.JobId} 帧数={env.Labels.Count} driver={env.DriverName ?? "(空)"}");
        if (cfg.LogEnvelope)
            log.Info($"信封摘要：capability={env.Capability} settings={env.Settings.Dpi}dpi {env.Settings.WidthMm}×{env.Settings.HeightMm}mm redacted=[{string.Join(',', env.RedactedFields)}]");

        // 1) 本地幂等：之前已经打成功过就不再出纸，直接回执
        if (ledger.HasPrinted(job.JobKey))
        {
            log.Warn($"jobKey={job.JobKey} 本地账本已记录成功，跳过打印（防重复出纸）");
            await SafeReceipt(client, log, job.JobKey, "succeeded", 0, null, ct);
            return;
        }

        // 2) 解析目标队列
        var driver = ResolveDriver(cfg, env.DriverName);
        if (driver == null)
        {
            var msg = $"本机没有可用的打印队列（任务要求「{env.DriverName}」，配置列表 [{string.Join(',', cfg.DriverNames)}]）";
            log.Error(msg);
            await SafeReceipt(client, log, job.JobKey, "failed", 0, msg, ct);
            return;
        }

        // 3) 先报 printing（状态机 claimed → printing；也告诉服务端"我接了"）
        await SafeReceipt(client, log, job.JobKey, "printing", 0, null, ct);

        if (cfg.DryRun)
        {
            log.Warn("DryRun 模式：不出纸，直接回执成功");
            await SafeReceipt(client, log, job.JobKey, "succeeded", 0, null, ct);
            return;
        }

        // 4) 逐帧打印（串行，任何一帧失败即整单失败，避免"打一半"变成部分成功）
        var printed = 0;
        string? error = null;
        foreach (var frame in env.Labels)
        {
            error = printer.Print(driver, frame, env.Settings);
            if (error != null) break;
            printed += Math.Max(1, frame.Copies);
        }

        // 5) 回执：成功记账本；失败把原因带回去（服务端会按 attempts 决定重派或置 expired）
        if (error == null)
        {
            ledger.MarkPrinted(job.JobKey);
            log.Info($"任务 {job.JobKey} 打印成功，共 {printed} 份");
            await SafeReceipt(client, log, job.JobKey, "succeeded", printed, null, ct);
        }
        else
        {
            log.Error($"任务 {job.JobKey} 打印失败：{error}");
            await SafeReceipt(client, log, job.JobKey, "failed", printed, error, ct);
        }
    }

    private static string? ResolveDriver(AgentConfig cfg, string? wanted)
    {
        if (string.IsNullOrWhiteSpace(wanted)) return cfg.DriverNames.FirstOrDefault();
        if (cfg.DriverNames.Contains(wanted, StringComparer.OrdinalIgnoreCase)) return wanted;
        // 信封里的 driverName 与本地配置不一致：不擅自替换成别的队列（打错介质比失败更糟）
        return null;
    }

    private static async Task SafeReceipt(ApiClient client, Logger log, string jobKey, string status, int printed, string? error, CancellationToken ct)
    {
        try
        {
            await client.ReceiptAsync(jobKey, status, printed, error, ct);
        }
        catch (Exception ex)
        {
            // 回执失败不能让代理崩溃；任务会在租约超时后被服务端回收，下一轮重新拉到
            log.Warn($"回执上报失败（{status}）：{ex.Message}");
        }
    }

    // ------------------------------------------------------------------ 体检

    private static async Task<int> DoctorAsync(AgentConfig cfg, ApiClient client, Logger log, SecretStore secrets)
    {
        var pass = true;
        Console.WriteLine("== LabelFlow 打印代理体检 ==");
        Console.WriteLine($"服务端   : {cfg.ServerApiBase}");
        Console.WriteLine($"租户     : {cfg.TenantId}  账号: {cfg.Username}");
        Console.WriteLine($"代理 ID  : {cfg.AgentId}");
        Console.WriteLine($"数据目录 : {cfg.DataDir}");
        Console.WriteLine($"签名校验 : {cfg.SignatureEnabled}");

        Console.WriteLine("\n[1/4] 登录 ...");
        try { await client.LoginAsync(); Console.WriteLine("  OK"); }
        catch (Exception ex) { pass = false; Console.WriteLine($"  失败：{ex.Message}"); }

        Console.WriteLine("[2/4] 代理注册状态 ...");
        try
        {
            if (!client.HasAgentSecret) { await client.RegisterAsync(); Console.WriteLine("  已注册"); }
            else
            {
                var (ok, pending, reason) = await client.HeartbeatAsync(0);
                Console.WriteLine(ok ? $"  OK（待打任务 {pending}）" : $"  未注册：{reason}（运行 --register 重新注册）");
                if (!ok) pass = false;
            }
        }
        catch (Exception ex) { pass = false; Console.WriteLine($"  失败：{ex.Message}"); }

        Console.WriteLine("[3/4] 本机打印队列 ...");
        if (!OperatingSystem.IsWindows())
        {
            pass = false;
            Console.WriteLine("  非 Windows，跳过（正式环境必须是 Windows）");
        }
        else
        {
            var installed = new List<string>();
            foreach (string p in PrinterSettings.InstalledPrinters) installed.Add(p);
            foreach (var want in cfg.DriverNames)
            {
                var hit = installed.FirstOrDefault(x => string.Equals(x, want, StringComparison.OrdinalIgnoreCase));
                Console.WriteLine(hit == null ? $"  ✗ 找不到「{want}」" : $"  ✓ 「{want}」");
                if (hit == null) pass = false;
            }
            if (installed.Count > 0) Console.WriteLine($"  本机已装队列：{string.Join(" / ", installed)}");
        }

        Console.WriteLine("[4/4] 拉取通道 ...");
        try
        {
            var jobs = await client.PullAsync();
            Console.WriteLine($"  OK（当前 {jobs.Count} 条待打）");
        }
        catch (Exception ex) { pass = false; Console.WriteLine($"  失败：{ex.Message}"); }

        Console.WriteLine(pass ? "\n体检通过，可以启动常驻。" : "\n体检未通过，按上面 ✗/失败 项修完再来。");
        return pass ? 0 : 2;
    }

    // ------------------------------------------------------------------ 工具

    private static async Task TryLoginAsync(ApiClient client, Logger log, CancellationToken ct)
    {
        try { await client.LoginAsync(ct); }
        catch (Exception ex) { log.Error("重新登录失败", ex); }
    }

    private static Task SafeDelay(int ms, CancellationToken ct)
    {
        if (ms <= 0) return Task.CompletedTask;
        try { return Task.Delay(ms, ct); } catch { return Task.CompletedTask; }
    }

    private static string ReadPassword()
    {
        var sb = new System.Text.StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace)
            {
                if (sb.Length > 0) sb.Length--;
                continue;
            }
            sb.Append(key.KeyChar);
        }
        return sb.ToString();
    }
}
