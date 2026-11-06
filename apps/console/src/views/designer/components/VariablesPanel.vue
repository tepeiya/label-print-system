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
        :model-value="String(v.defaultValue ?? '')"
        placeholder="示例值（设计态预览用）"
        @update:model-value="patch(v, { defaultValue: $event })"
      />
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

    <FBtn @click="addVar">＋ 新增变量</FBtn>
  </div>
</template>

<script setup lang="ts">
// 变量面板（inspector.js#variablesView）：name / label / 示例值 / 校验 / 必填 / 唯一
// name 改动要用 rename 走「按旧名定位、按新名写入」，否则 v-model 直接改 key 会丢历史与占位引用。
import { computed, inject } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useDesignerStore } from '../store';
import { VAR_VALIDATIONS } from '../model';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import type { VariableSpec } from '../types';
import FBtn from './fields/FBtn.vue';
import FCheck from './fields/FCheck.vue';
import FSelect from './fields/FSelect.vue';
import FText from './fields/FText.vue';

const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const vars = computed(() => store.variables);

/** 提示语里要出现真正的花括号，写在模板里会被当成插值，所以放这儿 */
const HINT = '在文本/条码/单元格里写 {{变量名}} 即可绑定数据';
const ph = (name: string) => `占位：{{${name}}}`;

function patch(v: VariableSpec, p: Partial<VariableSpec>) {
  commit.begin();
  store.updateVariable(v.name, p);
  commit.end();
}

function rename(v: VariableSpec, next: string) {
  const nn = next.trim();
  if (!nn || nn === v.name) return;
  if (!/^[A-Za-z_][\w]*$/.test(nn)) {
    ElMessage.error('变量名只能由字母、数字、下划线组成，且以字母或下划线开头');
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
  if (!/^[A-Za-z_][\w]*$/.test(value)) {
    ElMessage.error('变量名只能由字母、数字、下划线组成，且以字母或下划线开头');
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
