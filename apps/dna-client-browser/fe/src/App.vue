<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import AgentColumn from "./components/AgentColumn.vue";
import CardDetailDialog from "./components/CardDetailDialog.vue";
import ExecutionsView from "./components/ExecutionsView.vue";
import FeedColumn from "./components/FeedColumn.vue";
import MobileNav from "./components/MobileNav.vue";
import SettingsModal from "./components/SettingsModal.vue";
import TopBar from "./components/TopBar.vue";
import { layout, narrow, pane } from "./client/layout";
import { route } from "./client/route";
import { start, toast, ui } from "./client/store";

let stop: (() => void) | undefined;
onMounted(() => (stop = start()));
onBeforeUnmount(() => stop?.());

// The agent column gives way before the news column does, so a saved width never pushes the page sideways.
const grid = computed(() => {
  if (narrow.value) return undefined;
  if (layout.feed && layout.agent)
    return { gridTemplateColumns: `minmax(400px, 1fr) 6px minmax(0, ${layout.agentWidth}px)` };
  return { gridTemplateColumns: "minmax(0, 1fr)" };
});
/** Narrow screens keep both panes mounted (scroll and drafts survive a switch) and hide the other one. */
const showFeed = computed(() => (narrow.value ? true : layout.feed));
const showAgent = computed(() => (narrow.value ? true : layout.agent));
const hidden = (which: "feed" | "agent") => narrow.value && pane.value !== which;

let startX = 0;
let startWidth = 0;
function resizeStart(e: PointerEvent) {
  startX = e.clientX;
  startWidth = layout.agentWidth;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function resizeMove(e: PointerEvent) {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
  const max = Math.round(window.innerWidth * 0.7);
  layout.agentWidth = Math.min(max, Math.max(380, startWidth - (e.clientX - startX)));
}
</script>

<template>
  <div class="app">
    <TopBar />
    <main class="columns" :class="{ narrow }" :style="grid">
      <FeedColumn
        v-if="showFeed"
        :class="{ 'pane-hidden': hidden('feed') }"
        :inert="hidden('feed')"
      />
      <div
        v-if="!narrow && layout.feed && layout.agent"
        class="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the agent column"
        @pointerdown="resizeStart"
        @pointermove="resizeMove"
      />
      <AgentColumn
        v-if="showAgent"
        :class="{ 'pane-hidden': hidden('agent') }"
        :inert="hidden('agent')"
      />
    </main>
    <MobileNav v-if="narrow" />
    <ExecutionsView v-if="route.view === 'executions'" />
    <SettingsModal v-if="ui.settings" />
    <CardDetailDialog v-if="ui.card !== undefined" :id="ui.card" />
    <div v-if="toast" class="toast" :class="toast.kind" role="status">{{ toast.text }}</div>
  </div>
</template>
