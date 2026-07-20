import { test } from "node:test";
import assert from "node:assert/strict";
import { groundSkillArtifact } from "../src/grounding.js";

const survey = {
  allPaths: [
    "src/app.js",
    "src/utils/helpers.js",
    "test/app.test.js",
    "package.json",
  ],
  configs: {
    "package.json": JSON.stringify({
      name: "demo",
      scripts: { test: "node --test", build: "tsc -p ." },
    }),
  },
};

const skill = (body) => `---
name: demo-skill
description: >-
  Use when doing demo things in this repo.
---

${body}
`;

test("clean skill citing real paths and real scripts produces no defects", () => {
  const defects = groundSkillArtifact(
    skill("Edit `src/app.js` and `src/utils/helpers.js`, then run `npm run test` and `npm run build`."),
    survey
  );
  assert.deepEqual(defects, []);
});

test("fabricated path is flagged", () => {
  const defects = groundSkillArtifact(skill("Start from `src/ghost.js`."), survey);
  assert.equal(defects.length, 1);
  assert.equal(defects[0], "cited path src/ghost.js does not exist in the repo");
});

test("directory prefixes of real paths count as existing", () => {
  const defects = groundSkillArtifact(skill("Utilities live under `src/utils` in this repo, e.g. src/utils/helpers.js."), survey);
  assert.deepEqual(defects, []);
});

test("npm-script mismatch is flagged with the real script list", () => {
  const defects = groundSkillArtifact(skill("Run `npm run test:integration` before merging."), survey);
  assert.equal(defects.length, 1);
  assert.equal(
    defects[0],
    'command "npm run test:integration" references a script not in package.json (real scripts: test, build)'
  );
});

test("bare pnpm/yarn script invocations are checked, builtins are not", () => {
  const defects = groundSkillArtifact(
    skill("Run `pnpm install`, then `yarn lint` and `pnpm build`."),
    survey
  );
  // install is a package-manager builtin; lint is a missing script; build exists
  assert.equal(defects.length, 1);
  assert.match(defects[0], /command "yarn lint" references a script not in package\.json/);
});

test("unparseable (truncated) package.json skips script checks silently, keeps path checks", () => {
  const truncated = {
    allPaths: survey.allPaths,
    configs: { "package.json": '{"name": "demo", "scripts": {"test": "node --te' },
  };
  const defects = groundSkillArtifact(
    skill("Run `npm run definitely-not-a-script` after editing src/ghost.js."),
    truncated
  );
  assert.deepEqual(defects, ["cited path src/ghost.js does not exist in the repo"]);
});

test("frontmatter content is not grounded — only the body", () => {
  const md = `---
name: demo-skill
description: >-
  Use when working near src/never-existed.js in this repo.
---

Run \`npm run test\` from the repo root.
`;
  assert.deepEqual(groundSkillArtifact(md, survey), []);
});

test("mining-run output artifacts are not treated as fabricated paths", () => {
  const defects = groundSkillArtifact(
    skill("This ships as SKILL.md under .agents/skills/demo-skill/ and is listed in SKILLS_MINED.md."),
    survey
  );
  assert.deepEqual(defects, []);
});

test("trailing sentence punctuation is not part of a script name", () => {
  const defects = groundSkillArtifact(skill("Verify everything by running via npm run test."), survey);
  assert.deepEqual(defects, []);
});

test("prose mentioning pnpm/yarn outside code context is never flagged", () => {
  const defects = groundSkillArtifact(
    skill("This repo uses pnpm and manages deps with pnpm workspaces; prefer pnpm over npm. Install dependencies with pnpm or npm; pnpm and yarn are both supported."),
    survey
  );
  assert.deepEqual(defects, []);
});

test("bare pnpm/yarn invocations inside code fences are still checked", () => {
  const defects = groundSkillArtifact(
    skill("Setup:\n\n```bash\npnpm install\nyarn lint\n```\n"),
    survey
  );
  assert.equal(defects.length, 1);
  assert.match(defects[0], /command "yarn lint" references a script not in package\.json/);
});

test("a line ending in pnpm/yarn never chains onto the next line's command", () => {
  // \s+ in the invocation regex used to capture "pnpm\npnpm" as a fabricated
  // script name AND consume the next line's real command unchecked.
  const defects = groundSkillArtifact(
    skill("Setup:\n\n```bash\ncorepack enable pnpm\npnpm install\n```\n"),
    survey
  );
  assert.deepEqual(defects, []);
});

test("the command after a pm-name line ending is still checked on its own line", () => {
  const defects = groundSkillArtifact(
    skill("Setup:\n\n```bash\ncorepack enable pnpm\npnpm ghost-script\n```\n"),
    survey
  );
  assert.equal(defects.length, 1);
  assert.match(defects[0], /command "pnpm ghost-script" references a script not in package\.json/);
});

test("bare invocations of dependency-provided binaries are not missing-script defects", () => {
  // pnpm and yarn-classic fall back to node_modules/.bin for non-builtin,
  // non-script words — `pnpm tsc` is legitimate with typescript installed.
  const depSurvey = {
    allPaths: survey.allPaths,
    configs: {
      "package.json": JSON.stringify({
        name: "demo",
        scripts: { test: "node --test" },
        devDependencies: { typescript: "^5.0.0", vitest: "^2.0.0" },
      }),
    },
  };
  const defects = groundSkillArtifact(
    skill("Check types:\n\n```bash\npnpm tsc --noEmit\nyarn vitest run\n```\n"),
    depSurvey
  );
  assert.deepEqual(defects, []);
  // ...while a word matching neither a script nor a dependency still flags
  const flagged = groundSkillArtifact(skill("Run `yarn lint` before merging."), depSurvey);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /command "yarn lint" references a script not in package\.json/);
});

test("glob patterns do not leak fabricated path fragments", () => {
  const defects = groundSkillArtifact(skill("Test files match src/**/*.test.js in this repo."), survey);
  assert.deepEqual(defects, []);
});

test("npm package specifiers are not treated as repo paths", () => {
  const defects = groundSkillArtifact(
    skill("Install @anthropic-ai/sdk and import from react-dom/client."),
    survey
  );
  assert.deepEqual(defects, []);
});

test("never throws on garbage input", () => {
  assert.deepEqual(groundSkillArtifact(null, null), []);
  assert.deepEqual(groundSkillArtifact(undefined, undefined), []);
  assert.deepEqual(groundSkillArtifact(12345, {}), []);
  assert.deepEqual(groundSkillArtifact("plain text with src/ghost.js", { allPaths: "not-an-array" }), []);
  assert.deepEqual(groundSkillArtifact(skill("npm run x"), { allPaths: [], configs: { "package.json": 42 } }), []);
  assert.deepEqual(groundSkillArtifact({}, { allPaths: null, configs: null }), []);
});

test("missing allPaths disables path checks rather than flagging everything", () => {
  const defects = groundSkillArtifact(skill("Edit src/ghost.js."), { configs: survey.configs });
  assert.deepEqual(defects, []);
});
