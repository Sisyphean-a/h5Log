<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  NButton,
  NConfigProvider,
  NDropdown,
  NInput,
  NSelect,
  type GlobalThemeOverrides,
} from "naive-ui";
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

// Rule: 组件库只提供控件行为，颜色、圆角与密度统一由工作台令牌决定，避免默认绿色与页面撞色。
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "#3f6250",
    primaryColorHover: "#4b7460",
    primaryColorPressed: "#33503f",
    primaryColorSuppl: "#4b7460",
    textColorBase: "#1b2822",
    textColor1: "#1b2822",
    textColor2: "#3d4a43",
    textColor3: "#7d8a83",
    borderColor: "#e3e7e2",
    dividerColor: "#eceee9",
    bodyColor: "#ffffff",
    borderRadius: "6px",
    borderRadiusSmall: "5px",
    fontSize: "12.5px",
    fontSizeSmall: "12px",
    fontWeightStrong: "600",
    heightSmall: "28px",
    heightTiny: "24px",
    popoverColor: "#ffffff",
    modalColor: "#ffffff",
  },
  Input: {
    color: "#ffffff",
    colorFocus: "#ffffff",
    border: "1px solid #e1e6e0",
    borderHover: "1px solid #cfd8d1",
    borderFocus: "1px solid #3f6250",
    boxShadowFocus: "0 0 0 2px rgba(63, 98, 80, 0.12)",
    paddingSmall: "0 9px",
  },
  Select: {
    peers: {
      InternalSelection: {
        border: "1px solid #e1e6e0",
        borderHover: "1px solid #cfd8d1",
        borderActive: "1px solid #3f6250",
        borderFocus: "1px solid #3f6250",
        boxShadowActive: "0 0 0 2px rgba(63, 98, 80, 0.12)",
        boxShadowFocus: "0 0 0 2px rgba(63, 98, 80, 0.12)",
      },
    },
  },
  Button: {
    textColorQuaternaryHover: "#1b2822",
    textColorQuaternaryPressed: "#1b2822",
    colorQuaternaryHover: "#eef2ee",
    colorQuaternaryPressed: "#e6ece7",
    textColorHover: "#1b2822",
    fontWeight: "500",
  },
  Switch: {
    railColorActive: "#3f6250",
    railColor: "#d8ded9",
  },
  Dropdown: {
    optionHeightSmall: "28px",
  },
};

const canMatchMedia = typeof window.matchMedia === "function";
const narrow = ref(
  canMatchMedia && window.matchMedia("(max-width: 900px)").matches,
);
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
const moreOptions = computed(() => [
  ...(narrow.value ? [{ label: "清空视图", key: "clear" }] : []),
  { label: "服务状态", key: "status" },
  { label: "接入 SDK", key: "setup" },
  { label: "复制当前列表", key: "copy" },
  { label: "导出当前列表", key: "export" },
]);

// Rule: 手机上只留“选设备 + 搜索”，级别/来源/会话收进“筛选”，避免工具条占掉半个屏幕。
const activeFilterCount = computed(
  () =>
    [state.filter.level, state.filter.source, state.filter.sessionId].filter(
      Boolean,
    ).length,
);
const filterOptions = computed(() => [
  {
    type: "group",
    label: "级别",
    key: "group-level",
    children: [
      { label: "全部级别", key: "level:" },
      ...levelOptions.map((item) => ({
        label: item.label,
        key: `level:${item.value}`,
      })),
    ],
  },
  {
    type: "group",
    label: "来源",
    key: "group-source",
    children: [
      { label: "全部来源", key: "source:" },
      ...sourceOptions.map((item) => ({
        label: item.label,
        key: `source:${item.value}`,
      })),
    ],
  },
  {
    type: "group",
    label: "会话",
    key: "group-session",
    children: [
      { label: "全部会话", key: "session:" },
      ...sessionOptions.value.map((item) => ({
        label: item.label,
        key: `session:${item.value}`,
      })),
    ],
  },
]);
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
const showScopeInSubline = computed(
  () => !!state.filter.clientKey && !currentClient.value,
);
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

function toggleFollow(): void {
  state.follow = !state.follow;
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
  const body = visibleLogs.value.map((log) => JSON.stringify(log)).join("\n");
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
      visibleLogs.value.map((log) => JSON.stringify(log)).join("\n"),
    );
    showToast("已复制当前列表");
  } catch {
    showToast("复制失败，可在详情中选择内容手动复制");
  }
}

function onFilter(key: string): void {
  const [field, value = ""] = key.split(":");
  if (field === "level") workbench.setFilter({ level: value });
  else if (field === "source") workbench.setFilter({ source: value });
  else if (field === "session") workbench.setFilter({ sessionId: value });
}

function onMore(key: string): void {
  if (key === "clear") workbench.clearView();
  else if (key === "status") void openService();
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
  if (event.persisted) workbench.suspend();
}

let media: MediaQueryList | undefined;
function onMediaChange(event: MediaQueryListEvent): void {
  narrow.value = event.matches;
}

onMounted(() => {
  if (typeof window.matchMedia === "function") {
    media = window.matchMedia("(max-width: 900px)");
    narrow.value = media.matches;
    media.addEventListener("change", onMediaChange);
  }
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
  media?.removeEventListener("change", onMediaChange);
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);
  workbench.dispose();
  history?.dispose();
});
</script>

<template>
  <NConfigProvider :theme-overrides="themeOverrides">
    <div class="app">
      <header class="toolbar">
        <div class="brand">
          <span class="brand-mark">h5</span>
          <span class="brand-name">Log</span>
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

        <div class="search-wrap">
          <NInput
            ref="searchRef"
            size="small"
            clearable
            :value="searchInput"
            placeholder="搜索日志内容"
            @update:value="onSearchInput"
          />
          <kbd v-if="!searchInput" class="kbd">/</kbd>
        </div>

        <template v-if="!narrow">
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
        </template>
        <NDropdown v-else :options="filterOptions" @select="onFilter">
          <NButton size="small" quaternary>
            筛选<span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
          </NButton>
        </NDropdown>

        <span class="spacer" />

        <button
          type="button"
          class="toggle"
          :class="{ on: state.follow }"
          :aria-pressed="state.follow"
          title="跟随最新日志"
          @click="toggleFollow"
        >
          <i class="toggle-dot" />跟随
        </button>
        <NButton size="small" quaternary :disabled="!canOlder" @click="loadOlder">
          更早
        </NButton>
        <NButton size="small" quaternary @click="workbench.latest()">最新</NButton>
        <NButton
          v-if="!narrow"
          size="small"
          quaternary
          @click="workbench.clearView()"
        >
          清空
        </NButton>
        <NDropdown :options="moreOptions" @select="onMore">
          <NButton size="small" quaternary>更多</NButton>
        </NDropdown>
      </header>

      <div class="subline">
        <span class="count">{{ state.total }} 条</span>
        <span class="conn" :data-state="state.connection">
          <i class="conn-dot" />{{ connectionText }}
        </span>
        <span v-if="state.localMode" class="badge">本地历史</span>
        <span v-if="searchInput" class="badge">关键词 {{ searchInput }}</span>
        <span v-if="showScopeInSubline" class="badge warn">{{ scopeTitle }}</span>
        <span class="spacer" />
        <span v-if="state.error" class="error-text">读取失败：{{ state.error }}</span>
        <span class="hint-key"><kbd class="kbd">/</kbd> 搜索</span>
      </div>

      <div class="body">
        <main ref="listEl" class="workspace" @scroll="onScroll">
          <div v-if="visibleLogs.length > 0" class="list-head">
            <span>时间</span><span>级别</span><span>来源</span><span>内容</span>
          </div>
          <div v-if="visibleLogs.length === 0" class="empty">
            <p class="empty-title">
              {{ state.loading ? "正在读取日志…" : "当前范围没有日志" }}
            </p>
            <p v-if="!state.loading" class="hint">
              在手机上操作，或打开
              <a class="link" href="/demo.html" target="_blank" rel="noopener">接入演示</a>
              发一条测试日志。
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
  </NConfigProvider>
</template>
