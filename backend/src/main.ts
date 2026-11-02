import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { ResponseInterceptor } from './common/response.interceptor';
import { TenantContextInterceptor } from './common/tenant-context.interceptor';
import { AllExceptionsFilter } from './common/errors.filter';
import { Reflector } from '@nestjs/core';
import { Tenant, User } from './entities/tenant.entity';

async function seedDefaultTenantAndAdmin(dataSource: DataSource) {
  const tenantRepo = dataSource.getRepository(Tenant);
  let tenant = await tenantRepo.findOne({ where: { code: 'default' } });
  if (!tenant) {
    tenant = await tenantRepo.save(
      tenantRepo.create({ name: '默认租户', code: 'default', status: 1, settings: {} }),
    );
  }
  const userRepo = dataSource.getRepository(User);
  const exists = await userRepo.findOne({ where: { username: 'admin', tenantId: tenant.id } });
  if (!exists) {
    const passwordHash = await bcrypt.hash('admin123', 10);
    await userRepo.save(
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
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 全局 JWT 守卫（先于路由级 TenantGuard 执行，写入 req.user）
  app.useGlobalGuards(new JwtAuthGuard(new JwtService({ secret: process.env.JWT_SECRET || 'dev-secret' }), new Reflector()));
  app.setGlobalPrefix('api/v1');
  app.useGlobalInterceptors(new TenantContextInterceptor(), new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();

  // 首次启动种入默认租户与管理员（幂等）
  await seedDefaultTenantAndAdmin(app.get(DataSource));

  await app.listen(process.env.PORT || 3000);
  console.log(`LabelFlow API 已启动: ${await app.getUrl()}`);
}
bootstrap();
