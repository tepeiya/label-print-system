// BOM 齐套率 REST / Agent 接线的守卫测试：模块门 + 三段式权限点 + DTO 校验，锁死避免漏改。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';

import { BomController } from '../bom.controller';
import { PERMISSION_KEY } from '../../common/permission.guard';
import { MODULE_KEY } from '../../common/module.guard';
import { CheckKitDto, SaveBomDto, BomItemInputDto, QueryBomsDto } from '../dto/bom.dto';
import { findTool, visibleTools } from '../../agent/tool.catalog';

const reflector = new Reflector();

test('BOM REST 类级模块门 = bom', () => {
  assert.deepEqual(reflector.get(MODULE_KEY, BomController), ['bom']);
});

test('BOM 接口权限点：齐套=kit:read，缺料=shortage:read，维护=bom:write', () => {
  const expected: Record<string, string> = {
    checkKit: 'bom:kit:read',
    shortages: 'bom:shortage:read',
    listBoms: 'bom:kit:read',
    getBom: 'bom:kit:read',
    createBom: 'bom:bom:write',
    updateBom: 'bom:bom:write',
    setBomStatus: 'bom:bom:write',
    deleteBom: 'bom:bom:write',
  };
  for (const [method, code] of Object.entries(expected)) {
    const fn = (BomController.prototype as any)[method];
    assert.ok(typeof fn === 'function', `缺少接口 ${method}`);
    assert.deepEqual(reflector.get(PERMISSION_KEY, fn), [code], `${method} 权限点应为 ${code}`);
  }
});

test('BOM DTO：齐套查询/保存/明细行/列表过滤校验', async () => {
  const badKit = Object.assign(new CheckKitDto(), { product: '', demand: 0 });
  assert.ok((await validate(badKit)).length > 0, '空产品/需求 0 应被拒绝');
  const goodKit = Object.assign(new CheckKitDto(), { product: 'P001', demand: 10 });
  assert.deepEqual(await validate(goodKit), []);

  const badItem = Object.assign(new BomItemInputDto(), { material: 'M1', qtyPer: -1, lossRate: 2 });
  assert.ok((await validate(badItem)).length > 0);
  const goodItem = Object.assign(new BomItemInputDto(), { material: 'M1', qtyPer: 2, lossRate: 0.05 });
  assert.deepEqual(await validate(goodItem), []);

  const badSave = Object.assign(new SaveBomDto(), {
    id: 0, product: 'P001', status: 'weird', items: [badItem],
  });
  assert.ok((await validate(badSave)).length > 0);
  const goodSave = Object.assign(new SaveBomDto(), {
    product: 'P001', version: 'v1', status: 'active', items: [goodItem],
  });
  assert.deepEqual(await validate(goodSave), []);

  const badQuery = Object.assign(new QueryBomsDto(), { product: 'x'.repeat(50) });
  assert.ok((await validate(badQuery)).length > 0);
});

test('Agent 工具 bom.check_kit_rate / bom.explain_shortage 已实现且权限/模块正确', () => {
  const kit = findTool('bom.check_kit_rate');
  const shortage = findTool('bom.explain_shortage');
  assert.ok(kit && shortage, '两个工具都应注册');
  assert.equal(kit!.implemented, true);
  assert.equal(shortage!.implemented, true);
  assert.equal(kit!.permission, 'bom:kit:read');
  assert.equal(shortage!.permission, 'bom:shortage:read');
  assert.deepEqual(kit!.modules, ['bom']);

  const vis = visibleTools(['bom:kit:read'], ['bom']);
  assert.ok(vis.some((t) => t.name === 'bom.check_kit_rate'));
  assert.ok(!vis.some((t) => t.name === 'bom.explain_shortage')); // 缺 shortage 权限
  const visAll = visibleTools(['bom:kit:read', 'bom:shortage:read'], ['bom']);
  assert.ok(visAll.some((t) => t.name === 'bom.explain_shortage'));
});

test('未订 bom 模块时两个工具都不可见', () => {
  const vis = visibleTools(['bom:kit:read', 'bom:shortage:read'], ['inventory']);
  assert.ok(!vis.some((t) => t.name.startsWith('bom.')));
});
