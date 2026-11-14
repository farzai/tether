import { type Run, run } from "./run.ts";

/** The keychain could not be asked at all (locked, no session bus, tool missing), as opposed to not holding the item. */
export class KeychainUnavailable extends Error {}

/** The OS keychain, holding one secret per app origin. */
export interface Keychain {
  readonly name: string;
  /** The secret, or undefined when the keychain does not hold one; throws KeychainUnavailable. */
  get(origin: string): string | undefined;
  /** False when the keychain refused the secret: the caller keeps it somewhere else. */
  set(origin: string, secret: string): boolean;
  delete(origin: string): void;
}

/** A value `security -i` reads as one word: it splits its command line on spaces; quotes group. */
function quoted(value: string): string | undefined {
  return /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/.test(value) ? `"${value}"` : undefined;
}

const MAC_NOT_FOUND = 44;

/** The macOS login keychain through `/usr/bin/security`; `service` names this Tether home's items. */
export function macKeychain(service: string, exec: Run = run): Keychain {
  const keychain: Keychain = {
    name: "the macOS keychain",
    get: (origin) => {
      const done = exec("security", ["find-generic-password", "-s", service, "-a", origin, "-w"]);
      if (done.status === 0) return done.stdout.replace(/\n$/, "");
      if (done.status === MAC_NOT_FOUND) return undefined;
      throw new KeychainUnavailable(
        `the macOS keychain did not answer (${done.status ?? "timeout"})`,
      );
    },
    set: (origin, secret) => {
      const account = quoted(origin);
      const password = quoted(secret);
      if (!account || !password) return false;
      // `security -i` reads its commands from stdin, which keeps the secret out of argv.
      const line = `add-generic-password -U -s ${service} -a ${account} -l ${quoted(`Tether ${origin}`)} -w ${password}\n`;
      if (exec("security", ["-i"], line).status !== 0) return false;
      try {
        return keychain.get(origin) === secret;
      } catch {
        return false;
      }
    },
    delete: (origin) => {
      exec("security", ["delete-generic-password", "-s", service, "-a", origin]);
    },
  };
  return keychain;
}

/** The freedesktop Secret Service (GNOME Keyring, KWallet) through `secret-tool`. */
export function secretToolKeychain(service: string, exec: Run = run): Keychain {
  const attributes = (origin: string) => ["service", service, "account", origin];
  const keychain: Keychain = {
    name: "the Secret Service keyring",
    get: (origin) => {
      const done = exec("secret-tool", ["lookup", ...attributes(origin)]);
      if (done.status === 0) return done.stdout;
      // secret-tool exits 1 quietly when nothing matches, and says why when it cannot ask.
      if (done.status === 1 && done.stderr.trim() === "") return undefined;
      throw new KeychainUnavailable(
        `the Secret Service keyring did not answer (${done.status ?? "timeout"})`,
      );
    },
    set: (origin, secret) => {
      const args = ["store", `--label=Tether ${origin}`, ...attributes(origin)];
      if (exec("secret-tool", args, secret).status !== 0) return false;
      try {
        return keychain.get(origin) === secret;
      } catch {
        return false;
      }
    },
    delete: (origin) => {
      exec("secret-tool", ["clear", ...attributes(origin)]);
    },
  };
  return keychain;
}

/**
 * The keychain for this computer, or undefined when credentials stay in the 0600 file: on Windows
 * and whenever TETHER_KEYCHAIN is "off". A Linux without `secret-tool` or an unlocked keyring
 * refuses each write, which also leaves the credential in the file.
 */
export function systemKeychain(
  env: Record<string, string | undefined>,
  service: string,
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): Keychain | undefined {
  if (env.TETHER_KEYCHAIN === "off") return undefined;
  if (platform === "darwin") return macKeychain(service, exec);
  if (platform === "linux") return secretToolKeychain(service, exec);
  return undefined;
}
