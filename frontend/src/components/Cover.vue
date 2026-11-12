<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ url?: string; title?: string }>()
const broken = ref(false)
watch(
  () => props.url,
  () => {
    broken.value = false
  },
)
</script>
<template>
  <img
    :src="!broken && props.url ? props.url : '/cover.svg'"
    :alt="props.title || '专辑封面'"
    loading="lazy"
    referrerpolicy="no-referrer"
    @error="broken = true"
  />
</template>
