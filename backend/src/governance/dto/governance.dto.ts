// P8.3 企业治理 DTO。全局 ValidationPipe 为 whitelist:false，只做最小必要校验，
// 深度合法性由 governance.calc.normalizePolicy / transitionVerdict 在函数层兜住（脏数据不绕过治理）。
import { IsIn, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { GOVERNANCE_ACTIONS } from '../governance.calc';

export class SavePolicyDto {
  /** 原样传给 normalizePolicy 夹取；字段缺失/越界一律收敛到默认宽松策略 */
  @IsObject()
  policy!: Record<string, any>;
}

export class ReviewActionDto {
  @IsIn(GOVERNANCE_ACTIONS as unknown as string[])
  action!: string;

  /** 驳回 / 应急直发必填（状态机强制），其余可选 */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;

  /** 审批通过时锁定的模板版本号；不传则由服务层读 templates.current_version */
  @IsOptional()
  publishedVersion?: number;
}
