<script setup lang="ts">
// Executions: one list on the left, newest first. A sweep and the agent run it started are one execution; a chat is
// one too. Each opens into its tool calls and subagent runs. The right side shows the sweep (phases, audit, cost) and
// its run together, usage per day, and the logs.
import { computed, onMounted, ref, watch } from "vue";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  ListTree,
  MessageSquare,
  ScrollText,
  X,
} from "@lucide/vue";
import {
  ago,
  k,
  ms,
  usd,
  type RunSummary,
  type Sweep,
  type ToolCallDetail,
  type UsageDay,
} from "@dna/sdk";
import { go, route } from "../client/route";
import { api, attempt, now } from "../client/store";
import { clean } from "../client/text";
import ExecChildren from "./ExecChildren.vue";
import LogsPanel from "./LogsPanel.vue";
import RunTree from "./RunTree.vue";
import SweepDetail from "./SweepDetail.vue";
import ToolDetail from "./ToolDetail.vue";

const runs = ref<RunSummary[]>([]);
const sweeps = ref<Sweep[]>([]);
const usage = ref<UsageDay[]>([]);
/** One execution: a sweep with the run it started, a chat run, or a sweep that never ran (skipped). */
interface Exec {
  key: string;
  at: number;
  run?: RunSummary;
  sweep?: Sweep;
}
const execs = computed<Exec[]>(() => {
  const bySweep = new Map(sweeps.value.map((s) => [s.id, s]));
  const ran = new Set(runs.value.flatMap((r) => (r.sweepId ? [r.sweepId] : [])));
  return [
    ...runs.value.map((r) => ({
      key: `run-${r.runEntryId}`,
      at: r.startedAt,
      run: r,
      sweep: r.sweepId ? bySweep.get(r.sweepId) : undefined,
    })),
    ...sweeps.value
      .filter((s) => !ran.has(s.id) && !s.runEntryId)
      .map((s) => ({ key: `sweep-${s.id}`, at: Date.parse(s.createdAt), sweep: s })),
  ].sort((a, b) => b.at - a.at);
});
/** A taste answer reaches the agent as a prompt; everything else in the main chat is the reader's message. */
const answered = (r: RunSummary) => /reader answered your taste question/i.test(r.text ?? "");
const chatKind = (r: RunSummary) => (answered(r) ? "Taste answer" : "Chat");
const chatText = (r: RunSummary) => (answered(r) ? "" : clean(r.text ?? r.agent).slice(0, 60));
const open = ref(new Set<string>());
const toggle = (key: string) => {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
};
const select = (e: Exec) =>
  go(e.run ? `/executions/run/${e.run.runEntryId}` : `/executions/sweep/${e.sweep!.id}`);
const selected = (e: Exec) =>
  (sel.value.kind === "run" && sel.value.id === e.run?.runEntryId) ||
  (sel.value.kind === "sweep" && sel.value.id === e.sweep?.id);
/** The run and sweep the right side shows for a selected run or sweep. */
const shown = computed(() => {
  if (sel.value.kind === "run" && sel.value.id) {
    const run = runs.value.find((r) => r.runEntryId === sel.value.id);
    return { runId: sel.value.id, sweepId: run?.sweepId, conversationId: run?.conversationId };
  }
  if (sel.value.kind === "sweep" && sel.value.id) {
    const sweep = sweeps.value.find((s) => s.id === sel.value.id);
    const run = runs.value.find((r) => r.sweepId === sel.value.id);
    return { runId: run?.runEntryId ?? sweep?.runEntryId, sweepId: sel.value.id };
  }
  return undefined;
});
const sel = computed(() =>
  route.value.view === "executions" ? route.value : { view: "executions" as const },
);
const tool = ref<ToolCallDetail>();

async function load() {
  const [r, s, u] = await Promise.all([
    attempt(() => api.runs({ limit: 100 })),
    attempt(() => api.sweeps({ limit: 50 })),
    attempt(() => api.usage(14)),
  ]);
  runs.value = r ?? [];
  sweeps.value = s ?? [];
  usage.value = u ?? [];
}
onMounted(load);
watch(
  () => [sel.value.kind, sel.value.id],
  async () => {
    tool.value =
      sel.value.kind === "tool" && sel.value.id
        ? await attempt(() => api.toolCall(sel.value.id!))
        : undefined;
  },
  { immediate: true },
);
const close = () => go("/");
</script>

<template>
  <div class="executions" role="dialog" aria-label="Executions" @keydown.esc="close">
    <header class="exec-head">
      <ListTree :size="18" />
      <h2>Executions</h2>
      <span class="grow" />
      <button
        class="tab"
        :class="{ on: sel.kind === 'usage' }"
        data-cap="usage"
        @click="go('/executions/usage')"
      >
        <Coins :size="15" />Usage
      </button>
      <button class="tab" :class="{ on: sel.kind === 'logs' }" @click="go('/executions/logs')">
        <ScrollText :size="15" />Logs
      </button>
      <button class="icon-button" aria-label="Close executions" @click="close">
        <X :size="18" />
      </button>
    </header>
    <!-- On a narrow screen, picked shows the detail alone; Back returns to the list. -->
    <div class="exec-body" :class="{ picked: !!sel.kind }">
      <aside class="exec-list" data-cap="runs.read" aria-label="Executions, newest first">
        <ul class="exec-tree">
          <li v-for="e in execs" :key="e.key" :data-exec="e.key">
            <div class="list-row" :class="{ on: selected(e) }">
              <button
                v-if="e.run"
                class="twisty"
                :aria-label="`${open.has(e.key) ? 'Close' : 'Open'} ${e.sweep ? `sweep ${e.sweep.id}` : 'the chat'}`"
                @click="toggle(e.key)"
              >
                <component :is="open.has(e.key) ? ChevronDown : ChevronRight" :size="14" />
              </button>
              <span v-else class="twisty" />
              <button class="row-main" @click="select(e)">
                <template v-if="e.sweep">
                  <Clock :size="13" /><strong>Sweep {{ e.sweep.id }}</strong
                  ><span class="status" :class="e.sweep.status">{{ e.sweep.status }}</span
                  ><span class="muted">{{ e.sweep.presented }} cards</span>
                </template>
                <template v-else-if="e.run">
                  <MessageSquare :size="13" /><strong>{{ chatKind(e.run) }}</strong
                  ><span class="muted clip">{{ chatText(e.run) }}</span>
                </template>
                <span class="muted right"
                  >{{ e.run ? `${usd(e.run.costUsd)}, ` : "" }}{{ (now, ago(e.at)) }}</span
                >
              </button>
            </div>
            <ExecChildren v-if="e.run && open.has(e.key)" :run-id="e.run.runEntryId" />
          </li>
        </ul>
      </aside>
      <section class="exec-detail">
        <button class="exec-back bar-button" @click="go('/executions')">
          <ArrowLeft :size="15" /><span>All executions</span>
        </button>
        <template v-if="shown">
          <SweepDetail v-if="shown.sweepId" :id="shown.sweepId" />
          <RunTree v-if="shown.runId" :id="shown.runId" />
          <LogsPanel v-if="shown.sweepId" :sweep-id="shown.sweepId" />
          <LogsPanel v-else :conversation-id="shown.conversationId" />
        </template>
        <template v-else-if="sel.kind === 'tool' && sel.id">
          <button
            v-if="tool?.runEntryId"
            class="button secondary small"
            @click="go(`/executions/run/${tool.runEntryId}`)"
          >
            Open the run
          </button>
          <ToolDetail :id="sel.id" />
        </template>
        <template v-else-if="sel.kind === 'logs'"><LogsPanel /></template>
        <template v-else>
          <h3>Usage per day</h3>
          <table class="usage">
            <thead>
              <tr>
                <th>Day</th>
                <th>Model</th>
                <th>jev</th>
                <th>Images</th>
                <th>Tokens in</th>
                <th>Tokens out</th>
                <th>Firecrawl</th>
                <th>Sweeps</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in usage" :key="u.day">
                <td>{{ u.day }}</td>
                <td>{{ usd(u.modelUsd) }}</td>
                <td>{{ usd(u.jevUsd) }} ({{ u.jevCalls }})</td>
                <td>{{ usd(u.imageUsd) }}</td>
                <td>{{ k(u.tokensIn) }}</td>
                <td>{{ k(u.tokensOut) }}</td>
                <td>{{ u.firecrawlCredits }}</td>
                <td>{{ u.sweeps }}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted">
            Pick an execution on the left, a sweep or a chat, to see its phases, every generation,
            tool call and subagent run, and its jev calls.
          </p>
        </template>
      </section>
    </div>
  </div>
</template>
