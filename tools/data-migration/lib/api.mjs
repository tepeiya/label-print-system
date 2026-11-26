// 极简 API 客户端（Node 内置 fetch，无第三方依赖）
export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class Api {
  constructor(base, { token = '', timeoutMs = 60000 } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async raw(method, path, body, { retries = 0 } = {}) {
    const url = `${this.base}${path}`;
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    for (let attempt = 0; ; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method, headers, signal: ac.signal,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        if (!res.ok) {
          const msg = json?.message ?? json?.error ?? text?.slice(0, 300) ?? `HTTP ${res.status}`;
          throw new ApiError(res.status, Array.isArray(msg) ? msg.join('; ') : String(msg), json);
        }
        return json;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (attempt < retries && (e.name === 'AbortError' || e.code === 'ECONNREFUSED')) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw new ApiError(0, `无法连接 ${url}：${e.message}`, null);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** 统一解包 {code,data} 信封 */
  async call(method, path, body, opts) {
    const r = await this.raw(method, path, body, opts);
    if (r && typeof r === 'object' && 'code' in r && 'data' in r) {
      if (r.code !== 0 && r.code !== 200) throw new ApiError(200, r.message || `业务错误 code=${r.code}`, r);
      return r.data;
    }
    return r;
  }

  get(p, opts) { return this.call('GET', p, undefined, opts); }
  post(p, b, opts) { return this.call('POST', p, b, opts); }
  put(p, b, opts) { return this.call('PUT', p, b, opts); }

  async login({ username, password, tenantCode }) {
    const data = await this.post('/auth/login', { username, password, tenantCode });
    const token = data?.accessToken || data?.token;
    if (!token) throw new ApiError(200, '登录成功但没有拿到 accessToken', data);
    this.token = token;
    return data;
  }

  async health() { return this.get('/health', { retries: 2 }); }
}
