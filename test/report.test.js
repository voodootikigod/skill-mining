import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../src/report.js";

const DATA = {
  repoName: "demo",
  scope: ".",
  date: "2026-06-11",
  headCommit: "abc1234",
  exclusions: [],
  coverage: { filesCount: 42, samplesCount: 7, painTotal: 3, caps: ["churn window: last 500 commits"] },
  candidates: [
    {
      name: "how-tests-run", type: "skill",
      scores: { freq: 5, lev: 4, bsp: 4, stab: 4, ver: 5 },
      decision: "BUILD", objection: "survived: env|port setup is repo-specific",
      evidenceVerified: true, gateADelta: 3, revisitWhen: null,
    },
    {
      name: "react-tips", type: "skill",
      scores: { freq: 4, lev: 3, bsp: 1, stab: 4, ver: 3 },
      decision: "REUSE", objection: "covered by community skill", source: "u/r@1.0.0",
      evidenceVerified: true, gateADelta: 6,
    },
    {
      name: "maybe-later", type: "skill", scores: { freq: 3, lev: 3, bsp: 3, stab: 2, ver: 3 },
      decision: "DEFER", objection: "low stability", revisitWhen: "after the v2 migration lands",
      evidenceVerified: false,
    },
    {
      name: "noise", type: "skill", scores: { freq: 1, lev: 1, bsp: 2, stab: 3, ver: 2 },
      decision: "REJECT", objection: "a competent agent gets this right anyway",
      evidenceVerified: true,
    },
  ],
  skills: [
    {
      name: "how-tests-run", origin: "BUILD", path: ".agents/skills/how-tests-run/",
      source: "this repo @ abc1234", fingerprint: "sha256:deadbeef",
      manifestText: "# how-tests-run — manifest\nSKILL.md   sha256:cafe",
      verification: "**Gate B** @ 2026-06-11: used cold vs \"task\" (real commit abc1234) → SHIP; fixes: none",
      reuseCheckStatus: "reuse-checked: how tests run via npx skills find @ 2026-06-11 → no match",
    },
  ],
  agents: [{ name: "reviewer", loadedSkills: ["how-tests-run"], verification: "**Agent gate** → SHIP" }],
  teamManifest: "| Persona | ... |",
  installHint: "user/demo",
};

test("renderReport contains all required sections and rows", () => {
  const md = renderReport(DATA);

  assert.match(md, /# Skills Mined — `demo`/);
  assert.match(md, /HEAD: `abc1234`/);
  assert.match(md, /Candidates considered: \*\*4\*\*/);
  assert.match(md, /Built: \*\*1\*\* · Reused: \*\*1\*\*.*Rejected: \*\*1\*\* · Deferred: \*\*1\*\*/);
  // REUSE decisions live in the ledger, not in authored skills — the report
  // must surface them with their install source
  assert.match(md, /`react-tips`.*npx skills add u\/r@1\.0\.0/);
  assert.match(md, /## Coverage/);
  assert.match(md, /churn window: last 500 commits/);
  assert.match(md, /\| how-tests-run \| skill \| 5 \| 4 \| 4 \| 4 \| 5 \| 3 \| ✓ \| \*\*BUILD\*\*/);
  assert.match(md, /⚠ unverified/, "unverified evidence is visible in the ledger");
  assert.match(md, /reuse-checked: how tests run/);
  assert.match(md, /## Deferred — next mining pass/);
  assert.match(md, /after the v2 migration lands/);
  assert.match(md, /## Rejected — do not re-mine/);
  assert.match(md, /npx skills add user\/demo/);
  assert.match(md, /`reviewer`.*`how-tests-run`/);
});

test("renderReport escapes pipes/newlines in cells and survives missing fields", () => {
  const md = renderReport({
    ...DATA,
    candidates: [{ name: "x", type: "skill", scores: null, decision: "REJECT", objection: "a|b\nc" }],
    skills: [],
    agents: [],
    teamManifest: null,
    installHint: null,
    headCommit: null,
  });
  assert.match(md, /a\\\|b c/);
  assert.match(md, /npx skills add <user>\/<repo>/);
  assert.doesNotMatch(md, /HEAD:/);
});

test("renderReport notes user-chosen exclusions", () => {
  const md = renderReport({ ...DATA, exclusions: ["agents skipped (--no-agents)"], agents: [] });
  assert.match(md, /Section omitted: agents skipped by user choice/);
});
