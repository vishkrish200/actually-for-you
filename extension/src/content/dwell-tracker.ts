// Per-tweet dwell state machine.
// Accumulates focused+visible time keyed by tweet_id, NOT by DOM node.

import type { ImpressionEvent } from "../types";

const VISIBILITY_THRESHOLD = 0.5;
// ponytail: flick = dwell < 300ms AND high scroll velocity; tune in M12
const FLICK_DWELL_MS = 300;
const FLICK_VELOCITY = 5; // px/ms
// Max dwell credited for ONE continuous visible interval. IntersectionObserver exit events
// are unreliable under fast scroll + X's node virtualization, so a timer can leak (keep
// running while the tweet is off-screen) until pauseAll()/finalize drains it — which produced
// real impressions of 179s–855s on tweets that were only glanced at, and identical leaked
// values shared across several tweets drained at the same tab-blur. No genuine glance at a
// single tweet exceeds this without an intervening IO event, so clamp the interval.
// ponytail: hard cap; a geometry watchdog could credit exact visible time if precision matters.
const MAX_INTERVAL_MS = 30_000;

interface TweetState {
  impressionId: string;
  tweetId: string;
  el: HTMLElement;             // node showing this tweet; re-read for engagement confirmation
  entryTs: number;
  dwellMs: number;
  timerStart: number | null; // non-null when actively timing
  positionInFeed: number;
  scrollVelocityAtEntry: number;
  maxVisiblePct: number;
  openedDetail: boolean;
  profileExpanded: "none" | "hovercard" | "clickthrough";
  liked: boolean;
  rt: boolean;
  bookmarked: boolean;
  replied: boolean;
  // engagement state present on the node when this impression began — a flip vs. this
  // baseline is a fresh, DOM-confirmed engagement (catches keyboard 'L'/'T'/'B', not just clicks).
  entryLiked: boolean;
  entryRt: boolean;
  entryBookmarked: boolean;
  mediaPresent: boolean;
  isThread: boolean;
  charLen: number;
}

// DOM-confirmed engagement state (PRD §5.6: confirm the state flip, don't trust the click).
// X swaps the action button's data-testid when toggled: like→unlike, retweet→unretweet,
// bookmark→removeBookmark. Input-agnostic, so it captures keyboard shortcuts too.
// Promoted tweets give corrupt signal (placement isn't a choice the user made), so they're
// dropped entirely — no impression. X wraps promoted cells in data-testid="placementTracking".
// ponytail: anchored on testid per §5; the "Ad" label text is i18n'd and unreliable.
function isAd(el: HTMLElement): boolean {
  return el.closest('[data-testid="placementTracking"]') !== null;
}

function readEngagement(el: HTMLElement) {
  return {
    liked: el.querySelector('[data-testid="unlike"]') !== null,
    rt: el.querySelector('[data-testid="unretweet"]') !== null,
    bookmarked: el.querySelector('[data-testid="removeBookmark"]') !== null,
  };
}

type OnImpression = (ev: Omit<ImpressionEvent, "session_id">) => void;

export class DwellTracker {
  private states = new Map<string, TweetState>();
  private paused = false;
  private feedPosition = 0;
  private prevScrollY = window.scrollY;
  private prevScrollTs = Date.now();
  private scrollVelocity = 0;
  private io!: IntersectionObserver;
  private onImpression: OnImpression;

  constructor({ onImpression }: { onImpression: OnImpression }) {
    this.onImpression = onImpression;
  }

  start() {
    this.io = new IntersectionObserver(this.handleIntersection.bind(this), {
      threshold: [0, VISIBILITY_THRESHOLD, 1],
    });

    // Observe existing + new tweet articles
    this.observeTimeline();
    new MutationObserver(() => this.observeTimeline()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Scroll velocity tracking
    window.addEventListener("scroll", this.trackScroll.bind(this), { passive: true });

    // SPA navigation detection → attribute detail-open
    const origPush = history.pushState.bind(history);
    history.pushState = (...args) => {
      origPush(...args);
      this.handleNavigation(location.pathname);
    };
    window.addEventListener("popstate", () => this.handleNavigation(location.pathname));

    // Engagement clicks
    document.addEventListener("click", this.handleClick.bind(this), true);

    // Hovercard observer
    new MutationObserver(this.handleHovercard.bind(this)).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  private observeTimeline() {
    document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach(el => {
      if (el.dataset.afyObserved) return;
      el.dataset.afyObserved = "1";
      if (isAd(el)) return;
      const tweetId = this.extractTweetId(el);
      if (!tweetId) return;

      if (!this.states.has(tweetId)) {
        this.states.set(tweetId, this.makeState(tweetId, el));
        this.feedPosition++;
      }
      this.io.observe(el);

      // Detect node recycling (virtualized scroll) — X replaces children, not attributes
      new MutationObserver(() => {
        const newId = this.extractTweetId(el);
        if (newId !== tweetId) {
          this.finalize(tweetId);
          delete el.dataset.afyObserved;
        }
      }).observe(el, { attributes: true, childList: true, subtree: true });
    });
  }

  private makeState(tweetId: string, el: HTMLElement): TweetState {
    const eng = readEngagement(el); // baseline — a pre-existing like was logged on its own impression
    return {
      impressionId: crypto.randomUUID(),
      tweetId,
      el,
      entryTs: Date.now(),
      dwellMs: 0,
      timerStart: null,
      positionInFeed: this.feedPosition,
      scrollVelocityAtEntry: this.scrollVelocity,
      maxVisiblePct: 0,
      openedDetail: false,
      profileExpanded: "none",
      liked: false,
      rt: false,
      bookmarked: false,
      replied: false,
      entryLiked: eng.liked,
      entryRt: eng.rt,
      entryBookmarked: eng.bookmarked,
      mediaPresent: el.querySelector('img, video, [data-testid="tweetPhoto"]') !== null,
      isThread: el.querySelector('[data-testid="tweet-text-show-more-link"]') !== null,
      charLen: (el.querySelector('[data-testid="tweetText"]')?.textContent ?? "").length,
    };
  }

  // Mark like/rt/bookmark true once the DOM confirms a flip vs. entry baseline.
  // ponytail: sticky-true — a like-then-undo within one impression still logs the like;
  //           acceptable, we're recall-starved on positives. Authoritative-at-finalize if that flips.
  private updateEngagement(state: TweetState) {
    const now = readEngagement(state.el);
    if (now.liked && !state.entryLiked) state.liked = true;
    if (now.rt && !state.entryRt) state.rt = true;
    if (now.bookmarked && !state.entryBookmarked) state.bookmarked = true;
  }

  private handleIntersection(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const tweetId = this.extractTweetId(el);
      if (!tweetId) continue;
      let state = this.states.get(tweetId);
      if (!state) {
        // No live state: this tweet was finalized then scrolled back into view in the
        // same (un-recycled) node. Re-entry past the visibility gate = a NEW impression
        // (PRD §5.5). Only create on actual re-entry so hidden nodes don't leak 0ms rows.
        if (entry.intersectionRatio < VISIBILITY_THRESHOLD) continue;
        if (isAd(el)) continue;
        state = this.makeState(tweetId, el);
        this.states.set(tweetId, state);
        this.feedPosition++;
      }

      state.maxVisiblePct = Math.max(state.maxVisiblePct, entry.intersectionRatio);
      this.updateEngagement(state); // confirm like/rt/bookmark before the node scrolls off

      if (entry.intersectionRatio >= VISIBILITY_THRESHOLD) {
        this.startTimer(state);
      } else {
        this.stopTimer(state);
        if (entry.intersectionRatio === 0) this.finalize(tweetId);
      }
    }
  }

  private startTimer(state: TweetState) {
    if (this.paused || state.timerStart !== null) return;
    state.timerStart = Date.now();
  }

  private stopTimer(state: TweetState) {
    if (state.timerStart === null) return;
    state.dwellMs += Math.min(Date.now() - state.timerStart, MAX_INTERVAL_MS);
    state.timerStart = null;
  }

  pauseAll() {
    this.paused = true;
    // Finalize anything with accumulated dwell — tab switch is a natural session boundary
    const ids = [...this.states.keys()];
    for (const id of ids) {
      this.stopTimer(this.states.get(id)!);
      if (this.states.get(id)!.dwellMs > 0) this.finalize(id);
    }
  }

  resumeAll() {
    this.paused = false;
    // Timers restart on next intersection event
  }

  private finalize(tweetId: string) {
    const state = this.states.get(tweetId);
    if (!state) return;
    this.stopTimer(state);
    // Last chance to catch an engagement, but only if the node still shows this tweet
    // (on recycle the node already holds a different one — reading it would be wrong).
    if (this.extractTweetId(state.el) === tweetId) this.updateEngagement(state);
    this.states.delete(tweetId);

    const flicked = state.dwellMs < FLICK_DWELL_MS && state.scrollVelocityAtEntry > FLICK_VELOCITY;

    this.onImpression({
      impression_id: state.impressionId,
      tweet_id: state.tweetId,
      ts: new Date(state.entryTs).toISOString(),
      position_in_feed: state.positionInFeed,
      dwell_ms: state.dwellMs,
      max_visible_pct: state.maxVisiblePct,
      scroll_velocity_at_entry: state.scrollVelocityAtEntry,
      flicked,
      opened_detail: state.openedDetail,
      profile_expanded: state.profileExpanded,
      liked: state.liked,
      rt: state.rt,
      bookmarked: state.bookmarked,
      replied: state.replied,
      media_present: state.mediaPresent,
      is_thread: state.isThread,
      char_len: state.charLen,
    });
  }

  private handleNavigation(path: string) {
    const match = path.match(/\/status\/(\d+)/);
    if (!match) return;
    const tweetId = match[1];
    const state = this.states.get(tweetId);
    if (state) state.openedDetail = true;
  }

  private handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const article = target.closest<HTMLElement>('article[data-testid="tweet"]');
    if (!article) return;
    const tweetId = this.extractTweetId(article);
    if (!tweetId) return;
    const state = this.states.get(tweetId);
    if (!state) return;

    // like / rt / bookmark are confirmed via DOM state-flip (readEngagement), NOT the click,
    // so a click that opens-then-cancels a menu isn't mislogged (PRD §5.6). reply has no toggle
    // state to confirm against, so the click on the reply button is the signal we have.
    const testId = (target.closest("[data-testid]") as HTMLElement | null)?.dataset.testid ?? "";
    if (testId === "reply") state.replied = true;

    // Expanding truncated text / a thread is intent equal to opening the tweet — same high signal.
    if (testId === "tweet-text-show-more-link") state.openedDetail = true;

    // Profile clickthrough
    const href = (target.closest("a") as HTMLAnchorElement | null)?.href ?? "";
    if (href && !href.includes("/status/") && href.match(/x\.com\/\w+$/)) {
      state.profileExpanded = "clickthrough";
    }
  }

  private handleHovercard(mutations: MutationRecord[]) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if ((node as HTMLElement).querySelector?.('[data-testid="HoverCard"]')) {
          // Find which tweet is in focus — nearest article ancestor if possible
          // ponytail: weak signal, best-effort attribution
          this.states.forEach(s => {
            if (s.profileExpanded === "none") s.profileExpanded = "hovercard";
          });
        }
      }
    }
  }

  private trackScroll() {
    const now = Date.now();
    const dt = now - this.prevScrollTs;
    if (dt > 0) {
      this.scrollVelocity = Math.abs(window.scrollY - this.prevScrollY) / dt;
    }
    this.prevScrollY = window.scrollY;
    this.prevScrollTs = now;
  }

  private extractTweetId(el: HTMLElement): string | null {
    const link = el.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    const match = link?.href.match(/\/status\/(\d+)/);
    return match?.[1] ?? null;
  }
}
