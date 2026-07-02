// Per-tweet dwell state machine.
// Accumulates focused+visible time keyed by tweet_id, NOT by DOM node.

import type { ImpressionEvent, TweetRecord } from "../types";

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
  reported: boolean;
  negativeFeedback: boolean;
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

// DOM-scrape a tweet's content from its rendered article — the safety net for tweets X served
// from its own client cache or fetched before our network hook installed, so no GraphQL response
// ever crossed the wire to parse (the residual "unknown / no content" rows). Lower fidelity than a
// net record (no metrics, no author_id), so it's tagged source:"dom" and ingest lets a net record
// win. Returns null only if the article has no readable text/handle (nothing worth storing).
// ponytail: metrics default 0 — the DOM counts are i18n'd aria-labels; not worth parsing for the
//           tail of tweets the network never sees. Scrape them if a net upgrade path is ever added.
export function scrapeContent(el: HTMLElement, tweetId: string): TweetRecord | null {
  const statusLink = el.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const handleMatch = statusLink?.getAttribute("href")?.match(/^\/([^/]+)\/status\/\d+/);
  const author_handle = handleMatch?.[1] ?? "";

  const text = (el.querySelector('[data-testid="tweetText"]')?.textContent ?? "").trim();
  // Nothing readable on the node (e.g. a media-only quote shell) — don't store an empty husk.
  if (!text && !author_handle) return null;

  // User-Name testid concatenates "DisplayName@handle·time"; the display name is the first link's text.
  const author_name = (el.querySelector('[data-testid="User-Name"] a')?.textContent ?? "").trim();
  const created_at = el.querySelector<HTMLTimeElement>("time")?.getAttribute("datetime") ?? "";

  const media = [...el.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img')]
    .map(img => ({ type: "photo" as const, url: img.src }))
    .filter(m => m.url);

  return {
    tweet_id: tweetId,
    author_handle,
    author_name,
    author_id: "",
    text,
    media,
    is_thread: el.querySelector('[data-testid="tweet-text-show-more-link"]') !== null,
    created_at,
    metrics: { likes: 0, rts: 0, replies: 0 },
    captured_at: new Date().toISOString(),
    source: "dom",
  };
}

type OnImpression = (ev: Omit<ImpressionEvent, "session_id">) => void;
type OnContent = (tweet: TweetRecord) => void;

export class DwellTracker {
  private states = new Map<string, TweetState>();
  // tweet_id whose caret (overflow) menu was last opened — the negative-feedback menu items
  // live in a detached Dropdown popup with no article ancestor, so attribution rides this pointer.
  private lastCaretTweetId: string | null = null;
  private paused = false;
  private feedPosition = 0;
  private prevScrollY = window.scrollY;
  private prevScrollTs = Date.now();
  private scrollVelocity = 0;
  private io!: IntersectionObserver;
  private onImpression: OnImpression;
  private onContent?: OnContent;
  // tweet_ids we've already DOM-scraped this content-script lifetime — scrape once per id, the
  // server dedups the rest (net wins). Keeps the durable queue from bloating on scroll-back.
  private contentScraped = new Set<string>();

  constructor({ onImpression, onContent }: { onImpression: OnImpression; onContent?: OnContent }) {
    this.onImpression = onImpression;
    this.onContent = onContent;
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

    // No hovercard observer: it blanket-attributed "hovercard" to every in-flight tweet (useless
    // data) at the cost of a second document-wide MutationObserver, and nothing downstream ever
    // consumed it. profile_expanded still carries the strong signal, clickthrough (SPA nav).
  }

  private observeTimeline() {
    document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach(el => {
      if (el.dataset.afyObserved) return;
      el.dataset.afyObserved = "1";
      if (isAd(el)) return;
      const tweetId = this.extractTweetId(el);
      if (!tweetId) return;

      // Gap-fill content from the DOM (once per id) — covers tweets the network hook never saw.
      this.scrapeContentOnce(tweetId, el);

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

  private scrapeContentOnce(tweetId: string, el: HTMLElement) {
    if (!this.onContent || this.contentScraped.has(tweetId)) return;
    const tweet = scrapeContent(el, tweetId);
    if (!tweet) return; // husk node with no text/handle yet — try again on a later observe
    this.contentScraped.add(tweetId);
    this.onContent(tweet);
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
      reported: false,
      negativeFeedback: false,
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
        this.scrapeContentOnce(tweetId, el);
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
      reported: state.reported,
      negative_feedback: state.negativeFeedback,
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

    // Negative feedback is reached via the caret (overflow) menu. Opening it from a tracked
    // tweet pins lastCaretTweetId; the chosen menu item (a detached Dropdown popup) is then
    // attributed back to that tweet. A caret click is the only entry point, so the pointer is
    // always fresh when a menu item is clicked.
    if (article && target.closest('[data-testid="caret"]')) {
      this.lastCaretTweetId = this.extractTweetId(article);
    }
    this.handleNegativeMenuClick(target);

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

  // Attribute a caret-menu choice to the tweet whose menu is open. Mirrors X's negative heads:
  // report isolated (their largest-magnitude weight), the soft three (not-interested/"show fewer",
  // mute, block) bundled as one negative_feedback signal.
  // ponytail: menu items carry no stable per-item testid, so match visible text (English only).
  //           Captures intent on menu-click (a started-then-cancelled block still logs aversion) —
  //           we're recall-starved on negatives. Localize / track-to-confirm if false positives bite.
  private handleNegativeMenuClick(target: HTMLElement) {
    if (!target.closest('[data-testid="Dropdown"]')) return;
    if (this.lastCaretTweetId === null) return;
    const state = this.states.get(this.lastCaretTweetId);
    if (!state) return;
    const item = target.closest('[role="menuitem"]') ?? target;
    const text = (item.textContent ?? "").toLowerCase();
    if (text.includes("report")) state.reported = true;
    else if (text.includes("not interested") || text.includes("mute @") || text.includes("block @")) {
      state.negativeFeedback = true;
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
