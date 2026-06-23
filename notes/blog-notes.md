# Blog notes — actually-for-you

Raw, honest notes for a future blog post. Not the post itself — mineable material.
Keep the caveats; they're what make it credible.

Cross-ref: research findings on X's own algorithm live in [`x-algo-research.md`](./x-algo-research.md).

---

## 2026-06-23 — capture working, the instrument, and the dwell-is-not-a-reward insight

### 1. The capture surface was the actually-hard part (risk-first paid off)

I built this risk-first on purpose, and the riskiest milestone wasn't the ranker — it was
*reliably sensing my own behavior on a hostile, obfuscated page*. X is not built to be read by
an outside sensor, and three things make naive capture quietly wrong:

- **Virtualized scroll.** X recycles DOM nodes as you scroll — the same `<article>` element gets
  reused for different tweets. So you can **never** accumulate dwell keyed to a DOM node. Dwell
  has to accumulate by `tweet_id`. Get this wrong and your numbers look fine but mean nothing.
- **Rotating GraphQL query IDs.** The numeric query ID on each GraphQL op rotates. Match on the
  **operation name**, never the ID, or your network hook breaks silently on their next deploy.
- **Obfuscated CSS classes.** Class names are churned/minified. Anchor selectors on
  `data-testid`, never CSS classes.

The honest part of the story: the *code structure* was right early, but the **data was wrong in
ways that looked right.** A dogfood pass surfaced a pile of silent-correctness bugs:

- **`screen_name` moved `user.legacy` → `user.core`.** Every captured handle was empty. Worse:
  the *test fixture used the old schema*, so the test passed while real data was blank. Lesson
  worth a paragraph in the post: a green test against a stale fixture is more dangerous than no
  test. Historical handles are unrecoverable (no API backfill).
- **Dwell-timer leak under fast scroll.** Dwell accrues between an IntersectionObserver enter
  (≥50% visible) and exit. Under fast scroll + node virtualization, **exit events get dropped**,
  so a timer keeps running while the tweet is off-screen and only drains at tab-blur — crediting
  *minutes* to a tweet I glanced at. Smoking gun in the data: identical large dwell values shared
  across distinct tweets (several leaked timers draining at the same instant). Fixed by capping a
  single visible interval at 30s.
- **Engagement via state-flip, not click.** Likes/RTs/bookmarks were logged on *click* only —
  which missed keyboard shortcuts (`L`/`T`/`B`) entirely and never confirmed the toggle actually
  happened. Now read from the button's `data-testid` flip (`like`→`unlike`), input-agnostic.
- **Viewed-gate.** ~half the feed was tweets never actually ≥50% on screen (pure prefetch in the
  GraphQL payload). Product decision that fell out of this: **this is a re-ranker of what I
  actually saw, not a discovery engine.** A tweet is only a candidate if some impression crossed
  50% visibility.

**Verification after the pass:** 559/559 tweets now carry a handle (was 0%), max single-impression
dwell capped at 60s (was 855s), dwell density up (~40% of impressions non-zero vs ~15%). Capture
is finally *trustworthy* — which is the precondition for everything downstream.

> Theme for the post: in behavioral instrumentation, the failure mode isn't a crash, it's
> *plausible wrong numbers*. Every bug above produced data that looked completely fine.

### 2. What I actually built is a rare instrument

Step back from the ranker. The unusual asset is the **measurement**:

- **Continuous, passive, honest** record of *one person's* attention. No survey, no self-report.
  (Self-report on media consumption is notoriously garbage — nobody accurately reports their own
  scrolling.)
- **Exposure decoupled from engagement.** I capture what I *scrolled past*, not just what I
  clicked. The gap between "shown" and "attended to" is the whole interesting surface, and
  platforms rarely expose it to the user themselves.
- **An intervention lever.** I own the re-ranker, so I can change my own feed and measure the
  effect on myself.

This is an **n-of-1 instrument** — closer to quantified-self / single-subject design than to
classic ML eval.

### 3. Discovery directions the data could support

Ranked roughly by how much the *current* columns already support them:

- **Revealed-preference gap.** Who I *dwell on* vs. who I *follow / would claim to care about*.
  The delta = stuff I consume but wouldn't endorse. Introspection can't find this; dwell can.
- **"The like is a lie."** ~1 like per ~1000 impressions, but I dwell on hundreds. Quantify how
  badly the like button under-represents real interest. Split: *consume-but-never-like* (private
  interest) vs *like-but-barely-read* (performative/social likes).
- **Doomscroll / attention-decay signature.** Dwell vs. position-in-session: does my attention
  degrade the longer I scroll (fatigue → mindless), or spike (rabbit hole)? Does late-session
  content get worse by any quality proxy?
- **"What hijacks me."** Does my dwell track *quality* or *virality*? Correlate my attention
  against crowd signals (likes/RTs/views) and content features (length, media).

**Two validity threats to state honestly in the post:**

- **n=1.** Findings are valid *for me*, good for *generating* hypotheses — not universal. Don't
  dress N=1 up as a general law.
- **Self-contamination.** The moment my re-ranker drives the feed, exposure stops being natural —
  the instrument changes the system it measures. Keep **raw-order observation** (clean behavioral
  data) separate from **intervention** (deliberately flip the ranker, measure the effect).

### 4. THE key insight — dwell is magnitude, not sign

This is the one I'd build the post around.

**Dwell tells you *how much* attention a tweet pulled, never *whether the attention was
positive*.** A long dwell collapses at least four distinct states:

| Dwell looks the same, but it's actually… | Sign |
|---|---|
| Genuine interest | + |
| Hate-reading / outrage (read every word *because* it made me mad) | − |
| Confusion / effort (just hard to parse) | ~ |
| Trapped / can't-look-away (the doomscroll itself) | − |

So if you **reward dwell, you optimize for all four equally** — which means you rebuild the exact
ragebait engine you were trying to escape. The thing I'm fighting *is* engagement-as-reward, and
naive dwell-as-reward walks straight back into it.

**The fix:** dwell only *flags a tweet as worth labeling*. The **sign comes from the terminal
action that follows** the dwell — "I read it fully, *then* I act":

- dwell **+ like / bookmark / author-open / genuine reply** → **positive**
- dwell **+ not-interested / mute / block / report** → **negative**
- dwell **+ nothing** → **weak, ambiguous prior** (never a strong positive)

**The missing primitive:** today I capture **no explicit negatives at all** — only positives and
silence. X already gives the buttons: *Not interested in this post*, *Mute*, *Block*, *Report*.
Capture them (anchor on `data-testid`, same discipline as everything else).

**Why capture negatives NOW, before the ranker can even use them:** the corpus is **append-only**.
Every day I run without negative-action capture is negative labels *permanently lost* — same
lesson as the empty-handle bug. Capture quality compounds; you can't backfill behavior.

**Caveat worth keeping in the post:** don't try to infer hate-reading from the *shape* of dwell
(re-reads, rage-quit, fast-scroll-after). It's noisy and a research rabbit hole. One explicit
"not interested" click is worth more than any amount of behavioral sentiment inference. Let the
button be the label.

> The clean one-liner: **engagement ≠ endorsement.** Attention is a magnitude; only an action
> gives it a sign. (Cross-ref `x-algo-research.md` — is this how X actually separates the two?)

---

## Open questions (carry into later sections)

- **`position_in_feed` semantics for IPW.** It's currently a monotonic counter that never resets
  (session-scroll-depth), but inverse-propensity weighting wants *rank-in-view* as the propensity
  input. Bucket it? Reset per session? Capture viewport rank instead? Undecided — blocks the M5
  label/debias design.
- **How to weight the eventual negatives.** Is one "not interested" worth N positives? Is mute >
  not-interested > a fast-scroll-away? Asymmetric? TBD once negatives accumulate.
- **Is the dwell→sign separation novel or am I reinventing X's known machinery?** (Answered in
  `x-algo-research.md`.)
- **Detecting self-contamination.** Once the re-ranker is live, how do I tell behavioral drift
  caused by *me* from drift caused by *the feed I changed*?
- **Volume.** Capture is correct but sparse — only a handful of strong positives so far. Most of
  the discovery work is gated on accumulating engaged sessions, not more code.
