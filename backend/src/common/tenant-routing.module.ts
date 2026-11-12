// 全局路由模块：TenantRouting / TENANT_DATASOURCE 对所有业务模块可见。
// @Global 让它不必被逐个 import；TenantRouting 内部用 ModuleRef 懒取
// TenantDataSourceManager，避免与 SaasModule 形成构造期循环依赖。
import { Global, Module } from '@nestjs/common';
import { TenantRouting, TENANT_DATASOURCE, tenantDataSourceProxy } from './tenant-routing';

@Global()
@Module({
  providers: [
    TenantRouting,
    {
      provide: TENANT_DATASOURCE,
      useFactory: (routing: TenantRouting) => tenantDataSourceProxy(routing),
      inject: [TenantRouting],
    },
  ],
  exports: [TenantRouting, TENANT_DATASOURCE],
})
export class TenantRoutingModule {}
