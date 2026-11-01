// Pinned panes. Bottom-up (the default) flows like a chat: newest last, pinned to the bottom. Top-down puts the
// newest first, pinned to the top. Either way the pane stays pinned unless the reader scrolls more than 120 px away
// from the newest end; a button with the count of new items jumps back.
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

export type PinEnd = "bottom" | "top";

export function usePinned(el: Ref<HTMLElement | undefined>, count: () => number, end: PinEnd = "bottom") {
  const pinned = ref(true);
  const unseen = ref(0);
  const target = (e: HTMLElement) => (end === "top" ? 0 : e.scrollHeight);
  const snap = () => el.value && (el.value.scrollTop = target(el.value));
  const onScroll = () => {
    const e = el.value;
    if (!e) return;
    const away = end === "top" ? e.scrollTop : e.scrollHeight - e.scrollTop - e.clientHeight;
    pinned.value = away <= 120;
    if (pinned.value) unseen.value = 0;
  };
  let observer: ResizeObserver | undefined;
  onMounted(() => {
    el.value?.addEventListener("scroll", onScroll, { passive: true });
    observer = new ResizeObserver(() => pinned.value && snap());
    if (el.value?.firstElementChild) observer.observe(el.value.firstElementChild);
    void nextTick(snap);
  });
  onBeforeUnmount(() => {
    el.value?.removeEventListener("scroll", onScroll);
    observer?.disconnect();
  });
  watch(count, async (n, old) => {
    await nextTick();
    if (pinned.value) snap();
    else unseen.value += Math.max(0, n - (old ?? 0));
  });
  const jump = () => {
    unseen.value = 0;
    pinned.value = true;
    if (el.value) el.value.scrollTo({ top: target(el.value), behavior: "smooth" });
  };
  return { pinned, unseen, jump };
}
