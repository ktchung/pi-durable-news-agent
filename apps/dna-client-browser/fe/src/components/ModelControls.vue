<script setup lang="ts">
// Shown above the composer when the Model toggle is on: the agent's model and thinking level, the quick model and its
// thinking for one-shot jobs (reading publish dates), then the deep research subagents' model, thinking and count.
import { computed } from "vue";
import { ChevronDown } from "@lucide/vue";
import { agentState, api, attempt, feed, info, ui } from "../client/store";
import ThinkingSelect from "./ThinkingSelect.vue";

type ThinkingLevel = NonNullable<Parameters<typeof api.configure>[0]["thinkingLevel"]>;
const DEEP_COUNTS = [1, 2, 3, 4, 5];
const models = computed(() => info.value?.models ?? []);
const model = computed(() => models.value.find((m) => m.id === agentState.value?.model));
const quickModel = computed(() =>
  models.value.find((m) => m.id === agentState.value?.quick?.model),
);
const deepModel = computed(() =>
  models.value.find((m) => m.id === agentState.value?.deepResearch?.model),
);
async function configure(body: Parameters<typeof api.configure>[0]) {
  const state = await attempt(() => api.configure(body));
  if (state) feed.apply({ type: "agent.state", state });
}
</script>

<template>
  <p v-if="info?.modelCatalog?.source === 'codex'" class="subscription-note">
    Codex subscription quota applies; USD totals do not measure subscription usage. Research
    selection also applies to news-sweep researchers.
  </p>
  <div class="model-row" aria-label="Model and thinking">
    <button
      type="button"
      class="model-button"
      data-cap="agent.model"
      aria-label="Choose a model"
      @click="ui.models = true"
    >
      <img v-if="model" :src="`/icons/${model.icon}`" alt="" />
      <span>{{ model?.name ?? agentState?.model ?? "Model" }}</span>
      <ChevronDown :size="14" />
    </button>
    <ThinkingSelect
      data-cap="agent.thinking"
      :model="model"
      :level="agentState?.thinkingLevel"
      label="Thinking level"
      @change="configure({ thinkingLevel: $event as ThinkingLevel })"
    />
  </div>
  <div
    class="model-row quick"
    role="group"
    aria-label="Quick tasks"
    title="A small model for one-shot jobs, such as reading a publish date off a page"
  >
    <span class="control-label">Quick tasks</span>
    <select
      :value="quickModel?.id ?? ''"
      :disabled="!models.length"
      aria-label="Quick tasks model"
      @change="configure({ quickModel: ($event.target as HTMLSelectElement).value })"
    >
      <option v-if="!quickModel" value="" disabled>
        {{ agentState?.quick?.model ? `${agentState.quick.model} (unavailable)` : "Choose model" }}
      </option>
      <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
    </select>
    <ThinkingSelect
      :model="quickModel"
      :level="agentState?.quick?.thinkingLevel"
      label="Quick tasks thinking level"
      @change="configure({ quickThinking: $event as ThinkingLevel })"
    />
  </div>
  <div
    class="model-row quick deep"
    role="group"
    aria-label="Deep research"
    title="The subagents that dig into a question when you ask the agent to deep dive, and how many run at once"
  >
    <span class="control-label">Deep research</span>
    <select
      :value="deepModel?.id ?? ''"
      :disabled="!models.length"
      aria-label="Deep research model"
      @change="configure({ deepResearchModel: ($event.target as HTMLSelectElement).value })"
    >
      <option v-if="!deepModel" value="" disabled>
        {{
          agentState?.deepResearch?.model
            ? `${agentState.deepResearch.model} (unavailable)`
            : "Choose model"
        }}
      </option>
      <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
    </select>
    <ThinkingSelect
      :model="deepModel"
      :level="agentState?.deepResearch?.thinkingLevel"
      label="Deep research thinking level"
      @change="configure({ deepResearchThinking: $event as ThinkingLevel })"
    />
    <label class="thinking-select"
      ><span class="control-label">Count</span>
      <select
        :value="agentState?.deepResearch?.count ?? 1"
        aria-label="Deep research count"
        @change="
          configure({ deepResearchCount: Number(($event.target as HTMLSelectElement).value) })
        "
      >
        <option v-for="c in DEEP_COUNTS" :key="c" :value="c">{{ c }}</option>
      </select>
    </label>
  </div>
</template>
