using System.Security.Cryptography;
using System.Text;

namespace LabelFlow.PrintAgent;

/// <summary>
/// 与服务端同一套 HMAC 口径（后端 `jobs/trigger.calc.ts#verifySignature`）：
///   签名串 = HMAC-SHA256(secret, "{timestampSeconds}.{bodyRaw}")
///   请求头 = x-labelflow-timestamp / x-labelflow-signature
/// 关键点：bodyRaw 必须是**实际发出去的那一串字节**，先序列化一次拿到字符串，
/// 再拿它算签名、再原样作为请求体发送 —— 重新序列化一次就可能字段顺序/空格不同导致验签失败。
/// </summary>
public static class Signer
{
    public static (string timestamp, string signature) Sign(string bodyRaw, string secret, long? nowSeconds = null)
    {
        var ts = (nowSeconds ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString();
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var mac = hmac.ComputeHash(Encoding.UTF8.GetBytes($"{ts}.{bodyRaw}"));
        return (ts, Convert.ToHexString(mac).ToLowerInvariant());
    }
}
