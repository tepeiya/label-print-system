<template>
  <button type="button" class="f-btn" :class="kind ? `f-btn-${kind}` : ''" :disabled="disabled" @click="emit('click')">
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ kind?: 'danger' | 'primary'; disabled?: boolean }>(), {});
const emit = defineEmits<{ click: [] }>();
</script>
