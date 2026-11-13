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

const props = defineProps<{
  detail: LogDetail;
}>();
const emit = defineEmits<{ close: []; copy: []; select: [number] }>();

const log = computed(() => props.detail.log);
const hasArgs = computed(() => log.value.args.length > 0);
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
      <div>
        <span class="detail-level" :class="`level-${log.level}`">
          {{ levelLabels[log.level] ?? log.level }}
        </span>
        <span class="detail-source">{{ sourceLabels[log.source] ?? log.source }}</span>
        <time class="detail-time">{{ formatDateTime(log.receivedAt) }}</time>
      </div>
      <div class="detail-actions">
        <NButton size="tiny" quaternary @click="copyJson">复制 JSON</NButton>
        <NButton size="tiny" quaternary @click="emit('close')">关闭</NButton>
      </div>
    </header>

    <div class="detail-body">
      <dl class="meta">
        <dt>应用</dt><dd>{{ log.appId }} / {{ log.environment }}</dd>
        <dt>设备</dt><dd>{{ log.deviceName || log.deviceId }}</dd>
        <dt>会话</dt><dd class="mono">{{ log.sessionId.slice(0, 8) }}</dd>
        <dt>页面</dt><dd class="mono" :title="log.pageUrl">{{ log.pageUrl || "—" }}</dd>
        <dt v-if="log.requestId">请求</dt>
        <dd v-if="log.requestId" class="mono">{{ log.requestId }}</dd>
        <dt v-if="httpPayload(log)">去向</dt>
        <dd v-if="httpPayload(log)">{{ requestText }}</dd>
      </dl>

      <section v-if="hasArgs" class="block">
        <h3>内容</h3>
        <pre class="json">{{ jsonText(log.args.length === 1 ? log.args[0] : log.args) }}</pre>
      </section>

      <section class="block">
        <h3>关联请求</h3>
        <p v-if="related.length === 0" class="hint">
          没有找到同一次请求的其他记录，可能已被淘汰或尚未返回。
        </p>
        <button
          v-for="item in related"
          :key="item.id"
          type="button"
          class="related-row"
          :class="`level-${item.level}`"
          @click="emit('select', item.id)"
        >
          <span>{{ formatTime(item.receivedAt) }}</span>
          <span>{{ sourceLabels[item.source] ?? item.source }}</span>
          <span>{{ messageText(item) }}</span>
        </button>
      </section>

      <section class="block">
        <h3>原始事件</h3>
        <pre class="json">{{ jsonText(log) }}</pre>
      </section>
    </div>
  </aside>
</template>
