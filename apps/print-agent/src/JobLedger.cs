using System.Text.Json;

namespace LabelFlow.PrintAgent;

/// <summary>
/// 本地幂等账本：记下"已经打成功"的 jobKey。
///
/// 为什么必须有：服务端认领租约有 TTL（默认 300s），代理如果在回执前进程崩了/断电，
/// 任务会被回收重派 —— 没有本地账本，同一张标签就会打第二遍。
/// 拉到任务先查账本：已成功 → 直接回 succeeded，不出纸。
/// </summary>
public sealed class JobLedger
{
    private readonly object _gate = new();
    private readonly string _path;
    private readonly Logger _log;
    private readonly LinkedList<string> _order = new();
    private readonly HashSet<string> _done = new();
    private const int Keep = 5000;

    public JobLedger(string dataDir, Logger log)
    {
        _log = log;
        _path = Path.Combine(dataDir, "ledger.json");
        Load();
    }

    public bool HasPrinted(string jobKey)
    {
        lock (_gate) return _done.Contains(jobKey);
    }

    public void MarkPrinted(string jobKey)
    {
        lock (_gate)
        {
            if (!_done.Add(jobKey)) return;
            _order.AddLast(jobKey);
            while (_order.Count > Keep)
            {
                var old = _order.First!.Value;
                _order.RemoveFirst();
                _done.Remove(old);
            }
            Flush();
        }
    }

    private void Load()
    {
        if (!File.Exists(_path)) return;
        try
        {
            var arr = JsonSerializer.Deserialize<List<string>>(File.ReadAllText(_path)) ?? new();
            foreach (var k in arr.Take(Keep))
                if (_done.Add(k)) _order.AddLast(k);
            _log.Info($"本地幂等账本已加载：{_done.Count} 条已打记录");
        }
        catch (Exception ex)
        {
            _log.Warn($"账本损坏，从空账本开始（可能重复打印历史任务）：{ex.Message}");
        }
    }

    private void Flush()
    {
        try
        {
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_order.ToList()));
            File.Move(tmp, _path, overwrite: true);
        }
        catch (Exception ex)
        {
            _log.Warn($"账本写盘失败（内存里仍然生效）：{ex.Message}");
        }
    }
}
