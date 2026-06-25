// M1: dwell state machine tests — tab-blur, fast-scroll/flick, node-recycling.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DwellTracker, scrapeContent } from "./dwell-tracker";
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

  // Open the caret overflow menu on a tweet, then click a menu item by its visible text.
  // X renders the menu in a detached Dropdown popup with no article ancestor.
  function pickCaretMenuItem(el: HTMLElement, itemText: string) {
    const caret = document.createElement("button");
    caret.dataset.testid = "caret";
    el.appendChild(caret);
    caret.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const menu = document.createElement("div");
    menu.dataset.testid = "Dropdown";
    const item = document.createElement("div");
    item.setAttribute("role", "menuitem");
    item.textContent = itemText;
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it("negative: 'Not interested' via the caret menu sets negative_feedback (soft negative)", () => {
    const el = makeTweetEl("2020");
    (tracker as any).observeTimeline();
    intersect(tracker, el, 1.0);

    pickCaretMenuItem(el, "Not interested in this post");
    intersect(tracker, el, 0); // finalize

    expect(events).toHaveLength(1);
    expect(events[0].negative_feedback).toBe(true);
    expect(events[0].reported).toBe(false);
  });

  it("negative: 'Report post' sets reported, isolated from the soft-negative bundle", () => {
    const el = makeTweetEl("2121");
    (tracker as any).observeTimeline();
    intersect(tracker, el, 1.0);

    pickCaretMenuItem(el, "Report post");
    intersect(tracker, el, 0);

    expect(events[0].reported).toBe(true);
    expect(events[0].negative_feedback).toBe(false);
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

describe("scrapeContent (DOM gap-filler for tweets the network hook never saw)", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  // A realistic article: handle lives in the /handle/status/id link, text in tweetText,
  // display name in User-Name, timestamp in <time datetime>, a photo in tweetPhoto.
  function richArticle(): HTMLElement {
    const article = document.createElement("article");
    article.dataset.testid = "tweet";
    article.innerHTML = `
      <div data-testid="User-Name"><a href="/michelle_a_tran"><span>Michelle</span></a></div>
      <a href="/michelle_a_tran/status/2035434907351011489"><time datetime="2026-06-20T10:00:00.000Z"></time></a>
      <div data-testid="tweetText">weird little post</div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/abc.jpg"></div>`;
    document.body.appendChild(article);
    return article;
  }

  it("extracts handle, text, name, created_at, media and tags source=dom", () => {
    const t = scrapeContent(richArticle(), "2035434907351011489")!;
    expect(t.author_handle).toBe("michelle_a_tran");
    expect(t.text).toBe("weird little post");
    expect(t.author_name).toBe("Michelle");
    expect(t.created_at).toBe("2026-06-20T10:00:00.000Z");
    expect(t.media).toEqual([{ type: "photo", url: "https://pbs.twimg.com/media/abc.jpg" }]);
    expect(t.source).toBe("dom");
    expect(t.metrics).toEqual({ likes: 0, rts: 0, replies: 0 });
  });

  it("returns null for a husk node with no text or handle", () => {
    const empty = document.createElement("article");
    empty.dataset.testid = "tweet";
    document.body.appendChild(empty);
    expect(scrapeContent(empty, "999")).toBeNull();
  });

  it("DwellTracker emits content once per id via onContent", () => {
    const got: string[] = [];
    const tracker = new DwellTracker({ onImpression: () => {}, onContent: t => got.push(t.tweet_id) });
    const el = richArticle();
    (tracker as any).scrapeContentOnce("2035434907351011489", el);
    (tracker as any).scrapeContentOnce("2035434907351011489", el); // second call must be a no-op
    expect(got).toEqual(["2035434907351011489"]);
  });
});
