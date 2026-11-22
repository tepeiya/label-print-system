<template>
  <el-tour
    v-model="visible"
    :current="current"
    :mask="{ color: 'rgba(15,23,42,.55)' }"
    @update:current="current = $event"
    @finish="finish"
    @close="finish"
  >
    <el-tour-step
      target=".d-toolbar"
      placement="bottom"
      title="① 顶部工具栏"
      description="常用操作都在这里：新建、模板库、打印预览、保存。右边的「?」可以随时打开快捷键大全。"
    />
    <el-tour-step
      target=".toolbox"
      placement="right"
      title="② 左侧元素库"
      description="点一下就把元素放到画布中央。每种元素下面有一句白话说明，鼠标悬停能看到详细解释。"
    />
    <el-tour-step
      target=".viewport"
      placement="right"
      title="③ 中间画布"
      description="点选元素、拖动移动、Shift 多选、拖空白处框选、双击文字直接改。右键任何元素还有快捷菜单。"
    />
    <el-tour-step
      target=".inspector"
      placement="left"
      title="④ 右侧属性面板"
      description="选中元素后在这里改样式。「属性/页面/图层/变量」四个页签，高级设置默认折叠，不会被一堆选项淹没。"
    />
    <el-tour-step
      target=".d-toolbar .btn.primary"
      placement="bottom"
      title="⑤ 完成后记得保存"
      description="改完点「保存」写入模板库。未保存时左上角会显示「● 未保存」。现在去试试加一个文本吧！"
    />
  </el-tour>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const TOUR_KEY = 'labelflow.designerTourDone';
const current = ref(0);

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

function finish() {
  localStorage.setItem(TOUR_KEY, '1');
  emit('update:modelValue', false);
}

onMounted(() => {
  if (!localStorage.getItem(TOUR_KEY)) {
    // 稍等一帧，等画布和面板挂载后再定位引导锚点
    setTimeout(() => emit('update:modelValue', true), 400);
  }
});
</script>
