import { execSync } from "child_process";
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

// Check if a shell command is installed and executable
function isCmdInstalled(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

// Invokes a local CLI agent subscription by piping the prompt to standard input
function callCliLLM(cliCmd, prompt, systemInstruction) {
  let fullPrompt = "";
  if (systemInstruction) {
    fullPrompt += `System Instructions:\n${systemInstruction}\n\n`;
  }
  fullPrompt += `Prompt:\n${prompt}`;

  log.step(`Invoking local subscription agent via command: "${cliCmd}"...`);

  try {
    // Pipe full prompt to the CLI tool's stdin
    const stdout = execSync(cliCmd, {
      input: fullPrompt,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"], // Ignore stderr to avoid piping terminal spinner logs
      maxBuffer: 10 * 1024 * 1024 // 10MB limit
    });
    
    return stdout.trim();
  } catch (err) {
    // Fall back to shell argument passing if stdin piping is not supported by the CLI
    try {
      log.substep(`Stdin piping not supported by ${cliCmd}, retrying as argument...`);
      const escapedPrompt = fullPrompt.replace(/`/g, "\\`").replace(/\$/g, "\\$");
      // If the command is 'claude', support the -p option if stdin fails
      const cmdStr = (cliCmd === "claude") ? `claude -p "${escapedPrompt}"` : `${cliCmd} "${escapedPrompt}"`;
      const stdout = execSync(cmdStr, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024
      });
      return stdout.trim();
    } catch (err2) {
      throw new Error(`Failed to execute local CLI agent "${cliCmd}": ${err2.message || err.message}`);
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

  // Default models
  let model = args.model;
  if (!model && provider !== "cli") {
    if (provider === "gemini") {
      model = "gemini-2.5-flash";
    } else if (provider === "openai") {
      model = "gpt-4o";
    } else if (provider === "anthropic") {
      model = "claude-3-5-sonnet-latest";
    }
  }

  if (provider === "cli") {
    log.info(`Using Local CLI Agent: ${cliCmd} (using active subscription/session)`);
  } else {
    log.info(`Using LLM Provider: ${provider} (Model: ${model})`);
  }

  return { provider, model, apiKey, cliCmd };
}

// Universal LLM call wrapper
export async function llmCall(config, prompt, systemInstruction = "", jsonMode = false) {
  const { provider, model, apiKey, cliCmd } = config;
  
  if (provider === "cli") {
    return callCliLLM(cliCmd, prompt, systemInstruction);
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
          generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined,
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
          max_tokens: 4000,
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
