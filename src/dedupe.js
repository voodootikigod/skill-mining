import { execSync } from "child_process";
import { log } from "./utils.js";

/**
 * Searches the skills ecosystem for matching skills.
 * If the search fails (e.g. offline, registry down):
 *   - If offlineAllowed is true, returns { success: false, status: "offline" }
 *   - If offlineAllowed is false, throws a fail-closed error.
 */
export function findEcosystemSkills(query, offlineAllowed = false) {
  log.step(`Searching ecosystem for "${query}"...`);
  
  try {
    // Run npx -y skills find <query> to bypass interactive npm prompt
    // We set timeout to 10 seconds to avoid hanging indefinitely
    const stdout = execSync(`npx -y skills find "${query.replace(/"/g, '\\"')}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      encoding: "utf8"
    });
    
    log.substep(`Found search results: ${stdout.trim().split("\n").length} items`);
    return {
      success: true,
      status: "online",
      results: stdout.trim(),
    };
  } catch (err) {
    if (offlineAllowed) {
      log.substep("Search failed/offline. Offline mode enabled, so proceeding.");
      return {
        success: false,
        status: "offline",
        results: "",
      };
    } else {
      log.error(`Ecosystem search failed for "${query}" (registry unreachable or timeout).`);
      throw new Error(
        `FAIL CLOSED: Could not connect to the skills registry for deduplication. ` +
        `To run without a network connection, pass the --offline flag (this will mark built skills as "reuse-unchecked").`
      );
    }
  }
}
