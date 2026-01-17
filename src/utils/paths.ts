/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from "node:path";
import * as os from "node:os";

export const GEMINI_DIR = ".gemini";
export const ACCOUNTS_DIR = "accounts";
export const CREDENTIAL_FILENAME = "oauth_creds.json";
export const GOOGLE_ACCOUNTS_FILENAME = "accounts.json";
export const REQUEST_COUNTS_FILENAME = "request_counts.json";

/**
 * Get the path to the cached credentials file
 * @returns The absolute path to the credentials file
 */
export function getCachedCredentialPath(): string {
    return path.join(os.homedir(), GEMINI_DIR, CREDENTIAL_FILENAME);
}

/**
 * Get the path to the accounts directory
 * @returns The absolute path to the accounts directory
 */
export function getAccountsDirPath(): string {
    return path.join(os.homedir(), GEMINI_DIR, ACCOUNTS_DIR);
}

/**
 * Get the path to the request counts file
 * @returns The absolute path to the request counts file
 */
export function getRequestCountsPath(): string {
    return path.join(os.homedir(), GEMINI_DIR, REQUEST_COUNTS_FILENAME);
}

/**
 * Get the path to the Google accounts cache file
 * @returns The absolute path to the Google accounts file
 */
export function getGoogleAccountsCachePath(): string {
    return path.join(os.homedir(), GEMINI_DIR, GOOGLE_ACCOUNTS_FILENAME);
}
