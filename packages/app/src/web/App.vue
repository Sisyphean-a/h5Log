<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
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
const bodyEl = ref<HTMLElement>();
const MIN_PANE_WIDTH = 320;
const RESIZER_WIDTH = 12;
const bodyWidth = ref(0);
const preferredDetailWidth = ref<number>();
const resizing = ref(false);
const maxDetailWidth = computed(() => Math.max(MIN_PANE_WIDTH, bodyWidth.value - MIN_PANE_WIDTH - RESIZER_WIDTH));
const detailWidth = computed(() => Math.min(maxDetailWidth.value, Math.max(
  MIN_PANE_WIDTH,
  preferredDetailWidth.value ?? Math.min(580, Math.max(360, bodyWidth.value * 0.34)),
)));
let resizeStart: { pointerId: number; x: number; width: number } | undefined;
let layoutDisposed = false;
const toast = ref("");
const statusOpen = ref(false);
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
  }
}

async function restoreDetailWidth(): Promise<void> {
  if (!history) {
    showToast("浏览器不支持 IndexedDB，详情宽度无法保存");
    return;
  }
  try {
    const width = await history.loadDetailWidth();
    // Rule: 迟到的读取不能覆盖本次页面中已开始的手动调整。
    if (!layoutDisposed && !resizeStart && preferredDetailWidth.value === undefined)
      preferredDetailWidth.value = width;
  } catch (error) {
    if (!layoutDisposed)
      showToast(`读取详情宽度失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveDetailWidth(): Promise<void> {
  const width = preferredDetailWidth.value;
  if (width === undefined) return;
  if (!history) {
    showToast("浏览器不支持 IndexedDB，详情宽度无法保存");
    return;
  }
  try {
    await history.saveDetailWidth(width);
  } catch (error) {
    if (!layoutDisposed)
      showToast(`保存详情宽度失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function finishResize(): void {
  const adjusted = resizing.value && preferredDetailWidth.value !== undefined;
  stopResize();
  // Effect: 拖动结束才落盘，避免逐帧写 IndexedDB。
  if (adjusted) void saveDetailWidth();
}

function stopResize(): void {
  resizeStart = undefined;
  resizing.value = false;
}

function updateBodyWidth(): void {
  bodyWidth.value = bodyEl.value?.getBoundingClientRect().width ?? 0;
  stopResize();
}

function startResize(event: PointerEvent): void {
  if (event.button !== 0 || resizeStart) return;
  updateBodyWidth();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  resizeStart = { pointerId: event.pointerId, x: event.clientX, width: detailWidth.value };
  resizing.value = true;
  event.preventDefault();
}

function resizeDetail(event: PointerEvent): void {
  if (!resizeStart || resizeStart.pointerId !== event.pointerId) return;
  preferredDetailWidth.value = Math.min(maxDetailWidth.value, Math.max(
    MIN_PANE_WIDTH, resizeStart.width + resizeStart.x - event.clientX,
  ));
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  updateBodyWidth();
  const step = event.shiftKey ? 48 : 16;
  const width = event.key === "Home" ? MIN_PANE_WIDTH
    : event.key === "End" ? maxDetailWidth.value
      : detailWidth.value + (event.key === "ArrowLeft" ? step : -step);
  preferredDetailWidth.value = Math.min(maxDetailWidth.value, Math.max(MIN_PANE_WIDTH, width));
  void saveDetailWidth();
}

watch(() => state.detail, (detail) => {
  if (!detail) stopResize();
});

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) workbench.resume();
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) workbench.suspend();
}

onMounted(() => {
  updateBodyWidth();
  void restoreDetailWidth();
  window.addEventListener("resize", updateBodyWidth);
  workbench.connect();
  void workbench.load();
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
});
onBeforeUnmount(() => {
  layoutDisposed = true;
  stopResize();
  window.removeEventListener("resize", updateBodyWidth);
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
    <div class="app">
      <header class="workbench-header" aria-label="日志工具栏">
        <div class="toolbar">
          <div class="device-controls">
            <NSelect
              v-model:value="clientValue"
              class="client-select"
              aria-label="选择设备"
              size="small"
              filterable
              clearable
              :consistent-menu-width="false"
              :menu-props="{ style: { maxWidth: 'calc(100vw - 32px)' } }"
              placeholder="选择设备"
              :options="clientOptions"
            />
            <button
              v-if="hiddenBefore || canHideClients"
              type="button"
              class="icon-button scope-action"
              :class="{ active: hiddenBefore }"
              :aria-label="hiddenBefore ? '显示全部设备' : '隐藏其他设备'"
              :title="hiddenBefore ? '显示全部设备' : '隐藏其他设备；不删除日志，设备重新上报后会再次出现'"
              @click="hiddenBefore ? showAllClients() : hideOtherClients()"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.8 5.2A11 11 0 0 1 12 5c5.5 0 9 7 9 7a17 17 0 0 1-3 3.8M6.2 6.2A18 18 0 0 0 3 12s3.5 7 9 7a10 10 0 0 0 5-1.4" />
              </svg>
            </button>
          </div>

          <div class="search-wrap">
            <NInput
              ref="searchRef"
              size="small"
              clearable
              :value="searchInput"
              placeholder="搜索日志内容"
              aria-label="搜索日志内容"
              @update:value="onSearchInput"
            />
            <kbd v-if="!searchInput" class="kbd">/</kbd>
          </div>
          <NSelect
            v-model:value="levelValue"
            class="level-select"
            aria-label="筛选日志级别"
            size="small"
            clearable
            placeholder="级别"
            :options="levelOptions"
            :render-label="renderLevelLabel"
          />
          <NSelect
            v-model:value="sourceValue"
            class="source-select"
            aria-label="筛选日志来源"
            size="small"
            multiple
            clearable
            placeholder="全部来源"
            :max-tag-count="1"
            :options="sourceOptions"
          />

          <span v-if="state.localMode" class="badge">本地历史</span>
          <div class="view-actions">
            <button
              type="button"
              class="icon-button toggle"
              :class="{ active: state.follow }"
              :aria-pressed="state.follow"
              aria-label="跟随最新日志"
              :title="state.follow ? '暂停跟随最新日志' : '跟随最新日志'"
              @click="toggleFollow"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 5h10M4 10h10M4 15h5M17 10v10m-4-4 4 4 4-4" />
              </svg>
            </button>
            <div class="action-row">
              <button
                type="button"
                class="icon-button"
                :disabled="!canOlder"
                aria-label="更早"
                title="查看更早一页"
                @click="workbench.loadOlder()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 11a9 9 0 1 1 2.7 7.4M3 5v6h6M12 7v5l3 2" />
                </svg>
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label="最新"
                title="返回最新日志"
                @click="workbench.latest()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 4 5 5 5-5m-10 6 5 5 5-5M5 20h14" />
                </svg>
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label="清空视图"
                title="清空当前视图，不删除服务器日志和本地历史"
                @click="workbench.clearView()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m14 3 7 7-10 10H7l-5-5L14 3Zm-7 7 7 7M11 20h10" />
                </svg>
              </button>
            </div>
          </div>
          <button
            type="button"
            class="icon-button service-button"
            :data-state="state.connection"
            aria-label="服务状态"
            :title="`服务状态 · ${connectionText}（工作台与服务的连接，不代表设备在线）`"
            aria-haspopup="dialog"
            :aria-expanded="statusOpen"
            @click="openService"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="3" width="16" height="7" rx="2" />
              <rect x="4" y="14" width="16" height="7" rx="2" />
              <path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4M12 10v4" />
              <path v-if="state.connection === 'offline'" d="m3 3 18 18" />
            </svg>
          </button>
        </div>

        <p v-if="hasStaleScope" class="scope-warn" role="status">{{ scopeTitle }}</p>
        <p v-if="state.error" class="header-error error-text" role="alert">读取失败：{{ state.error }}</p>
      </header>

      <div class="main">
        <div ref="bodyEl" class="body" :class="{ 'is-resizing': resizing }" :style="{ '--detail-width': `${detailWidth}px`, '--resizer-width': `${RESIZER_WIDTH}px` }">
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
                  <a class="link" href="./demo.html" target="_blank" rel="noopener">接入演示</a>
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

          <div
            v-if="state.detail"
            class="detail-resizer"
            role="separator"
            tabindex="0"
            aria-label="调整详情面板宽度"
            aria-orientation="vertical"
            aria-controls="log-detail"
            :aria-valuemin="MIN_PANE_WIDTH"
            :aria-valuemax="maxDetailWidth"
            :aria-valuenow="Math.round(detailWidth)"
            :aria-valuetext="`详情宽度 ${Math.round(detailWidth)} 像素`"
            title="拖动调整详情宽度；左右方向键微调"
            @pointerdown="startResize"
            @pointermove="resizeDetail"
            @pointerup="finishResize"
            @pointercancel="finishResize"
            @lostpointercapture="finishResize"
            @keydown="resizeWithKeyboard"
          />
          <LogDetailPanel
            v-if="state.detail"
            id="log-detail"
            :detail="state.detail"
            @close="workbench.closeDetail()"
            @copy="showToast('已复制详情')"
          />
        </div>
      </div>

      <div v-if="toast" class="toast">{{ toast }}</div>

      <StatusDialog v-model:show="statusOpen" :service="state.service" />
    </div>
  </NConfigProvider>
</template>
