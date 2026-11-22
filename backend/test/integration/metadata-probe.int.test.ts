/**
 * 硬坑探针：验证 ts-jest 能 emit decorator metadata，正确加载真实 entity。
 * 若此测试通过，说明方案 A（jest + ts-jest）可行，不再受 tsx/esbuild
 * 的 ColumnTypeUndefinedError 阻断。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../../src/snake-naming.strategy';
import { WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule } from '../../src/wms/inbound/entities/wms.entity';
import { Material, WarehouseLocation } from '../../src/inventory/inventory.entity';

describe('entity metadata 加载探针（ts-jest 硬坑验证）', () => {
  let ds: DataSource;

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('真实 entity 能被 TypeORM 解析并连库初始化（不再报 Column type undefined）', async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: +(process.env.DB_PORT || 5434),
      username: process.env.DB_USER || 'labelflow',
      password: process.env.DB_PASS || 'labelflow',
      database: process.env.DB_NAME || 'labelflow',
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      entities: [WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule, Material, WarehouseLocation],
    });
    await expect(ds.initialize()).resolves.toBeDefined();
    expect(ds.isInitialized).toBe(true);
    // 触发列元数据解析（若有裸 @Column 缺 type，此处会抛 ColumnTypeUndefinedError）
    const cols = ds.getMetadata(WmsReceipt).columns.map((c) => c.databaseName);
    expect(cols).toContain('receipt_no');
    expect(cols).toContain('tenant_id');
  });
});
