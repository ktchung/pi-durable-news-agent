<script setup lang="ts">
// The bottom bar on a narrow screen: News or Agent fills the screen, one at a time. The Agent tab spins while the
// agent works and marks a reply that finished while you were reading the news; Executions and Settings stay in the
// top bar.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { LoaderCircle, MessagesSquare, Newspaper } from "@lucide/vue";
import { pane } from "../client/layout";
import { agentState, feedState, onFrame } from "../client/store";

const busy = computed(() => agentState.value?.busy ?? false);
const news = computed(
  () => feedState.value.news.filter((c) => c.feedback?.signal !== "less").length,
);
const unseen = ref(false);
const stop = onFrame((frame) => {
  if (
    pane.value === "feed" &&
    frame.type === "agent.batch" &&
    frame.events.some((e) => e.type === "message_end")
  )
    unseen.value = true;
});
onBeforeUnmount(stop);
watch(pane, (p) => p === "agent" && (unseen.value = false));
</script>

<template>
  <nav class="mobile-nav" aria-label="Switch between News and Agent">
    <button
      class="mobile-tab"
      data-pane="feed"
      :aria-pressed="pane === 'feed'"
      @click="pane = 'feed'"
    >
      <Newspaper :size="18" /><span>News</span><small>{{ news }}</small>
    </button>
    <button
      class="mobile-tab"
      data-pane="agent"
      :aria-pressed="pane === 'agent'"
      :aria-label="unseen ? 'Agent, new messages' : 'Agent'"
      @click="pane = 'agent'"
    >
      <LoaderCircle v-if="busy" :size="18" class="spin" /><MessagesSquare v-else :size="18" /><span
        >Agent</span
      ><i v-if="unseen" class="mobile-unseen" aria-hidden="true" />
    </button>
  </nav>
</template>
