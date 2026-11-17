<script setup lang="ts">
import { computed } from "vue";
import { NButton } from "naive-ui";
import type { LogDetail } from "@h5-log/sdk";
import {
  formatDateTime,
  httpPayload,
  jsonText,
  levelLabels,
  sourceLabels,
} from "../format.js";
import JsonBlock from "./JsonBlock.vue";
import HttpDetail from "./HttpDetail.vue";

const props = defineProps<{
  detail: LogDetail;
}>();
const emit = defineEmits<{ close: []; copy: [text: string] }>();

const log = computed(() => props.detail.log);
const payload = computed(() => httpPayload(log.value));
const related = computed(() => props.detail.related);

function copyJson(): void {
  emit("copy", jsonText({ log: log.value, related: related.value }));
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
    <p class="detail-time" title="SDK 采集日志时的设备时间">发生时间 {{ formatDateTime(log.timestamp) }}</p>

    <div class="detail-body">
      <dl class="meta">
        <dt>接收时间</dt>
        <dd>{{ formatDateTime(log.receivedAt) }}</dd>
        <dt>应用设备</dt>
        <dd>{{ log.appId }} / {{ log.environment }} · {{ log.deviceName || log.deviceId }}</dd>
        <dt>页面</dt>
        <dd class="mono">{{ log.pageUrl || "—" }}</dd>
      </dl>

      <HttpDetail v-if="payload" :payload="payload" />
      <section v-else-if="log.args.length > 0" class="block">
        <h3>内容</h3>
        <JsonBlock :value="log.args.length === 1 ? log.args[0] : log.args" />
      </section>
      <section v-if="payload && log.args.length > 1" class="http-section" data-http-section="args">
        <h3>附加输出</h3>
        <JsonBlock :value="log.args.slice(1)" />
      </section>
    </div>
  </aside>
</template>
