<script setup lang="ts">
import { computed } from "vue";
import { NButton } from "naive-ui";
import type { LogDetail } from "@h5-log/sdk";
import {
  formatDateTime,
  formatTime,
  httpPayload,
  jsonText,
  levelLabels,
  messageText,
  sourceLabels,
} from "../format.js";
import JsonBlock from "./JsonBlock.vue";

const props = defineProps<{
  detail: LogDetail;
}>();
const emit = defineEmits<{ close: []; copy: []; select: [number] }>();

const log = computed(() => props.detail.log);
const payload = computed(() => httpPayload(log.value));
const related = computed(() => props.detail.related);
const requestText = computed(() => messageText(log.value));

function copyJson(): void {
  void navigator.clipboard
    .writeText(jsonText({ log: log.value, related: related.value }))
    .then(() => emit("copy"))
    .catch(() => emit("copy"));
}
</script>

<template>
  <aside class="detail">
    <header class="detail-head">
      <div class="detail-title">
        <span class="detail-level" :class="`level-${log.level}`">
          <i class="level-dot" />{{ levelLabels[log.level] ?? log.level }}
        </span>
        <span class="detail-source">{{ sourceLabels[log.source] ?? log.source }}</span>
      </div>
      <div class="detail-actions">
        <NButton size="tiny" quaternary @click="copyJson">复制 JSON</NButton>
        <NButton size="tiny" quaternary @click="emit('close')">关闭</NButton>
      </div>
    </header>
    <p class="detail-time">{{ formatDateTime(log.receivedAt) }}</p>

    <div class="detail-body">
      <dl class="meta">
        <dt>应用</dt>
        <dd>{{ log.appId }} / {{ log.environment }}</dd>
        <dt>设备</dt>
        <dd>{{ log.deviceName || log.deviceId }}</dd>
        <dt>会话</dt>
        <dd class="mono">{{ log.sessionId }}</dd>
        <dt>页面</dt>
        <dd class="mono ellipsis" :title="log.pageUrl">{{ log.pageUrl || "—" }}</dd>
        <template v-if="payload">
          <dt>请求</dt>
          <dd class="mono ellipsis" :title="requestText">{{ requestText }}</dd>
        </template>
      </dl>

      <section v-if="log.args.length > 0" class="block">
        <h3>内容</h3>
        <JsonBlock :value="log.args.length === 1 ? log.args[0] : log.args" />
      </section>

      <section class="block">
        <h3>关联请求</h3>
        <p v-if="related.length === 0" class="hint">
          没有同一次请求的其他记录，可能已被淘汰或尚未返回。
        </p>
        <button
          v-for="item in related"
          :key="item.id"
          type="button"
          class="related-row"
          :class="`level-${item.level}`"
          @click="emit('select', item.id)"
        >
          <span class="related-time">{{ formatTime(item.receivedAt) }}</span>
          <span class="related-source">{{ sourceLabels[item.source] ?? item.source }}</span>
          <span class="related-text">{{ messageText(item) }}</span>
        </button>
      </section>
    </div>
  </aside>
</template>
