// BullMQ Worker 入口：独立进程消费 print 队列（与 API 分离，避免阻塞事件循环）
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PrintProcessor } from './src/print/print.processor';

async function bootstrap() {
  // 仅需要 Worker 上下文：启动 Nest 以实例化 Provider（PrintProcessor 注册 BullMQ Worker）
  await NestFactory.createApplicationContext(AppModule);
  console.log('LabelFlow Print Worker 已启动，监听 print 队列');
}
bootstrap();
