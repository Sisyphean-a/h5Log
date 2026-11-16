<script setup lang="ts">
import { computed } from "vue";
import { NModal, NSpin } from "naive-ui";
import type { LogClient, ServiceStatus } from "@h5-log/sdk";
import { formatDateTime } from "../format.js";

const props = defineProps<{
  show: boolean;
  service: ServiceStatus | undefined;
  connection: string;
  lastStreamAt: number | undefined;
  client: LogClient | undefined;
}>();
const emit = defineEmits<{ "update:show": [boolean] }>();

const rows = computed(() => {
  const service = props.service;
  if (!service) return [];
  const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;
  const { limits } = service;
  return [
    ["电脑与服务的连接", props.connection],
    ["最近收到服务推送", props.lastStreamAt === undefined ? "尚未收到" : formatDateTime(props.lastStreamAt)],
    ["所选设备最近上报", props.client ? formatDateTime(props.client.lastSeen) : "未选择设备或暂无记录"],
    ["服务状态", service.status],
    ["服务器 ID", service.serverId],
    ["运行时长", `${Math.floor(service.uptimeSeconds / 60)} 分钟`],
    ["保留时长", `${service.retentionHours} 小时`],
    ["当前条数", `${service.logs} / ${limits.maxLogs}`],
    ["当前体积", `${mb(service.bytes)} / ${mb(limits.maxBytes)}`],
    ["设备", String(service.clients)],
    ["查看连接", `${service.subscribers} / ${limits.maxSubscribers}`],
    ["累计接收 / 淘汰", `${service.received} / ${service.evicted}`],
    ["单条上限", `${Math.round(limits.maxEventBytes / 1024)} KiB`],
  ];
});
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="服务状态"
    style="width: min(520px, 92vw)"
    @update:show="emit('update:show', $event)"
  >
    <NSpin :show="!service">
      <dl v-if="service" class="meta wide">
        <template v-for="[label, value] in rows" :key="label">
          <dt>{{ label }}</dt>
          <dd class="mono">{{ value }}</dd>
        </template>
      </dl>
      <p v-else class="hint">正在读取服务状态…</p>
      <p class="hint">电脑连接正常不代表手机仍在上报；设备时间仅表示服务端最近收到日志的时间。</p>
    </NSpin>
  </NModal>
</template>
