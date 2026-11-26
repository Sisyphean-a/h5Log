<script setup lang="ts">
import { computed } from "vue";
import { jsonDisplayText, jsonTokens } from "../format.js";

const props = defineProps<{ value: unknown; copyLabel?: string | undefined }>();
const emit = defineEmits<{ copy: [text: string, label: string] }>();

const tokens = computed(() => {
  const text = jsonDisplayText(props.value);
  // Rule: 接口 JSON 按节点数限制开销，避免少量长字符串失去逐项复制。
  return props.copyLabel ? jsonTokens(text, Infinity, 16000) : jsonTokens(text);
});

function copyToken(event: MouseEvent): void {
  if (!(event.target instanceof HTMLButtonElement) || !props.copyLabel) return;
  const token = tokens.value[Number(event.target.dataset.tokenIndex)];
  if (!token) return;
  const key = token.kind === "key";
  const text = key || token.kind === "string" ? JSON.parse(token.text) as string : token.text;
  emit("copy", text, props.copyLabel + (key ? "键" : "值"));
}
</script>

<template>
  <pre v-if="copyLabel" class="json" @click="copyToken"><component
    v-for="(token, index) in tokens"
    :key="index"
    :is="token.kind === 'plain' || token.kind === 'punct' ? 'span' : 'button'"
    :class="[`tok-${token.kind}`, { 'detail-copy-value': token.kind !== 'plain' && token.kind !== 'punct' }]"
    v-bind="token.kind === 'plain' || token.kind === 'punct' ? {} : {
      type: 'button',
      'data-token-index': index,
      title: token.kind === 'key' ? '复制键' : '复制值',
    }"
  >{{ token.text }}</component></pre>
  <pre v-else class="json"><span
    v-for="(token, index) in tokens"
    :key="index"
    :class="`tok-${token.kind}`"
  >{{ token.text }}</span></pre>
</template>
