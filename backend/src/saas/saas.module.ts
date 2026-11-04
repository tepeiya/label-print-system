// SaaS P0 模块：注册 7 个 Repository + 导出 3 个 Service + 2 个 Controller
import { Module as NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ModuleRecord, Plan, PlanModule, Subscription,
  TenantModule, Permission, RolePermission,
} from '../entities/saas.entity';
import { ModulesService } from './modules.service';
import { SubscriptionService } from './subscription.service';
import { PermissionsService } from './permissions.service';
import { SubscriptionController } from './subscription.controller';
import { PlatformController } from './platform.controller';

@NestModule({
  imports: [
    TypeOrmModule.forFeature([
      ModuleRecord, Plan, PlanModule, Subscription,
      TenantModule, Permission, RolePermission,
    ]),
  ],
  providers: [ModulesService, SubscriptionService, PermissionsService],
  controllers: [SubscriptionController, PlatformController],
  exports: [ModulesService, SubscriptionService, PermissionsService],
})
export class SaasModule {}
