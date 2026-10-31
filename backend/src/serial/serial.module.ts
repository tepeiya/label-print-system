import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SerialSequence, SerialUsageLog } from '../entities/serial.entity';
import { SerialModuleService } from './serial.service';
import { SerialController } from './serial.controller';

@Module({
  imports: [TypeOrmModule.forFeature([SerialSequence, SerialUsageLog])],
  providers: [SerialModuleService],
  controllers: [SerialController],
  exports: [SerialModuleService],
})
export class SerialModule {}
