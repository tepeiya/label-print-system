import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { JwtService } from '@nestjs/jwt';
import { ResponseInterceptor } from './common/response.interceptor';
import { TenantContextInterceptor } from './common/tenant-context.interceptor';
import { AllExceptionsFilter } from './common/errors.filter';
import { Reflector } from '@nestjs/core';
import { Tenant, User, UserRole } from './entities/tenant.entity';
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
    await roleRepo.save({ tenantId: tenant.id, userId: admin.id, role: 'admin' });
    console.log('已授予 admin 用户 "admin" 角色');
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const reflector = new Reflector();
  const jwt = new JwtService({ secret: JWT_SECRET });
  // 全局守卫顺序：先 JWT 写 req.user，再 Roles 做权限校验
  app.useGlobalGuards(new JwtAuthGuard(jwt, reflector), new RolesGuard(reflector));
  app.setGlobalPrefix('api/v1');
  app.useGlobalInterceptors(new TenantContextInterceptor(), new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();

  // 首次启动种入默认租户、管理员与 admin 角色（幂等）
  await seedDefaultTenantAndAdmin(app.get(DataSource));

  await app.listen(PORT);
  console.log(`LabelFlow API 已启动: ${await app.getUrl()}`);
}
bootstrap();
