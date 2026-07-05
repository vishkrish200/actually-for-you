<!--
============================================================================
  EDIT ME — THIS FILE IS THE PRODUCT.
============================================================================
This rubric IS the qualityWeight. An LLM reads everything below and grades
each tweet 0–10 against it (rubric.ts). Personalize it hard: the starter
text is opinionated-but-generic for a technical Twitter reader — rewrite the
anchors in your own words, add your own pet loves and pet peeves, delete what
doesn't fit. The more specific and personal this is, the better the scores.

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

# What earns 8–10 — I would stop scrolling for this

A tweet scores high when it would genuinely change what I think, know, or do.
Concrete anchors:

- **A real technical claim with substance**: a benchmark result, an
  architecture insight, a non-obvious failure mode, a "here's what actually
  happened when we tried X". Specific enough that I could act on it or argue
  with it.
- **A sharp idea, cleanly argued**: a genuinely novel framing, a
  counter-intuitive take backed by reasoning (not just contrarianism), a
  mental model that makes something click.
- **Primary-source signal**: the person who built the thing explaining a
  decision; a paper's actual finding stated plainly; a first-hand report from
  someone who was there. Not a reaction to a reaction.
- **Dense, earned specificity**: names the actual system, the actual number,
  the actual tradeoff. Teaches me the shape of a problem I didn't have before.
- **Craft**: a piece of writing, a demo, or an explanation good enough that
  the quality itself is the point.

A 10 is rare — reserve it for something I'd screenshot and send to someone.

# What sits at 4–7 — fine, but forgettable

Most competent tweets live here. Real, on-topic, not annoying — just not
something I'd have missed.

- A reasonable opinion I already agree with, adding nothing new (5–6).
- A useful-but-routine link, announcement, or "TIL" with little context (4–6).
- A decent question or observation that doesn't quite land a point (4–5).
- On-topic but shallow: gestures at a real idea without developing it (4–6).
- Mildly interesting personal/industry note, low stakes either way (4–5).

If it's competent and on-topic but I'd forget it in an hour, it's a 5.

# What earns 0–3 — actively not worth my attention (anti-criteria)

These are the things the feed is FULL of and the whole point is to filter out.
Score low even if the tweet is "popular" — popularity is not quality, and the
grader can't see engagement anyway.

- **Engagement-bait**: "RT if you agree", "reply with X", follower-farming,
  "a thread 🧵" that promises the world and delivers a listicle, "unpopular
  opinion:" as a hook, manufactured polls, "who else…".
- **Breathless hype**: "this changes EVERYTHING", "mind = blown", "we are so
  back", "the future is here" — superlatives with zero substance under them.
  Announcement-as-revelation with no actual detail.
- **Outrage-bait / dunks**: ragebait, bad-faith quote-tweet pile-ons, tribal
  score-settling, "imagine thinking…", contrarian-for-clicks. Heat, no light.
- **Pure vibes / noise**: "gm", "wagmi", subtweets with no referent, cryptic
  one-word posts, in-jokes I can't parse, mood-posting, "vibes".
- **Grift & spam**: crypto/token shilling, "I made $X doing Y, here's how"
  (link in bio), giveaway farming, obvious astroturf, SEO-slop.
- **Empty motivation**: fortune-cookie platitudes, hustle-porn, "here are 10
  productivity hacks" with no actual hack.

A 0 is for something that made the feed strictly worse by existing.

# Tie-breakers & edge cases

- **Substance over polish**: a rough but genuinely informative tweet beats a
  slick but empty one. Grade the idea, not the wordsmithing.
- **Quote-tweets**: you're given the quoted text too — grade the WHOLE unit.
  A "this." over a great point inherits some of the quote's value; a smug dunk
  over a strawman is still a dunk. If the quote is the only substance and the
  quoter adds nothing, don't let the quote alone push it high.
- **Jokes**: a genuinely funny, sharp joke can reach 6–7 if the wit is the
  substance; a lazy meme-format reply is a 2–3.
- **Threads (single tweet seen in isolation)**: grade what's in front of you.
  A strong standalone opener scores on its own merit; "🧵👇" with nothing else
  is engagement-bait.
- **When genuinely on the fence**, score 5. Don't inflate; the whole feed
  averages mediocre, and a rubric that grades everything a 7 is useless.
