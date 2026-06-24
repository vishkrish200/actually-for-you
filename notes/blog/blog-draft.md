# I built a sensor for my own attention, then used it to re-rank my feed

*A start-to-finish account of building `actually-for-you` — a single-user X feed re-ranker — and what it taught me about the difference between attention and approval.*

> **Draft v0.** Built from the real project notes, PRD, and build log. Sections marked
> `[FILL]` need a fact only I have (the inspirations, exact dates). Sections marked
> `[CLIP]` are where a screen recording goes — capture list at the bottom.

---

## The itch

I open X to read three things and close it forty minutes later having read none of them.
Everyone knows this feeling. The usual explanation is "the algorithm is addictive," which is
true but useless — it doesn't tell you what to *do* about it.

The thing that actually bothered me was narrower and weirder: **the feed is optimized for a
version of me I don't recognize.** It serves the me that stops scrolling, not the me that
wanted to read three specific things. And those two are not the same person. The stopping-me
is reactive, outrage-prone, easily hijacked. The reading-me has actual taste.

So the question became: could I measure the gap? Not "is X bad" — I mean literally instrument
*my own* behavior, capture what I actually attend to versus what I'd claim to care about, and
then build a feed ranked by the reading-me instead of the stopping-me.

That's `actually-for-you`. One user. Me.

[CLIP: cold open — 10–15s of a normal doomscroll on x.com, fast, thumb-blur, then cut to the
re-ranked reader. The contrast *is* the thesis. No narration.]

## Where the idea came from

[FILL: Surya's blog post — what it was about, the one idea from it that lodged in my head, and
the link. This is one of the two seeds, so it deserves a real paragraph, not a name-drop.]

[FILL: noscroll.com — what it does, and why it was the *other* half of the seed. My read is
that noscroll attacks the symptom (stop scrolling) while I wanted to attack the ranking (change
what scrolling shows you) — confirm/correct that framing and I'll write the contrast.]

The two together pointed at the same place from opposite sides: one says *the feed is the
problem, so leave*; the other [FILL]. I didn't want to leave. I wanted the feed to be ranked by
me. That's a third option, and as far as I could tell nobody had built it for a single person
because it makes no business sense — which is exactly why it was interesting to build for an
audience of one.

## The thesis I started with (and the one I ended with)

I started with a sloppy version: *dwell time = interest. Capture how long I look at each tweet,
rank by that, done.*

I ended somewhere much sharper, and the gap between the two is most of what I learned.

**The like is a lie.** In my own data, I like roughly **1 tweet per 1,000 impressions** — but I
*dwell* on hundreds. The like button captures a rounding error of my actual interest. Anything
built on explicit engagement is reading the wrong instrument. That part held up.

**But dwell is a magnitude, not a sign.** This is the insight the whole project pivots on. A
long dwell tells you *how much* attention a tweet pulled. It tells you **nothing about whether
the attention was positive.** One number collapses at least four different states:

| Dwell looks identical, but it's really… | Sign |
|---|---|
| Genuine interest | + |
| Hate-reading — I read every word *because* it made me mad | − |
| Confusion — it was just hard to parse | ~ |
| Trapped — the doomscroll itself, can't look away | − |

If you **reward dwell, you reward all four equally** — which means you carefully rebuild the
exact ragebait engine you were trying to escape. The thing I was fighting *is*
engagement-as-reward, and naive dwell-as-reward walks right back into it wearing a disguise.

The clean one-liner I'd put on the wall: **engagement ≠ endorsement. Attention is a magnitude;
only an action gives it a sign.**

The fix, which I'll come back to: dwell only *flags a tweet as worth labeling.* The **sign comes
from the terminal action that follows** the dwell — "I read it fully, *then* I acted."

- dwell **+ like / bookmark / open-the-author / real reply** → **positive**
- dwell **+ not-interested / mute / block / report** → **negative**
- dwell **+ nothing** → a weak, ambiguous prior. Never a strong positive.

## The first real decision: what's actually hard here?

The instinct is that the ranking model is the hard part. It isn't. I wrote this into the PRD as
the load-bearing decision, and being right about it saved the project:

> The hard part is **not** the ranking model. It is the **capture surface** and the **labels.**

Dwell time, detail-opens, profile-expands — none of these exist in any scrape of a timeline.
They are first-party interaction telemetry that X collects and does not expose. You cannot
download them. You have to **sense them at the moment they happen**, off a page that was never
built to be read by an outside observer.

So the build order was risk-first, not pipeline-order: de-risk *capture* before writing a single
line of ranker. If I couldn't reliably sense my own behavior on a hostile page, nothing
downstream would matter. The milestones (M0 capture spike → M1 hardened capture → M2 ingest →
M3 read loop → M4 ranker v0 → dogfood → M5 labels → M6 learned ranker) all front-load the part
most likely to kill the project.

## Building the sensor — and why "it works" was a trap

The architecture is a Chrome MV3 extension acting as a passive sensor, with two **independent**
streams that must never take each other down:

- **Content** comes from X's own GraphQL responses — I hook `fetch`/`XHR` in the page context
  and read the structured JSON X already sends itself. Clean, robust to DOM churn.
- **Behavior** comes from the rendered DOM — `IntersectionObserver` for dwell, event listeners
  for clicks and expands. The only place a human's attention is observable.

Separate try/catch boundaries on purpose: a DOM change must not break content capture; a GraphQL
schema change must not break behavior capture. (PRD §5.)

[CLIP: extension architecture — quick screen-record of the three contexts in DevTools: the
injected page hook logging GraphQL ops, the content script, and the service worker draining to
localhost. 20s, narrated.]

The capture surface fought back in exactly the ways a hostile, obfuscated page does:

- **X virtualizes the scroll** — it recycles the same `<article>` DOM node for different tweets
  as you scroll. So you can **never** accumulate dwell keyed to a DOM element. Everything keys by
  `tweet_id`. Get this wrong and your numbers look perfectly fine and mean nothing.
- **GraphQL query IDs rotate** — match on the *operation name* (`HomeTimeline`), never the
  numeric id in the URL, or your hook breaks silently on X's next deploy.
- **CSS classes are obfuscated and churned** — anchor every selector on `data-testid`, never a
  class name.

These I knew going in. The ones that actually taught me something were the bugs where the code
was *right* and the data was *wrong.*

## The war stories: when "the test passes" is the most dangerous sentence

Here is the theme I'd build the whole middle of the post around, because it generalizes far
beyond this project:

> In behavioral instrumentation, the failure mode is almost never a crash. It's **plausible
> wrong numbers.** Every bug below produced data that looked completely fine.

**The empty handle, and the green test that lied.** X quietly moved `screen_name` from
`user.legacy` to `user.core` in their GraphQL shape. My hook still read `legacy`, so **every
single captured handle was empty** — 6,091 tweets attributed to nobody. The part that still makes
me wince: *my test fixture used the old schema*, so the test passed, green, the whole time real
data came back blank. **A green test against a stale fixture is more dangerous than no test** — no
test at least makes you nervous. And because the corpus is append-only and X has no backfill API,
every handle captured before the fix is **gone forever.**

[CLIP: the empty-handle bug — split screen of the feed reader showing numeric user-ids before the
fix, then `@handles` and avatars after. 10s.]

**The dwell-timer leak — minutes credited to a glance.** Dwell accrues between an
IntersectionObserver *enter* (≥50% visible) and *exit*. But under fast scroll plus node
virtualization, **exit events get dropped.** So a timer keeps running while the tweet is long
off-screen, and only drains when I blur the tab — crediting *minutes* of "attention" to a tweet I
flicked past in a quarter second. The smoking gun in the database was beautiful: **identical large
dwell values shared across distinct tweets** — 179.4s on three different tweets, 424.7s on two —
because several leaked timers all drained at the same tab-blur instant. One was 179 seconds of
"attention" on a tweet that said, in full, the word "no." Fixed by capping any single visible
interval at 30s, and by having the lanes use `MAX` not `SUM` of per-impression dwell, velocity-
filtered.

**Engagement logged on click — so keyboard shortcuts were invisible.** Likes/RTs/bookmarks were
logged on the *click event* only. Which meant every time I used the keyboard shortcut (`L`, `T`,
`B`) it logged nothing, and even on a click it never confirmed the action actually toggled (an
opened-then-cancelled menu counts as a like). Rewrote it to read the button's `data-testid`
flipping (`like` → `unlike`), input-agnostic, with an entry-baseline so pre-existing likes aren't
re-counted. This alone probably explains why my engagement counts had been near-zero.

**The viewed-gate, and a product decision falling out of a bug.** Diagnosing the above, I found
that **~half the feed was tweets that were never actually ≥50% on screen** — pure prefetch sitting
in X's GraphQL payload that I'd never laid eyes on. The fix was a one-line gate (a tweet is only a
candidate if *some* impression crossed 50% visibility), but the *decision* it forced was the
important part: **this is a re-ranker of what I actually saw, not a discovery engine.** That one
sentence resolved a dozen smaller design arguments.

After that pass: 559/559 tweets carry a handle (was 0%), max single-impression dwell capped at 60s
(was 855s), dwell density roughly tripled. The capture was finally *trustworthy* — which is the
precondition for literally everything downstream. So I did the brutal thing and **flushed the
entire corpus** to re-accumulate clean data, because append-only means you can't launder dirty
history.

[CLIP: the dwell-leak forensics — screen-record scrolling the SQLite/feed drill-down showing the
duplicated 179.4s values across different tweets, then the same view after the cap. This is the
most visual bug. 25s, narrated.]

## The ranker, deliberately boring

By design, the v0 ranker is the least interesting part — a weighted heuristic that works on day
one with zero labels, so I could dogfood immediately:

- **Lanes** (priority order, first-lane-wins): `bookmark` → `liked_author` → `fresh` → `backlog`
  → `resurface` → `explore`.
- **`explore` is non-negotiable** and exists in *every* version of the ranker — it's both
  anti-filter-bubble and the source of low-bias training data. A feed that only shows you what it
  already thinks you like can never learn it was wrong.
- **Scorer:** `opened_detail=10, liked=8, bookmarked=7, replied=6, dwell_norm=3` (capped),
  `flicked=−5`.
- **MMR diversity** so three hot-takes on the same thing don't cluster at the top.

[CLIP: the product working — side-by-side of X's native home timeline and my re-ranked reader on
the same corpus, scrolling both. The payoff shot. 30s.]

## I went and checked: is this how X actually does it?

Before getting too pleased with the dwell-is-not-a-sign insight, I did the honest thing and
checked whether I'd just reinvented machinery X already ships. **I had** — and finding that out
made the project *more* convincing, not less.

X open-sourced its Heavy Ranker in 2023. The actual weights are public, and they tell the whole
story:

| Label | Weight |
|---|---:|
| like (`fav`) | 0.5 |
| retweet | 1.0 |
| reply | 13.5 |
| profile click | 12.0 |
| **good click v2** (click in *and stay ≥2 min*) | 10.0 |
| reply *engaged by the author* | 75.0 |
| video playback ≥50% | **0.005** |
| **negative feedback** (mute/block/show-less) | **−74.0** |
| **report** | **−369.0** |

Three things jump out, and all three independently confirm the thesis I arrived at by stubbing my
toe on it:

1. **There is no raw-dwell reward anywhere.** The closest thing — passive video watch time — is
   weighted `0.005`, deliberately near-zero. X does not reward attention-as-such.
2. **The only dwell that counts is *conditioned* dwell.** "Good click v2" requires you to click
   into the conversation *and stay at least two minutes* — explicitly a defense against
   click-in-then-bounce ragebait. Sustained, in-context attention is a weak positive; a glance is
   nothing. That's my "dwell flags, the action signs" rule, productionized.
3. **The sign lives on dedicated negative heads, and they're enormous.** A single report (−369)
   outweighs ~700 maximal likes. Negative feedback (−74) outweighs ~148 likes. The sign of an
   interaction is *never* inferred from time-on-content — it's carried by explicit negative
   actions, weighted an order of magnitude above the positives.

And it's not just X. YouTube ranks by expected watch time *because* click-through promotes
clickbait (Covington 2016). Yahoo showed dwell is confounded by length and must be normalized
(Yi 2014). Facebook explicitly down-ranked passive consumption in 2018 and ate the lost
engagement on purpose. "Ragebait" was Oxford's Word of the Year 2025. My insight wasn't novel —
it was a well-worn field result I happened to rederive from my own behavior, which is the most
reassuring way to be unoriginal.

## The thing I was missing entirely: negatives

Here's the gap that finding closed. My sensor captured **positives and silence — no explicit
negatives at all.** X hands you the buttons right there: *not interested*, *mute*, *block*,
*report.* I was capturing none of them. And remember the append-only rule: **every day I ran
without negative-action capture was negative labels permanently lost.** Same lesson as the empty
handles — capture quality compounds, and you cannot backfill behavior.

So I wired negative capture in *before* the ranker could even use it, on the same `data-testid`
discipline as everything else, plus an end-of-session review loop: the system resurfaces tweets I
dwelled on and lets me sign them by hand — keep (→) or drop (←). The button is the label. The one
discipline I held: **don't try to infer hate-reading from the *shape* of dwell** (re-reads,
rage-quits, fast-scroll-after). That's a noisy research rabbit hole. One explicit "not interested"
click is worth more than any amount of behavioral sentiment guessing.

[CLIP: the end-of-session review loop — me signing a few dwelled tweets keep/drop with the arrow
keys. Shows the human-in-the-loop labeling. 15s.]

## What I actually built, underneath the feed

Step back from the ranker and the rarest asset is the **measurement itself**: a continuous,
passive, *honest* record of one person's attention. No survey, no self-report — and self-report on
media consumption is notoriously garbage; nobody accurately reports their own scrolling. It
**decouples exposure from engagement**: I capture what I scrolled *past*, not just what I clicked,
and the gap between "shown" and "attended to" is the entire interesting surface — the one platforms
almost never expose to the user themselves. And it's an **intervention lever**: I own the
re-ranker, so I can change my own feed and measure the effect on me.

That's not really a recommender project. It's an **n-of-1 instrument** — closer to
quantified-self / single-subject design than to classic ML. Which leads straight to the caveats I
want to state plainly rather than bury:

- **n = 1.** Every finding is valid *for me.* It's good for *generating* hypotheses, useless as a
  universal law. I will not dress N=1 up as a discovery about people.
- **Self-contamination.** The moment my re-ranker drives the feed, exposure stops being natural —
  the instrument changes the system it's measuring. So I keep raw-order observation (clean
  behavioral data) strictly separate from intervention (deliberately flip the ranker, measure the
  effect).

## Where it stands, and what's next

Capture is correct, trustworthy, and — honestly — still *sparse.* The bottleneck now isn't code;
it's accumulating enough engaged sessions to have hundreds of strong positives instead of dozens.
Most of the interesting discovery work (the revealed-preference gap: who I dwell on versus who I'd
claim to follow; the doomscroll attention-decay signature; whether my attention tracks quality or
just virality) is gated on data volume, not more engineering.

The next real milestone is the label pipeline — session reconstruction and inverse-propensity
debiasing to correct for position bias — and then a learned ranker that has to beat the v0
heuristic on honest offline replay (NDCG@k / MAP) before it's allowed to ship. That's the gate. If
the learned model can't beat the dumb one on data it's never seen, the dumb one stays.

The deepest open question is the one I find most interesting: once the re-ranker is live, how do I
tell behavioral drift caused by *me* from drift caused by *the feed I changed*? An instrument that
alters what it measures is the whole problem with recommender systems in miniature — and now it's
mine to solve at a scale of one.

---

## Clip & capture checklist (for the production pass)

Recordings to grab once the system's running (`cd ingest && npm start`, reader at
`http://localhost:2727`, extension loaded on x.com):

1. **Cold open** — doomscroll vs. re-ranked reader, the contrast. ~15s, no narration.
2. **Extension architecture** — DevTools showing injected hook / content script / SW draining to
   localhost. ~20s, narrated.
3. **Empty-handle bug** — numeric ids → handles+avatars. ~10s.
4. **Dwell-leak forensics** — duplicated 179.4s values across tweets, then capped. ~25s, narrated.
   *Most visual bug — worth the most effort.*
5. **The product working** — native X timeline vs. re-ranked reader, same corpus. ~30s. *The payoff.*
6. **End-of-session review loop** — signing dwelled tweets keep/drop with arrow keys. ~15s.

I can drive the browser and record these (GIF or screen capture) in a follow-up once you confirm
the system's live and there's enough data in `afy.db` to make the reader look populated.

## Open `[FILL]`s I need from you

- **Surya's post:** the link, what it argued, and the one idea you took from it.
- **noscroll.com:** what it does and whether the "attacks the symptom vs. I attack the ranking"
  framing is right.
- **Dates:** want a real timeline in the post, or keep it loose?
