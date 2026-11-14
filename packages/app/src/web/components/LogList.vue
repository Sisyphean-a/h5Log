<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type { StoredLog } from "@h5-log/sdk";
import { highlightLogText, tokenClass } from "../highlight.js";
import {
  clientLabel,
  formatTime,
  httpPayload,
  levelLabels,
  messageText,
  requestIdOf,
  sourceLabels,
} from "../format.js";

const props = defineProps<{
  logs: StoredLog[];
  selectedId: number | undefined;
  query?: string;
}>();
const emit = defineEmits<{ select: [number] }>();

const listEl = ref<HTMLElement>();
const linkPaths = ref<string[]>([]);
const linkHeight = ref(0);
const summaries = new WeakMap<StoredLog, string>();
let resizeObserver: ResizeObserver | undefined;

function summary(log: StoredLog): string {
  const text = messageText(log);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function failed(log: StoredLog): boolean {
  const status = httpPayload(log)?.status;
  return typeof status === "number" && status >= 400;
}

function piecesFor(log: StoredLog) {
  let text = summaries.get(log);
  if (text === undefined) {
    text = summary(log);
    summaries.set(log, text);
  }
  return highlightLogText(text, props.query ?? "");
}

// Rule: 提示只标记每台设备某次采集的首条可见记录，不推断真实启动时间或断开状态。
const reporting = computed(() => {
  const seen = new Map<string, Set<string>>();
  const starts = new Map<number, string>();
  for (const log of props.logs) {
    let sessions = seen.get(log.clientKey);
    if (!sessions) {
      sessions = new Set();
      seen.set(log.clientKey, sessions);
    }
    if (sessions.has(log.sessionId)) continue;
    starts.set(log.id, sessions.size === 0 ? "开始上报" : "重新开始上报");
    sessions.add(log.sessionId);
  }
  return { starts, showDevice: seen.size > 1 };
});

// Rule: 只连接当前列表中同一设备、同次采集的请求记录。
const relatedIds = computed(() => {
  const selected = props.logs.find((log) => log.id === props.selectedId);
  if (!selected || selected.source !== "http") return new Set<number>();
  const requestId = requestIdOf(selected);
  if (!requestId) return new Set<number>();
  return new Set(
    props.logs
      .filter(
        (log) =>
          log.id !== selected.id &&
          log.source === "http" &&
          log.clientKey === selected.clientKey &&
          log.sessionId === selected.sessionId &&
          requestIdOf(log) === requestId,
      )
      .map((log) => log.id),
  );
});

function isRelated(log: StoredLog): boolean {
  return relatedIds.value.has(log.id);
}

function rowCenter(row: HTMLElement): number {
  return row.offsetTop + row.offsetHeight / 2;
}

function linkPath(x: number, y1: number, y2: number): string {
  const tip = x + 8;
  const direction = y2 > y1 ? 1 : -1;
  const radius = Math.min(3, Math.abs(y2 - y1) / 2);
  return `M ${tip} ${y1} H ${x + radius} Q ${x} ${y1} ${x} ${y1 + direction * radius} V ${y2 - direction * radius} Q ${x} ${y2} ${x + radius} ${y2} H ${tip}`;
}

function measureLinks(): void {
  const list = listEl.value;
  linkPaths.value = [];
  if (!list || relatedIds.value.size === 0) return;
  const selected = list.querySelector<HTMLElement>(
    `[data-log-id="${props.selectedId}"]`,
  );
  const text = selected?.querySelector<HTMLElement>(".log-text");
  if (!selected || !text) return;

  const x = text.getBoundingClientRect().left - list.getBoundingClientRect().left - 6;
  const y1 = rowCenter(selected);
  const paths = [...relatedIds.value].flatMap((id) => {
    const row = list.querySelector<HTMLElement>(`[data-log-id="${id}"]`);
    if (!row) return [];
    const y2 = rowCenter(row);
    if (Math.abs(y2 - y1) < 2) return [];
    return [linkPath(x, y1, y2)];
  });
  linkPaths.value = paths;

  const last = list.lastElementChild as HTMLElement | null;
  linkHeight.value = last ? last.offsetTop + last.offsetHeight : list.offsetHeight;
}

function scheduleMeasure(): void {
  void nextTick(measureLinks);
}

watch(() => [props.selectedId, props.logs], scheduleMeasure, { flush: "post" });

onMounted(() => {
  window.addEventListener("resize", scheduleMeasure);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(scheduleMeasure);
    if (listEl.value) resizeObserver.observe(listEl.value);
  }
  scheduleMeasure();
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", scheduleMeasure);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="listEl" class="log-list" role="list">
    <svg
      v-if="linkPaths.length > 0"
      class="log-links"
      :height="linkHeight"
      aria-hidden="true"
    >
      <path v-for="path in linkPaths" :key="path" :d="path" />
    </svg>
    <template v-for="log in logs" :key="log.id">
      <div
        v-if="reporting.starts.has(log.id)"
        class="reporting-marker"
        :data-reporting-log-id="log.id"
        role="separator"
        :aria-label="`${reporting.showDevice ? clientLabel(log) + '，' : ''}${reporting.starts.get(log.id)}`"
        title="这是这次采集的首条可见记录，不代表设备实时在线状态或实际启动时间。"
      >
        <span v-if="reporting.showDevice" class="reporting-device" :title="clientLabel(log)">{{ clientLabel(log) }}</span>
        <span class="reporting-label">{{ reporting.starts.get(log.id) }}</span>
      </div>
      <button
        :data-log-id="log.id"
        type="button"
        role="listitem"
        class="log-row"
        :class="[
          `level-${log.level}`,
          {
            selected: log.id === selectedId,
            related: isRelated(log),
            failed: failed(log),
          },
        ]"
        @click="emit('select', log.id)"
      >
        <span class="log-time">{{ formatTime(log.receivedAt) }}</span>
        <span
          class="log-source"
          :title="`${sourceLabels[log.source] ?? log.source} · ${levelLabels[log.level] ?? log.level}`"
        >{{ sourceLabels[log.source] ?? log.source }}</span>
        <span class="log-text">
          <span
            v-for="(piece, index) in piecesFor(log)"
            :key="index"
            :class="[tokenClass(piece.kind), { 'search-hit': piece.hit }]"
          >{{ piece.text }}</span>
        </span>
      </button>
    </template>
  </div>
</template>
