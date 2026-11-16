<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  NButton,
  NConfigProvider,
  NInput,
  NSelect,
  type GlobalThemeOverrides,
  type SelectRenderLabel,
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

// Rule: 控件与工作区统一使用蓝色强调、冷灰背景，绿色只表示成功状态。
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "#3568d4",
    primaryColorHover: "#4478e7",
    primaryColorPressed: "#2856b7",
    primaryColorSuppl: "#4478e7",
    textColorBase: "#17243a",
    textColor1: "#17243a",
    textColor2: "#2b3a50",
    textColor3: "#52647d",
    placeholderColor: "#5a6b82",
    borderColor: "#d9e1eb",
    dividerColor: "#e7ecf2",
    bodyColor: "#eef2f6",
    borderRadius: "6px",
    borderRadiusSmall: "5px",
    fontFamily: "var(--font-sans)",
    fontFamilyMono: "var(--font-mono)",
    fontSize: "14px",
    fontSizeSmall: "14px",
    fontSizeTiny: "13px",
    fontWeightStrong: "600",
    heightSmall: "32px",
    heightTiny: "26px",
    popoverColor: "#ffffff",
    modalColor: "#ffffff",
  },
  Input: {
    color: "#f7f9fb",
    colorFocus: "#ffffff",
    border: "1px solid #d9e1eb",
    borderHover: "1px solid #9db6e0",
    borderFocus: "1px solid #3568d4",
    boxShadowFocus: "0 0 0 2px rgba(53, 104, 212, 0.12)",
    paddingSmall: "0 10px",
  },
  Select: {
    peers: {
      InternalSelection: {
        color: "#ffffff",
        placeholderColor: "#5a6b82",
        border: "1px solid #d9e1eb",
        borderHover: "1px solid #9db6e0",
        borderActive: "1px solid #3568d4",
        borderFocus: "1px solid #3568d4",
        boxShadowActive: "0 0 0 2px rgba(53, 104, 212, 0.12)",
        boxShadowFocus: "0 0 0 2px rgba(53, 104, 212, 0.12)",
      },
    },
  },
  Button: {
    textColorQuaternaryHover: "#2856b7",
    textColorQuaternaryPressed: "#2856b7",
    colorQuaternaryHover: "#edf3ff",
    colorQuaternaryPressed: "#dfeaff",
    textColorHover: "#2856b7",
    fontWeight: "500",
  },
};

const searchInput = ref(state.filter.search);
const searchRef = ref<{ focus: () => void } | null>(null);
const listEl = ref<HTMLElement>();
const toast = ref("");
const statusOpen = ref(false);
const setupOpen = ref(false);
const sidebarOpen = ref(false);
const CLIENT_HIDE_KEY = "h5-log:hidden-clients-before";
const hiddenBefore = ref(readHiddenBefore());
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let autoSelected = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const clientOptions = computed(() =>
  state.clients
    .filter(
      (client) =>
        client.key === state.filter.clientKey ||
        client.lastSeen >= hiddenBefore.value,
    )
    .map((client) => ({
      label: `${clientLabel(client)} · ${relativeTime(client.lastSeen)}`,
      value: client.key,
    })),
);
const canHideClients = computed(
  () =>
    !!state.filter.clientKey &&
    state.clients.some((client) => client.key !== state.filter.clientKey),
);
const levelOptions = [
  { label: "错误", value: "error" },
  { label: "警告", value: "warn" },
  { label: "信息", value: "info" },
  { label: "调试", value: "debug" },
];
const renderLevelLabel: SelectRenderLabel = (option) => h(
  "span",
  { class: ["level-label", `level-${option.value}`] },
  String(option.label),
);
const sourceOptions = [
  { label: "控制台", value: "console" },
  { label: "异常", value: "error" },
  { label: "接口", value: "http" },
];

const currentClient = computed<LogClient | undefined>(() =>
  state.clients.find((client) => client.key === state.filter.clientKey),
);
const scopeTitle = computed(() =>
  currentClient.value
    ? clientLabel(currentClient.value)
    : state.filter.clientKey
      ? "设备暂无记录"
      : "全部设备",
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
const viewCleared = computed(() => state.clearAfter > 0 && !state.loading);
const canOlder = computed(() =>
  !state.loading && state.logs.length > 0 && (state.serverHasMore || state.localHasMore),
);
const hasStaleScope = computed(
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
const sourceValue = computed<string[]>({
  get: () => state.filter.source ? state.filter.source.split(",") : [],
  set: (value) => workbench.setFilter({ source: value.join(",") }),
});

function readHiddenBefore(): number {
  try {
    const value = Number(localStorage.getItem(CLIENT_HIDE_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function persistHiddenBefore(): void {
  try {
    if (hiddenBefore.value > 0) {
      localStorage.setItem(CLIENT_HIDE_KEY, String(hiddenBefore.value));
    } else {
      localStorage.removeItem(CLIENT_HIDE_KEY);
    }
  } catch {
    // Failure: 本地存储不可用时只隐藏当前会话。
  }
}

function hideOtherClients(): void {
  hiddenBefore.value = Date.now();
  persistHiddenBefore();
}

function showAllClients(): void {
  hiddenBefore.value = 0;
  persistHiddenBefore();
}

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
  if (event.key === "Escape") {
    workbench.closeDetail();
    sidebarOpen.value = false;
  }
}

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) workbench.resume();
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) workbench.suspend();
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
  <NConfigProvider :theme-overrides="themeOverrides">
    <div class="app" :class="{ 'sidebar-open': sidebarOpen }">
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-head">
          <div class="brand">
            <span class="brand-mark">h5</span>
            <span class="brand-name">Log</span>
          </div>
          <span class="spacer" />
          <button
            type="button"
            class="drawer-close"
            aria-label="关闭侧栏"
            @click="sidebarOpen = false"
          >
            ×
          </button>
        </div>

        <div class="sidebar-scroll">
          <NSelect
            v-model:value="clientValue"
            class="client-select"
            size="small"
            filterable
            clearable
            :consistent-menu-width="false"
            :menu-props="{ style: { maxWidth: 'calc(100vw - 32px)' } }"
            placeholder="选择设备"
            :options="clientOptions"
          />

          <div class="scope-meta">
            <span class="count">{{ state.total }} 条</span>
            <span class="conn" :data-state="state.connection" title="工作台与日志服务的连接状态，不代表设备在线状态">
              <i class="conn-dot" />{{ connectionText }}
            </span>
            <span v-if="state.localMode" class="badge">本地历史</span>
            <button
              v-if="hiddenBefore"
              type="button"
              class="scope-action"
              title="恢复显示所有设备"
              @click="showAllClients"
            >
              显示全部设备
            </button>
            <button
              v-else-if="canHideClients"
              type="button"
              class="scope-action"
              title="只影响当前浏览器的设备列表，不删除日志；设备重新上报后会再次出现"
              @click="hideOtherClients"
            >
              隐藏其他设备
            </button>
          </div>
          <p v-if="hasStaleScope" class="scope-warn">{{ scopeTitle }}</p>

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

          <div class="filter-stack">
            <NSelect
              v-model:value="levelValue"
              size="small"
              clearable
              placeholder="级别"
              :options="levelOptions"
              :render-label="renderLevelLabel"
            />
            <NSelect
              v-model:value="sourceValue"
              size="small"
              multiple
              clearable
              placeholder="全部来源"
              :max-tag-count="2"
              :options="sourceOptions"
            />
          </div>

          <div class="side-actions">
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
            <div class="action-row">
              <NButton
                size="small"
                quaternary
                :disabled="!canOlder"
                title="手动查看更早一页，点击“最新”返回实时日志"
                @click="workbench.loadOlder()"
              >
                更早
              </NButton>
              <NButton size="small" quaternary @click="workbench.latest()">最新</NButton>
              <NButton
                size="small"
                quaternary
                title="清空当前视图，不删除服务器日志和本地历史"
                @click="workbench.clearView()"
              >
                清空视图
              </NButton>
            </div>
          </div>
        </div>

        <div class="sidebar-foot">
          <p v-if="state.error" class="error-text">读取失败：{{ state.error }}</p>
          <div class="foot-actions">
            <button type="button" class="quiet-link" @click="openService">服务状态</button>
            <button type="button" class="quiet-link" @click="setupOpen = true">接入 SDK</button>
            <button type="button" class="quiet-link" @click="copyVisible">复制列表</button>
            <button type="button" class="quiet-link" @click="exportPage">导出列表</button>
          </div>
        </div>
      </aside>

      <div v-if="sidebarOpen" class="scrim" @click="sidebarOpen = false" />

      <div class="main">
        <div class="mobile-bar">
          <button
            type="button"
            class="bar-menu"
            aria-label="打开侧栏"
            aria-controls="sidebar"
            :aria-expanded="sidebarOpen"
            title="打开侧栏"
            @click="sidebarOpen = true"
          >
            ☰
          </button>
          <span class="bar-scope">{{ scopeTitle }}</span>
          <span class="spacer" />
          <span v-if="state.error" class="bar-error">读取失败</span>
          <span class="count">{{ state.total }} 条</span>
          <span
            class="conn"
            :data-state="state.connection"
            title="工作台与日志服务的连接状态，不代表设备在线状态"
          >
            <i class="conn-dot" />{{ connectionText }}
          </span>
        </div>

        <div class="body">
          <main ref="listEl" class="workspace">
            <div v-if="visibleLogs.length > 0" class="list-head">
              <span>时间</span><span>来源</span><span>内容</span>
            </div>
            <div v-if="visibleLogs.length === 0" class="empty">
              <p class="empty-title">
                {{
                  state.loading
                    ? "正在读取日志…"
                    : viewCleared
                      ? "视图已清空"
                      : state.total > 0 ? "当前页没有日志" : "当前范围没有日志"
                }}
              </p>
              <p v-if="!state.loading" class="hint">
                <template v-if="viewCleared">
                  服务器日志仍在；新日志会继续显示。
                  <button
                    type="button"
                    class="empty-action"
                    @click="workbench.resetView()"
                  >
                    恢复视图
                  </button>
                </template>
                <template v-else-if="state.total > 0">
                  最新日志仍可查看。
                  <button type="button" class="empty-action" @click="workbench.latest()">查看最新日志</button>
                </template>
                <template v-else>
                  在手机上操作，或打开
                  <a class="link" href="/demo.html" target="_blank" rel="noopener">接入演示</a>
                  发一条测试日志。
                </template>
              </p>
            </div>
            <LogList
              v-else
              :logs="visibleLogs"
              :selected-id="state.selectedId"
              :query="state.filter.search"
              @select="openDetail"
            />
          </main>

          <LogDetailPanel
            v-if="state.detail"
            :detail="state.detail"
            @close="workbench.closeDetail()"
            @copy="showToast('已复制详情')"
          />
        </div>
      </div>

      <div v-if="toast" class="toast">{{ toast }}</div>

      <StatusDialog v-model:show="statusOpen" :service="state.service" />
      <SetupDialog v-model:show="setupOpen" />
    </div>
  </NConfigProvider>
</template>
