<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, X } from "@lucide/vue";
import type { ModelInfo } from "@dna/sdk";
import { agentState, api, attempt, feed, info, notify, ui } from "../client/store";

const refreshing = ref(false);
const catalog = computed(() => info.value?.modelCatalog);
async function refreshCatalog() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await attempt(async () => {
      info.value = await api.info(true);
    });
  } finally {
    refreshing.value = false;
  }
}
const search = ref("");
const models = computed(() => info.value?.models ?? []);
const filtered = computed(() =>
  models.value.filter((m) =>
    `${m.name} ${m.id} ${m.tier}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const current = computed(() => agentState.value?.model);
const close = () => (ui.models = false);

async function choose(m: ModelInfo) {
  const state = await attempt(() => api.configure({ model: m.id }));
  if (!state) return;
  feed.apply({ type: "agent.state", state });
  notify(`${m.name} from the next turn`);
  close();
}
</script>

<template>
  <div class="modal-backdrop" @click.self="close">
    <section class="modal model-modal" role="dialog" aria-modal="true" aria-label="Choose a model">
      <header>
        <h2>Choose a model</h2>
        <div class="catalog-actions">
          <button
            class="catalog-refresh"
            :disabled="refreshing"
            aria-label="Refresh model catalog"
            @click="refreshCatalog"
          >
            {{ refreshing ? "Refreshing" : "Refresh catalog" }}
          </button>
          <button class="icon-button" aria-label="Close the model picker" @click="close">
            <X :size="18" />
          </button>
        </div>
      </header>
      <p v-if="catalog" class="catalog-status" role="status">
        {{ catalog.source }} catalog{{ catalog.stale ? " (stale)" : "" }}
        <span v-if="catalog.refreshedAt">, updated {{ catalog.refreshedAt }}</span>
        <span v-if="catalog.error">: {{ catalog.error }}</span>
      </p>
      <input v-model="search" placeholder="Search models or tiers" aria-label="Search models" />
      <p v-if="!filtered.length" class="catalog-status" role="status">
        {{ models.length ? "No matching models" : "Model catalog unavailable. Try refreshing." }}
      </p>
      <div class="model-list">
        <button
          v-for="m in filtered"
          :key="m.id"
          class="model-row"
          :class="{ selected: m.id === current }"
          :data-model="m.id"
          @click="choose(m)"
        >
          <img :src="`/icons/${m.icon}`" alt="" />
          <div>
            <strong>{{ m.name }}</strong>
            <small
              >{{ m.tier }} tier, {{ m.provider }}, {{ Math.round(m.contextWindow / 1000) }}k
              context</small
            >
          </div>
          <span v-if="m.id === info?.defaultModel" class="badge">Default</span>
          <Check v-if="m.id === current" :size="18" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.catalog-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.catalog-refresh {
  border: 1px solid var(--line);
  padding: 4px 8px;
  font-size: 12px;
}
.catalog-status {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
