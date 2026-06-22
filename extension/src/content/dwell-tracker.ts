// Per-tweet dwell state machine.
// Accumulates focused+visible time keyed by tweet_id, NOT by DOM node.

import type { ImpressionEvent } from "../types";

const VISIBILITY_THRESHOLD = 0.5;
// ponytail: flick = dwell < 300ms AND high scroll velocity; tune in M12
const FLICK_DWELL_MS = 300;
const FLICK_VELOCITY = 5; // px/ms

interface TweetState {
  impressionId: string;
  tweetId: string;
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
  mediaPresent: boolean;
  isThread: boolean;
  charLen: number;
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
    return {
      impressionId: crypto.randomUUID(),
      tweetId,
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
      mediaPresent: el.querySelector('img, video, [data-testid="tweetPhoto"]') !== null,
      isThread: el.querySelector('[data-testid="tweet-text-show-more-link"]') !== null,
      charLen: (el.querySelector('[data-testid="tweetText"]')?.textContent ?? "").length,
    };
  }

  private handleIntersection(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const tweetId = this.extractTweetId(el);
      if (!tweetId) continue;
      const state = this.states.get(tweetId);
      if (!state) continue;

      state.maxVisiblePct = Math.max(state.maxVisiblePct, entry.intersectionRatio);

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
    state.dwellMs += Date.now() - state.timerStart;
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

    const testId = (target.closest("[data-testid]") as HTMLElement | null)?.dataset.testid ?? "";
    if (testId === "like" || testId === "unlike") state.liked = true;
    else if (testId === "retweet" || testId === "unretweet") state.rt = true;
    else if (testId === "bookmark") state.bookmarked = true;
    else if (testId === "reply") state.replied = true;

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
