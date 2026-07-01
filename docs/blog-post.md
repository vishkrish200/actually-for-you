# I built an ML eval that told me not to ship my model — and I listened

_Draft. Written to be edited into your own voice. Section headers are load-bearing; the prose is a
starting point._

---

I got tired of my X feed. Not in the vague "social media is bad" way — in the specific way where I
could feel the algorithm optimizing for *its* goals (keep me scrolling, show me the ragebait that
performs) instead of mine (the long technical threads I actually read to the end and save). So I did
the obvious over-engineer's move: I rebuilt the ranking algorithm for an audience of one. Me.

The project is called **actually-for-you**. A Chrome extension quietly watches how I read my feed —
how long I dwell on each tweet, which ones I open, like, bookmark — and a local pipeline re-ranks the
same tweets by my *revealed* taste. It texts me a calibrated digest every morning. Single-user by
design: no accounts, no cloud, nothing leaves my laptop.

But the part I actually want to talk about isn't the ranker. It's the eval harness — because it did
the most useful thing an eval can do. **It told me my model wasn't good enough to ship, and I
believed it.**

## Capturing a hostile surface

First you have to see what you read, and X does not want you to. A few things I learned the hard way:

- **Match GraphQL operations by name, not by ID.** X's timeline comes over GraphQL, and the numeric
  query IDs rotate. Anchor on the operation *name* or your capture silently dies on the next deploy.
- **Anchor DOM selectors on `data-testid`, never CSS classes.** The classes are obfuscated and
  churn constantly. `data-testid` is the stable contract.
- **Accumulate dwell by tweet ID, never by DOM node.** The timeline virtualizes — it recycles a
  small pool of DOM nodes as you scroll — so if you track reading time per element, you smear one
  tweet's attention onto whatever recycles into its slot.
- **The MV3 service worker is ephemeral.** It gets killed constantly, so no durable state can live
  there. Everything goes through an IndexedDB queue that drains on a natural session boundary.

I split content capture and behavior capture into independent failure boundaries — a rule that paid
off in a way I'll come back to.

## The bug I found by tracing, not staring

At some point capture just… stopped. The database count froze. My first instinct was to read the
code and guess. That's almost always the slow path.

Instead I added freshness telemetry — "how long since the last impression?" — and a log line on the
ingest path. That immediately told me something a code-read wouldn't have: the browser *was* reaching
the server, sending the same batch every 15 seconds, and the server was *failing to write it* and
the extension was retrying forever. So I logged the exception the server was swallowing.

The culprit: a diagnostic event (`capture_health`, the thing that's supposed to make breakage
*loud*) had a malformed field that couldn't bind to SQLite. It threw *inside the write transaction*,
which rolled back the real data along with it. A diagnostic stream was taking down the payload it
existed to observe — the exact failure my "independent boundaries" rule was meant to prevent, sitting
one layer below where I'd drawn the boundary. Coerce the diagnostic fields, guard each in its own
try/catch, and the backlog drained on the next retry.

Lesson I keep relearning: **when something's broken, add the instrument that makes the invisible
state visible, then look. Don't guess from the code.**

## The eval that said no

Here's the part I'm proud of.

I built a learned ranker — logistic regression over a hashing-trick bag-of-words, plus author
features. Nothing fancy; the point was never a big model. And I built an offline replay harness as
the **ship gate**: the learned model only replaces the simple baseline if it beats that baseline on
held-out data. NDCG and MAP, time-split so I'm predicting the future from the past.

The first run said **SHIP ✅**. It was lying, and finding out *why* was the whole education:

**The random baseline scored a perfect 1.0.** That's impossible unless something's leaking the
answer. It was: tweet IDs are time-ordered snowflakes, and my positive examples (older, harvested
from my likes) and negatives (recent timeline) lived in different ID ranges. So *any* function of the
ID — including my "random" baseline that hashed it — was secretly sorting by era, which correlated
with the label. Fixed with a genuinely label-independent shuffle.

**Then the whole gate turned out to be saturated.** After the time-split, my "same-era" test pool was
about 86% positive. When the pool is that lopsided, NDCG@10 is maxed out no matter how you score it —
the top 10 are almost all positives by sheer base rate. `random` scored 1.0. `char_len` — literally
ranking by tweet *length* — scored 1.0. The metric wasn't measuring anything. I balanced the pool to
50/50 so that random lands at ~0.5 and the number can actually move.

**On a fair gate, my model honestly lost.** Keyword baseline MAP 0.735, my learned model 0.559. And
the tell that made me stop entirely: `char_len` alone scored 0.732 — nearly tying the "best"
baseline. That means the keyword baseline was near-circular. I'd curated my training labels partly
*using* those same AI keywords, so asking a text model to beat the keyword rule was asking it to beat
the rule that defined its own answer key. There's no honest win available on that gate.

So I didn't ship the model. I wrote `HOLD` in the log and moved on.

## Why not shipping is the result

It's tempting to treat "the model lost" as a failure — to keep tuning until the number goes green.
That instinct is exactly how people ship models that are secretly just memorizing an artifact. The
eval existed to protect me from my own motivated reasoning, and the correct response when it fires is
to *believe it*, not to torture the setup until it stops firing.

The honest state of the project: the simple similarity-to-my-likes scorer is the best thing I have,
it's shipped, and it delivers a digest I actually read. The learned model waits for denser behavioral
data — I have thousands of tweets I've *seen*, but only a couple hundred I engaged with deeply, and
that's the signal a behavioral model needs. When it densifies, the gate is already there to keep me
honest.

That's the thing I'd want a teammate to trust me with: not that I can train a model, but that I'll
build the check that tells me when *not* to.

---

_Code: [github.com/…/actually-for-you](#). Stack: WXT/MV3 + TypeScript extension, a zero-dependency
Node + `node:sqlite` ingest server, a pure-TypeScript ranker, vitest + `node:test`, macOS launchd for
scheduling._
