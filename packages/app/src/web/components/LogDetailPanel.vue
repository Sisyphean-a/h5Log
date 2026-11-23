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
  parsePageUrl: boolean;
}>();
const emit = defineEmits<{ close: []; copy: [text: string]; "update:parsePageUrl": [enabled: boolean] }>();

const log = computed(() => props.detail.log);
const payload = computed(() => httpPayload(log.value));
const related = computed(() => props.detail.related);
const phaseLabel = computed(() => {
  const phase = payload.value?.phase;
  switch (phase) {
    case "request": return "请求";
    case "response": return "响应";
    case "error": return "失败";
    case undefined: return undefined;
    default: return typeof phase === "string" && phase !== "" ? phase : JSON.stringify(phase);
  }
});

const pageQuery = computed(() => {
  const url = log.value.pageUrl;
  const hashStart = url.indexOf("#");
  const queryEnd = hashStart < 0 ? url.length : hashStart;
  const queryStart = url.indexOf("?");
  if (queryStart < 0 || queryStart >= queryEnd) return;
  const search = url.slice(queryStart, queryEnd);
  if (!/[^&]/.test(search.slice(1))) return;
  return { address: url.slice(0, queryStart) + url.slice(queryEnd), search };
});
const parsedPageUrl = computed(() => props.parsePageUrl && pageQuery.value
  ? { address: pageQuery.value.address, params: [...new URLSearchParams(pageQuery.value.search)] }
  : undefined);

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
        <span v-if="phaseLabel" class="detail-phase" :class="{ 'is-error': payload?.phase === 'error' }">{{ phaseLabel }}</span>
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
        <dt>
          <button
            v-if="pageQuery"
            type="button"
            class="page-url-toggle"
            aria-label="页面 URL 解析（全局）"
            :aria-pressed="parsePageUrl"
            :title="parsePageUrl ? '关闭全局 URL 解析' : '开启全局 URL 解析'"
            @click="emit('update:parsePageUrl', !parsePageUrl)"
          >
            页面
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
              <path d="m4 3 3 3-3 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <template v-else>页面</template>
        </dt>
        <dd class="mono">
          <code>{{ (parsedPageUrl?.address ?? log.pageUrl) || "—" }}</code>
          <dl v-if="parsedPageUrl" class="detail-fields page-url-params">
            <template v-for="([key, value], index) in parsedPageUrl.params" :key="index">
              <dt>{{ key || '（空名称）' }}</dt><dd>{{ value === '' ? '""' : value }}</dd>
            </template>
          </dl>
        </dd>
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
