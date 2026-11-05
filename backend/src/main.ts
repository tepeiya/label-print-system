// 优先加载 .env（生产用 pm2/systemd 的 env 文件也兼容）
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { ModuleGuard } from './common/module.guard';
import { PermissionGuard } from './common/permission.guard';
import { JwtService } from '@nestjs/jwt';
import { ResponseInterceptor } from './common/response.interceptor';
import { TenantContextInterceptor } from './common/tenant-context.interceptor';
import { ModulesService } from './saas/modules.service';
import { PermissionsService } from './saas/permissions.service';
import { TenantConfigService } from './saas/tenant-config.service';
import { AllExceptionsFilter } from './common/errors.filter';
import { Reflector } from '@nestjs/core';
import { Tenant, User, UserRole } from './entities/tenant.entity';
import { Role } from './entities/saas.entity';
import { JWT_SECRET, PORT } from './common/config';

async function seedDefaultTenantAndAdmin(dataSource: DataSource) {
  const tenantRepo = dataSource.getRepository(Tenant);
  let tenant = await tenantRepo.findOne({ where: { code: 'default' } });
  if (!tenant) {
    tenant = await tenantRepo.save(
      tenantRepo.create({ name: '默认租户', code: 'default', status: 1, settings: {} }),
    );
  }
  const userRepo = dataSource.getRepository(User);
  let admin = await userRepo.findOne({ where: { username: 'admin', tenantId: tenant.id } });
  if (!admin) {
    const passwordHash = await bcrypt.hash('admin123', 10);
    admin = await userRepo.save(
      userRepo.create({
        tenantId: tenant.id,
        username: 'admin',
        passwordHash,
        status: 1,
        displayName: '管理员',
      }),
    );
    console.log('已创建默认管理员账号 admin / admin123（租户 default）');
  }
  // 给 admin 用户种 admin 角色（幂等：已存在则跳过）
  const roleRepo = dataSource.getRepository(UserRole);
  const exists = await roleRepo.findOne({
    where: { tenantId: tenant.id, userId: admin.id, role: 'admin' },
  });
  if (!exists) {
    // 兼容期双写：role 用旧码，role_id 指向 roles 表的 tenant_admin。
    // roles 表由 scripts/saas_p0_roles.sql 建，没跑脚本的老库这里取到 null 也不影响登录。
    const tenantAdminRole = await dataSource.getRepository(Role)
      .findOne({ where: { tenantId: tenant.id, code: 'tenant_admin' } })
      .catch(() => null);
    await roleRepo.save({
      tenantId: tenant.id, userId: admin.id, role: 'admin', roleId: tenantAdminRole?.id ?? null,
    });
    console.log('已授予 admin 用户 "admin" 角色');
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const reflector = app.get(Reflector);
  const jwt = app.get(JwtService);

  // 全局守卫顺序：JWT(注入 req.user) → ModuleGuard(订阅模块) → PermissionGuard(细粒度权限) → RolesGuard(角色回退)
  // ModuleGuard / PermissionGuard 需要 ModulesService / PermissionsService，手动构造传入
  const modulesSvc = app.get(ModulesService);
  const permsSvc = app.get(PermissionsService);
  const configSvc = app.get(TenantConfigService);
  app.useGlobalGuards(
    new JwtAuthGuard(jwt, reflector),
    new ModuleGuard(reflector, modulesSvc),
    new PermissionGuard(reflector, permsSvc),
    new RolesGuard(reflector),
  );

  app.setGlobalPrefix('api/v1');
  // 全局入参校验（docs/10 §10.17）：
  // - transform:true 让 @Param('id') id: number 真正变成数字（NaN → 400），字符串/布尔同理
  // - whitelist:false 不丢未知字段：web 设计器 / AI 保存的 body 历史上是整包透传的，
  //   开白名单会静默丢数据。DTO 只挡「形状」，多余字段原样保留（跟改造前行为一致）
  // - 没写 DTO 的 @Body()（metatype 是 Object）会被 pipe 跳过，存量接口零影响
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(
    new TenantContextInterceptor(modulesSvc, permsSvc, configSvc),
    new ResponseInterceptor(),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();

  // 首次启动种入默认租户、管理员与 admin 角色（幂等）
  await seedDefaultTenantAndAdmin(app.get(DataSource));

  await app.listen(PORT, '0.0.0.0');
  console.log(`LabelFlow API 已启动: http://0.0.0.0:${PORT}`);
}
bootstrap();
