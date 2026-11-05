/**
 * 入参校验底座单测（docs/10 §10.17）
 * 历史根因：POST /templates 少传 content → 一路穿透到 TypeORM → 500。
 * 现在全局 ValidationPipe + DTO 在门口就拦成 400。
 * 注意：本文件不 import TypeORM 实体（tsx 不产出 decorator metadata，实体类会炸 ColumnTypeUndefinedError）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationPipe } from '@nestjs/common';
import { CreateTemplateDto, ImportTemplateDto } from '../../template/dto/template.dto';
import { SaveSqlDto } from '../../datasource/dto/datasource.dto';
import { ResetPasswordDto } from '../../user/dto/user.dto';
import { AddModuleDto } from '../../saas/dto/platform.dto';
import { AllExceptionsFilter } from '../errors.filter';
import { BadRequestException } from '@nestjs/common';

// 与 main.ts 注册的全局 pipe 同配置
const pipe = new ValidationPipe({ transform: true, whitelist: false, forbidNonWhitelisted: false });

test('POST /templates 缺 content → 400（原来是 500 的根因）', async () => {
  await assert.rejects(
    () => pipe.transform({ name: '测试模板' }, { type: 'body', metatype: CreateTemplateDto }),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      const msgs = err.getResponse().message as string[];
      assert.ok(msgs.some((m) => m.includes('content')), '报错里要点名 content');
      return true;
    },
  );
});

test('POST /templates 合法 body 通过，且未知字段保留（whitelist:false 不丢数据）', async () => {
  const body = {
    name: '测试模板',
    content: { page: {}, elements: [] },
    // web 设计器历史上会带的各种额外字段：全都要原样透传
    isFavorite: true,
    someLegacyField: { a: 1 },
  };
  const out: any = await pipe.transform(body, { type: 'body', metatype: CreateTemplateDto });
  assert.equal(out.name, '测试模板');
  assert.equal(out.isFavorite, true, '额外字段不能被白名单吃掉');
  assert.equal(out.someLegacyField.a, 1);
});

test('multipart / 兜底型 @Body()（metatype Object）不校验、原样通过', async () => {
  const body: any = { foo: 'bar', n: 1 };
  const out: any = await pipe.transform(body, { type: 'body', metatype: Object });
  assert.deepEqual(out, body);
});

test('data-sources/save-sql 缺 connectionUrl → 400', async () => {
  await assert.rejects(
    () => pipe.transform({ name: 'x' }, { type: 'body', metatype: SaveSqlDto }),
    (err: any) => err.getStatus() === 400,
  );
});

test('users/:id/reset-password 缺 newPassword → 400（console 曾错发 { password } 打不到这个字段）', async () => {
  await assert.rejects(
    () => pipe.transform({ password: '123456' }, { type: 'body', metatype: ResetPasswordDto }),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      assert.ok((err.getResponse().message as string[]).some((m) => m.includes('newPassword')));
      return true;
    },
  );
});

test('platform 加购：moduleCode 缺失 → 400', async () => {
  await assert.rejects(
    () => pipe.transform({ source: 'addon' }, { type: 'body', metatype: AddModuleDto }),
    (err: any) => err.getStatus() === 400,
  );
});

test('template/import：schemaVersion 0 的旧包（带多余字段）能过 DTO', async () => {
  const out: any = await pipe.transform(
    { schemaVersion: 0, name: '旧包', category: '默认', tags: [], content: { page: {}, elements: [] }, extra: 1 },
    { type: 'body', metatype: ImportTemplateDto },
  );
  assert.equal(out.schemaVersion, 0);
});

test('AllExceptionsFilter 把 class-validator 的 string[] 拼成可读 message + errors 明细', () => {
  let captured: any = null;
  const res = { status: () => res, json: (b: any) => { captured = b; } };
  const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }) };
  new AllExceptionsFilter().catch(
    new BadRequestException({ statusCode: 400, message: ['name 必填', 'content 必须是对象'], error: 'Bad Request' }),
    host,
  );
  assert.equal(captured.code, 400);
  assert.ok(captured.message.includes('参数校验失败'), JSON.stringify(captured));
  assert.ok(captured.message.includes('content'));
  assert.deepEqual(captured.errors, ['name 必填', 'content 必须是对象']);
  assert.equal(captured.data, null);
});
