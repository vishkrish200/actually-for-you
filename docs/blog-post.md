# I rebuilt my X feed for an audience of one — and the hard part was the eval

I got tired of my feed optimizing for *its* goals (keep me scrolling, surface the ragebait that
performs) instead of mine (the long technical threads I actually read to the end). So I rebuilt
the ranking for an audience of one. **actually-for-you**: a Chrome extension quietly watches
how I read — dwell, opens, likes, bookmarks — and a local pipeline re-ranks the same tweets by
my *revealed* taste. It texts me a digest every morning at 8am, and every digest secretly runs
a blind A/B between two rankers. No accounts, no cloud; nothing leaves my laptop.

![The morning digest reader — cards re-ranked by taste, each with a ✦ score and in-flow Keep/Drop votes](reader.png)

The ranker turned out to be the easy part. The story is the eval stack — the gate that told me
not to ship my first model, and the later, stranger discovery that the gate itself had become
the wrong instrument.

## Capturing a hostile surface

Dwell time and detail-opens exist in no scrape — they're telemetry X collects and doesn't
expose. You have to sense them live, off a page never built to be observed. The hard-won rules:

- **Match GraphQL operations by name, not ID** — the numeric IDs rotate, and your capture dies
  silently on the next deploy.
- **Anchor selectors on `data-testid`, never CSS classes** — the classes are obfuscated churn.
- **Accumulate dwell by tweet ID, never by DOM node** — the timeline recycles nodes as you
  scroll; per-element timing smears one tweet's attention onto the next.
- **Watch state, not input** — logging likes on click events misses keyboard shortcuts; watch
  the button's `data-testid` flip (`like` → `unlike`) instead.
- **MV3 service workers are ephemeral** — durable state lives in an IndexedDB queue.

Content capture (the GraphQL hook) and behavior capture (the DOM observer) run in independent
failure boundaries — a rule that paid off in a way I'll come back to. A background tab also
polls my own home timeline every 30 minutes through the same path; polled tweets are candidates
only, never behavioral labels, because nobody read them.

## The bug I found by tracing, not staring

Capture just… stopped. Instead of re-reading code, I added freshness telemetry and a log line —
which showed the browser dutifully re-sending the same batch every 15 seconds while the server
swallowed an exception. The culprit: a malformed `capture_health` diagnostic — the event that
exists to make breakage *loud* — threw *inside the write transaction* and rolled back the real
data with it. The diagnostic stream was killing the payload it observed, one layer below where
I'd drawn my failure boundary.

The lesson that becomes the spine of this whole story: **when something's broken, add the
instrument that makes invisible state visible, then look. Don't guess from the code.**

## Act one: the eval that said no

I built a learned ranker (logistic regression, hashing-trick bag-of-words) and an offline
replay harness as the **ship gate**: beat the simple baseline on held-out data or don't ship.
The first run said SHIP ✅. It was lying, three ways:

- **The random baseline scored a perfect 1.0.** Tweet IDs are time-ordered snowflakes, and my
  positives and negatives lived in different ID ranges — *any* function of the ID was secretly
  sorting by era.
- **The gate was saturated.** An 86%-positive test pool maxes out NDCG@10 under any scorer —
  ranking by tweet *length* scored 1.0.
- **On a fair gate, my model honestly lost** — and `char_len` nearly tied the keyword baseline,
  because I'd curated training labels partly *using* those keywords. The model was being asked
  to beat the rule that defined its own answer key.

So I wrote `HOLD` and moved on. The discipline that HOLD forced survives everywhere: hand-signed
👍/👎 became the *only* gold labels, keyword may rank but never label, and `char_len`/`media`
became confounder controls — regressed in during training, dropped at predict.

## What replaced the model

Judges and similarity: **taste** (TF-IDF cosine to ~2,900 curated likes, length-normalized),
**rubric** (an LLM grades each tweet 0–10 against my personal `RUBRIC.md` — text-only, so
quality can't proxy fame — by shelling out to the local `claude` CLI: zero deps, no API key,
skips loudly and ranks neutral if starved), and an **author prior** (from behavior only, never
votes). Blended `0.5·taste + 0.3·rubric + 0.2·author`, with ~10% of every digest reserved for
an **explore lane** — tweets the ranker did *not* pick. The explore lane is the quiet MVP:
anti-filter-bubble, and a serve-bias-free audit pool for the eval itself.

## Act two: the instrument becomes the suspect

Week after week, every new ranker read "statistically tied with keyword" on the gate. At some
point the question flipped from "why are my rankers mediocre?" to "is the ruler broken?" It
was, three ways: pooled MAP **threw away ~20% of my hand votes** to class-balancing, **scored
only the head** of one giant pile, and **silently credited keyword every pair its integer
word-counts couldn't order** — 25% of all pairs, concentrated exactly where a taste ranker
earns its keep (good AI content vs AI-flavored junk, identical to a keyword counter).

I rebuilt the gate as **pairwise preference accuracy**: AUC over *every* hand-signed pair,
nothing trains on reviews, and a challenger clears only with a paired-bootstrap CI on the
(arm − keyword) difference excluding zero. Same votes, honest ruler — on the rebuild-day read
the rubric separated from keyword at 0.71 vs 0.63. The weeks of "tie" were the metric's fault.
The gate as of this write-up, with the arms shuffled as votes accumulated:

```
▼ NON-CIRCULAR SHIP GATE  (233 👍 × 358 👎 = 83,414 pairs)
char_len                      0.6796  [+0.006, +0.098] *
keyword (baseline to beat)    0.6282
rubric (LLM judge)            0.6784  [-0.006, +0.107]   483/591 scored
mix (M9 digest blend)         0.6959  [+0.011, +0.123] *

SHIP ✅  mix beats keyword on all-pairs AUC with a diff CI excluding 0.
```

That's what the rebuild bought: a ruler that *separates* rankers instead of flattening
everything into a tie. (Even tweet-length beats a keyword counter on my votes — which is why
length is a confounder control, never a feature.) One more loop fell out: a per-version **judge
calibration** table — rewriting the rubric from generic quality to my actual taste moved
LLM-vs-my-votes agreement from 0.687 to 0.724. Observe-only by doctrine: tune the rubric
against that table and the judge stops being independent of the gate. Every measurement here is
one convenience away from measuring itself.

## Act three: offline is only a guardrail

An offline gate can say a ranker is *not worse*; it can't say which feed you'd rather live
with. The verdict-maker is **blind team-draft interleaving** on the live product: two rankers
secretly split every slate, pixel-identical UI, arm logged per card. Credit is a net judgment —
opens + 👍 − 👎, and it goes negative, because a ranker that serves confident junk should bleed.
The current matchup, in the report's own words:

```
TIED at n=36 judged events — the (keyword − mix) credit-rate CI [-0.077, 0.047] contains 0.
No ranker leads yet; keep serving.
```

An A/B report that says "keep serving" instead of inventing a winner is the best artifact this
project has produced.

![A digest card — Keep/Drop feed the gold labels; nothing shows which arm drafted it](card.png)

Around the interleave: a daily **scorecard** (junk@10: 72.7% on day one, 0% the last three
days) and a **recall probe** (organic likes the digest never served me first — the only
detector for what the system *misses* rather than mis-ranks). Each layer checks the one below
it, and none may train the thing it judges.

## What I'd tell you over coffee

**The failure mode of behavioral systems is never a crash — it's plausible wrong numbers.**
Green tests against a stale fixture while every captured handle came back empty; leaked dwell
timers surfacing as identical values across distinct tweets; an LLM judge quietly decaying
because the CLI ignores SIGTERM and my timeout minted zombie processes. The defenses are
boring: freshness telemetry, coverage printed next to every verdict, diagnostics that can't
kill their payload.

**Not shipping is a result.** The learned ranker lost on a fair gate and is retired by
evidence. The eval exists to protect you from your own motivated reasoning; when it fires,
believe it.

**But sometimes the eval is the bug.** The same skepticism you point at a suspiciously good
number eventually has to point at a suspiciously *flat* one. The move is identical either way:
trace, instrument, look.

**Bigger models wait until an eval asks for them.** Today's champions are a similarity score
and an LLM judge with a hand-written rubric. At n=1 the bottleneck is labels, not capacity.

---

_Code: [github.com/vishkrish200/actually-for-you](https://github.com/vishkrish200/actually-for-you).
Stack: esbuild + MV3 TypeScript extension, zero-dependency Node + `node:sqlite` ingest, pure-TS
ranker, the local `claude` CLI as headless judge, vitest + `node:test`, launchd._
