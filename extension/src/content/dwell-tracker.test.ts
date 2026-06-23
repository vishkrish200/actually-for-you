// M1: dwell state machine tests — tab-blur, fast-scroll/flick, node-recycling.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DwellTracker } from "./dwell-tracker";
import type { ImpressionEvent } from "../types";

// Build a minimal tweet article DOM node
function makeTweetEl(tweetId: string): HTMLElement {
  const article = document.createElement("article");
  article.dataset.testid = "tweet";
  const a = document.createElement("a");
  a.href = `https://x.com/user/status/${tweetId}`;
  article.appendChild(a);
  document.body.appendChild(article);
  return article;
}

// Flip the like button to its "liked" state (data-testid swaps like → unlike).
function setLiked(el: HTMLElement) {
  const btn = document.createElement("button");
  btn.dataset.testid = "unlike";
  el.appendChild(btn);
}

// Trigger the IntersectionObserver callback directly
function intersect(tracker: DwellTracker, el: HTMLElement, ratio: number) {
  const entry = { target: el, intersectionRatio: ratio } as unknown as IntersectionObserverEntry;
  (tracker as any).handleIntersection([entry]);
}

describe("DwellTracker state machine", () => {
  let events: Omit<ImpressionEvent, "session_id">[];
  let tracker: DwellTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    tracker = new DwellTracker({ onImpression: ev => events.push(ev) });
    // stub IntersectionObserver/MutationObserver so start() doesn't throw
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
    (globalThis as any).MutationObserver = class {
      observe() {}
      disconnect() {}
    };
    tracker.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("golden: records dwell_ms for a visible-then-scrolled-away tweet", () => {
    const el = makeTweetEl("111");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);          // enters viewport fully
    vi.advanceTimersByTime(2000);
    intersect(tracker, el, 0);            // leaves → finalize

    expect(events).toHaveLength(1);
    expect(events[0].tweet_id).toBe("111");
    expect(events[0].dwell_ms).toBeGreaterThanOrEqual(2000);
    expect(events[0].opened_detail).toBe(false);
    expect(events[0].flicked).toBe(false);
  });

  it("tab-blur: pauseAll finalizes tweets with accumulated dwell; blurred time not counted", () => {
    const el = makeTweetEl("222");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(1000);
    tracker.pauseAll();             // should finalize with ~1000ms dwell

    expect(events).toHaveLength(1);
    expect(events[0].tweet_id).toBe("222");
    expect(events[0].dwell_ms).toBeGreaterThanOrEqual(1000);
    expect(events[0].dwell_ms).toBeLessThan(2000);   // blurred time not counted
  });

  it("flick: short dwell + high scroll velocity → flicked=true", () => {
    (tracker as any).scrollVelocity = 10; // must be set before observeTimeline captures scrollVelocityAtEntry
    const el = makeTweetEl("333");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(100);    // < FLICK_DWELL_MS=300
    intersect(tracker, el, 0);

    expect(events[0].flicked).toBe(true);
    expect(events[0].dwell_ms).toBeLessThan(300);
  });

  it("fast-scroll: normal dwell even at high velocity if dwell >= 300ms → flicked=false", () => {
    (tracker as any).scrollVelocity = 10;
    const el = makeTweetEl("444");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(400);    // >= FLICK_DWELL_MS
    intersect(tracker, el, 0);

    expect(events[0].flicked).toBe(false);
  });

  it("node recycling: finalize old tweet when element reused for different tweet_id", () => {
    const el = makeTweetEl("555");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(1000);

    // Simulate X recycling the DOM node: change the link to a new tweet
    const a = el.querySelector("a")!;
    a.href = "https://x.com/user/status/666";

    // The MutationObserver callback in observeTimeline detects id change and finalizes
    const newId = (tracker as any).extractTweetId(el);
    expect(newId).toBe("666");

    // Manually trigger what the MutationObserver would call
    (tracker as any).finalize("555");

    expect(events).toHaveLength(1);
    expect(events[0].tweet_id).toBe("555");
    expect(events[0].dwell_ms).toBeGreaterThanOrEqual(1000);
  });

  it("leaked timer: visible with no exit event for 60s → dwell capped, not minutes of phantom", () => {
    const el = makeTweetEl("1212");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);          // becomes visible, timer starts
    vi.advanceTimersByTime(60000);        // 60s pass with NO ratio<0.5 exit event (the leak)
    tracker.pauseAll();                   // tab blur drains the still-running timer

    expect(events).toHaveLength(1);
    expect(events[0].dwell_ms).toBeLessThanOrEqual(30000); // clamped, not 60000
  });

  it("engagement: DOM like-flip during the impression is captured (catches keyboard, not just clicks)", () => {
    const el = makeTweetEl("888");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);          // enters; entryLiked baseline = false
    vi.advanceTimersByTime(500);
    setLiked(el);                         // user likes via keyboard 'L' → testid flips to unlike
    intersect(tracker, el, 1.0);          // a later tick re-reads engagement
    intersect(tracker, el, 0);            // scroll away → finalize

    expect(events).toHaveLength(1);
    expect(events[0].liked).toBe(true);
  });

  it("re-impression: same node scrolled back into view emits a second impression", () => {
    const el = makeTweetEl("999");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(800);
    intersect(tracker, el, 0);            // full exit → finalize #1 (state deleted)

    intersect(tracker, el, 1.0);          // scrolled back into the same un-recycled node
    vi.advanceTimersByTime(400);
    intersect(tracker, el, 0);            // exit again → finalize #2

    expect(events).toHaveLength(2);
    expect(events.every(e => e.tweet_id === "999")).toBe(true);
    expect(events[0].impression_id).not.toBe(events[1].impression_id); // distinct impressions
  });

  it("engagement: a pre-existing like (present on entry) is NOT logged as this impression's like", () => {
    const el = makeTweetEl("1010");
    setLiked(el);                         // already liked before it enters view
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(500);
    intersect(tracker, el, 0);

    expect(events).toHaveLength(1);
    expect(events[0].liked).toBe(false);  // baseline, not a fresh engagement
  });

  it("ads: a promoted tweet (placementTracking wrapper) is never observed → no impression", () => {
    const el = makeTweetEl("1313");
    const wrapper = document.createElement("div");
    wrapper.dataset.testid = "placementTracking";
    el.parentNode!.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(2000);
    intersect(tracker, el, 0);

    expect(events).toHaveLength(0);
  });

  it("show-more: clicking expand on truncated text sets opened_detail (high signal)", () => {
    const el = makeTweetEl("1414");
    const link = document.createElement("button");
    link.dataset.testid = "tweet-text-show-more-link";
    el.appendChild(link);
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    intersect(tracker, el, 0);

    expect(events).toHaveLength(1);
    expect(events[0].opened_detail).toBe(true);
  });

  it("does not double-count: finalize on already-removed state is a no-op", () => {
    const el = makeTweetEl("777");
    (tracker as any).observeTimeline();

    intersect(tracker, el, 1.0);
    vi.advanceTimersByTime(500);
    intersect(tracker, el, 0);     // finalize #1
    (tracker as any).finalize("777"); // finalize #2 — should be no-op

    expect(events).toHaveLength(1); // only one emission
  });
});
