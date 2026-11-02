import { DefaultNamingStrategy } from 'typeorm';
import { NamingStrategyInterface } from 'typeorm';
import { snakeCase } from 'typeorm/util/StringUtils';

/**
 * 统一命名策略：实体未显式指定 column name 时，按 snake_case 映射，
 * 对齐 docs/03-database.sql 的蛇形命名（created_at / updated_at 等）。
 * 已通过 @Column({ name: '...' }) 指定的列保持不变。
 */
export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  columnName(propertyName: string, customName?: string): string {
    return customName ?? snakeCase(propertyName);
  }
}
