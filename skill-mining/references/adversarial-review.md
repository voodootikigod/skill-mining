# Adversarial Review

Skill mining produces two things worth attacking before you trust them: the
**decision** about what to build vs. reuse, and the **artifact** (the authored
`SKILL.md`). Left unchallenged, both drift toward a predictable bias — the loop
*wants* to build clever, bespoke skills, and an author *wants* to believe the
skill it just wrote is good. Adversarial review is the counterweight.

This file defines the mechanic and the three insertion points.

## The one rule that makes it work: independence

A reviewer that shares the proposer's context will rubber-stamp. Every
adversarial pass must be **independent**:

- **Fresh context.** Spawn a separate agent/subagent. Do not let it inherit the
  reasoning that produced the thing it's reviewing.
- **Refute by default.** Prompt it to *disprove*, not to "check." Its job is to
  kill weak candidates and expose weak skills, not to validate.
- **Burden of proof on the positive.** The default verdict is REJECT / REUSE /
  "skill is inadequate." The proposer's evidence has to overcome that.
- **Resolve, don't average.** On disagreement, the skeptic's objection stands
  until the proposer answers it with specific evidence. For high-stakes calls,
  use 3 independent skeptics with any-REJECT veto and a 2-of-3 majority for
  build-like verdicts (see the Gate A voting rules below).

If your harness has parallel subagents, run the skeptics concurrently. If not,
run the review in a fresh session/turn so it can't see the proposer's chain.

## Gate A — Challenge the decision (between Score and Dedupe)

**Catches:** inflated scores, vanity skills, missed reuse. **Protects:** accuracy
of result.

For each surviving candidate, an independent skeptic re-examines it and must be
*convinced to allow a BUILD*. Default verdict is REUSE or REJECT.

**Blind re-score — never show the skeptic the proposer's scores.** A skeptic who
sees the proposer's numbers anchors on them and merely nudges; one who re-derives
from raw evidence actually re-scores. Hand it only: name, description, evidence,
the deterministic evidence-verification flag, and the *real* ecosystem search
output (run the reuse search **before** Gate A so bespokeness is attacked with
search results, not model memory). Record the proposer-vs-skeptic score delta in
the report — a high delta is signal.

Skeptic prompt shape:

```
You are reviewing a proposed skill candidate. Default position: this should be
REUSED from the ecosystem or REJECTED, not built. Try to refute the case for
building it. Specifically attack:
  1. RECURRENCE — is the evidence real? Did it actually recur, or appear twice?
     Show the proof or downgrade Frequency.
  2. BESPOKENESS — name a maintained public skill (find-skills / skills.sh) that
     plausibly covers this. If one exists, the verdict is REUSE/EXTEND.
  3. LEVERAGE — would a competent agent get this right anyway? If yes, downgrade.
  4. STABILITY — will this be wrong in a month? If yes, defer or point at source.
Return: revised scores, a verdict (BUILD only if you could not refute it), and
the single strongest objection.
```

Only candidates that survive the challenge proceed to Author. Record the
skeptic's revised scores and objection in the report — the disagreement is signal.

**Voting rules (as implemented).** Every BUILD/EXTEND candidate first passes
through a **single batch skeptic** — one blind re-score covering the whole list.
Then a deterministic risk keyword check (security / auth / secrets / tokens /
credentials, deploy / release / publish, payments / billing / money,
migrations, prod / infra) flags the safety-, security-, or money-relevant
candidates; the routing itself uses no LLM. Each flagged candidate still
standing at BUILD/EXTEND gets **two additional independent skeptics** on the
exact same blind payload. The three verdicts combine as:

- **Any REJECT is a veto** — the candidate is rejected, with the vetoing
  objection recorded.
- **BUILD/EXTEND stands only with a 2-of-3 build-like majority.**
- **Any other split defers** — no build majority means DEFER, with a
  revisit-when condition.
- An extra skeptic whose response can't be parsed counts as a **DEFER vote** —
  a failed reviewer is caution, never a free pass.

## Gate B — Red-team the artifact (after Author, before Compose)

**Catches:** generic, vague, wrong, or unverifiable skills. **Protects:**
meaningfulness of the resulting skill.

This is stronger than a self dry-run, because the author can't lean on knowledge
that lives in its head instead of in the file.

Protocol:

1. **Cold load.** Give a fresh-context agent *only* the authored `SKILL.md` (and
   its references) — not the mining survey, not the proposer's reasoning.
2. **Use it for real.** Hand it a real recent task or diff from the repo and tell
   it to complete the task *using only the skill*.
3. **Report defects.** It flags every place the skill was ambiguous, sent it to
   the wrong path/command, assumed unstated knowledge, or couldn't be verified.
4. **Adversarial framing:** "Assume the skill is inadequate. Find the cases where
   following it literally produces a wrong or unverifiable result."

Red-team prompt shape:

```
You have ONLY the attached SKILL.md. Use it to complete this task: <real task>.
Do not use outside knowledge of the repo. Report: every step that was ambiguous
or wrong, every command/path that failed or was missing, and whether the skill's
verification step actually let you confirm success. Verdict: SHIP / FIX (list the
edits) / REJECT (skill is not meaningful).
```

FIX findings feed back into Author — **and the fixed artifact is re-red-teamed.**
A FIX verdict is never terminal: loop fix → re-review, bounded at 2 fix rounds.
**No fix is applied on the final round** — an edit that can't be re-reviewed
would ship unverified, so a FIX verdict there ends the loop instead. A skill
that cannot reach SHIP within the budget is REJECTED, not shipped with "FIX"
recorded as its verification. Ground the reviewer: pick the test task from a
*real recent commit* (not from the skill text — that's circular), and give it
the repo's real directory shape and script names as ground truth *for
fact-checking only*, so wrong paths/commands are detectable defects rather than
invisible ones. Before **every** round, a deterministic grounding pre-check (no
LLM) re-verifies each path and npm script the current artifact cites against
the survey and hands the confirmed defects to the reviewer. The fixer sees the
same facts the reviewer had — the test task, the repo ground truth, and the
grounding findings — so path/command defects get fixed against reality instead
of guessed at.

**Composed agents get the same treatment.** An agent definition that no gate ever
read is an unverified artifact: cold-load each one ("could you operate this role
from the definition alone?"), one fix round, drop non-SHIP agents.

## Completeness critic (at Detect — lightweight)

**Catches:** missed seams. **Protects:** coverage.

After Detect produces the candidate list, one cheap pass asks the inverse
question: *what high-leverage knowledge in this repo did the sweep miss?* Point it
at `candidate-taxonomy.md` and the hotspot/churn data and have it name categories
or subsystems with no candidate. Anything it surfaces re-enters at Detect.

```
Here is the candidate list and the repo's churn/hotspot map. Assume the list is
incomplete. Name the highest-leverage recurring knowledge that is NOT represented
— especially in build/test ops, domain invariants, and review checklists.
```

## Cost discipline

Adversarial review is not free. Scale it to stakes:

- **Always** run Gate A on BUILD candidates and Gate B on every built skill —
  these are the irreversible-ish outputs.
- Use a **single** batch skeptic for ordinary skills; escalate to **3 +
  majority/veto** only for safety-, security-, or money-relevant candidates.
  The CLI routes these with a deterministic risk keyword check, so the
  escalation decision itself costs no tokens.
- Skip adversarial review on REUSE/REJECT candidates already settled by Gate A —
  don't re-litigate.
