// Agent 管理面 DTO（/agents，§11.6.1；类名带 Agent 前缀避免与全局 DTO 冲突）
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Max, Min,
} from 'class-validator';

export class CreateAgentClientDto {
  @IsString() @Length(1, 80) name: string;
  @IsOptional() @IsString() @Length(0, 300) description?: string;
  @IsOptional() @IsIn(['mcp_stdio', 'mcp_http', 'internal']) kind?: 'mcp_stdio' | 'mcp_http' | 'internal';
}

export class CreateAgentTokenDto {
  /** 权限点子集；缺省 = 只读集合（§11.7.7 护栏 2） */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) scopes?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
}

export class SetAgentClientStatusDto {
  @IsIn(['active', 'disabled']) status: 'active' | 'disabled';
}
