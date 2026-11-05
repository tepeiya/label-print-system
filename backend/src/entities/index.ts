// 实体统一出口（app.module 通过 import * as entities 批量注册）
export * from './tenant.entity';
export * from './template.entity';
export * from './serial.entity';
export * from './print.entity';
export * from './ai-template.entity';
export * from './saas.entity';
export { PlatformUser } from '../saas/platform-admin/platform-user.entity';
export { PlatformAuditLog } from '../saas/platform-admin/platform-audit.service';
