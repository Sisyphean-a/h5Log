<script setup lang="ts">
import { computed } from "vue";
import { jsonText, jsonTokens } from "../format.js";

const props = defineProps<{ value: unknown }>();

const tokens = computed(() => jsonTokens(jsonText(props.value)));
</script>

<template>
  <pre class="json"><span
    v-for="(token, index) in tokens"
    :key="index"
    :class="`tok-${token.kind}`"
  >{{ token.text }}</span></pre>
</template>
