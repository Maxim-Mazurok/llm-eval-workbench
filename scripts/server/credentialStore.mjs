import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CREDENTIAL_SERVICE = "llm-eval-workbench";

function credentialAccount(providerId) {
  return createHash("sha256").update(String(providerId)).digest("hex");
}

class MacOsKeychainStore {
  async save(account, value) {
    execFileSync("security", [
      "add-generic-password",
      "-a", account,
      "-s", CREDENTIAL_SERVICE,
      "-w", value,
      "-U"
    ], { stdio: "ignore" });
  }

  async load(account) {
    try {
      return execFileSync("security", [
        "find-generic-password",
        "-a", account,
        "-s", CREDENTIAL_SERVICE,
        "-w"
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  }

  async clear(account) {
    try {
      execFileSync("security", [
        "delete-generic-password",
        "-a", account,
        "-s", CREDENTIAL_SERVICE
      ], { stdio: "ignore" });
    } catch {
      // Missing entries are already clear.
    }
  }
}

class WindowsCredentialStore {
  keytar() {
    try {
      return require("@github/keytar");
    } catch {
      throw new Error(
        "Secure provider keys require the optional @github/keytar package on Windows. "
        + "Reinstall dependencies with npm install."
      );
    }
  }

  async save(account, value) {
    await this.keytar().setPassword(CREDENTIAL_SERVICE, credentialAccount(account), value);
  }

  async load(account) {
    return this.keytar().getPassword(CREDENTIAL_SERVICE, credentialAccount(account));
  }

  async clear(account) {
    await this.keytar().deletePassword(CREDENTIAL_SERVICE, credentialAccount(account));
  }
}

class LinuxSecretServiceStore {
  constructor() {
    try {
      execFileSync("which", ["secret-tool"], { stdio: "ignore" });
    } catch {
      throw new Error(
        "Secure provider keys require Secret Service and the secret-tool command on Linux. "
        + "Install libsecret-tools (or your distribution's equivalent) and unlock a keyring."
      );
    }
  }

  async save(account, value) {
    execFileSync("secret-tool", [
      "store",
      "--label", "LLM Eval Workbench provider",
      "service", CREDENTIAL_SERVICE,
      "account", account
    ], { input: value, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
  }

  async load(account) {
    try {
      return execFileSync("secret-tool", [
        "lookup",
        "service", CREDENTIAL_SERVICE,
        "account", account
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  }

  async clear(account) {
    try {
      execFileSync("secret-tool", [
        "clear",
        "service", CREDENTIAL_SERVICE,
        "account", account
      ], { stdio: "ignore" });
    } catch {
      // Missing entries are already clear.
    }
  }
}

export function createCredentialStore(platform = process.platform) {
  if (platform === "darwin") return new MacOsKeychainStore();
  if (platform === "win32") return new WindowsCredentialStore();
  return new LinuxSecretServiceStore();
}
