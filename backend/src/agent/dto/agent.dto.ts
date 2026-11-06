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

/**
 * Prompt 库写入（P6.5，PUT /agent-prompts/:name）。
 * name 走 URL；这里只做「形状」校验，语义校验（占位符是否声明、名字规则）在 prompt.calc.ts，
 * 因为 MCP/预览也要复用同一套规则，不能只靠 DTO。
 */
export class UpsertPromptDto {
  @IsString() @Length(2, 120) title: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsString() @Length(10, 20000) content: string;
  @IsOptional() @IsArray() @ArrayMaxSize(12) arguments?: any[];
  @IsOptional() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}
