const base = 'http://127.0.0.1:3200/api/v1';
const H = (t) => ({ authorization: 'Bearer ' + t, 'x-tenant-code': 'default', 'content-type': 'application/json' });
const j = async (r) => ({ status: r.status, body: await r.json() });

(async () => {
  const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123', tenantCode: 'default' }) });
  const token = (await login.json())?.data?.accessToken;
  if (!token) throw new Error('登录失败');

  // 1. 导入内置 UDI 模板（幂等：已存在同 code 就复用）
  const imported = {};
  for (const code of ['UDI_UNIT_V1', 'UDI_CARTON_V1']) {
    const list = await j(await fetch(base + '/templates?pageSize=200', { headers: H(token) }));
    const exists = (list.body?.data?.items ?? list.body?.items ?? []).find((x) => x.code === code);
    if (exists) { imported[code] = exists.id; console.log('已有模板', code, exists.id); continue; }
    const payload = await j(await fetch(base + '/udi/templates/' + code, { headers: H(token) }));
    const t = payload.body?.data ?? payload.body;
    const r = await fetch(base + '/templates/import', {
      method: 'POST', headers: H(token),
      body: JSON.stringify({ name: t.name, content: t.template, schemaVersion: 1, category: 'UDI', tags: ['UDI', '内置模板'] }),
    });
    const rj = await r.json();
    imported[code] = (rj?.data?.id ?? rj?.id);
    console.log('导入', code, r.status, 'id=', imported[code]);
  }

  // 2. 建一台验证用打印机（image 通道，不出物理纸；验证后删除）
  const pr = await j(await fetch(base + '/printers', {
    method: 'POST', headers: H(token),
    body: JSON.stringify({ name: '验证用-图像通道(临时)', type: 'zpl', connection: { protocol: 'image' }, dpi: 203, labelWidthMm: 50, labelHeightMm: 30 }),
  }));
  const printerId = pr.body?.data?.id ?? pr.body?.id;
  console.log('创建验证打印机', pr.status, 'id=', printerId);

  // 3. 真跑主从打印
  const body = {
    gtin: '06901234567892', lot: 'VF2611', expiry: '2028-12-31',
    serial: { mode: 'auto', from: 'SN0001' }, qty: 10,
    unitTemplateId: imported.UDI_UNIT_V1, cartonTemplateId: imported.UDI_CARTON_V1,
    printerId, register: true,
  };
  const r = await j(await fetch(base + '/udi/pack-print', { method: 'POST', headers: H(token), body: JSON.stringify(body) }));
  const d = r.body?.data ?? r.body;
  console.log('pack-print', r.status, JSON.stringify({
    sscc: d.sscc, count: d.unitCount, range: d.serialRange, packageId: d.packageId,
    unitJobId: d.unitJobId, cartonJobId: d.cartonJobId, registered: d.registered, warnings: d.warnings, msg: d.message,
  }, null, 1));

  await new Promise((res) => setTimeout(res, 6000));
  for (const id of [d.unitJobId, d.cartonJobId].filter(Boolean)) {
    const job = await j(await fetch(base + `/print/jobs/${id}`, { headers: H(token) }));
    const jb = job.body?.data ?? job.body;
    console.log('job', id, 'status=', jb.status, 'total=', jb.total, 'printerId=', jb.printerId);
  }
})().catch((e) => console.log('ERR', e.message));
