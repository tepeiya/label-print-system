<template>
  <section class="f-group">
    <div v-if="title" class="f-group-title">{{ title }}</div>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{ title?: string }>();
</script>
