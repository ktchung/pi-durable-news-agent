<script setup lang="ts">
import { computed } from "vue";
import type { ModelInfo } from "@dna/sdk";

const props = defineProps<{ model?: ModelInfo; level?: string; label: string }>();
const emit = defineEmits<{ change: [level: string] }>();
const levels = computed(() => props.model?.thinkingLevels ?? []);
const current = computed(() => props.level ?? props.model?.defaultThinkingLevel);
const selected = computed(() =>
  current.value && levels.value.includes(current.value) ? current.value : "",
);

function change(event: Event) {
  const level = (event.target as HTMLSelectElement).value;
  if (levels.value.includes(level)) emit("change", level);
}
</script>

<template>
  <label class="thinking-select">
    <span class="control-label">Thinking</span>
    <select
      :value="selected"
      :aria-label="label"
      :disabled="!levels.length"
      :title="!levels.length ? 'Thinking levels are unavailable for this model' : undefined"
      @change="change"
    >
      <option v-if="!selected" value="" disabled>
        {{
          !levels.length ? "Unavailable" : current ? `${current} (unavailable)` : "Choose effort"
        }}
      </option>
      <option v-for="level in levels" :key="level" :value="level">{{ level }}</option>
    </select>
  </label>
</template>
