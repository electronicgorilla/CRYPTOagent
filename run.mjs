#!/usr/bin/env node
// degen-radar entrypoint.
//   node run.mjs serve      # start the dashboard (default)
//   node run.mjs scan       # one scan, print the leaderboard
//   node run.mjs loop       # scan forever on config interval
//   node run.mjs grade      # grade any due predictions now (free)
//   node run.mjs scorecard  # print agent track records
import { loadConfig, loadEnv } from "./src/config.mjs";
loadEnv();

const cmd = process.argv[2] || "serve";
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const rpad = (s, n) => String(s).padStart(n);

if (cmd === "serve") {
  const { main } = await import("./src/server.mjs");
  main();
} else if (cmd === "scan") {
  const { runScan } = await import("./src/pipeline.mjs");
  const res = await runScan({ cfg: loadConfig() });
  console.log(
    `\n ${pad("SYM", 12)} ${rpad("COMP", 6)} ${rpad("ATT", 5)} ${rpad("MOM", 5)} ` +
    `${rpad("LIQ", 5)} ${rpad("RISK", 5)}  ${pad("VERDICT", 8)} ${pad("PANEL", 8)} PHASE`
  );
  for (const r of res.tokens.slice(0, 25)) {
    const { score: s, feat: f, advice: a, panel } = r;
    const arb = panel?.agents?.arbiter;
    console.log(
      ` ${pad(f.symbol || "?", 12)} ${rpad(s.composite.toFixed(1), 6)} ` +
      `${rpad(s.attention.toFixed(0), 5)} ${rpad(s.momentum.toFixed(0), 5)} ` +
      `${rpad(s.liquidityHealth.toFixed(0), 5)} ${rpad(s.risk.toFixed(0), 5)}  ` +
      `${pad(s.verdict, 8)} ${pad(arb?.call ? `${arb.call}/${arb.conviction}` : "-", 8)} ${a.phase}`
    );
  }
  console.log(`\n graded: ${res.graded?.graded ?? 0} | agents: ${res.agents?.ran ? `${res.agents.analysed} analysed, $${res.agents.spend}` : res.agents?.reason}`);
} else if (cmd === "loop") {
  const { loop } = await import("./src/pipeline.mjs");
  await loop(loadConfig());
} else if (cmd === "grade") {
  const { gradeDue } = await import("./src/grader.mjs");
  console.log(await gradeDue());
} else if (cmd === "scorecard") {
  const sc = (await import("./src/scorecard.mjs")).build();
  console.log(`\n predictions ${sc.totals.predictions} | graded ${sc.totals.graded} | open ${sc.totals.open} | spend $${sc.totals.spend_usd}\n`);
  console.log(` ${pad("AGENT", 16)} ${rpad("GRADED", 7)} ${rpad("HIT", 6)} ${rpad("BRIER", 6)} ${rpad("LONG EV%", 9)}  STATUS`);
  for (const [id, a] of Object.entries(sc.agents)) {
    console.log(
      ` ${pad(id, 16)} ${rpad(a.n_graded, 7)} ${rpad(a.hit_rate ?? "-", 6)} ` +
      `${rpad(a.brier ?? "-", 6)} ${rpad(a.longs?.expectancy_pct ?? "-", 9)}  ` +
      `${a.n_graded ? (a.unproven ? "unproven (<10)" : "proven") : "no track record"}`
    );
  }
  if (Object.keys(sc.vs_baseline).length) {
    console.log("\n vs baseline_rules (the free deterministic score):");
    for (const [id, v] of Object.entries(sc.vs_baseline))
      console.log(`   ${pad(id, 16)} ${v.beats_baseline ? "BEATS" : "loses to"} baseline by ${(v.hit_rate_delta * 100).toFixed(1)}pp${v.proven ? "" : " (unproven)"}`);
  }
} else {
  console.log("usage: node run.mjs [serve|scan|loop|grade|scorecard]");
  process.exit(1);
}
