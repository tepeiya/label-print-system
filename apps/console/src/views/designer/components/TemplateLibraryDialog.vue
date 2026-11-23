<template>
  <el-dialog
    :model-value="modelValue"
    title="模板库"
    width="900px"
    top="6vh"
    class="tpl-dialog"
    :destroy-on-close="true"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <TemplateLibraryPanel :version-target="versionTarget" @open="onOpen" />
  </el-dialog>
</template>

<script setup lang="ts">
// =============================================================================
// TemplateLibraryDialog.vue —— 模板库弹窗（纯外壳）
//   列表 / 版本逻辑全部下沉到 TemplateLibraryPanel，这里只负责弹窗容器与
//   「打开」事件的落地：调 useTemplateIO.open 把模板载入画布，再关闭自身。
//   destroy-on-close 保证每次打开都重新挂载 Panel，触发列表重新拉取。
// =============================================================================
import TemplateLibraryPanel from './TemplateLibraryPanel.vue';
import { useTemplateIO } from '../useTemplateIO';

defineProps<{ modelValue: boolean; versionTarget?: number | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; opened: [] }>();

const io = useTemplateIO();

async function onOpen(id: number) {
  if (await io.open(id)) {
    emit('update:modelValue', false);
    emit('opened');
  }
}
</script>
