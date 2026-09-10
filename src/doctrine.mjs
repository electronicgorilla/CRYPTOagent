// The doctrine.
//
// Derived from a systematic pass over 7 shooting scripts (~339k chars, S1
// E01-E07). These are reasoning rules for this system, written in our own
// words; the bracketed fragments are short attributed quotes marking where each
// rule comes from.
//
// The point is not flavour. Each rule below removes a specific failure mode
// that a naive market model has.

export const RULES = [
  {
    id: "no-magic",
    name: "Refuse the mystical explanation",
    // "There's no such thing as psychic powers." - 1x02; repeated 1x04, 1x07
    rule:
      "Every apparently uncanny read has a mundane mechanism. If a score cannot " +
      "be decomposed into observations that were available at the time, it is not " +
      "insight, it is a number. Do not emit it.",
    enforced_by: "predict.mjs requires a non-empty observation chain; an empty chain returns 'no read'.",
  },
  {
    id: "confident-guess",
    name: "It is an educated guess stated with confidence - and it is still a guess",
    // Lisbon, 1x07: "She simply did what you do so well. With an air of great
    // confidence, she made an educated guess."
    rule:
      "Confidence is presentation; the underlying object is a probability. State " +
      "the call plainly, then attach the honest probability and the expected error " +
      "band. Never let the delivery imply more certainty than the estimate has.",
    enforced_by: "Every forecast carries p_up and an expected-move band; conviction is damped by rank instability.",
  },
  {
    id: "two-explanations",
    name: "An impossible-looking correct call has exactly two mundane explanations",
    // 1x07: "...either she really does have supernatural powers or, she was
    // involved in the crime."
    rule:
      "When something is right more often than inference allows, the answer is " +
      "not that it is gifted. It is either (a) superior inference from signals " +
      "that WERE observable, or (b) information you did not have because the " +
      "source is involved. These have opposite trading implications: (a) is worth " +
      "following, (b) means you are the exit liquidity.",
    enforced_by: "classifyEdgeSource() below, applied to every channel and agent in the ledger.",
  },
  {
    id: "provoke",
    name: "Create the tell; do not wait for one",
    // 1x03: "Jane lets that hang, forcing Kurtik to step toward him, or risk
    // appearing to back off."
    rule:
      "Passive observation is slow and the market will not volunteer its intentions. " +
      "Commit to a falsifiable, time-boxed claim BEFORE being asked; the market's " +
      "answer is the data you could not otherwise obtain.",
    enforced_by: "Percentile verdicts force a directional call each scan; the ledger grades it.",
  },
  {
    id: "keen-but-casual",
    name: "Keen but casual",
    // 1x02 stage direction: "looking around in that keen but casual way of his."
    rule:
      "Observe everything cheaply and continuously; spend expensive attention only " +
      "where something has already twitched. Exhaustive analysis of every candidate " +
      "is how you run out of budget before the one that mattered.",
    enforced_by: "Free deterministic scan over the full cohort; the paid agent panel runs only past the promotion gate.",
  },
  {
    id: "read-the-mark",
    name: "Read what people want, not what is true",
    // He was a con man before he was a consultant - the framing recurs across 6 of 7 scripts.
    rule:
      "A memecoin is a confidence game with a self-selecting mark. The question is " +
      "never 'is this a good asset' - it is 'what does the crowd currently want to " +
      "believe, and how much of that belief is already spent'.",
    enforced_by: "fomo.mjs - inverted-U attention saturation, second-chance detection, cohort share.",
  },
  {
    id: "play-me",
    name: "Demonstrate, do not assert",
    // 1x02: challenged on whether he has powers, he says "Play me" - and wins
    // at rock-paper-scissors. The claim is settled by a scored trial, not argument.
    rule:
      "Credibility comes from a public track record, not from the tone of the " +
      "analysis. Any component that cannot be scored does not belong on the dashboard.",
    enforced_by: "ledger.mjs + grader.mjs + scorecard.mjs; every agent competes against baseline_rules.",
  },
];

/** Compact form injected into agent system prompts. */
export function promptFragment() {
  return [
    "REASONING DOCTRINE (binding):",
    ...RULES.map((r, i) => `${i + 1}. ${r.name}. ${r.rule}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rule 3, operationalised.
//
// This is the part that pays for the whole file. When a Telegram channel is
// right more often than chance, the naive response is to follow it harder. The
// correct response is to ask WHICH of the two explanations applies, because
// they point in opposite directions.
//
// The discriminator is available in the data we already store: the feature
// vector AT THE MOMENT OF THE CALL. If the observable signals (volume
// acceleration, transaction velocity, price move) were already elevated when
// the call landed, the caller was reading the same tape we read - that is
// inference, and it is followable. If those signals were flat and the token
// moved anyway, the caller knew something that was not in the tape.
//
// A third case matters in this market specifically: a large channel can CAUSE
// the move it predicted. That is neither inference nor inside information - it
// is reflexivity, and it is tradeable but only if you are fast enough to be
// early in the move the channel itself creates.
const SIGNAL_KEYS = ["volumeAccel", "txnVelocity", "priceH1", "priceM5"];

export function classifyEdgeSource(rows, { minCalls = 8, moveThreshold = 20 } = {}) {
  const graded = rows.filter((r) => r.outcome && r.features);
  if (graded.length < minCalls) {
    return { verdict: "insufficient-data", n: graded.length, need: minCalls };
  }

  // "Winners" = calls that were followed by a real move in the called direction.
  const winners = graded.filter((r) => {
    const move = r.outcome.return_pct;
    return r.predicted_direction === "up" ? move >= moveThreshold : move <= -moveThreshold;
  });
  if (!winners.length) {
    return { verdict: "no-edge", n: graded.length, winners: 0 };
  }

  // Was the tape already moving when they called it?
  const visibility = winners.map((r) => {
    const f = r.features;
    const vals = SIGNAL_KEYS.map((k) => f[k]).filter((v) => typeof v === "number");
    if (!vals.length) return null;
    // priceH1/priceM5 are centred on 0.5; volumeAccel/txnVelocity start at 0.
    const norm = [
      f.volumeAccel ?? 0,
      f.txnVelocity ?? 0,
      Math.max(0, (f.priceH1 ?? 0.5) - 0.5) * 2,
      Math.max(0, (f.priceM5 ?? 0.5) - 0.5) * 2,
    ];
    return norm.reduce((a, b) => a + b, 0) / norm.length;
  }).filter((v) => v != null);

  const meanVisibility = visibility.reduce((a, b) => a + b, 0) / (visibility.length || 1);
  const blindCalls = visibility.filter((v) => v < 0.15).length;
  const blindShare = blindCalls / (visibility.length || 1);

  let verdict, note;
  if (blindShare >= 0.6) {
    verdict = "insider-suspected";
    note =
      `${Math.round(blindShare * 100)}% of winning calls landed while the observable tape was flat. ` +
      "Either they move it themselves or they knew first. Following this late means being exit liquidity.";
  } else if (meanVisibility >= 0.4) {
    verdict = "inference";
    note =
      "Winning calls consistently landed while the signals were ALREADY visible. " +
      "This source is reading the same tape you can read - followable, and reproducible without them.";
  } else {
    verdict = "mixed";
    note = "Neither cleanly early nor cleanly late. Needs more graded calls to separate.";
  }

  return {
    verdict,
    note,
    n: graded.length,
    winners: winners.length,
    mean_visibility: Math.round(meanVisibility * 1000) / 1000,
    blind_share: Math.round(blindShare * 1000) / 1000,
  };
}

/** Apply the classifier to every tg:* agent in the ledger. */
export function channelEdgeSources(ledgerRows) {
  const byAgent = {};
  for (const r of ledgerRows) {
    if (!r.agent?.startsWith("tg:")) continue;
    (byAgent[r.agent] ||= []).push(r);
  }
  return Object.fromEntries(
    Object.entries(byAgent).map(([a, rs]) => [a.slice(3), classifyEdgeSource(rs)])
  );
}
