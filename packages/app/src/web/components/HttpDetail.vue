<script setup lang="ts">
import { computed } from "vue";
import type { JsonValue } from "@h5-log/sdk";
import JsonBlock from "./JsonBlock.vue";

const props = defineProps<{ payload: Record<string, JsonValue> }>();
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
const sections = computed(() => [
  { key: "params", label: "请求参数" },
  { key: "headers", label: props.payload.phase === "request" ? "请求头" : props.payload.phase === "response" ? "响应头" : "头信息" },
  { key: "body", label: props.payload.phase === "request" ? "请求正文" : props.payload.phase === "response" ? "响应正文" : "正文" },
  { key: "error", label: "错误" },
].filter((section) => has(section.key)));
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
      <h3>{{ section.label }}</h3>
      <template v-if="section.key === 'headers' && headers !== undefined">
        <dl v-if="headers.length > 0" class="detail-fields">
          <template v-for="[key, value] in headers" :key="key">
            <dt>{{ key }}</dt><dd>{{ inlineValue(value) }}</dd>
          </template>
        </dl>
        <p v-else class="http-empty">{}</p>
      </template>
      <p v-else-if="payload[section.key] === ''" class="http-empty">""</p>
      <JsonBlock v-else :value="payload[section.key]" />
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
