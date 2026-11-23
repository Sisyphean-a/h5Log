<script setup lang="ts">
import { computed } from "vue";
import { NModal } from "naive-ui";
import type { ResourceMetric, WorkbenchServiceStatus } from "../../service-status.js";

const props = defineProps<{
  show: boolean;
  service: WorkbenchServiceStatus | undefined;
  error: string;
}>();
const emit = defineEmits<{ "update:show": [boolean] }>();

const cpu = (value: number | null): string => value === null ? "—" : `${value.toFixed(1)}%`;
const mib = (value: number | null): string => value === null ? "—" : `${(value / 2 ** 20).toFixed(1)} MiB`;
const gib = (value: number | null): string => value === null ? "—" : `${(value / 2 ** 30).toFixed(2)} GiB`;

const resources = computed(() => props.service?.resources);
const resourceRows = computed(() => {
  const sample = resources.value;
  if (!sample) return [];
  const row = (label: string, metric: ResourceMetric, format: (value: number | null) => string) =>
    [label, format(metric.current), format(metric.peak)];
  return [
    row("宿主机 CPU", sample.hostCpu, cpu),
    row("宿主机内存", sample.hostMemory, gib),
    row("H5 Log CPU", sample.processCpu, cpu),
    row("H5 Log 内存", sample.processMemory, mib),
  ];
});

const statusRows = computed(() => {
  const service = props.service;
  if (!service) return [];
  const { limits } = service;
  return [
    ["运行时长", `${Math.floor(service.uptimeSeconds / 60)} 分钟`],
    ["当前条数", `${service.logs} / ${limits.maxLogs}`],
    ["当前体积", `${mib(service.bytes)} / ${mib(limits.maxBytes)}`],
    ["设备", String(service.clients)],
    ["查看连接", `${service.subscribers} / ${limits.maxSubscribers}`],
    ["累计接收 / 淘汰", `${service.received} / ${service.evicted}`],
  ];
});
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="服务状态"
    style="width: min(780px, calc(100vw - 24px))"
    @update:show="emit('update:show', $event)"
  >
    <div class="status-body">
      <p v-if="error" class="status-error" role="status">{{ error }}{{ service ? "（保留上次结果）" : "" }}</p>
      <p v-else-if="!service" class="status-note" role="status">正在读取服务状态…</p>
      <template v-if="service && resources">
        <section aria-labelledby="resource-heading">
          <div class="status-heading">
            <h3 id="resource-heading">资源监控</h3>
            <span v-if="resources.hostMemory.total !== null" class="status-note">
              宿主机总内存 {{ gib(resources.hostMemory.total) }}
            </span>
          </div>
          <table class="resource-table" aria-labelledby="resource-heading">
            <thead>
              <tr><th scope="col">指标</th><th scope="col">当前</th><th scope="col">采样峰值</th></tr>
            </thead>
            <tbody>
              <tr v-for="[label, current, peak] in resourceRows" :key="label">
                <th scope="row">{{ label }}</th><td class="mono">{{ current }}</td><td class="mono">{{ peak }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="log-status" aria-labelledby="log-status-heading">
          <h3 id="log-status-heading">日志服务</h3>
          <dl class="status-list">
            <div v-for="[label, value] in statusRows" :key="label">
              <dt>{{ label }}</dt>
              <dd class="mono">{{ value }}</dd>
            </div>
          </dl>
        </section>
      </template>
    </div>
  </NModal>
</template>

<style scoped>
.status-body {
  max-height: calc(100dvh - 110px);
  overflow: auto;
}
.status-heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 4px 12px;
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.resource-table {
  width: 100%;
  margin: 8px 0;
  border-collapse: collapse;
  font-size: 13px;
  text-align: right;
}
.resource-table :is(th, td) {
  padding: 7px 8px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.resource-table th {
  font-weight: 500;
  color: var(--muted);
}
.resource-table th:first-child {
  padding-left: 0;
  text-align: left;
}
.status-note, .status-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.status-error {
  margin-bottom: 10px;
  color: #a22b30;
}
.log-status {
  margin-top: 16px;
}
.status-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
  margin: 10px 0 0;
  font-size: 13px;
}
.status-list > div {
  display: grid;
  grid-template-columns: 8rem minmax(0, 1fr);
  gap: 8px;
}
.status-list dt {
  white-space: nowrap;
  color: var(--muted);
}
.status-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 650px) {
  .status-list {
    grid-template-columns: minmax(0, 1fr);
  }
  .resource-table :is(th, td) {
    padding-inline: 4px;
  }
}
</style>
