/**
 * Antigravity-specific paths (separate from Gemini CLI)
 */

import * as path from "node:path";
import * as os from "node:os";

export const ANTIGRAVITY_DIR = ".antigravity";
export const ANTIGRAVITY_ACCOUNTS_DIR = "accounts";
export const ANTIGRAVITY_CREDENTIAL_FILENAME = "oauth_creds.json";
export const ANTIGRAVITY_ACCOUNTS_FILENAME = "accounts.json";
export const ANTIGRAVITY_REQUEST_COUNTS_FILENAME = "request_counts.json";

/**
 * Get the path to the Antigravity cached credentials file
 * @returns The absolute path to the credentials file
 */
export function getAntigravityCachedCredentialPath(): string {
    return path.join(os.homedir(), ANTIGRAVITY_DIR, ANTIGRAVITY_CREDENTIAL_FILENAME);
}

/**
 * Get the path to the Antigravity accounts directory
 * @returns The absolute path to the accounts directory
 */
export function getAntigravityAccountsDirPath(): string {
    return path.join(os.homedir(), ANTIGRAVITY_DIR, ANTIGRAVITY_ACCOUNTS_DIR);
}

/**
 * Get the path to the Antigravity request counts file
 * @returns The absolute path to the request counts file
 */
export function getAntigravityRequestCountsPath(): string {
    return path.join(os.homedir(), ANTIGRAVITY_DIR, ANTIGRAVITY_REQUEST_COUNTS_FILENAME);
}

/**
 * Get the path to the Antigravity accounts cache file
 * @returns The absolute path to the accounts file
 */
export function getAntigravityAccountsCachePath(): string {
    return path.join(os.homedir(), ANTIGRAVITY_DIR, ANTIGRAVITY_ACCOUNTS_FILENAME);
}
