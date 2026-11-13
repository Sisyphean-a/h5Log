<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NDropdown, NInput, NSelect, NSwitch } from "naive-ui";
import type { LogClient } from "@h5-log/sdk";
import { createWorkbench } from "./workbench.js";
import { createLocalHistory } from "./history.js";
import { clientLabel, relativeTime } from "./format.js";
import LogList from "./components/LogList.vue";
import LogDetailPanel from "./components/LogDetailPanel.vue";
import StatusDialog from "./components/StatusDialog.vue";
import SetupDialog from "./components/SetupDialog.vue";

const history = createLocalHistory({
  onError: (message) => {
    toast.value = message;
  },
});
const workbench = createWorkbench({ history });
const state = workbench.state;

const searchInput = ref(state.filter.search);
const searchRef = ref<{ focus: () => void } | null>(null);
const listEl = ref<HTMLElement>();
const toast = ref("");
const statusOpen = ref(false);
const setupOpen = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let autoSelected = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const clientOptions = computed(() =>
  state.clients.map((client) => ({
    label: `${clientLabel(client)} · ${relativeTime(client.lastSeen)}`,
    value: client.key,
  })),
);
const moreOptions = [
  { label: "服务状态", key: "status" },
  { label: "接入 SDK", key: "setup" },
  { label: "复制当前列表", key: "copy" },
  { label: "导出当前列表", key: "export" },
];
const levelOptions = [
  { label: "错误", value: "error" },
  { label: "警告", value: "warn" },
  { label: "信息", value: "info" },
  { label: "调试", value: "debug" },
];
const sourceOptions = [
  { label: "控制台", value: "console" },
  { label: "异常", value: "error" },
  { label: "接口", value: "http" },
  { label: "桥接", value: "bridge" },
  { label: "自定义", value: "custom" },
];
const sessionOptions = computed(() =>
  [...state.sessions]
    .filter(
      (item) => !state.filter.clientKey || item.clientKey === state.filter.clientKey,
    )
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((item) => ({
      label: `${item.sessionId.slice(0, 6)} · ${item.logCount} 条 · ${relativeTime(item.lastSeen)}`,
      value: item.sessionId,
    })),
);

const currentClient = computed<LogClient | undefined>(() =>
  state.clients.find((client) => client.key === state.filter.clientKey),
);
const scopeTitle = computed(() =>
  currentClient.value
    ? clientLabel(currentClient.value)
    : state.filter.clientKey
      ? "客户端已过期"
      : "全部客户端",
);
const connectionText = computed(() =>
  state.connection === "open"
    ? "实时连接"
    : state.connection === "connecting"
      ? "连接中"
      : "已断开",
);
// Rule: 关键词在本地也立即过滤一次，不必等服务端往返；服务端同样按关键词收窄窗口。
const visibleLogs = computed(() => state.logs.filter((log) => workbench.matches(log)));
const canOlder = computed(() => !state.loading && state.logs.length > 0);
const clientValue = computed<string | null>({
  get: () => state.filter.clientKey || null,
  set: (value) => workbench.setScope({ clientKey: value ?? "" }),
});
const levelValue = computed<string | null>({
  get: () => state.filter.level || null,
  set: (value) => workbench.setFilter({ level: value ?? "" }),
});
const sourceValue = computed<string | null>({
  get: () => state.filter.source || null,
  set: (value) => workbench.setFilter({ source: value ?? "" }),
});
const sessionValue = computed<string | null>({
  get: () => state.filter.sessionId || null,
  set: (value) => workbench.setFilter({ sessionId: value ?? "" }),
});

function showToast(message: string): void {
  clearTimeout(toastTimer);
  toast.value = message;
  toastTimer = setTimeout(() => {
    toast.value = "";
  }, 5000);
}

function onSearchInput(value: string): void {
  searchInput.value = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if ((state.filter.search || "") === value.trim()) return;
    workbench.setFilter({ search: value.trim() });
  }, 250);
}

// Rule: 常用形态是盯住一个设备，首次加载自动选中最近上报的客户端。
watch(
  () => state.clients,
  (clients) => {
    if (autoSelected || state.filter.clientKey || clients.length === 0) return;
    autoSelected = true;
    const latest = [...clients].sort((a, b) => b.lastSeen - a.lastSeen)[0]!;
    workbench.setScope({ clientKey: latest.key });
  },
  { immediate: true },
);

watch(
  () => state.logs.length,
  async () => {
    if (!state.follow || state.localMode) return;
    await nextTick();
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

watch(
  () => state.notice,
  (message) => {
    if (message) showToast(message);
  },
);

async function loadOlder(): Promise<void> {
  await workbench.loadOlder();
}

function onScroll(): void {
  const el = listEl.value;
  if (!el || state.loading || el.scrollTop > 4) return;
  if (state.logs.length === 0) return;
  void loadOlder();
}

async function openDetail(id: number): Promise<void> {
  await workbench.openDetail(id);
}

async function openService(): Promise<void> {
  statusOpen.value = true;
  await workbench.loadService();
}

function exportPage(): void {
  const body = state.logs.map((log) => JSON.stringify(log)).join("\n");
  const blob = new Blob([body], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `h5-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已导出当前 ${visibleLogs.value.length} 条`);
}

async function copyVisible(): Promise<void> {
  try {
    await navigator.clipboard.writeText(
      state.logs.map((log) => JSON.stringify(log)).join("\n"),
    );
    showToast("已复制当前列表");
  } catch {
    showToast("复制失败，可在详情中选择内容手动复制");
  }
}

function onMore(key: string): void {
  if (key === "status") void openService();
  else if (key === "setup") setupOpen.value = true;
  else if (key === "copy") void copyVisible();
  else if (key === "export") exportPage();
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable === true;
  if (event.key === "/" && !typing) {
    event.preventDefault();
    searchRef.value?.focus();
  }
  if (event.key === "Escape") workbench.closeDetail();
}

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) workbench.resume();
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) workbench.dispose();
}

onMounted(() => {
  workbench.connect();
  void workbench.load();
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pageshow", onPageShow);
  window.removeEventListener("pagehide", onPageHide);
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);
  workbench.dispose();
  history?.dispose();
});
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark">h5</span>
        <span class="brand-name">Log<span class="brand-dot">.</span></span>
        <span class="environment-badge">TEST</span>
      </div>

      <NSelect
        v-model:value="clientValue"
        class="client-select"
        size="small"
        filterable
        clearable
        placeholder="选择客户端"
        :options="clientOptions"
      />
      <NInput
        ref="searchRef"
        class="search-input"
        size="small"
        clearable
        :value="searchInput"
        placeholder="搜索日志内容，输入即筛选"
        @update:value="onSearchInput"
      />
      <NSelect
        v-model:value="levelValue"
        class="narrow"
        size="small"
        clearable
        placeholder="级别"
        :options="levelOptions"
      />
      <NSelect
        v-model:value="sourceValue"
        class="narrow"
        size="small"
        clearable
        placeholder="来源"
        :options="sourceOptions"
      />
      <NSelect
        v-model:value="sessionValue"
        class="narrow session-select"
        size="small"
        clearable
        placeholder="会话"
        :options="sessionOptions"
      />
      <NSwitch v-model:value="state.follow" size="small">
        <template #checked>跟随</template>
        <template #unchecked>暂停</template>
      </NSwitch>
      <NButton size="tiny" quaternary :disabled="!canOlder" @click="loadOlder">更早</NButton>
      <NButton size="tiny" quaternary @click="workbench.latest()">最新</NButton>
      <NButton size="tiny" quaternary @click="workbench.clearView()">清空</NButton>
      <NDropdown :options="moreOptions" @select="onMore">
        <NButton size="tiny" quaternary>更多</NButton>
      </NDropdown>
    </header>

    <div class="status-bar">
      <span class="scope">{{ scopeTitle }}</span>
      <span class="muted">
        {{ state.total }} 条 · {{ connectionText }}
        <template v-if="state.localMode"> · 本地历史</template>
        <template v-if="searchInput"> · 关键词「{{ searchInput }}」</template>
      </span>
      <span v-if="currentClient" class="muted mono">
        {{ currentClient.appId }}/{{ currentClient.environment }} ·
        {{ currentClient.deviceId.slice(0, 6) }} ·
        {{ relativeTime(currentClient.lastSeen) }}上报
      </span>
      <span v-if="state.error" class="error-text">读取失败：{{ state.error }}</span>
    </div>

    <div class="body">
      <main ref="listEl" class="workspace" @scroll="onScroll">
        <div v-if="visibleLogs.length > 0" class="list-head">
          <span>时间</span><span>级别</span><span>来源</span><span>内容</span>
        </div>
      <div v-if="visibleLogs.length === 0" class="empty">
        <p>{{ state.loading ? "正在读取日志…" : "当前筛选没有日志" }}</p>
        <p class="hint" v-if="!state.loading">
          在手机上操作，或打开 <a class="link" href="/demo.html" target="_blank" rel="noopener">接入演示</a> 发送一条测试日志。
        </p>
      </div>
        <LogList
          v-else
          :logs="visibleLogs"
          :selected-id="state.selectedId"
          @select="openDetail"
        />
      </main>

      <LogDetailPanel
        v-if="state.detail"
        :detail="state.detail"
        @close="workbench.closeDetail()"
        @copy="showToast('已复制详情')"
        @select="openDetail"
      />
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>

    <StatusDialog v-model:show="statusOpen" :service="state.service" />
    <SetupDialog v-model:show="setupOpen" />
  </div>
</template>
