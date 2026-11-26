<script setup lang="ts">
import { computed } from "vue";
import type { JsonValue } from "@h5-log/sdk";
import { logValueCopyText } from "../log-copy.js";
import JsonBlock from "./JsonBlock.vue";

const props = defineProps<{ payload: Record<string, JsonValue> }>();
const emit = defineEmits<{ copy: [text: string, label: string] }>();
const has = (key: string): boolean => Object.hasOwn(props.payload, key);
// Rule: 收发阶段由详情标题显示；状态和耗时仅保留在列表与原始数据中。
const knownKeys = new Set(["phase", "method", "url", "status", "durationMs", "requestId", "params", "headers", "body", "error"]);

const query = computed(() => {
  if (typeof props.payload.url !== "string") return [];
  const path = props.payload.url.split("#", 1)[0]!;
  const start = path.indexOf("?");
  // Rule: 保留同名参数的每次出现，片段中的问号不是查询串。
  return start < 0 ? [] : [...new URLSearchParams(path.slice(start + 1))];
});
const headers = computed(() => {
  const value = props.payload.headers;
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value) : undefined;
});
const bodyDisplay = computed(() => {
  const value = props.payload.body;
  if (typeof value !== "string") return { value, json: true };
  try {
    JSON.parse(value);
    return { value, json: true };
  } catch {
    const type = headers.value?.find(([key]) => key.toLowerCase() === "content-type")?.[1];
    // Rule: SDK 解包后的顶层 JSON 字符串以原值保存，借助媒体类型区分普通文本。
    const json = typeof type === "string" && /[/+]json(?:\s*;|\s*$)/i.test(type);
    return { value: json ? JSON.stringify(value) : value, json };
  }
});

function hasContent(value: JsonValue | undefined): boolean {
  if (value == null) return false;
  // Rule: SDK 将未采集到的 undefined 序列化为占位文本。
  if (typeof value === "string") {
    const text = value.trim();
    return text !== "" && text !== "[undefined]" && !/^(?:\{\s*\}|\[\s*\])$/.test(text);
  }
  return typeof value !== "object" || Object.keys(value).length > 0;
}

const sections = computed(() => [
  { key: "params", label: "请求参数", visible: hasContent(props.payload.params), copy: false },
  { key: "headers", label: props.payload.phase === "request" ? "请求头" : props.payload.phase === "response" ? "响应头" : "头信息", visible: has("headers"), copy: true },
  { key: "body", label: props.payload.phase === "request" ? "请求正文" : props.payload.phase === "response" ? "响应正文" : "正文", visible: hasContent(props.payload.body), copy: true },
  { key: "error", label: "错误", visible: has("error"), copy: false },
].filter((section) => section.visible));
const extra = computed(() => Object.fromEntries(
  Object.entries(props.payload).filter(([key]) => !knownKeys.has(key)),
));
const hasExtra = computed(() => Object.keys(extra.value).length > 0);
const empty = computed(() => Object.keys(props.payload).length === 0);

function structuredValue(value: JsonValue): boolean {
  return value !== null && typeof value === "object"
    || typeof value === "string" && /^[{\[]/.test(value.trim());
}

function inlineValue(value: unknown): string {
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value) ?? String(value);
}
</script>

<template>
  <div class="http-detail">
    <div v-if="has('method') || has('url')" class="http-request-line">
      <span v-if="has('method')" class="http-method">{{ inlineValue(payload.method) }}</span>
      <code v-if="has('url')" class="http-endpoint ellipsis" :title="inlineValue(payload.url)">{{ inlineValue(payload.url) }}</code>
    </div>

    <section v-if="query.length > 0" class="http-section" data-http-section="query">
      <h3>查询参数 <span>{{ query.length }}</span></h3>
      <dl class="detail-fields">
        <template v-for="([key, value], index) in query" :key="index">
          <dt>{{ key || '（空名称）' }}</dt><dd>{{ value === '' ? '""' : value }}</dd>
        </template>
      </dl>
    </section>

    <section v-for="section in sections" :key="section.key" class="http-section" :data-http-section="section.key">
      <h3>
        {{ section.label }}
        <button
          v-if="section.copy"
          type="button"
          class="http-copy-section"
          :aria-label="'复制' + section.label"
          :title="'复制' + section.label"
          @click="emit('copy', logValueCopyText(payload[section.key]!), section.label)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
          </svg>
        </button>
      </h3>
      <template v-if="section.key === 'headers' && headers !== undefined">
        <dl v-if="headers.length > 0" class="detail-fields">
          <template v-for="[key, value] in headers" :key="key">
            <dt>{{ key }}</dt>
            <dd><button
              type="button"
              class="detail-copy-value"
              :title="'复制' + section.label + '值'"
              @click="emit('copy', logValueCopyText(value), section.label + '值')"
            >{{ inlineValue(value) }}</button></dd>
          </template>
        </dl>
        <p v-else class="http-empty">{}</p>
      </template>
      <JsonBlock
        v-else-if="section.key === 'body'"
        :value="bodyDisplay.value"
        :copy-label="bodyDisplay.json ? section.label : undefined"
        @copy="(text, label) => emit('copy', text, label)"
      />
      <p v-else-if="payload[section.key] === ''" class="http-empty">""</p>
      <JsonBlock
        v-else
        :value="payload[section.key]"
        :copy-label="section.key === 'headers' && Array.isArray(payload.headers) ? section.label : undefined"
        @copy="(text, label) => emit('copy', text, label)"
      />
    </section>

    <section v-if="hasExtra" class="http-section" data-http-section="extra">
      <h3>其他字段</h3>
      <dl class="detail-fields">
        <template v-for="(value, key) in extra" :key="key">
          <dt :class="{ 'http-field-structured': structuredValue(value) }">{{ key }}</dt>
          <dd :class="{ 'http-field-structured': structuredValue(value) }">
            <JsonBlock v-if="structuredValue(value)" :value="value" />
            <template v-else>{{ inlineValue(value) }}</template>
          </dd>
        </template>
      </dl>
    </section>
    <JsonBlock v-if="empty" :value="payload" />
  </div>
</template>
