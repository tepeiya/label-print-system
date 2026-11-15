// =============================================================================
// tenant-typeorm.module.ts —— 代理版 TypeOrmModule（对外同名，调用处零改动）
//
// 各业务模块原来写的是 `import { TypeOrmModule } from '@nestjs/typeorm'` +
// `TypeOrmModule.forFeature([...])`。本模块导出同名 TypeOrmModule，
// 只需把那一行 import 指向本文件，业务代码一行都不用改，注入的 Repository
// 就变成按 TenantCtx.dataSourceKey 路由的代理（见 tenant-routing.ts）。
//
// 实现要点：DynamicModule 里同时 imports 原版 forFeature（保留真实 Repository 元数据），
// 但**当前模块的 providers 覆盖同名 token** → Nest 解析 @InjectRepository 时拿到代理；
// exports 导出的也是代理，跨模块注入同样生效。
// =============================================================================
import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule as BaseTypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { TenantRouting, tenantRepositoryProxy } from './tenant-routing';

type FeatureEntity = NonNullable<Parameters<typeof BaseTypeOrmModule.forFeature>[0]>[number];

@Module({})
class TenantTypeOrmModule {}

export const TypeOrmModule = {
  /** 与 @nestjs/typeorm 的 forFeature 签名一致；返回按租户路由的 Repository provider */
  forFeature(entities: FeatureEntity[] = []): DynamicModule {
    return {
      module: TenantTypeOrmModule,
      imports: [BaseTypeOrmModule.forFeature(entities)],
      providers: entities.map((e) => ({
        provide: getRepositoryToken(e),
        useFactory: (routing: TenantRouting) => tenantRepositoryProxy<any>(routing, e as any),
        inject: [TenantRouting],
      })),
      exports: entities.map((e) => getRepositoryToken(e)),
    };
  },
};

/** 供 app.module 之外的场景复用原版 forRoot（app.module 仍直接用 @nestjs/typeorm） */
export const OriginalTypeOrmModule = BaseTypeOrmModule;
