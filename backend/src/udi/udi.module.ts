// UDI 模块（医疗合规赋码）：纯数据与判定，无库依赖，先于 UDI 追溯落地。
// 后续里程碑（udi.trace 表/导出/真机）在本模块内扩展，不新建顶层模块。
import { Module } from '@nestjs/common';
import { UdiController } from './udi.controller';
import { UdiService } from './udi.service';

@Module({ controllers: [UdiController], providers: [UdiService], exports: [UdiService] })
export class UdiModule {}
