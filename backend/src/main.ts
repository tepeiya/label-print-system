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
import { PORT } from './common/config';
// B2.2 上线前加固：启动期配置强校验（生产带 dev 密钥/弱口令直接拒绝启动）
import { readConfigSnapshot, assertProductionConfig } from './common/config.guard';
// D2 上线加固：traceId + 结构化日志 / 全局限流 / 健康探针 / 优雅停机
import { traceMiddleware, accessLogMiddleware, log } from './common/trace.middleware';
import { rateLimitMiddleware } from './common/rate-limit.middleware';
import { HealthController } from './common/health.controller';

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
  // 必须在建连/建容器之前：严格模式下有 block 级问题直接抛错，进程不启动（fail-closed）。
  // dev/test 只打印 warn，不打断本地开发与单测。日志只报「哪项不合规」，绝不打印密钥明文。
  const configIssues = assertProductionConfig(readConfigSnapshot());
  for (const issue of configIssues) {
    console.warn(`[CONFIG ${issue.level}] ${issue.key}: ${issue.message}`);
  }

  const app = await NestFactory.create(AppModule);
  // 中间件顺序（express 层，先挂先生效）：
  //   trace(生成 traceId 并进 ALS) → 限流 → 访问日志 → Nest 路由
  // trace 必须最先，否则限流/日志里没有 traceId。
  app.use(traceMiddleware());
  app.use(rateLimitMiddleware());
  app.use(accessLogMiddleware());

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
    new TenantContextInterceptor(modulesSvc, permsSvc, configSvc, app.get(DataSource)),
    new ResponseInterceptor(),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();
  // 让 TenantDataSourceManager / BullMQ 的 onApplicationShutdown 在 SIGTERM 时执行，
  // 独立库与 RLS 角色连接池才能被干净释放（否则滚动发布时会留一堆半开连接）。
  app.enableShutdownHooks();

  // 首次启动种入默认租户、管理员与 admin 角色（幂等）
  await seedDefaultTenantAndAdmin(app.get(DataSource));

  // 裸 /health 探针（不带 /api/v1 前缀，compose/nginx/k8s 探针习惯这个路径）。
  // 直接挂在 express 实例上，不经过拦截器，返回体是原始 JSON（便于 curl 一眼看）。
  const health = app.get(HealthController);
  const http = app.getHttpAdapter().getInstance();
  http.get('/health/live', (_req: any, res: any) => res.json(health.live()));
  http.get('/health/ready', async (_req: any, res: any) => res.json(await health.ready(res)));
  http.get('/health', async (_req: any, res: any) => res.json(await health.summary()));

  await app.listen(PORT, '0.0.0.0');
  log.info('api_started', { port: PORT, pid: process.pid, node: process.version, env: process.env.NODE_ENV || 'dev' });

  // 优雅停机（docs/24 §D2）：SIGTERM 先停止收新连接 → 等在途请求与连接池收尾 → 超时强杀。
  // app.enableShutdownHooks() 已注册 onApplicationShutdown（TenantDataSourceManager / BullMQ 会释放池）。
  const shutdown = async (signal: string) => {
    const timeoutMs = +(process.env.SHUTDOWN_TIMEOUT_MS || 20000);
    log.info('shutdown_begin', { signal, timeoutMs });
    const force = setTimeout(() => {
      log.error('shutdown_forced', { signal, timeoutMs });
      process.exit(1);
    }, timeoutMs);
    force.unref();
    try {
      await app.close();
      log.info('shutdown_ok', { signal });
      clearTimeout(force);
      process.exit(0);
    } catch (e: any) {
      log.error('shutdown_failed', { signal, error: e?.message });
      process.exit(1);
    }
  };
  // enableShutdownHooks() 自带一套 SIGTERM/SIGINT listener（会调 app.close()），
  // 我们再注册一套就会 app.close() 两次 → pg 报 "Called end on pool more than once"。
  // 统一由下面的自研 handler 负责（它内部只调一次 app.close() + 超时强杀 + 日志）。
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 兜底：未捕获异常/未处理的 Promise 拒绝必须留证据（否则容器里只看到进程被 OOM/重启）
  process.on('uncaughtException', (err) => {
    log.error('uncaught_exception', { error: err?.message, stack: String(err?.stack || '').split('\n').slice(0, 5).join(' | ') });
  });
  process.on('unhandledRejection', (reason: any) => {
    log.error('unhandled_rejection', { error: reason?.message ?? String(reason) });
  });
}
bootstrap();
