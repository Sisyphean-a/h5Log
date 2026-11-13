<script setup lang="ts">
import { formatTime, levelLabels, messageText, sourceLabels } from "../format.js";
import type { StoredLog } from "@h5-log/sdk";

defineProps<{
  logs: StoredLog[];
  selectedId: number | undefined;
}>();
const emit = defineEmits<{ select: [number] }>();

function summary(log: StoredLog): string {
  const text = messageText(log);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
</script>

<template>
  <div class="log-list" role="list">
    <button
      v-for="log in logs"
      :key="log.id"
      class="log-row"
      :class="[`level-${log.level}`, { selected: log.id === selectedId }]"
      role="listitem"
      type="button"
      @click="emit('select', log.id)"
    >
      <span class="log-time">{{ formatTime(log.receivedAt) }}</span>
      <span class="log-level">{{ levelLabels[log.level] ?? log.level }}</span>
      <span class="log-source">{{ sourceLabels[log.source] ?? log.source }}</span>
      <span class="log-text">{{ summary(log) }}</span>
    </button>
  </div>
</template>
