// ANSI Escape code helpers for terminal styling without external packages
export const colors = {
  reset: (text) => `${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  red: (text) => `\x1b[31m${text}\x1b[39m`,
  green: (text) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text) => `\x1b[33m${text}\x1b[39m`,
  blue: (text) => `\x1b[34m${text}\x1b[39m`,
  magenta: (text) => `\x1b[35m${text}\x1b[39m`,
  cyan: (text) => `\x1b[36m${text}\x1b[39m`,
  gray: (text) => `\x1b[90m${text}\x1b[39m`,
};

// Help text to display when requested
export const HELP_TEXT = `
${colors.bold("SKILL MINING CLI v1.6.1")}
Point an agent at a codebase, extract latent skills and agents as durable artifacts.

${colors.bold("Usage:")}
  npx skill-mining mine [path-or-scope] [options]
  (or: npx mine [path-or-scope] [options], npx mine-skills [path-or-scope] [options])

${colors.bold("Options:")}
  --no-agents, --skills-only    Skip Phase 6 entirely. Mine skills + report only.
  --no-team                     Build agent personas, but standalone — no team manifest.
  --agents-only                 Skip skills; (re)compose agents + team from existing report.
  --report-only                 Re-emit SKILLS_MINED.md from prior results; author nothing.
  --offline                     Run in offline mode (allow search failures without failing closed).
  --provider <name>             Force LLM provider: gemini | openai | anthropic.
  --model <name>                Force one LLM model for every phase (sets both tiers).
  --model-strong <name>         Model for judgment-heavy phases (Detect, Gates, Author, Compose).
  --model-fast <name>           Model for mechanical phases (Score, Dedupe decision, manifest).
  --gate-model <name>           Separate model for adversarial Gates A/B (cross-model independence).
  -h, --help                    Show this help message.

${colors.bold("Environment Variables:")}
  ANTHROPIC_API_KEY             Required if using Anthropic provider (default).
  GEMINI_API_KEY                Required if using Gemini provider.
  OPENAI_API_KEY                Required if using OpenAI provider.
`;

// Simple argument parser
export function parseArgs(argv) {
  const args = {
    command: null,
    target: ".",
    noAgents: false,
    noTeam: false,
    agentsOnly: false,
    reportOnly: false,
    offline: false,
    provider: null,
    model: null,
    modelStrong: null,
    modelFast: null,
    gateModel: null,
    help: false,
  };

  const positional = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--no-agents" || arg === "--skills-only") {
      args.noAgents = true;
    } else if (arg === "--no-team") {
      args.noTeam = true;
    } else if (arg === "--agents-only") {
      args.agentsOnly = true;
    } else if (arg === "--report-only") {
      args.reportOnly = true;
    } else if (arg === "--offline") {
      args.offline = true;
    } else if (arg === "--provider") {
      args.provider = argv[++i];
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg === "--model-strong") {
      args.modelStrong = argv[++i];
    } else if (arg === "--model-fast") {
      args.modelFast = argv[++i];
    } else if (arg === "--gate-model") {
      args.gateModel = argv[++i];
    } else if (arg.startsWith("--provider=")) {
      args.provider = arg.split("=")[1];
    } else if (arg.startsWith("--model=")) {
      args.model = arg.split("=")[1];
    } else if (arg.startsWith("--model-strong=")) {
      args.modelStrong = arg.split("=")[1];
    } else if (arg.startsWith("--model-fast=")) {
      args.modelFast = arg.split("=")[1];
    } else if (arg.startsWith("--gate-model=")) {
      args.gateModel = arg.split("=")[1];
    } else if (arg.startsWith("-")) {
      // Unknown option
      console.warn(colors.yellow(`Warning: Unknown option "${arg}"`));
    } else {
      positional.push(arg);
    }
  }

  // Check if first positional is a known command
  if (positional.length > 0 && (positional[0] === "mine" || positional[0] === "mine-skills")) {
    args.command = positional.shift();
  }

  if (positional.length > 0) {
    args.target = positional[0];
  }

  // Precedence rules
  if (args.noAgents) {
    args.noTeam = true;
  }

  return args;
}

// The only decisions a candidate may carry. Any LLM-produced decision string
// is validated against this — an unrecognized token (case drift, "Build",
// "REUSED") otherwise flows downstream and silently vanishes at authoring.
export const VALID_DECISIONS = new Set(["BUILD", "REUSE", "EXTEND", "REJECT", "DEFER"]);

// A package reference safe to interpolate into a copy-paste `npx skills add`
// command. `source` comes from LLM output over untrusted repo content, so it
// must be charset-validated before it reaches a runnable instruction.
const PACKAGE_REF_RE = /^[\w.-]+\/[\w.-]+(@[\w.:/-]+)?$/;

export function isSafePackageRef(source) {
  return typeof source === "string" && PACKAGE_REF_RE.test(source.trim());
}

// Custom log helpers for premium console output
export const log = {
  info: (msg) => console.log(`${colors.blue("ℹ")} ${msg}`),
  success: (msg) => console.log(`${colors.green("✔")} ${msg}`),
  warn: (msg) => console.warn(`${colors.yellow("⚠")} ${msg}`),
  error: (msg) => console.error(`${colors.red("✖")} ${msg}`),
  phase: (num, name) => {
    console.log();
    console.log(colors.bold(colors.cyan(`=== Phase ${num}: ${name} ===`)));
  },
  gate: (letter, name) => {
    console.log();
    console.log(colors.bold(colors.magenta(`=== ⟂ Gate ${letter}: ${name} (Adversarial) ===`)));
  },
  step: (msg) => console.log(`  ${colors.dim("▪")} ${msg}`),
  substep: (msg) => console.log(`    ${colors.gray("↳")} ${msg}`),
  errorTrace: (err) => {
    console.error(colors.red(err.stack || err.message || err));
  }
};
