<script setup lang="ts">
import { computed } from "vue";
import { NButton, NModal } from "naive-ui";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ "update:show": [boolean] }>();

const snippet = computed(
  () => `import { createLogger } from '@h5-log/sdk';

export const logger = createLogger({
  enabled: import.meta.env.MODE === 'test',
  appId: '26',
  endpoint: '${location.origin}/api/logs',
  captureFetch: true,
  flushIntervalMs: 250,
});`,
);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(snippet.value);
  } catch {
    // 复制失败时保留文本供手动选择
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="接入 SDK"
    style="width: min(620px, 92vw)"
    @update:show="emit('update:show', $event)"
  >
    <p class="hint">
      在目标 H5 项目安装 <code>h5-log-sdk-0.1.0.tgz</code> 后，仅在测试构建中启用。
      演示页可以发送真实日志：<a class="link" href="/demo.html" target="_blank" rel="noopener">打开接入演示 ↗</a>
    </p>
    <pre class="json">{{ snippet }}</pre>
    <template #footer>
      <NButton size="small" @click="copy">复制代码</NButton>
    </template>
  </NModal>
</template>
