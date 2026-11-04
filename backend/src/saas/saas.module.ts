// SaaS P0 模块：注册 10 个 Repository + 5 个 Service + 2 个 Controller
import { Module as NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ModuleRecord, Plan, PlanModule, Subscription,
  TenantModule, Permission, RolePermission,
  Role, DataScopeRecord, FeatureFlag,
} from '../entities/saas.entity';
import { Tenant, User, UserRole } from '../entities/tenant.entity';
import { ModulesService } from './modules.service';
import { SubscriptionService } from './subscription.service';
import { PermissionsService } from './permissions.service';
import { TenantConfigService } from './tenant-config.service';
import { ProvisionService } from './provision.service';
import { SubscriptionController } from './subscription.controller';
import { PlatformController } from './platform.controller';
import { TenantDataSourceManager } from '../common/tenant-data-source.manager';

@NestModule({
  imports: [
    TypeOrmModule.forFeature([
      ModuleRecord, Plan, PlanModule, Subscription,
      TenantModule, Permission, RolePermission,
      Role, DataScopeRecord, FeatureFlag,
      Tenant, User, UserRole,
    ]),
  ],
  providers: [
    ModulesService, SubscriptionService, PermissionsService,
    TenantConfigService, ProvisionService, TenantDataSourceManager,
  ],
  controllers: [SubscriptionController, PlatformController],
  // AuthModule（/auth/me）与全局拦截器都要用，必须导出
  exports: [
    ModulesService, SubscriptionService, PermissionsService,
    TenantConfigService, ProvisionService, TenantDataSourceManager,
  ],
})
export class SaasModule {}
