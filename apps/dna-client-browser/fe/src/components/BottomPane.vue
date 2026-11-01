<script setup lang="ts">
// A pinned pane. By default it flows bottom up like a chat: newest last, pinned to the bottom. With from="top" the
// newest comes first and the pane pins to the top. Either way a jump button counts new items.
import { ref } from "vue";
import { ArrowDown, ArrowUp } from "@lucide/vue";
import { usePinned, type PinEnd } from "../client/pin";

const props = withDefaults(defineProps<{ count: number; label: string; from?: PinEnd }>(), {
  from: "bottom",
});
const scroller = ref<HTMLElement>();
const { unseen, jump } = usePinned(scroller, () => props.count, props.from);
</script>

<template>
  <div class="bottom-pane" :class="{ 'top-pane': from === 'top' }">
    <div ref="scroller" class="bottom-scroll" :aria-label="label">
      <div class="bottom-inner"><slot /></div>
    </div>
    <button
      v-if="unseen > 0"
      class="new-items"
      :aria-label="`${unseen} new, jump to the newest`"
      @click="jump"
    >
      <component :is="from === 'top' ? ArrowUp : ArrowDown" :size="15" />{{ unseen }} new
    </button>
  </div>
</template>
