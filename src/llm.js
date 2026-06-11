import { execSync, execFileSync } from "child_process";
import { log } from "./utils.js";

// Helper to clean JSON responses, robustly extracting JSON even if wrapped in text or markdown code blocks
export function cleanJsonResponse(text) {
  let cleaned = text.trim();

  // Find first '{' or '[' and last '}' or ']' to extract JSON if there's surrounding text
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = cleaned.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = cleaned.lastIndexOf("]");
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  // Strip markdown code block markers
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

// Check if a shell command is installed and executable. `command -v` is a
// shell builtin, so a shell is unavoidable here — restrict the name to a safe
// charset since it can come from the user's --provider flag.
function isCmdInstalled(cmd) {
  if (!/^[\w.-]+$/.test(cmd)) {
    return false;
  }
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

// Default models per provider, two cost tiers.
// "strong" runs the judgment-heavy phases (Detect, Gate A/B, Author, Compose);
// "fast" runs the mechanical phases (Score, Dedupe decision, team manifest).
const DEFAULT_MODELS = {
  anthropic: { strong: "claude-sonnet-4-6", fast: "claude-haiku-4-5" },
  openai: { strong: "gpt-4o", fast: "gpt-4o-mini" },
  gemini: { strong: "gemini-2.5-pro", fast: "gemini-2.5-flash" },
};

// Output budget for API providers. Author/Report-sized outputs need headroom;
// the old 4000 cap silently truncated long SKILL.md bodies.
const MAX_OUTPUT_TOKENS = 16000;

// Model identifiers are plain tokens (claude-sonnet-4-6, gpt-4o,
// us.anthropic.claude-…, vendor/model). Anything outside this charset —
// spaces, semicolons, quotes, backticks — is rejected at configuration time
// so it can never reach a subprocess invocation, even as an argv element.
const MODEL_NAME_RE = /^[\w.:\/-]+$/;

export function assertSafeModelName(name, flagLabel) {
  if (name != null && !MODEL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid model name for ${flagLabel}: "${name}". ` +
      `Model names may only contain letters, digits, ".", ":", "/", "_" and "-".`
    );
  }
  return name;
}

/**
 * Resolve the model name for a tier from an llm config.
 * Tiers: "strong" (default), "fast", "gate".
 * "gate" falls back to strong unless an explicit gate model was configured —
 * pointing it at a different model/family gives the adversarial gates genuine
 * independence from the proposer.
 */
export function resolveTierModel(config, tier = "strong") {
  const models = config.models || {};
  if (tier === "fast") {
    return models.fast || models.strong || null;
  }
  if (tier === "gate") {
    return models.gate || models.strong || null;
  }
  return models.strong || null;
}

// Build the CLI argv for a local subscription agent, honoring a model
// override when the CLI supports one. Unknown CLIs ignore the tier (graceful
// degrade). Returned as [binary, ...args] for execFileSync — no shell is ever
// involved, so prompt/model content cannot be shell-expanded.
export function buildCliArgv(cliCmd, model) {
  if (cliCmd === "claude") {
    return ["claude", "-p", ...(model ? ["--model", model] : [])];
  }
  if (cliCmd === "codex") {
    return ["codex", "exec", ...(model ? ["-m", model] : [])];
  }
  return [cliCmd];
}

// Invokes a local CLI agent subscription by piping the prompt to standard input
function callCliLLM(cliCmd, prompt, systemInstruction, model) {
  let fullPrompt = "";
  if (systemInstruction) {
    fullPrompt += `System Instructions:\n${systemInstruction}\n\n`;
  }
  fullPrompt += `Prompt:\n${prompt}`;

  const [binary, ...cliArgs] = buildCliArgv(cliCmd, model);
  const label = [binary, ...cliArgs].join(" ");
  log.step(`Invoking local subscription agent via command: "${label}"...`);

  // Windows installs these CLIs as .cmd shims that Node cannot spawn without a
  // shell. shell:true is safe ONLY here: the argv carries flags plus a model
  // name already charset-validated by assertSafeModelName, and the untrusted
  // prompt travels via stdin, never through the shell.
  const isWindows = process.platform === "win32";

  try {
    // Pipe full prompt to the CLI tool's stdin (no shell on POSIX)
    const stdout = execFileSync(binary, cliArgs, {
      input: fullPrompt,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"], // Ignore stderr to avoid piping terminal spinner logs
      maxBuffer: 10 * 1024 * 1024, // 10MB limit
      shell: isWindows,
    });

    return stdout.trim();
  } catch (err) {
    // Fall back to passing the prompt as a positional argument if the CLI
    // does not read stdin. The prompt contains untrusted repo content (commit
    // messages, file contents) and must never hit a shell — so this fallback
    // is POSIX-only (execFileSync argv, no shell). On Windows there is no
    // shell-safe way to pass it positionally; fail with a clear remedy.
    if (isWindows) {
      throw new Error(
        `Local CLI agent "${label}" did not accept the prompt on stdin, and the ` +
        `argument fallback is disabled on Windows (it would route untrusted repo ` +
        `content through a shell). Use an API provider (--provider anthropic|openai|gemini) ` +
        `or a stdin-capable CLI. Original error: ${err.message}`
      );
    }
    try {
      log.substep(`Stdin piping not supported by ${label}, retrying as argument...`);
      const stdout = execFileSync(binary, [...cliArgs, fullPrompt], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024
      });
      return stdout.trim();
    } catch (err2) {
      throw new Error(`Failed to execute local CLI agent "${label}": ${err2.message || err.message}`);
    }
  }
}

// Configures the LLM provider based on flags, environment variables, or local CLI agents
export function configureLLM(args) {
  let provider = args.provider;
  let apiKey = null;
  let cliCmd = null;

  if (!provider) {
    // 1. Check API keys first
    if (process.env.ANTHROPIC_API_KEY) {
      provider = "anthropic";
    } else if (process.env.GEMINI_API_KEY) {
      provider = "gemini";
    } else if (process.env.OPENAI_API_KEY) {
      provider = "openai";
    }
    // 2. Check if a local subscription CLI is installed
    else if (isCmdInstalled("agy")) {
      provider = "cli";
      cliCmd = "agy";
    } else if (isCmdInstalled("claude")) {
      provider = "cli";
      cliCmd = "claude";
    } else if (isCmdInstalled("codex")) {
      provider = "cli";
      cliCmd = "codex";
    } else if (isCmdInstalled("gemini")) {
      provider = "cli";
      cliCmd = "gemini";
    } else {
      throw new Error(
        "No LLM configuration found.\n" +
        "Please set an API key: GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY,\n" +
        "OR make sure one of the local CLI agents is installed: agy, claude, codex, or gemini."
      );
    }
  } else {
    // If provider is forced as a flag, check if it's a known API or local command
    const knownApis = ["gemini", "openai", "anthropic"];
    if (!knownApis.includes(provider)) {
      if (isCmdInstalled(provider)) {
        cliCmd = provider;
        provider = "cli";
      } else {
        throw new Error(`Provider CLI command "${provider}" is not installed or available in PATH.`);
      }
    }
  }

  // Get matching API key if using API
  if (provider === "gemini") {
    apiKey = process.env.GEMINI_API_KEY;
  } else if (provider === "openai") {
    apiKey = process.env.OPENAI_API_KEY;
  } else if (provider === "anthropic") {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  if (provider !== "cli" && !apiKey) {
    throw new Error(`Provider "${provider}" requested but corresponding API key is not set in environment.`);
  }

  // Reject malformed model names before they can reach any subprocess
  assertSafeModelName(args.model, "--model");
  assertSafeModelName(args.modelStrong, "--model-strong");
  assertSafeModelName(args.modelFast, "--model-fast");
  assertSafeModelName(args.gateModel, "--gate-model");

  // Resolve the two model tiers. --model (legacy) sets both; --model-strong /
  // --model-fast override individually. CLI providers default to the session's
  // own model (null = no flag passed) unless explicitly overridden.
  const defaults = provider !== "cli" ? (DEFAULT_MODELS[provider] || {}) : {};
  const models = {
    strong: args.modelStrong || args.model || defaults.strong || null,
    fast: args.modelFast || args.model || defaults.fast || null,
    gate: args.gateModel || null,
  };

  if (provider === "cli") {
    const tierNote = models.strong || models.fast
      ? ` (tiers: strong=${models.strong || "session default"}, fast=${models.fast || "session default"})`
      : "";
    log.info(`Using Local CLI Agent: ${cliCmd} (using active subscription/session)${tierNote}`);
    // buildCliArgv can only pass a model to claude/codex. Any other tier flag
    // is silently dropped — warn, since --gate-model's whole value is the
    // cross-model independence it would lose.
    const canPassModel = cliCmd === "claude" || cliCmd === "codex";
    if (!canPassModel && (models.strong || models.fast || models.gate)) {
      log.warn(`Local CLI "${cliCmd}" cannot accept a --model flag — model-tier and --gate-model overrides are ignored; proposer and gates share one session model (no cross-model independence).`);
    } else if (canPassModel && models.gate) {
      log.info(`Gate model override: ${models.gate}`);
    }
  } else {
    log.info(`Using LLM Provider: ${provider} (strong: ${models.strong}, fast: ${models.fast}${models.gate ? `, gate: ${models.gate}` : ""})`);
  }

  return { provider, apiKey, cliCmd, models };
}

/**
 * Call the model and parse its JSON response, with one re-ask retry on a parse
 * failure. cleanJsonResponse is a heuristic, not a guarantee — an unguarded
 * JSON.parse in a late-stage gate throws away the whole run's verified work.
 * On persistent failure the caller decides how to degrade (the thrown error is
 * domain-labelled, not a raw SyntaxError).
 */
export async function llmCallJson(config, prompt, systemInstruction, tier, label = "LLM") {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : "\n\nYour previous response was not valid JSON. Return ONLY a valid JSON object, no prose, no code fences.";
    const response = await llmCall(config, prompt + suffix, systemInstruction, true, tier);
    try {
      return JSON.parse(cleanJsonResponse(response));
    } catch (err) {
      lastErr = err;
      log.warn(`${label}: response was not parseable JSON (attempt ${attempt + 1}/2)`);
    }
  }
  throw new Error(`${label}: model did not return valid JSON after retry (${lastErr?.message || "unknown"})`);
}

// Universal LLM call wrapper. `tier` selects the model: "strong" | "fast" | "gate".
export async function llmCall(config, prompt, systemInstruction = "", jsonMode = false, tier = "strong") {
  const { provider, apiKey, cliCmd } = config;
  const model = resolveTierModel(config, tier);

  if (provider === "cli") {
    return callCliLLM(cliCmd, prompt, systemInstruction, model);
  }

  let retries = 3;
  let delay = 1000;

  while (retries > 0) {
    try {
      if (provider === "gemini") {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            ...(jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        };

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Gemini API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts) {
          throw new Error("Invalid response format from Gemini API: " + JSON.stringify(data));
        }

        return data.candidates[0].content.parts[0].text;

      } else if (provider === "openai") {
        const url = "https://api.openai.com/v1/chat/completions";
        const body = {
          model,
          messages: [
            ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
            { role: "user", content: prompt },
          ],
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: jsonMode ? { type: "json_object" } : undefined,
        };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`OpenAI API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        return data.choices[0].message.content;

      } else if (provider === "anthropic") {
        const url = "https://api.anthropic.com/v1/messages";
        const body = {
          model,
          messages: [{ role: "user", content: prompt }],
          system: systemInstruction || undefined,
          max_tokens: MAX_OUTPUT_TOKENS,
        };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Anthropic API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        return data.content[0].text;
      }
    } catch (err) {
      retries--;
      if (retries === 0) {
        throw err;
      }
      log.warn(`LLM call failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}
