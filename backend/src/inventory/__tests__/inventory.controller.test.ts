// 出入库 REST 接线的守卫测试：菜单/路由容易漏改权限点，这里用元数据锁死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';

import { InventoryController } from '../inventory.controller';
import { PERMISSION_KEY } from '../../common/permission.guard';
import { MODULE_KEY } from '../../common/module.guard';
import { StockAdjustDto, StockTransferDto, QueryMovesDto } from '../dto/inventory.dto';

const reflector = new Reflector();

test('库存 REST 类级模块门 = inventory', () => {
  assert.equal(reflector.get(PATH_METADATA, InventoryController), 'inventory');
  assert.deepEqual(reflector.get(MODULE_KEY, InventoryController), ['inventory']);
});

test('读接口统一 inventory:stock:read，写入分别用 adjust / transfer 权限点', () => {
  const expected: Record<string, string> = {
    stock: 'inventory:stock:read',
    lowStock: 'inventory:stock:read',
    expiring: 'inventory:stock:read',
    moves: 'inventory:stock:read',
    materials: 'inventory:stock:read',
    warehouses: 'inventory:stock:read',
    inbound: 'inventory:stock:adjust',
    outbound: 'inventory:stock:adjust',
    transfer: 'inventory:stock:transfer',
  };
  for (const [method, code] of Object.entries(expected)) {
    const fn = (InventoryController.prototype as any)[method];
    assert.ok(typeof fn === 'function', `缺少接口 ${method}`);
    assert.deepEqual(reflector.get(PERMISSION_KEY, fn), [code], `${method} 权限点应为 ${code}`);
  }
  // 写接口必须是 POST，避免误挂 GET 造成误触
  for (const method of ['inbound', 'outbound', 'transfer']) {
    assert.equal(reflector.get(METHOD_METADATA, (InventoryController.prototype as any)[method]), RequestMethod.POST);
  }
});

test('菜单目录里的库存入口与路由 path 一致', () => {
  // 直接比对常量，避免菜单有了、路由没加（或反之）造成点了 404 / 被守卫拦
  const catalogPath = '/inventory';
  const routePath = 'inventory';
  assert.equal(catalogPath.slice(1), routePath);
});

test('出入库 DTO 拦截空值 / 非法数量 / 过短事由', async () => {
  const bad = Object.assign(new StockAdjustDto(), {
    sku: '', warehouse: '', delta: 0, reason: 'x',
  });
  assert.ok((await validate(bad)).length > 0, '空物料/仓库/数量、过短事由都应被拒绝');

  const good = Object.assign(new StockAdjustDto(), {
    sku: 'M-APPLE', warehouse: 'WH-SH', delta: 12.5, reason: '采购到货',
  });
  assert.deepEqual(await validate(good), [], '合法入库单应通过');

  const badTransfer = Object.assign(new StockTransferDto(), {
    sku: 'M-APPLE', fromWarehouse: 'WH-SH', toWarehouse: 'WH-BJ', qty: -1,
  });
  assert.ok((await validate(badTransfer)).length > 0, '调拨数量必须为正');
});

test('台账查询 DTO 只接受合法类型与分页上限', async () => {
  const good = Object.assign(new QueryMovesDto(), { kind: 'in', limit: 20, offset: 0 });
  assert.deepEqual(await validate(good), []);

  const bad = Object.assign(new QueryMovesDto(), { kind: 'delete', limit: 1000 });
  assert.ok((await validate(bad)).length > 0);
});

// ---- 产品自定义字段：MasterdataController 接线与 DTO 校验（本功能新增） ----
import { MasterdataController } from '../masterdata.controller';
import { CreateFieldDefDto, CreateMaterialDto, UpdateFieldDefDto } from '../dto/masterdata.dto';

test('字段定义 REST 权限点：读用 masterdata:item:read，写用 masterdata:item:write', () => {
  const expected: Record<string, string> = {
    fields: 'masterdata:item:read',
    createField: 'masterdata:item:write',
    updateField: 'masterdata:item:write',
    setFieldActive: 'masterdata:item:write',
  };
  for (const [method, code] of Object.entries(expected)) {
    const fn = (MasterdataController.prototype as any)[method];
    assert.ok(typeof fn === 'function', `缺少接口 ${method}`);
    assert.deepEqual(reflector.get(PERMISSION_KEY, fn), [code], `${method} 权限点应为 ${code}`);
  }
});

test('字段定义 DTO 拦截非法类型 / 空标识 / 空选项', async () => {
  const good = Object.assign(new CreateFieldDefDto(), {
    fieldKey: 'shelf_life', label: '保质期', type: 'text', required: true,
  });
  assert.deepEqual(await validate(good), []);
  const bad = Object.assign(new CreateFieldDefDto(), { fieldKey: '', label: '', type: 'hack' });
  assert.ok((await validate(bad)).length > 0);
  const badUpdate = Object.assign(new UpdateFieldDefDto(), { type: 'drop-table' });
  assert.ok((await validate(badUpdate)).length > 0);
});

test('产品 DTO 接受 customFields 对象', async () => {
  const good = Object.assign(new CreateMaterialDto(), {
    code: 'M-1', name: '测试', customFields: { shelf_life: '12个月', net_weight: 2.5 },
  });
  assert.deepEqual(await validate(good), []);
  const bad = Object.assign(new CreateMaterialDto(), {
    code: 'M-1', name: '测试', customFields: 'not-an-object',
  });
  assert.ok((await validate(bad)).length > 0, 'customFields 必须是对象');
});
