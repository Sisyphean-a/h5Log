<script setup lang="ts">
import type { StoredLog } from "@h5-log/sdk";
import {
  formatTime,
  httpPayload,
  levelLabels,
  messageText,
  sourceLabels,
} from "../format.js";

defineProps<{
  logs: StoredLog[];
  selectedId: number | undefined;
}>();
const emit = defineEmits<{ select: [number] }>();

function summary(log: StoredLog): string {
  const text = messageText(log);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function failed(log: StoredLog): boolean {
  const status = httpPayload(log)?.status;
  return typeof status === "number" && status >= 400;
}
</script>

<template>
  <div class="log-list" role="list">
    <button
      v-for="log in logs"
      :key="log.id"
      type="button"
      role="listitem"
      class="log-row"
      :class="[
        `level-${log.level}`,
        { selected: log.id === selectedId, failed: failed(log) },
      ]"
      @click="emit('select', log.id)"
    >
      <span class="log-time">{{ formatTime(log.receivedAt) }}</span>
      <span class="log-level">
        <i class="level-dot" />{{ levelLabels[log.level] ?? log.level }}
      </span>
      <span class="log-source">{{ sourceLabels[log.source] ?? log.source }}</span>
      <span class="log-text">{{ summary(log) }}</span>
    </button>
  </div>
</template>
