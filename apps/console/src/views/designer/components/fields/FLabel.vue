<template>
  <span class="f-label">{{ text }}</span>
</template>

<script setup lang="ts">
defineProps<{ text: string }>();
</script>
