<template>
  <div class="insp-inner">
    <span class="f-hint">{{ HINT }}</span>

    <div v-for="v in vars" :key="v.name" class="var-card">
      <div class="var-row">
        <FText :model-value="v.name" @update:model-value="rename(v, $event)" />
        <FText :model-value="v.label ?? ''" placeholder="显示名" @update:model-value="patch(v, { label: $event })" />
        <FBtn kind="danger" @click="removeVar(v)">✕</FBtn>
      </div>
      <FText
        :model-value="String(v.expr ?? '')"
        placeholder="计算公式（留空=普通变量；如 {{price}} * {{qty}}）"
        @update:model-value="patch(v, { expr: $event })"
      />
      <FText
        :model-value="String(v.defaultValue ?? '')"
        :placeholder="v.expr ? '出错兜底值（设计态预览用）' : '示例值（设计态预览用）'"
        @update:model-value="patch(v, { defaultValue: $event })"
      />
      <span v-if="cycleHint" class="f-hint f-hint-bad">{{ cycleHint }}</span>
      <div class="var-row">
        <FSelect :model-value="v.validation ?? ''" :options="VAR_VALIDATIONS" @update:model-value="patch(v, { validation: $event })" />
        <FText
          v-if="v.validation === 'regex'"
          :model-value="v.regex ?? ''"
          placeholder="正则表达式，如 ^\d{4}-\d{4}$"
          @update:model-value="patch(v, { regex: $event })"
        />
      </div>
      <div class="var-row">
        <FCheck text="必填" :model-value="!!v.required" @update:model-value="patch(v, { required: $event })" />
        <FCheck text="唯一码" :model-value="!!v.unique" @update:model-value="patch(v, { unique: $event })" />
      </div>
      <span class="f-hint">{{ ph(v.name) }}</span>
    </div>

    <div class="var-actions">
      <FBtn @click="addVar">＋ 新增变量</FBtn>
      <FBtn @click="importProductFields">导入产品字段</FBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
// 变量面板（inspector.js#variablesView）：name / label / 示例值 / 校验 / 必填 / 唯一
// name 改动要用 rename 走「按旧名定位、按新名写入」，否则 v-model 直接改 key 会丢历史与占位引用。
import { computed, inject } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useDesignerStore } from '../store';
import { VAR_VALIDATIONS } from '../model';
import { detectComputedCycle } from '../engine/context';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import type { VariableSpec } from '../types';
import FBtn from './fields/FBtn.vue';
import FCheck from './fields/FCheck.vue';
import FSelect from './fields/FSelect.vue';
import FText from './fields/FText.vue';

const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const vars = computed(() => store.variables);

/** 计算变量成环时给出可见反馈；环上变量求值时已回落到 default 兜底，不会崩 */
const cycleHint = computed(() => {
  const fields: Record<string, string> = {};
  for (const v of vars.value) if (v.expr?.trim()) fields[v.name] = v.expr!;
  const cycle = detectComputedCycle(fields);
  return cycle.length ? `公式循环依赖：${cycle.join(' → ')}（这些变量将显示兜底值）` : '';
});

/** 提示语里要出现真正的花括号，写在模板里会被当成插值，所以放这儿 */
const HINT = '变量名支持中文；写 {{变量名}} 绑定数据，可用「导入产品字段」一次加入产品资料字段；打印日期可带格式与偏移，如 {{@printDate:YYYYMMDD|+3d}}';
const ph = (name: string) => `占位：{{${name}}}`;

function patch(v: VariableSpec, p: Partial<VariableSpec>) {
  commit.begin();
  store.updateVariable(v.name, p);
  commit.end();
}

function rename(v: VariableSpec, next: string) {
  const nn = next.trim();
  if (!nn || nn === v.name) return;
  if (!/^[^\s{}@0-9][^\s{}]*$/.test(nn)) {
    ElMessage.error('变量名不能含空格、花括号，不能以数字或 @ 开头；支持中文');
    return;
  }
  if (vars.value.some((x) => x.name === nn)) {
    ElMessage.error('变量已存在');
    return;
  }
  patch(v, { name: nn });
}

function removeVar(v: VariableSpec) {
  commit.begin();
  store.removeVariable(v.name);
  commit.end();
}

/** 产品打印行的中文字段别名，导入后设计器预览与打印出纸用同一份变量名 */
const PRODUCT_FIELDS = [
  { name: '产品编码', label: '产品编码', defaultValue: 'M-DEMO-001' },
  { name: '产品名称', label: '产品名称', defaultValue: '示例产品' },
  { name: '规格型号', label: '规格型号', defaultValue: '' },
  { name: '单位', label: '单位', defaultValue: '件' },
  { name: '产品类别', label: '产品类别', defaultValue: '' },
  { name: '批次号', label: '批次号', defaultValue: '' },
  { name: '生产日期', label: '生产日期', defaultValue: '' },
  { name: '到期日', label: '到期日', defaultValue: '' },
  { name: '库存数量', label: '库存数量', defaultValue: '0' },
];

function importProductFields() {
  let added = 0;
  commit.begin();
  for (const f of PRODUCT_FIELDS) {
    if (vars.value.some((x) => x.name === f.name)) continue;
    store.addVariable({ name: f.name, type: 'text', label: f.label, defaultValue: f.defaultValue });
    added++;
  }
  commit.end();
  ElMessage.success(added ? `已导入 ${added} 个产品字段变量` : '产品字段变量已存在');
}

async function addVar() {
  let value: string;
  try {
    const r = await ElMessageBox.prompt('变量名（英文/数字，如 orderNo）', '新增变量', {
      inputValue: `field${vars.value.length + 1}`,
      confirmButtonText: '添加',
      cancelButtonText: '取消',
    });
    value = String(r.value ?? '').trim();
  } catch {
    return;
  }
  if (!value) return;
  if (!/^[^\s{}@0-9][^\s{}]*$/.test(value)) {
    ElMessage.error('变量名不能含空格、花括号，不能以数字或 @ 开头；支持中文');
    return;
  }
  if (vars.value.some((x) => x.name === value)) {
    ElMessage.error('变量已存在');
    return;
  }
  commit.begin();
  store.addVariable({ name: value, type: 'text', label: value, defaultValue: '' });
  commit.end();
}
</script>
