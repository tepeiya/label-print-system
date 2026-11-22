/**
 * Jest 集成测试专用配置（与现有 node:test 纯函数测试并存，互不干扰）
 *
 * 为什么需要独立配置：
 *   node:test 用 tsx 跑纯函数测试（快、无依赖），但 tsx/esbuild 不 emit
 *   decorator metadata，一 import 真实 entity 就报 ColumnTypeUndefinedError。
 *   jest + ts-jest 走完整 tsc 编译（emitDecoratorMetadata=true），能正确加载
 *   真实 entity / TypeORM DataSource，专用于真 PG 集成测试。
 *
 * 运行：pnpm test:integration
 * 前提：测试 PG 已就绪（见 docs/14-wms-phase1-acceptance.md §9）
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.int.test.ts'],
  setupFiles: ['<rootDir>/test/integration/setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        strict: true,
        strictPropertyInitialization: false,
        target: 'ES2021',
        module: 'commonjs',
        skipLibCheck: true,
      },
      isolatedModules: false, // 必须 false：emitDecoratorMetadata 需要类型信息
    }],
  },
  testTimeout: 30000,
  maxWorkers: 1, // 真库测试串行，避免并发建单互相干扰
  verbose: true,
};
