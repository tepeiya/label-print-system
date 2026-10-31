import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 全局 JWT 守卫（先于路由级 TenantGuard 执行，写入 req.user）
  app.useGlobalGuards(new JwtAuthGuard(new JwtService({ secret: process.env.JWT_SECRET || 'dev-secret' })));
  app.enableCors();
  await app.listen(process.env.PORT || 3000);
  console.log(`LabelFlow API 已启动: ${await app.getUrl()}`);
}
bootstrap();
