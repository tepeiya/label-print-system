// 过账关键决策纯函数（无 Nest/TypeORM/entity 依赖，node:test 可直接 import）。
// 把 US-4 里最容易出错的规则抽出来单测：幂等键、库存落点硬约束、打印变量组装、差异计算。

/** 收货标签幂等键：GRN:{receiptNo}:{lineNo} */
export function receiptIdemKey(receiptNo: string, lineNo: number): string {
  return `GRN:${receiptNo}:${lineNo}`;
}

/** 补打幂等键（新键，避免覆盖原打印）：GRN:{no}:{line}:reprint:{n} */
export function reprintIdemKey(receiptNo: string, lineNo: number, nth: number): string {
  return `GRN:${receiptNo}:${lineNo}:reprint:${nth}`;
}

/** 库存变更幂等键：STOCK:{收货幂等键} */
export function stockIdemKey(receiptNo: string, lineNo: number): string {
  return `STOCK:${receiptIdemKey(receiptNo, lineNo)}`;
}

/**
 * 库存落点硬约束（C5）：推荐库位为空即拒绝过账，杜绝无库位库存。
 * @returns 抛错或返回库位 id
 */
export function assertStockLocation(locationId: number | null | undefined, reason?: string): number {
  const id = Number(locationId);
  if (locationId == null || !Number.isFinite(id) || id <= 0) {
    throw new Error(reason || '无可用库位，禁止过账（禁止无库位库存）');
  }
  return id;
}

/** 超收/短收差异计算（按累计实收 vs 预期） */
export function calcDiff(expected: number, cumulative: number): { diffType: 'OVER' | 'SHORT' | null; diffQty: number } {
  if (expected > 0 && cumulative > expected) return { diffType: 'OVER', diffQty: cumulative - expected };
  if (expected > 0 && cumulative < expected) return { diffType: 'SHORT', diffQty: expected - cumulative };
  return { diffType: null, diffQty: 0 };
}

/**
 * 打印变量组装（C4：由 WMS 过账服务组装，Gateway 只传输不解析）。
 * 明确字段口径：skuCode/skuName/batchNo/qty/unit/supplierName/receiptNo。
 */
export function buildReceiptVariables(p: {
  skuCode: string; skuName: string; unit?: string; batchNo?: string | null;
  qty: number; receiptNo: string; lineNo: number; supplierName?: string;
}): Record<string, any> {
  return {
    skuCode: p.skuCode, skuName: p.skuName,
    batchNo: p.batchNo ?? '', qty: p.qty, unit: p.unit ?? '',
    supplierName: p.supplierName ?? '', receiptNo: p.receiptNo, lineNo: p.lineNo,
  };
}
