// SaaS P0 模块：注册 10 个 Repository + 5 个 Service + 2 个 Controller
import { Module as NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ModuleRecord, Plan, PlanModule, Subscription,
  TenantModule, Permission, RolePermission,
  Role, DataScopeRecord, FeatureFlag,
} from '../entities/saas.entity';
import { PlatformUser } from './platform-admin/platform-user.entity';
import { PlatformAuditLog } from './platform-admin/platform-audit.service';
import { Tenant, User, UserRole } from '../entities/tenant.entity';
import { ModulesService } from './modules.service';
import { SubscriptionService } from './subscription.service';
import { PermissionsService } from './permissions.service';
import { TenantConfigService } from './tenant-config.service';
import { ProvisionService } from './provision.service';
import { SubscriptionController } from './subscription.controller';
import { PlatformController } from './platform.controller';
import { PlatformAdminController, PlatformAuthController } from './platform-admin/platform-admin.controller';
import { PlatformAdminService } from './platform-admin/platform-admin.service';
import { PlatformAuditService } from './platform-admin/platform-audit.service';
import { TenantDataService } from './platform-admin/tenant-data.service';
import { TenantDataSourceManager } from '../common/tenant-data-source.manager';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';

@NestModule({
  imports: [
    AuditModule, // PlatformAdminService 写平台侧审计（platform.login / suspend 等）
    BillingModule, // P3：平台运营 API 里的配额 / 账单 / 收款委托给 Usage/InvoiceService
    TypeOrmModule.forFeature([
      ModuleRecord, Plan, PlanModule, Subscription,
      TenantModule, Permission, RolePermission,
      Role, DataScopeRecord, FeatureFlag,
      Tenant, User, UserRole, PlatformUser, PlatformAuditLog,
    ]),
  ],
  providers: [
    ModulesService, SubscriptionService, PermissionsService,
    TenantConfigService, ProvisionService, TenantDataSourceManager,
    PlatformAdminService, PlatformAuditService, TenantDataService,
  ],
  controllers: [SubscriptionController, PlatformController, PlatformAdminController, PlatformAuthController],
  // AuthModule（/auth/me）与全局拦截器都要用，必须导出
  exports: [
    ModulesService, SubscriptionService, PermissionsService,
    TenantConfigService, ProvisionService, TenantDataSourceManager,
  ],
})
export class SaasModule {}
