# I rebuilt my X feed for an audience of one

I open X to read three things and close it forty minutes later having read none of them.

The feed isn't ranked for the me that wants to read. It's ranked for the me that can't stop
scrolling. Those are different people, and X sides with the second one.

So I built **actually-for-you** — my feed, re-ranked by my own behavior:

- A Chrome extension quietly watches how I *actually* read: how long I linger on each tweet,
  what I open, what I save.
- A local pipeline turns that into a taste profile and re-ranks the same tweets.
- Every morning at 8am, it texts me a digest.
- Every digest secretly runs an A/B test between two rankers.
- My thumbs-up / thumbs-down votes decide which ranker survives.

One user. No accounts, no cloud, no API keys. Nothing leaves my laptop.

![The morning digest — my feed, re-ranked, with Keep/Drop votes on every card](reader.png)

The ranking math turned out to be the easy part. The two hard parts were **sensing behavior
from a page that fights you**, and **building an eval I could trust** — including the day I
discovered the eval itself was broken. That's the story.

## Part 1 — a sensor for my own attention

How long you look at a tweet isn't in any API or scrape. X measures it and keeps it. If I
wanted my own attention data, I had to capture it live, in the browser, from a page that was
never meant to be observed.

X fights you in specific ways, and each one became a rule:

- **Match GraphQL requests by operation name.** The numeric IDs rotate on every deploy, and
  your capture dies silently.
- **Anchor on `data-testid`, never CSS classes.** The class names are obfuscated and churn
  weekly.
- **Track dwell by tweet ID, never by DOM element.** X recycles the same handful of DOM nodes
  as you scroll. Track the node and you credit one tweet's reading time to whatever renders in
  its slot next.
- **Watch state, not clicks.** Log likes on click events and you miss every keyboard shortcut.
  Watch the like button's own state flip instead.

The one architectural rule: content capture and behavior capture run in **separate failure
boundaries**. A change on X's side can break one; it must never silently take down both.

### The bug that taught me how to debug this project

One day, capture just stopped. The database count froze.

Instead of staring at code, I added one piece of telemetry — *how long since the last write?* —
and one log line. They showed something a code-read never would: the extension was faithfully
re-sending the same batch every 15 seconds, and the server was throwing it away.

The culprit was almost poetic. A health-check event — the thing that exists to make breakage
loud — had a malformed field. It crashed inside the database transaction and rolled back the
real data along with it. My diagnostic was killing the patient.

That became the house rule: **when something breaks, don't guess from the code. Add the
instrument that makes the invisible state visible, then look.** It ends up being the theme of
everything below.

## Part 2 — the eval that said "don't ship"

With clean data flowing, I trained a small model to rank tweets, and I built a gate for it: an
offline eval where the model had to beat a dumb keyword baseline on held-out data, or it
doesn't ship.

The first run said **SHIP ✅**. It was lying, three different ways:

1. **The "random" baseline scored a perfect 1.0.** Impossible — unless something leaks the
   answer. Tweet IDs encode time, and my positive and negative examples came from different
   eras. Anything that touched the ID was secretly sorting by date.
2. **The test pool was 86% positive.** With numbers that lopsided, every scorer looks perfect.
   Ranking tweets by *length* scored 1.0 too. The metric couldn't fail.
3. **The baseline was grading its own homework.** I had curated my training labels partly
   *using* those same keywords. My model was being asked to beat the rule that wrote its
   answer key.

After fixing all three, the honest result: **my model lost.** So I didn't ship it. I wrote
`HOLD` in the log and moved on.

That decision bought the three rules the whole project now runs on:

- My hand votes are the **only** ground truth. Nothing else gets to label.
- Keyword scores and LLM scores may *rank* tweets, but may never *label* them — that's
  circular.
- Tweet length and media are **confounds**, not features. A ranker never gets credit for
  "longer tweet."

## Part 3 — what ships instead

If a trained model can't win, use judges:

- **Taste** — how similar is this tweet to the ~2,900 tweets I've liked?
- **Rubric** — an LLM grades each tweet 0–10 against a written description of what I want to
  read. It sees only the text: no author, no like counts, so quality can't proxy fame.
- **Author prior** — how often do I actually engage with this author?

Blend the three, and reserve 10% of every digest for an **explore lane**: tweets the ranker
did *not* pick. That's the anti-filter-bubble valve, and my votes on those cards form a clean
audit set no ranker had a hand in selecting.

## Part 4 — the day the eval became the suspect

Then something strange happened. Week after week, every new ranker — the LLM judge, the taste
score, the blend — came back "statistically tied with keyword."

Three different approaches, all mysteriously equal to a keyword counter? At some point the
question flips: maybe the rankers aren't mediocre. Maybe the *ruler* is broken.

It was. The old metric quietly threw away 20% of my votes for statistical hygiene, only really
scored the top of the pile, and — worst — handed the keyword baseline a free pass on every
comparison its coarse integer scores couldn't decide. That was **a quarter of all
comparisons**, concentrated exactly where a taste ranker earns its keep: telling good AI
content from AI-flavored junk, which all looks the same to a keyword counter.

So I rebuilt the gate around one plain question: **out of every pair of tweets where I voted
👍 on one and 👎 on the other, how often does the ranker put my 👍 on top?** That's it. Every
vote counts, nothing is discarded, and a ranker only clears the gate if it beats keyword by a
margin the bootstrap says is real.

Same votes, honest ruler — the rankers separated immediately:

```
model                            AUC   vs keyword
keyword (baseline to beat)    0.6282
rubric (LLM judge)            0.6784
mix (shipped blend)           0.6959   beats it — CI excludes zero  →  SHIP ✅
```

The weeks of "tie" were the metric's fault. And the fix used the exact same move as the
capture bug in Part 1: stop arguing with the number, instrument the instrument, then look.

One more feedback loop fell out of this: every time I edit the rubric the LLM grades against,
the eval reports whether the LLM's scores got *closer to my actual votes* or further away.
Rewriting it from generic "is this high quality?" to my real taste moved agreement from 0.69
to 0.72. (And a warning prints right in the report: never tune the rubric against this table —
that would make the judge grade its own homework.)

## Part 5 — the deciding vote is the product itself

An offline eval can tell you a ranker isn't *worse*. It can't tell you which feed you'd rather
live with. So the final verdict runs live, inside the product.

Every morning's digest is secretly drafted by **two rankers taking turns**, like picking
teams. The interface is pixel-identical either way; nothing on any card reveals which ranker
picked it. Not even to me.

![A digest card — my Keep/Drop votes are the ground truth, and I can't see which ranker chose it](card.png)

Each ranker earns credit when I open or 👍 its picks — and *loses* credit when I 👎 them,
because a ranker that confidently serves junk should bleed for it. Right now the scoreboard
says:

```
TIED at n=36 judged events — no ranker leads yet; keep serving.
```

An A/B report that says "keep serving" instead of inventing a winner is my favorite thing this
project has produced.

Two smaller instruments run daily alongside it: a **scorecard** (how much junk lands in the
top 10 of each digest — 73% on day one, 0% the last three days) and a **recall probe** (what
did I organically like that the digest never showed me first — the only detector for what the
system *misses*).

## What I learned

**In behavioral systems, the failure mode is never a crash. It's plausible wrong numbers.**
Every real bug produced data that looked fine: green tests while every username came back
empty, leaked timers crediting minutes of "attention" to tweets I flicked past, an LLM judge
quietly grading only two-thirds of the pool. The defenses are boring and they work: freshness
checks, coverage printed next to every score, diagnostics that can't take down what they
monitor.

**Not shipping is a result.** The eval exists to protect you from your own motivated
reasoning. When it fires, believe it.

**Sometimes the eval is the bug.** The same suspicion you aim at a number that looks too good,
you eventually have to aim at a number that looks too flat. The move is identical: trace,
instrument, look.

**Capacity is rarely the bottleneck.** Today's champions are a similarity score and an LLM
with a hand-written rubric. Bigger models wait until the eval — not my ego — says they're
needed. At n=1, the bottleneck is labels.

---

_Code and full build log: [github.com/vishkrish200/actually-for-you](https://github.com/vishkrish200/actually-for-you).
Chrome extension (MV3, TypeScript) → zero-dependency Node + SQLite server → pure-TS ranker →
local `claude` CLI as the judge → launchd for the 8am text._
