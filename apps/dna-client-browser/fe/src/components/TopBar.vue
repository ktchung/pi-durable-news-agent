<script setup lang="ts">
import { computed } from "vue";
import {
  Activity,
  Coins,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Server,
  SlidersHorizontal,
  WifiOff,
  Zap,
} from "@lucide/vue";
import { usd } from "@dna/sdk";
import { layout, toggle } from "../client/layout";
import { go } from "../client/route";
import { agentState, api, attempt, connection, feed, info, ui } from "../client/store";
import ScheduleControls from "./ScheduleControls.vue";

const busy = computed(() => agentState.value?.busy ?? false);
const schedule = computed(() => agentState.value?.schedule);

const CARD_CHOICES = [3, 5, 7, 10, 15, 20, 30];
async function setCards(value: string) {
  const next = await attempt(() => api.setCardsPerSweep(Number(value)));
  if (next) feed.apply({ type: "schedule", schedule: next });
}

/** All time: what the agent's model, jev and image generation have cost on this device. */
const spend = computed(() => agentState.value?.spend);
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><Zap :size="17" /></span>
      <div>
        <strong>Durable News Agent</strong>
        <span class="tagline">News Worth Your Attention</span>
      </div>
    </div>
    <div class="agent-status" data-cap="status" :class="{ working: busy }">
      <template v-if="connection !== 'live'"
        ><WifiOff :size="16" /><span>{{
          connection === "unauthorized" ? "Token refused" : "Reconnecting"
        }}</span></template
      >
      <template v-else-if="busy"
        ><LoaderCircle :size="16" class="spin" /><span>Working</span></template
      >
      <ScheduleControls />
      <select
        v-if="schedule"
        class="schedule-select"
        aria-label="Cards per sweep"
        title="The most cards one sweep presents; jev ranks the candidates and keeps the top ones"
        :value="schedule.cardsPerSweep"
        @change="setCards(($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="n in [...new Set([...CARD_CHOICES, schedule.cardsPerSweep])].sort((a, b) => a - b)"
          :key="n"
          :value="n"
        >
          {{ n }} cards
        </option>
      </select>
    </div>
    <div class="topbar-right">
      <button
        class="stat link"
        data-cap="usage"
        :title="
          spend
            ? `Total spend: model ${usd(spend.modelUsd)}, jev ${usd(spend.jevUsd)}, images ${usd(spend.imageUsd)}`
            : 'Total spend'
        "
        @click="go('/executions/usage')"
      >
        <Coins :size="15" />{{ usd(spend?.totalUsd ?? 0) }}
      </button>
      <span class="stat device" :title="`Device ${info?.device ?? ''}`" data-testid="device"
        ><Server :size="15" />{{ info?.deviceName ?? info?.device ?? "device" }}</span
      >
      <button
        class="bar-button"
        data-cap="runs.read"
        aria-label="Executions"
        title="Executions"
        @click="go('/executions')"
      >
        <Activity :size="16" /><span>Executions</span>
      </button>
      <button class="bar-button" aria-label="Settings" title="Settings" @click="ui.settings = true">
        <SlidersHorizontal :size="16" /><span>Settings</span>
      </button>
      <button
        class="bar-button column-toggle"
        :class="{ on: layout.feed }"
        :aria-pressed="layout.feed"
        aria-label="Toggle the news column"
        title="News column"
        @click="toggle('feed')"
      >
        <PanelLeft :size="16" /><span>News</span>
      </button>
      <button
        class="bar-button column-toggle"
        :class="{ on: layout.agent }"
        :aria-pressed="layout.agent"
        aria-label="Toggle the agent column"
        title="Agent column"
        @click="toggle('agent')"
      >
        <PanelRight :size="16" /><span>Agent</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
/* Let the compact status row wrap instead of pushing controls off small screens; app.css has the narrow layout. */
.topbar {
  flex-wrap: wrap;
}
.agent-status {
  flex-wrap: wrap;
  min-width: 0;
}
</style>
