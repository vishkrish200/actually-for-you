<!--
============================================================================
  EDIT ME — THIS FILE IS THE PRODUCT.
============================================================================
This rubric IS the qualityWeight. An LLM reads everything below and grades
each tweet 0–10 against it (rubric.ts). Personalized 2026-07-07 from the
owner's OWN curation history — harvested likes/bookmarks and hand-pruned
negatives (never from the review pool: those are the eval gate's test
labels, and a rubric written from them would leak the gate).

How it's used (so you can calibrate the wording):
  - The grader sees ONLY the tweet text (+ quoted text when it's a quote-
    tweet). It is DELIBERATELY blind to the author, handle, follower count,
    and engagement numbers — quality must never proxy fame. So write anchors
    about the WRITING and the IDEAS, never "if it's from @so-and-so".
  - Editing this file changes its sha256, which re-scores the whole corpus on
    the next `npm run rubric`. Cheap to iterate — tweak and re-run.
  - Scores are ranking FEATURES, never labels (CLAUDE.md invariant). Grading
    a tweet high here does NOT teach the taste model anything; it only feeds
    the M9 mix and the eval arm. So grade for what you'd want to READ, not for
    what you think the model "should" learn.

Output contract the grader is held to: one integer 0–10 per tweet. Whole
numbers only. When unsure, it lands the tweet at 5 and moves on.
============================================================================
-->

# Who is reading

An ML/AI engineer who builds with and studies LLMs: training and fine-tuning,
GPU/systems internals, agents and coding tools (Claude Code, Codex, and the
skill/subagent ecosystem around them), evals, and AI infrastructure. Reads to
get better at this craft and to track the frontier. Also a polymath: values
thought-provoking writing and sharp mental models WELL beyond AI — a
non-obvious idea, a cross-disciplinary insight, a genuinely resonant personal
or life reflection all land, as long as there is REAL insight and not just a
slogan. Not here for markets, crypto, politics, or celebrity anything.

# What earns 8–10 — I would stop scrolling for this

A tweet scores high when it would genuinely change what I know, build, or do
next. Concrete anchors, in roughly descending order of how reliably I want
them:

- **ML/AI systems substance**: a training or fine-tuning recipe with real
  numbers, an architecture insight or derivation, kernel/GPU internals
  (memory layout, TMA, why something is fast), inference/serving tricks, a
  non-obvious failure mode, "here's what actually happened when we trained X".
- **Curated learning resources with judgment**: "read these papers in this
  order", a vetted list of blogs/courses/repos for a hard topic, a reading
  list someone clearly earned by doing the work. Density of vetted links IS
  the substance — do NOT dock a tweet for being a list or a thread if the
  items are specific and the curation is real.
- **Agent & coding-tool craft**: a concrete workflow, skill, or configuration
  that changes how I'd use Claude Code/Codex/agents tomorrow — token-cost
  engineering, subagent patterns, eval harnesses, a trick with a measured
  payoff. "Paste this, here's why it works" beats "AI will change coding".
- **First-person builder/researcher reports**: "I implemented the paper and
  found…", "I beat the baseline by 4%, here's the config", "we cut AI spend
  in half with routing/caching, here's the architecture". Skin in the game,
  specifics on the table. CRUCIAL: the specifics must be IN the tweet. A
  first-person HOOK whose payoff is hidden behind a thread or link ("I thought
  my agents were autonomous. They weren't. 🧵", "I built X this weekend 👇") is
  graded on what's visible, not what's promised — usually a 4–5, not an 8. The
  builder voice is not the substance; the config / number / failure mode is.
- **A thought-provoking idea or mental model with real insight — including
  outside AI**: a sharp essay, a non-obvious framework, a cross-disciplinary
  connection that makes me think differently. Judge the insight, not the
  topic — originality and depth earn the score; a familiar aphorism dressed as
  wisdom does not (that is a 2–3, see anti-criteria).
- **Frontier-lab and AI-career intel with substance**: how hiring actually
  works at frontier labs, what skills they screen for, an insider explaining
  a real decision, a model release WITH the details that matter (capabilities,
  price, context, what changed) rather than vibes.
- **A sharp idea about where the field is going, argued**: inference-compute
  economics, data-vs-compute takes, bitter-lesson discourse — when it commits
  to a claim and gives reasoning I could argue with.

A 10 is rare — reserve it for something I'd screenshot and send to someone.

# What sits at 4–7 — fine, but forgettable

Most competent tweets live here. Real, on-topic, not annoying — just not
something I'd have missed.

- A solid model/product release note with some specifics but no depth (5–7).
- A reasonable AI opinion I already agree with, adding nothing new (5–6).
- A useful-but-routine link or "TIL" with little context (4–6).
- On-topic but shallow: gestures at a real idea without developing it (4–6).
- A genuinely funny, sharp joke or meme — wit is the substance (5–7). A lazy
  meme-format reply is a 2–3.
- Mildly interesting industry/personal note, low stakes either way (4–5).
- A genuinely sharp or resonant personal / local / life note — a specific
  reflection, a real observation, a place or scene I'd actually care about
  (5–6). The personal lane: only when it says something. A generic slogan or
  fortune-cookie line is NOT this — that stays a 2–3 (see anti-criteria).

If it's competent and on-topic but I'd forget it in an hour, it's a 5.

# What earns 0–3 — actively not worth my attention (anti-criteria)

These are the things the feed is FULL of and the whole point is to filter out.
Score low even if the tweet is "popular" — popularity is not quality, and the
grader can't see engagement anyway.

- **Crypto, memecoins, tokens, NFTs, onchain ANYTHING**: trading calls,
  wallet tracking, "$X to $Y" flips, airdrops, mints, DAOs, giveaway threads,
  chain-vs-chain discourse. This is a hard topic floor: even technically
  competent crypto-infrastructure content is a 0–2 here — it is not what this
  feed is for.
- **Trading, markets, and money-flex content**: stock/forex/portfolio talk,
  "how I make $X/day", copy-trading, hustle-porn, "I turned $1k into $1M".
- **Politics, celebrity, and outrage**: politician/billionaire news, net-worth
  updates, tribal dunks, ragebait, "imagine thinking…". Heat, no light.
- **Engagement-bait**: "RT if you agree", "reply and I'll DM you", follow-to-
  enter anything, manufactured polls, "who else…", a "🧵" that promises the
  world and delivers nothing — the sin is the emptiness, not the thread form.
- **Build-in-public hooks & hustle-flex**: "I built X this weekend", "I did Y
  in 3 minutes for $0.50", "I run 5 businesses on AI agents", "I turned his
  video into a full step-by-step". The first-person builder costume with no
  reproducible payload IN the tweet — 2–4 unless it actually hands over the how
  (config, numbers, architecture). A promise of value is not value.
- **Rumors, scoops, and leaks**: "🚨 exclusive scoop", "X may be quietly
  routing…", "sources say", unconfirmed model gossip. Unverified speculation is
  hype dressed as intel — 1–3 no matter how juicy. A release earns its score
  from official, specific detail, never from the word "scoop".
- **Breathless hype**: "this changes EVERYTHING", "we are so back",
  announcement-as-revelation with zero detail under the superlatives. A
  specific product/model announcement counts here too when it's all superlative
  and no substance ("[Product] is 6× faster", "goes GA in 2 days 🚀").
- **Pure vibes / noise**: "gm", subtweets with no referent, cryptic one-word
  posts, in-jokes with no payload, mood-posting.
- **Empty motivation**: fortune-cookie platitudes, "10 productivity hacks"
  with no actual hack.

A 0 is for something that made the feed strictly worse by existing.

# Tie-breakers & edge cases

- **Substance over polish**: a rough but genuinely informative tweet beats a
  slick but empty one. Grade the idea, not the wordsmithing.
- **Hook vs payload**: grade what is actually in the tweet, never what it
  promises. A magnetic opener with the substance hidden behind "🧵 / 👇 / link"
  is a hook — score the visible payload only. This is the #1 thing that fools
  the grader: an "I built / I discovered / exclusive" voice is not substance.
- **Lists and threads are format, not sin**: judge the payload. A dense
  curated list of real resources is top-tier; a listicle of platitudes is
  engagement-bait.
- **Quote-tweets**: you're given the quoted text too — grade the WHOLE unit.
  A "this." over a great point inherits some of the quote's value; a smug dunk
  over a strawman is still a dunk. If the quote is the only substance and the
  quoter adds nothing, don't let the quote alone push it high.
- **Announcements**: specifics (what changed, numbers, availability) push it
  up; pure momentum ("huge, more soon") pushes it down.
- **AI content about making money** (selling courses, "AI side-hustle"
  farming): grade it as money-flex, not as AI content — 1–3.
- **Threads (single tweet seen in isolation)**: grade what's in front of you.
  A strong standalone opener scores on its own merit; "🧵👇" with nothing else
  is engagement-bait.
- **When genuinely on the fence**, score 5. Don't inflate; the whole feed
  averages mediocre, and a rubric that grades everything a 7 is useless.
