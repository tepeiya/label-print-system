// =============================================================================
// NmpaUdidClient —— 国家药监局医疗器械唯一标识数据库（UDID）申报接口适配
//
// 依据《医疗器械唯一标识管理信息系统业务申报API标准文档》（官方 REST/JSON）：
//   P001 连通性测试  POST {base}/connection/test
//   P002 取凭据      POST {base}/token/get
//   M001 数据填报    POST {base}/company/identifier/save
//   M002 提交标识    POST {base}/company/identifier/submit
// 测试环境 base = https://udid.nmpa.gov.cn/api/beta/v2
// 正式环境 base = https://udid.nmpa.gov.cn/api/v2
//
// 前提：注册人/备案人需在 UDID 系统提交《对接申请表》并审核通过，官方会邮件下发
//       对接凭据（appKey/secret 口径）。没有凭据时本客户端只做连通性探测，不做"假成功"。
// 注意：接口导入的数据在对方系统里是**草稿**状态，需再调 M002 提交；授权码当日 24:00 失效，
//       因此 token 只缓存到当天结束。
// =============================================================================
import { Injectable, Logger } from '@nestjs/common';

const DEFAULT_BETA = 'https://udid.nmpa.gov.cn/api/beta/v2';
const DEFAULT_PROD = 'https://udid.nmpa.gov.cn/api/v2';

@Injectable()
export class NmpaUdidClient {
  private readonly logger = new Logger('NmpaUdidClient');
  private tokenCache: { token: string; at: number } | null = null;

  private get baseUrl(): string {
    const explicit = process.env.UDID_BASE_URL?.trim();
    if (explicit) return explicit.replace(/\/$/, '');
    return process.env.UDID_ENV === 'prod' ? DEFAULT_PROD : DEFAULT_BETA;
  }

  private get credentials(): { appKey: string; appSecret: string } | null {
    const appKey = process.env.UDID_APP_KEY?.trim();
    const appSecret = process.env.UDID_APP_SECRET?.trim();
    return appKey && appSecret ? { appKey, appSecret } : null;
  }

  /** 连通性自检：不需要 token，可用来判断网络是否通（沙箱里通常不通，属正常） */
  async probe(): Promise<{ ok: boolean; code: string; message: string; baseUrl: string; configured: boolean }> {
    const configured = Boolean(this.credentials);
    try {
      const res = await this.post('/connection/test', {});
      return {
        ok: true,
        code: String((res as any)?.returnCode ?? 'OK'),
        message: sanitizeMessage(String((res as any)?.returnMessage ?? '连通')),
        baseUrl: this.baseUrl,
        configured,
      };
    } catch (e: any) {
      return { ok: false, code: 'NETWORK', message: sanitizeMessage(e?.message ?? '连接失败'), baseUrl: this.baseUrl, configured };
    }
  }

  /** 只取凭据（M001/M002 之前的 P002） */
  async getToken(): Promise<{ ok: boolean; token?: string; code: string; message: string }> {
    const cred = this.credentials;
    if (!cred) {
      return { ok: false, code: 'NOT_CONFIGURED', message: '未配置 UDID_APP_KEY / UDID_APP_SECRET（需先向药监局提交对接申请）' };
    }
    if (this.tokenCache && this.tokenCache.at > Date.now()) {
      return { ok: true, token: this.tokenCache.token, code: 'CACHED', message: '复用当日凭据' };
    }
    try {
      const res: any = await this.post('/token/get', { appKey: cred.appKey, appSecret: cred.appSecret });
      const token = res?.data?.accessToken ?? res?.accessToken;
      if (!token) return { ok: false, code: String(res?.returnCode ?? 'NO_TOKEN'), message: String(res?.returnMessage ?? '未返回 accessToken') };
      // 官方：授权码有效截止到当日 24:00
      const endOfDay = new Date(); endOfDay.setHours(24, 0, 0, 0);
      this.tokenCache = { token, at: endOfDay.getTime() };
      return { ok: true, token, code: String(res?.returnCode ?? 'OK'), message: '取凭据成功' };
    } catch (e: any) {
      return { ok: false, code: 'NETWORK', message: e?.message ?? '取凭据失败' };
    }
  }

  /** 填报 + 提交（M001 → M002），返回最后一次调用的结果 */
  async submitIdentifiers(payload: Record<string, any>): Promise<{ ok: boolean; code: string; message: string }> {
    const dataSet = (payload?.dataSet ?? []) as any[];
    if (!dataSet.length) return { ok: false, code: 'EMPTY', message: '没有要提交的 DI' };
    const t = await this.getToken();
    if (!t.ok || !t.token) return { ok: false, code: t.code, message: t.message };

    try {
      const save: any = await this.post('/company/identifier/save', { accessToken: t.token, dataSet: payload.dataSet });
      const saveCode = String(save?.returnCode ?? '');
      if (save?.success === false || (saveCode && saveCode !== '0000' && saveCode !== '0')) {
        return { ok: false, code: saveCode || 'SAVE_FAILED', message: String(save?.returnMessage ?? '填报被拒') };
      }
      const submit: any = await this.post('/company/identifier/submit', { accessToken: t.token });
      const code = String(submit?.returnCode ?? '');
      const ok = submit?.success !== false && (!code || code === '0000' || code === '0');
      return { ok, code: code || (ok ? 'OK' : 'SUBMIT_FAILED'), message: String(submit?.returnMessage ?? (ok ? '已提交（对方系统为草稿，需人工确认发布）' : '提交被拒')) };
    } catch (e: any) {
      this.logger.warn(`NMPA 申报失败：${e?.message}`);
      return { ok: false, code: 'NETWORK', message: e?.message ?? '网络异常' };
    }
  }

  private async post(path: string, body: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { returnCode: String(res.status), returnMessage: text.slice(0, 300) }; }
  }
}

/** 网关/防火墙常返回整页 HTML，界面上只保留一句话 */
function sanitizeMessage(raw: string): string {
  const text = String(raw ?? '');
  if (/<\w+[^>]*>/.test(text)) return '对方网关拒绝（响应不是接口报文），请确认 base 路径 / 网络策略 / 是否需要专线';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
