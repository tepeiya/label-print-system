// 预警 REST / Agent 工具接线的守卫测试：模块门 + 三段式权限点 + DTO 校验，锁死避免漏改。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';

import { AlertController } from '../alert.controller';
import { PERMISSION_KEY } from '../../common/permission.guard';
import { MODULE_KEY } from '../../common/module.guard';
import { AlertRuleDto, QueryAlertsDto, AckAlertDto } from '../dto/alert.dto';
import { AGENT_TOOLS, findTool, visibleTools } from '../../agent/tool.catalog';

const reflector = new Reflector();

test('预警 REST 类级模块门 = alert', () => {
  assert.deepEqual(reflector.get(MODULE_KEY, AlertController), ['alert']);
});

test('预警接口权限点：规则=configure，事件读=read，处理=ack，扫描=configure', () => {
  const expected: Record<string, string> = {
    listRules: 'alert:event:read',
    createRule: 'alert:rule:configure',
    updateRule: 'alert:rule:configure',
    setRuleActive: 'alert:rule:configure',
    deleteRule: 'alert:rule:configure',
    scan: 'alert:rule:configure',
    listEvents: 'alert:event:read',
    summary: 'alert:event:read',
    ack: 'alert:event:ack',
  };
  for (const [method, code] of Object.entries(expected)) {
    const fn = (AlertController.prototype as any)[method];
    assert.ok(typeof fn === 'function', `缺少接口 ${method}`);
    assert.deepEqual(reflector.get(PERMISSION_KEY, fn), [code], `${method} 权限点应为 ${code}`);
  }
});

test('预警 DTO：规则阈值/事件状态/处理状态校验', async () => {
  const badRule = Object.assign(new AlertRuleDto(), { type: 'nope', idleDays: 0, minQty: -1 });
  assert.ok((await validate(badRule)).length > 0, '非法规则应被拒绝');
  const goodRule = Object.assign(new AlertRuleDto(), { name: '呆滞90天', type: 'dead_stock', idleDays: 90 });
  assert.deepEqual(await validate(goodRule), []);

  const badQuery = Object.assign(new QueryAlertsDto(), { status: 'nope', severity: 'x' });
  assert.ok((await validate(badQuery)).length > 0);
  const goodQuery = Object.assign(new QueryAlertsDto(), { status: 'open', severity: 'critical' });
  assert.deepEqual(await validate(goodQuery), []);

  const badAck = Object.assign(new AckAlertDto(), { status: 'delete' });
  assert.ok((await validate(badAck)).length > 0);
  const goodAck = Object.assign(new AckAlertDto(), { status: 'ack', note: '已联系供应商补货' });
  assert.deepEqual(await validate(goodAck), []);
});

test('Agent 工具 alerts.list / alerts.ack 已实现且权限/模块正确', () => {
  const list = findTool('alerts.list');
  const ack = findTool('alerts.ack');
  assert.ok(list && ack, '两个工具都应注册');
  assert.equal(list!.implemented, true);
  assert.equal(ack!.implemented, true);
  assert.equal(list!.permission, 'alert:event:read');
  assert.equal(ack!.permission, 'alert:event:ack');
  assert.deepEqual(list!.modules, ['alert']);
  assert.equal(ack!.risk, 'write', 'ack 是写工具，须带幂等键');

  // 订阅了 alert 且有读权限的 token 应能看到 list，但看不到需要 ack 权限的 write 工具
  const vis = visibleTools(['alert:event:read'], ['alert']);
  assert.ok(vis.some((t) => t.name === 'alerts.list'));
  assert.ok(!vis.some((t) => t.name === 'alerts.ack'));
  const visAck = visibleTools(['alert:event:read', 'alert:event:ack'], ['alert']);
  assert.ok(visAck.some((t) => t.name === 'alerts.ack'));
});

test('未订 alert 模块时两个工具都不可见', () => {
  const vis = visibleTools(['alert:event:read', 'alert:event:ack'], ['inventory']);
  assert.ok(!vis.some((t) => t.name.startsWith('alerts.')));
  assert.ok(AGENT_TOOLS.some((t) => t.name === 'alerts.list'), '目录本身仍含该工具定义');
});
