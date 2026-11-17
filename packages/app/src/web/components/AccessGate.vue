<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ACCESS_KEY_LENGTH,
  isAccessKey,
  normalizeAccessKey,
  saveAccessKey,
} from "../access.js";

const props = defineProps<{
  checking: boolean;
  notice: string;
}>();

const emit = defineEmits<{ unlock: [warning?: string] }>();

const value = ref("");
const error = ref("");
const saving = ref(false);
const shaking = ref(false);
const inputRef = ref<HTMLInputElement>();
let shakeTimer: ReturnType<typeof setTimeout> | undefined;

function triggerShake(): void {
  shaking.value = false;
  void nextTick(() => {
    shaking.value = true;
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => {
      shaking.value = false;
    }, 320);
  });
}

function focusInput(): void {
  void nextTick(() => inputRef.value?.focus());
}

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const clean = input.value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, ACCESS_KEY_LENGTH);
  if (input.value !== clean) input.value = clean;
  value.value = clean;
  error.value = "";
  // Rule: 满 4 位自动尝试解锁，失败时清空并保留焦点。
  if (clean.length === ACCESS_KEY_LENGTH) void submit();
}

async function submit(): Promise<void> {
  if (props.checking || saving.value) return;
  const key = normalizeAccessKey(value.value);
  if (key.length !== ACCESS_KEY_LENGTH) {
    error.value = `请输入 ${ACCESS_KEY_LENGTH} 位密钥`;
    focusInput();
    return;
  }
  if (!isAccessKey(key)) {
    error.value = "密钥不正确，请重试";
    value.value = "";
    triggerShake();
    focusInput();
    return;
  }
  saving.value = true;
  let warning: string | undefined;
  try {
    await saveAccessKey(key);
  } catch (reason) {
    // Failure: 存储不可用时仍允许本次进入，但明确告知下次需要重新输入。
    warning = `已解锁，但密钥未能保存：${reason instanceof Error ? reason.message : "浏览器存储异常"}；下次打开需要重新输入`;
  }
  emit("unlock", warning);
}

watch(
  () => props.checking,
  (checking) => {
    if (!checking) focusInput();
  },
);

onMounted(() => {
  if (!props.checking) focusInput();
});

onBeforeUnmount(() => clearTimeout(shakeTimer));
</script>

<template>
  <div class="access-gate">
    <p v-if="checking" class="access-loading" role="status">正在检查登录状态…</p>
    <section
      v-else
      class="access-panel"
      :class="{ 'is-error': !!error, 'is-shaking': shaking }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="access-title"
      :aria-busy="checking || saving"
    >
      <div class="access-brand" aria-hidden="true">
        <span class="access-mark">H5</span>
        <span class="access-brand-name">LOG</span>
      </div>
      <h1 id="access-title" class="access-title">输入访问密钥</h1>

      <form class="access-form" @submit.prevent="submit">
        <label class="access-label" for="access-key">访问密钥</label>
        <input
          id="access-key"
          ref="inputRef"
          class="access-input"
          :value="value"
          type="text"
          inputmode="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          :maxlength="ACCESS_KEY_LENGTH"
          :disabled="checking || saving"
          :aria-invalid="!!error"
          :aria-describedby="error ? 'access-error' : undefined"
          :placeholder="'•'.repeat(ACCESS_KEY_LENGTH)"
          @input="onInput"
        />
        <button
          class="access-submit"
          type="submit"
          :disabled="checking || saving || value.length < ACCESS_KEY_LENGTH"
        >
          {{ saving ? "正在解锁…" : "解锁" }}
        </button>
      </form>

      <p v-if="error" id="access-error" class="access-message access-error" role="alert">
        {{ error }}
      </p>
      <p v-else-if="notice" class="access-message access-notice" role="status">{{ notice }}</p>
    </section>
  </div>
</template>
