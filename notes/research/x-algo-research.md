# How X (and RecSys) handle dwell-as-magnitude-not-sign

**Question:** Dwell time (attention) is a *magnitude* signal, not a *sign* signal — you can dwell long on a tweet because you hate-read it, are confused, or can't look away, not because you like it. Rewarding dwell risks optimizing for ragebait. How does X's real algorithm, and the broader RecSys field, solve this?

**Verdict up front:** The observation is **not novel** — it's a well-established result in the RecSys field and is structurally baked into X's open-sourced algorithm. X never rewards raw dwell. It only rewards *conditioned* dwell (click-into-conversation **AND** stay ≥ 2 min) and pairs every attention signal with large, explicit **negative** heads (report `-369`, negative-feedback `-74`). Below are the verified numbers and the literature.

---

## 1. X's Heavy Ranker — the actual weights (PRIMARY SOURCE, verified)

Source: `twitter/the-algorithm-ml`, `projects/home/recap/README.md` (open-sourced March 31, 2023; weights "as of April 5, 2023"). The Heavy Ranker is a parallel-MaskNet multi-task neural net that, for each candidate tweet, predicts ~10 engagement probabilities (each in [0,1]). The final score is a **weighted sum** of those probabilities. Verbatim weight table:

| Label (head) | Weight |
|---|---:|
| `scored_tweets_model_weight_fav` (like) | **0.5** |
| `scored_tweets_model_weight_retweet` | **1.0** |
| `scored_tweets_model_weight_reply` | **13.5** |
| `scored_tweets_model_weight_good_profile_click` | **12.0** |
| `scored_tweets_model_weight_video_playback50` | **0.005** |
| `scored_tweets_model_weight_reply_engaged_by_author` | **75.0** |
| `scored_tweets_model_weight_good_click` | **11.0** |
| `scored_tweets_model_weight_good_click_v2` | **10.0** |
| `scored_tweets_model_weight_negative_feedback_v2` | **−74.0** |
| `scored_tweets_model_weight_report` | **−369.0** |

`score = Σ (weight_i × P(engagement_i))`.

**Key structural facts:**
- **No raw-dwell head exists.** There is no "time spent on tweet" or "scroll-stop dwell" reward anywhere in the weight list. The closest the model gets to dwell is `good_click_v2` (see §2) and `video_playback50` — and `video_playback50` is weighted **0.005**, i.e. deliberately near-zero. Passive attention is essentially not rewarded.
- The biggest *positive* weights are on signals that are hard to fake and require an explicit, effortful, two-sided action: `reply_engaged_by_author` (75) — you reply *and the author replies back* — and `reply` (13.5).
- The two negative heads are enormous relative to the positives. A single high-probability report (`−369`) outweighs ~700 maximal likes (0.5 each), and a negative-feedback (`−74`) outweighs ~148 likes. Negative feedback is a near-veto, not a tiebreaker.

Sources:
- README (raw): <https://raw.githubusercontent.com/twitter/the-algorithm-ml/main/projects/home/recap/README.md>
- README (rendered): <https://github.com/twitter/the-algorithm-ml/blob/main/projects/home/recap/README.md>
- Annotated repo (igorbrigadir/awesome-twitter-algo): <https://github.com/igorbrigadir/awesome-twitter-algo>

---

## 2. How X assigns a SIGN to attention — the "good click" trick

X solves the exact "dwell is unsigned" problem by **never treating dwell as a standalone label**. It only counts dwell when it co-occurs with a behavior that disambiguates valence. Verbatim label definitions from the README:

- **`good_click`** (weight 11): *"The probability the user will click into the conversation of this Tweet and reply or Like a Tweet."* → dwell **+ an explicit positive act**.
- **`good_click_v2`** (weight 10): *"The probability the user will click into the conversation of this Tweet and stay there for at least 2 minutes."* → dwell **with a 2-minute threshold inside the conversation**.

The widely-cited reading (igorbrigadir annotations, multiple analyses) is that `good_click_v2` is explicitly **a defense against comment-bait / ragebait**: if you click in and bounce quickly, it is *not* counted as positive. The 2-minute floor filters out the "clicked because outraged, left immediately" pattern. Sustained, in-context attention is treated as a (weak) positive; a glance is treated as nothing.

So X's answer to "what disambiguates positive dwell from negative dwell":
1. **Conditioning** — dwell only counts when bundled with a positive action (`good_click`) or a meaningful duration threshold (`good_click_v2`).
2. **Separate negative heads** — the *sign* of an interaction is carried by dedicated report / negative-feedback labels, not inferred from time-on-content.
3. **Down-weighting passive signals** — `video_playback50` at 0.005 shows raw consumption time is intentionally near-zeroed.

Twitter does **not** describe how the weights were chosen; the consensus is they are tuned via A/B testing on downstream user-satisfaction outcomes (per igorbrigadir notes — the release omits the methodology).

---

## 3. The negative-feedback labels & weights to mirror

These are the labels you should replicate in your own capture (verbatim definitions from the README):

- **`report`** (weight **−369**): *"The probability the user will click Report Tweet."* The single largest-magnitude weight in the entire model. In your sensor: capture an explicit **report** action as a near-veto signal.
- **`negative_feedback_v2`** (weight **−74**): *"The probability the user will react negatively (requesting 'show less often' on the Tweet or author, block or mute the Tweet author)."* Note X **bundles** three distinct actions — *"see/show less often" (not interested)*, *block author*, *mute author* — into one head with one weight, even though their real-world consequences differ. For your re-ranker, the cheap, available DOM signals are:
  - **"Not interested in this post" / "Show fewer"** (the caret → menu item)
  - **Mute author**
  - **Block author**
  - **Report**

These map cleanly onto your append-only event schema as distinct negative event types. You can mirror X's bundling (one combined negative head) or keep them separate and learn weights; X chose to bundle the soft ones (see-less/mute/block) and isolate `report` as its own, much larger penalty. A reasonable mirror: `report` ≫ `block` ≈ `mute` ≈ `not-interested`, with report an order of magnitude larger.

**Caveat on exact magnitudes:** the `−369` / `−74` numbers are the *positive*-to-*negative* ratio of probability weights in X's score, tuned for X's scale and candidate set. Do not copy the literal integers into a single-user re-ranker — copy the *structure* (report ≫ soft-negatives ≫ likes; negatives an order of magnitude above positives) and re-tune.

---

## 4. Broader RecSys literature — "engagement ≠ satisfaction" and dwell valence

The dwell-valence problem is old and well-documented. Key references:

- **Yi et al., "Beyond Clicks: Dwell Time for Personalization," RecSys 2014** (Yahoo Labs). First major use of dwell time as a relevance proxy for content recommendation. Critically, they don't use raw dwell: they **normalize dwell across devices/content types and length** because raw time-on-content is confounded by article length, device, and reading speed. This is the canonical "dwell needs normalization / is confounded" citation.
  - PDF: <https://www.hongliangjie.com/publications/recsys2014.pdf>
  - ACM: <https://dl.acm.org/doi/10.1145/2645710.2645724>

- **Covington, Adams, Sargin, "Deep Neural Networks for YouTube Recommendations," RecSys 2016.** YouTube ranks by **expected watch time, not click-through**, with the explicit stated reason that *"ranking by click-through rate often promotes deceptive videos that the user does not complete (clickbait), whereas watch time better captures engagement."* This is the foundational "raw clicks reward clickbait; richer engagement signal is needed" paper — and itself an admission that a single attention proxy still needs care (they use *completion*, not raw seconds).
  - Paper: <https://research.google.com/pubs/archive/45530.pdf>
  - Summary: <https://blog.acolyer.org/2016/09/19/deep-neural-networks-for-youtube-recommendations/>

- **Facebook "Meaningful Social Interactions" reweighting, Jan 2018.** Zuckerberg: *"changing the goal I give our product teams from focusing on helping you find relevant content to helping you have more meaningful social interactions."* FB explicitly **down-ranked passive consumption** (watching video, reading, scrolling) and **penalized engagement-bait** (posts begging for comments/reactions) — an industry-scale acknowledgment that raw engagement/time is not satisfaction and can be gamed. They knowingly accepted reduced total time-on-platform.
  - TechCrunch: <https://techcrunch.com/2018/01/11/facebook-time-well-spent/>

- **Ragebait as the named failure mode.** "Rage bait" was Oxford's Word of the Year 2025 precisely because engagement-optimized feeds reward outrage. The mechanism described in popular and academic coverage is exactly your observation: outrage produces dwell/comments/shares, so engagement metrics *conflate aversion with interest*.
  - Stanford Report: <https://news.stanford.edu/stories/2025/12/rage-bait-explained-oxford-word-year>
  - UCSD Today: <https://today.ucsd.edu/story/why-rage-bait-rose-to-the-top-in-2025>

**Bottom line on novelty:** your dwell-valence insight restates a known field result. Yi 2014 (dwell is confounded, must be normalized), Covington 2016 (clicks/attention proxies reward clickbait), and FB-2018 (passive engagement ≠ meaningful, gets gamed) all predate it; X's `good_click_v2` is a direct productionized fix.

---

## 5. Gotchas to mirror (training-on-own-output, confounders)

- **Don't train on raw dwell as a positive.** Mirror X: dwell only counts conditioned on a positive co-action (a reply / like) or a sustained-attention threshold (≥ N seconds *in an expanded/detail context*, not a scroll-stop). A scroll-stop with no follow-up should be neutral, not positive.
- **Carry sign on dedicated negative labels.** Report / block / mute / not-interested are your *only* reliable sign signals. Weight them an order of magnitude above your positives, as X does.
- **Confounder controls, not rewards.** This matches your own CLAUDE.md invariant: `char_len` / `media_present` are confounder controls. Yi 2014 normalizes dwell by content length for exactly this reason — a long tweet earns more dwell mechanically. Regress dwell on length/media before using it, or it just rewards long posts and image posts.
- **Don't train the ranker on the ranker's output.** X's labels come from *observed user behavior* (reply, report, mute), not from the score the model itself produced — consistent with your invariant. The release does **not** document its position-bias/IPW debiasing for the Heavy Ranker (the open-source drop omits the training-data/debiasing methodology), so there's no X-specific recipe to copy here; lean on your planned IPW debiasing instead.
- **`explore` lane.** Your invariant that every ranker version needs an explore lane is the right complement: behavior-only labels are biased toward what was already shown, and an explore lane both fights filter-bubble and supplies lower-bias training data.

---

## Sources

- X Heavy Ranker README (primary, weights + label defs): <https://raw.githubusercontent.com/twitter/the-algorithm-ml/main/projects/home/recap/README.md> · <https://github.com/twitter/the-algorithm-ml/blob/main/projects/home/recap/README.md>
- Annotated open-source release: <https://github.com/igorbrigadir/awesome-twitter-algo>
- System-design analysis (label defs): <https://vivekbansal.substack.com/p/system-design-study-twitters-recommendation>
- Yi et al. 2014, Beyond Clicks: <https://www.hongliangjie.com/publications/recsys2014.pdf> · <https://dl.acm.org/doi/10.1145/2645710.2645724>
- Covington et al. 2016, YouTube DNN: <https://research.google.com/pubs/archive/45530.pdf> · <https://blog.acolyer.org/2016/09/19/deep-neural-networks-for-youtube-recommendations/>
- Facebook MSI 2018: <https://techcrunch.com/2018/01/11/facebook-time-well-spent/>
- Ragebait / Word of the Year 2025: <https://news.stanford.edu/stories/2025/12/rage-bait-explained-oxford-word-year> · <https://today.ucsd.edu/story/why-rage-bait-rose-to-the-top-in-2025>
