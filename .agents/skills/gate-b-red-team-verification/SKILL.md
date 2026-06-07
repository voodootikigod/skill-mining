I will start by list-directoring the workspace directory to understand the layout and locate the referenced files.
I will list the contents of the `skill-mining` directory to find the reference files.
I will list the files in the `skill-mining/references` directory.
I will read `skill-mining/references/adversarial-review.md` to understand the Gate B cold trial protocols and verification processes.
I will search for the relevant code in `src/` to see how Gate B / Red-team is implemented or executed.
I will list files in `src/` to see what modules/phases exist in the codebase.
I will read lines 190 to 250 of `src/phases.js` to see the exact context of Gate B or red team implementation.
I will search `src/phases.js` for "Gate B" or "red-team" to find how Gate B verification is run in the codebase.
I will read the source code around Gate B implementation in `src/phases.js` to see how it operates.
I will read the rest of the Gate B execution code in `src/phases.js` (lines 490-530) to see the details of how the FIX verdict is handled.
I will view the `skill-mining/SKILL.md` file to see a representative example of a well-formed SKILL.md in this repository.
I will view `package.json` to see the available scripts and dependencies in the repository.
I will view `bin/cli.js` to see how the cli is structured and how commands are invoked.
I will view the rest of `bin/cli.js` to see the full execution flow.
I will view `src/utils.js` to check the parsing of command line arguments and options.
I will run a grep search for "test" or "run" or "verify" to see if there are built-in test utilities or routines.
I will view `src/llm.js` to see how it manages API keys and providers.
---
name: gate-b-red-team-verification
description: >-
  Use when validating newly mined or authored SKILL.md files in the skill-mining repository using cold trials to catch ambiguous steps, broken commands, or missing paths before writing to .agents/skills/ and shipping.
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
  source: mined from skill-mining
  evidence: skill-mining/references/adversarial-review.md (lines 57-89), src/phases.js (lines 424-521)
---

# Gate B Red-Team Verification

**Gate B Red-Team Verification** is the adversarial quality-assurance process that protects the utility and correctness of mined skills. In the [skill-mining](file://./) framework, authored skills are saved under the `.agents/skills/` directory and tracked in the central [SKILLS_MINED.md](file://./SKILLS_MINED.md) report. Gate B prevents the accumulation of vague, incorrect, or unusable skills by forcing a cold trial: a fresh-context agent must execute a real test task using only the authored skill instructions, revealing any assumptions, undocumented requirements, or broken commands.

## When to use

- "Red-team this new SKILL.md file."
- "Validate the authored skill files using a Gate B cold trial."
- Challenging and correcting ambiguous steps or invalid paths before updating [SKILLS_MINED.md](file://./SKILLS_MINED.md).
- Running automated CLI verification to process all newly mined skills.
- Performing manual verification of custom-built skills using a clean subagent session.

## The procedure

### Option 1: Automated Verification via CLI
The [cli.js](file://./bin/cli.js) runner executes Gate B automatically during a full mining loop via [runGateB](file://./src/phases.js#L426).
1. Set the appropriate API key environment variable (e.g., `export GEMINI_API_KEY="your-api-key"`).
2. Execute the CLI from the workspace root directory:
   ```bash
   node bin/cli.js .
   ```
3. Monitor the CLI output during Phase 5 (Author) and Gate B verification. The CLI will:
   - Formulate a test task description.
   - Run the cold-loaded reviewer model.
   - Apply automated corrections if the verdict is `FIX` or skip the skill if `REJECT`.
4. Open the generated [SKILLS_MINED.md](file://./SKILLS_MINED.md) file to verify the logged status under the verified skills listing.

### Option 2: Manual Cold-Trial Execution
To manually verify an authored `SKILL.md` (e.g., at `.agents/skills/my-skill/SKILL.md`):
1. Identify the newly written skill markdown and its companion files under the skill's subfolder.
2. Devise a concrete, 1-sentence test task that represents a real change or operation covered by the skill.
3. Spawn a clean-context subagent using the `invoke_subagent` tool. Set the `Workspace` mode parameter to `'branch'` or `'share'` to ensure context isolation and prevent access to the codebase survey results or proposer chat history.
4. Provide the target files required by the test task (such as [phases.js](file://./src/phases.js) or [adversarial-review.md](file://./skill-mining/references/adversarial-review.md)) to the subagent alongside the skill file, and prompt the agent with the following red-team prompt:
   ```
   You have ONLY the attached SKILL.md and target files. Use them to complete this task: <real test task>.
   Do not use outside knowledge of the repo. Report: every step that was ambiguous or wrong, every command/path that failed or was missing, and whether the skill's verification step actually let you confirm success. Verdict: SHIP / FIX (list the edits) / REJECT (skill is not meaningful).
   ```
5. Based on the subagent's response:
   - **SHIP**: Accept the file as-is and log the verification details.
   - **FIX**: Open the target `SKILL.md` and modify the instructions or paths to address the objections. Run the cold trial again with the updated text.
   - **REJECT**: Delete the candidate skill directory.

## Conventions / rules

- **Reviewer Independence**: Never let the author agent review its own work in the same session. The reviewer must be cold-loaded (no survey metadata, no prior reasoning) to ensure it does not lean on implicit context that lives in its head instead of the file.
- **Executable Verification**: The `## Verification` section of the skill must not be empty or vague. It must contain a real command (e.g., `node bin/cli.js --help` or checking a specific file state) that can be run to prove correctness.
- **Accurate Paths and Commands**: Every path listed in the skill (such as [package.json](file://./package.json)) and every command (such as `node bin/cli.js`) must be validated against the actual repository files.
- **Document Verification Metadata**: Every verified skill must carry verification evidence. For example, after validation, log the verdict, task, and timestamp in [SKILLS_MINED.md](file://./SKILLS_MINED.md) (e.g., `**Gate B** @ YYYY-MM-DD: used cold vs "<task>" → SHIP`).

## Verification

To verify that Gate B red-team verification was applied successfully:
1. Run the CLI in verification mode (partial mode) to validate all installed skills, their fingerprints, and their policies on disk:
   ```bash
   node bin/cli.js . --report-only
   ```
   The output must show successful verification (e.g., `All existing skills verified successfully (fingerprints + policies).`).
2. Verify that each active skill file (e.g., `.agents/skills/<name>/SKILL.md`) has a valid, detailed, and actionable `## Verification` section.
3. Confirm that the central report [SKILLS_MINED.md](file://./SKILLS_MINED.md) contains the Gate B verification metadata:
   ```bash
   grep -i "Gate B" SKILLS_MINED.md
   ```
   The output must list the cold trial task and its final verdict (e.g., `→ SHIP`).

## References

- [Adversarial Review Reference](file://./skill-mining/references/adversarial-review.md)
- [Phases Implementation](file://./src/phases.js)