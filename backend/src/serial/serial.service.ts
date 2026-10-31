// 流水号服务：复用 core/serial-number.service（行锁+号段预分配），接 TypeORM 事务
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SerialNumberService, DbManager } from '../../core/serial-number.service';

@Injectable()
export class SerialModuleService {
  constructor(@InjectDataSource() private ds: DataSource) {}

  /**
   * 分配号段：在事务内用悲观写锁（SELECT ... FOR UPDATE）串行化，
   * 由 core 的 SerialNumberService 完成号段预分配与格式化。
   */
  allocate(tenantId: number, ref: string, count: number) {
    return this.ds.transaction(async (manager) => {
      // DbManager 适配：tx 即 EntityManager，直接执行 core 发出的原始 SQL（含 FOR UPDATE）
      const db: DbManager = {
        transaction: (fn) => manager.transaction(fn),
        queryOneForUpdate: (tx, sql, p) => tx.query(sql, p).then((r: any) => r[0]),
        updateCurrent: (tx, sql, p) => tx.query(sql, p),
        insertUsage: (tx, sql, p) => tx.query(sql, p),
      };
      return new SerialNumberService(db).allocate(tenantId, ref, count);
    });
  }

  /** 页面级批量打印入口（不暴露为公开 REST，由 PrintService 内部调用） */
  async allocateForJob(tenantId: number, ref: string, count: number) {
    return this.allocate(tenantId, ref, count);
  }
}
