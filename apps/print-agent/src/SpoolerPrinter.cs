using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Printing;

namespace LabelFlow.PrintAgent;

/// <summary>
/// 真正把字节送到 Windows 打印队列：
///   1) RAW 直发（ZPL/TSPL/EPL）：OpenPrinter → StartDocPrinter(datatype="RAW") → WritePrinter
///      —— 必须是 RAW，否则厂商驱动会自己重排内容，GS1 DataMatrix 的 FNC1 会被吃掉。
///   2) PNG 帧：GDI 打印到指定纸张（尺寸取信封 settings 的 mm 换算）。
///
/// 注意：这里不做任何"连打印机 IP"的事。信封里的 connection 已被服务端白名单脱敏，
/// 只剩 driverName —— 代理只能通过本机队列打印。
/// </summary>
public sealed class SpoolerPrinter
{
    private readonly Logger _log;

    public SpoolerPrinter(Logger log) => _log = log;

    /// <summary>把一帧打到本机队列；返回 null 表示成功，否则是错误文案</summary>
    public string? Print(string driverName, LabelFrame frame, JobSettings settings)
    {
        if (!OperatingSystem.IsWindows())
            return "当前不是 Windows，无法调用打印队列（仅用于开发机冒烟，请勿在生产使用）";

        return frame.Format switch
        {
            "zpl" or "tspl" or "epl" => PrintRaw(driverName, frame),
            "png-base64" => PrintPng(driverName, frame, settings),
            "pdf-base64" => "PDF 帧暂不支持（需要额外 PDF 渲染依赖）；请让服务端改出 PNG 或原生指令",
            _ => $"未知标签格式：{frame.Format}",
        };
    }

    // ---------------------------------------------------------------- RAW

    private string? PrintRaw(string driverName, LabelFrame frame)
    {
        var bytes = Encoding.UTF8.GetBytes(frame.Data);
        for (var copy = 0; copy < Math.Max(1, frame.Copies); copy++)
        {
            var err = RawWrite(driverName, bytes, $"LabelFlow-{DateTime.Now:HHmmss}-{copy + 1}");
            if (err != null) return err;
        }
        _log.Info($"RAW 打印完成：{driverName} × {Math.Max(1, frame.Copies)} 份，{bytes.Length} 字节");
        return null;
    }

    private string? RawWrite(string printerName, byte[] data, string docName)
    {
        IntPtr hPrinter = IntPtr.Zero;
        try
        {
            if (!OpenPrinter(printerName.Normalize(), out hPrinter, IntPtr.Zero))
                return $"打不开打印队列「{printerName}」（名字要和 Windows 里显示的完全一致）";

            var doc = new DOC_INFO_1
            {
                pDocName = docName,
                pOutputFile = null,
                // ← 关键：RAW
                pDataType = "RAW",
            };
            if (StartDocPrinter(hPrinter, 1, doc) == 0) return $"StartDocPrinter 失败：{Marshal.GetLastWin32Error()}";
            try
            {
                if (!StartPagePrinter(hPrinter)) return $"StartPagePrinter 失败：{Marshal.GetLastWin32Error()}";
                try
                {
                    if (!WritePrinter(hPrinter, data, data.Length, out var written))
                        return $"WritePrinter 失败：{Marshal.GetLastWin32Error()}";
                    if (written != data.Length) return $"只写进 {written}/{data.Length} 字节（队列可能中断）";
                }
                finally { EndPagePrinter(hPrinter); }
            }
            finally { EndDocPrinter(hPrinter); }
            return null;
        }
        finally
        {
            if (hPrinter != IntPtr.Zero) ClosePrinter(hPrinter);
        }
    }

    // ---------------------------------------------------------------- PNG

    private string? PrintPng(string driverName, LabelFrame frame, JobSettings settings)
    {
        try
        {
            var raw = frame.Data;
            var comma = raw.IndexOf(',');
            var b64 = comma >= 0 ? raw[(comma + 1)..] : raw;
            var bytes = Convert.FromBase64String(b64);
            using var ms = new MemoryStream(bytes);
            using var img = Image.FromStream(ms);

            using var doc = new PrintDocument();
            doc.PrinterSettings.PrinterName = driverName;
            if (!doc.PrinterSettings.IsValid) return $"打印队列「{driverName}」在本机不可用";

            // 标签尺寸（mm）→ 1/100 英寸；没给尺寸就按图片比例套 A4 可打印区
            var width = settings.WidthMm > 0 ? (int)Math.Round(settings.WidthMm / 25.4 * 100) : doc.DefaultPageSettings.PaperSize.Width;
            var height = settings.HeightMm > 0 ? (int)Math.Round(settings.HeightMm / 25.4 * 100) : doc.DefaultPageSettings.PaperSize.Height;
            doc.DefaultPageSettings.PaperSize = new PaperSize("LabelFlowLabel", width, height);
            doc.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);

            doc.PrintPage += (_, e) =>
            {
                var g = e.Graphics!;
                var area = e.MarginBounds;
                var scale = Math.Min((float)area.Width / img.Width, (float)area.Height / img.Height);
                var w = (int)(img.Width * scale);
                var h = (int)(img.Height * scale);
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(img, area.Left, area.Top, w, h);
                e.HasMorePages = false;
            };

            for (var copy = 0; copy < Math.Max(1, frame.Copies); copy++) doc.Print();
            _log.Info($"PNG 打印完成：{driverName} × {Math.Max(1, frame.Copies)} 份，{width / 100.0:0.##}×{height / 100.0:0.##} in");
            return null;
        }
        catch (Exception ex)
        {
            return $"PNG 打印失败：{ex.GetType().Name}: {ex.Message}";
        }
    }

    // ---------------------------------------------------------------- P/Invoke

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr hPrinter, int level, DOC_INFO_1 pDocInfo);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
}
