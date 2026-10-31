// App-owned Codex device login only. Never import an ambient/Hermes auth store.
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { CodexCredentials } from "./codex-credentials.ts";

export async function codexAuth(role: string, authDir: string): Promise<void> {
  const action = role.replace(/^auth-/, "");
  if (!["login", "status", "logout"].includes(action)) throw new Error("Unknown Codex auth role");
  const file = join(resolve(authDir), "credentials.sqlite");
  // A status check must never contact OpenAI or refresh an expired grant.
  if (!existsSync(file) && action !== "login") {
    if (action === "logout") {
      for (const suffix of ["", ".new"])
        rmSync(join(authDir, "models-cache.json" + suffix), { force: true });
    }
    console.log("Codex: not logged in (dedicated app store).");
    return;
  }
  const credentials = new CodexCredentials(file);
  try {
    if (action === "status") {
      const stored = await credentials.read("openai-codex");
      const status =
        stored?.type !== "oauth"
          ? "not logged in"
          : stored.expires <= Date.now()
            ? "stored grant expired; API use may refresh it"
            : "stored grant present";
      console.log(`Codex: ${status} (local status only; account access not verified).`);
      return;
    }
    if (action === "logout") {
      await credentials.delete("openai-codex");
      // Account-bound catalog metadata is private too; remove it on local logout.
      for (const suffix of ["", ".new"])
        rmSync(join(authDir, "models-cache.json" + suffix), { force: true });
      console.log(
        "Codex: local grant and catalog cache removed. Server-side sessions are not revoked.",
      );
      return;
    }
    const models = createModels({ credentials });
    models.setProvider(openaiCodexProvider());
    // The pinned pi-ai API uses AuthInteraction, not legacy onAuth callbacks.
    // Its exact headless selection is device_code (underscore), not device-code.
    await models.login("openai-codex", "oauth", {
      prompt: async (prompt) => {
        if (
          prompt.type === "select" &&
          prompt.options?.some((option) => option.id === "device_code")
        )
          return "device_code";
        throw new Error("Only device-code login is allowed; no credential input is accepted");
      },
      notify: (event) => {
        if (event.type === "device_code") {
          console.log(`Open ${event.verificationUri} in your own browser.`);
          console.log(`Enter the device code shown here: ${event.userCode}`);
          console.log(
            "Complete authorization there; do not paste credentials into this terminal or chat.",
          );
        }
        // Never print arbitrary provider messages/errors, token payloads or account identifiers.
      },
    });
    console.log("Codex: login saved in the dedicated app store.");
  } finally {
    credentials.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.argv[2] ?? "";
  const authDir = process.env.DNA_CODEX_AUTH_DIR;
  if (
    !authDir ||
    !["auth-login", "auth-status", "auth-logout", "login", "status", "logout"].includes(role)
  ) {
    console.error(
      "Usage: codex-login.ts auth-login|auth-status|auth-logout (DNA_CODEX_AUTH_DIR required)",
    );
    process.exitCode = 64;
  } else {
    try {
      await codexAuth(role, authDir);
    } catch {
      console.error(
        "Codex auth failed; check the private auth mount, VPN and device authorization. No credential details are printed.",
      );
      process.exitCode = 1;
    }
  }
}
