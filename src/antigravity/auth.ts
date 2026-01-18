/**
 * Antigravity OAuth Authentication
 * Uses different OAuth credentials than Gemini CLI
 */

import {
    OAuth2Client,
    Credentials,
    CodeChallengeMethod,
} from "google-auth-library";
import * as http from "http";
import url from "url";
import crypto from "crypto";
import * as net from "net";
import open from "open";
import path from "node:path";
import { promises as fs } from "node:fs";
import readline from "node:readline";
import chalk from "chalk";
import { getLogger, Logger } from "../utils/logger.js";
import {
    ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET,
    ANTIGRAVITY_SCOPES,
    ANTIGRAVITY_REQUEST_TIMEOUT_MS,
} from "./constant.js";
import {
    getAntigravityCachedCredentialPath,
    getAntigravityAccountsCachePath,
} from "./paths.js";

const HTTP_REDIRECT = 301;
const SIGN_IN_SUCCESS_URL =
    "https://developers.google.com/gemini-code-assist/auth_success_gemini";
const SIGN_IN_FAILURE_URL =
    "https://developers.google.com/gemini-code-assist/auth_failure_gemini";

// Default redirect port for Antigravity OAuth
const DEFAULT_OAUTH_PORT = 51121;

export interface AntigravityOauthWebLogin {
    authUrl: string;
    loginCompletePromise: Promise<void>;
}

// Cached account info
interface AntigravityAccount {
    email?: string;
    projectId?: string;
}

let cachedAccount: AntigravityAccount | undefined;

/**
 * Set up Antigravity authentication (separate from Gemini CLI)
 * @returns OAuth2Client with valid credentials
 */
export async function setupAntigravityAuthentication(
    disableBrowserAuth: boolean,
): Promise<OAuth2Client> {
    const logger = getLogger("ANTIGRAVITY-AUTH", chalk.magenta);
    logger.info("setting up Antigravity authentication...");
    logger.info(
        "if you have not used antigravity before, you might be prompted to sign-in",
    );

    const client = new OAuth2Client({
        clientId: ANTIGRAVITY_CLIENT_ID,
        clientSecret: ANTIGRAVITY_CLIENT_SECRET,
    });

    client.on("tokens", async (tokens: Credentials) => {
        await cacheAntigravityCredentials(tokens);
    });

    // If there are cached creds on disk, they always take precedence
    if (await loadAntigravityCachedCredentials(client)) {
        if (!getCachedAntigravityAccount()) {
            try {
                await fetchAndCacheAntigravityUserInfo(client, logger);
            } catch {
                // Non-fatal, continue with existing auth
            }
        }
        const email = cachedAccount?.email ?? "unknown";
        logger.info(
            `cached credentials loaded for: ${chalk.bold.underline(email)}`,
        );
        logger.info(
            `to use another account, remove ${chalk.underline(
                "~/.antigravity",
            )} folder and restart server`,
        );
        return client;
    }

    // Determine whether to use browser or code-based auth
    if (isAntigravityBrowserLaunchSuppressed(disableBrowserAuth)) {
        let success = false;
        const maxRetries = 2;
        for (let i = 0; !success && i < maxRetries; i++) {
            success = await antigravityAuthWithUserCode(client, logger);
            if (!success) {
                logger.error(
                    `Failed to authenticate with user code. ${
                        i === maxRetries - 1 ? "" : "Retrying..."
                    }`,
                );
            }
        }
        if (!success) {
            process.exit(1);
        }
    } else {
        const webLogin = await antigravityAuthWithWeb(client, logger);

        logger.info("Google login required for Antigravity.");
        logger.info("Opening auth page, otherwise navigate to:");
        logger.info(`${webLogin.authUrl}`);

        try {
            const childProcess = await open(webLogin.authUrl);

            childProcess.on("error", () => {
                logger.error(
                    "Failed to open browser automatically. Please try running again with NO_BROWSER=true set.",
                );
                process.exit(1);
            });
        } catch (err) {
            logger.error(
                "Failed to open browser automatically. Please try running again with NO_BROWSER=true set.",
            );
            if (err instanceof Error) {
                logger.error(err.message);
            }
            process.exit(1);
        }

        logger.info("Waiting for authentication...");
        await webLogin.loginCompletePromise;
        logger.info("Authentication complete.");
    }

    return client;
}

/**
 * Authenticate with user code flow (for headless environments)
 */
export async function antigravityAuthWithUserCode(
    client: OAuth2Client,
    logger: Logger,
): Promise<boolean> {
    const redirectUri = "https://codeassist.google.com/authcode";
    const codeVerifier = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(32).toString("hex");
    const authUrl: string = client.generateAuthUrl({
        redirect_uri: redirectUri,
        access_type: "offline",
        scope: [...ANTIGRAVITY_SCOPES],
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeVerifier.codeChallenge,
        state,
        prompt: "consent",
    });

    logger.info("Please visit the following URL to authorize the application:");
    logger.info(`${authUrl}\n`);

    const code = await new Promise<string>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        logger.info("Enter auth code");
        rl.question("Code: ", (code) => {
            rl.close();
            resolve(code.trim());
        });
    });

    if (!code) {
        logger.error("Auth code is required");
        return false;
    }

    try {
        const { tokens } = await client.getToken({
            code,
            codeVerifier: codeVerifier.codeVerifier,
            redirect_uri: redirectUri,
        });
        client.setCredentials(tokens);
    } catch {
        return false;
    }

    return true;
}

/**
 * Authenticate with web-based flow
 */
export async function antigravityAuthWithWeb(
    client: OAuth2Client,
    logger: Logger,
): Promise<AntigravityOauthWebLogin> {
    const port = await getAntigravityAvailablePort();
    const host = process.env.OAUTH_CALLBACK_HOST || "localhost";
    const redirectUri = `http://localhost:${port}/oauth-callback`;
    const state = crypto.randomBytes(32).toString("hex");
    const authUrl = client.generateAuthUrl({
        redirect_uri: redirectUri,
        access_type: "offline",
        scope: [...ANTIGRAVITY_SCOPES],
        state,
        prompt: "consent",
    });

    const loginCompletePromise = new Promise<void>((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                if (req.url!.indexOf("/oauth-callback") === -1) {
                    res.writeHead(HTTP_REDIRECT, {
                        Location: SIGN_IN_FAILURE_URL,
                    });
                    res.end();
                    reject(new Error("Unexpected request: " + req.url));
                }
                const qs = new url.URL(req.url!, "http://localhost:3000")
                    .searchParams;
                if (qs.get("error")) {
                    res.writeHead(HTTP_REDIRECT, {
                        Location: SIGN_IN_FAILURE_URL,
                    });
                    res.end();

                    reject(
                        new Error(
                            `Error during authentication: ${qs.get("error")}`,
                        ),
                    );
                } else if (qs.get("state") !== state) {
                    res.end("State mismatch. Possible CSRF attack");

                    reject(new Error("State mismatch. Possible CSRF attack"));
                } else if (qs.get("code")) {
                    const { tokens } = await client.getToken({
                        code: qs.get("code")!,
                        redirect_uri: redirectUri,
                    });
                    client.setCredentials(tokens);
                    try {
                        await fetchAndCacheAntigravityUserInfo(client, logger);
                    } catch (err) {
                        logger.error(
                            "Failed to retrieve user info during authentication",
                        );
                        if (err instanceof Error) {
                            logger.error(err.message);
                        }
                    }

                    res.writeHead(HTTP_REDIRECT, {
                        Location: SIGN_IN_SUCCESS_URL,
                    });
                    res.end();
                    resolve();
                } else {
                    reject(new Error("No code found in request"));
                }
            } catch (e) {
                reject(e);
            } finally {
                server.close();
            }
        });
        server.listen(port, host);
    });

    return {
        authUrl,
        loginCompletePromise,
    };
}

/**
 * Get an available port for the OAuth callback server
 */
function getAntigravityAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        let port = DEFAULT_OAUTH_PORT;
        try {
            const portStr = process.env.ANTIGRAVITY_OAUTH_CALLBACK_PORT;
            if (portStr) {
                port = parseInt(portStr, 10);
                if (isNaN(port) || port <= 0 || port > 65535) {
                    return reject(
                        new Error(
                            `Invalid value for ANTIGRAVITY_OAUTH_CALLBACK_PORT: "${portStr}" `,
                        ),
                    );
                }
                return resolve(port);
            }
            // Try default port first, then find available
            const server = net.createServer();
            server.listen(port, () => {
                server.close();
                server.unref();
            });
            server.on("listening", () => {
                server.close();
                server.unref();
            });
            server.on("error", (e: NodeJS.ErrnoException) => {
                if (e.code === "EADDRINUSE") {
                    // Port in use, find another
                    const fallbackServer = net.createServer();
                    fallbackServer.listen(0, () => {
                        const address =
                            fallbackServer.address()! as net.AddressInfo;
                        port = address.port;
                    });
                    fallbackServer.on("listening", () => {
                        fallbackServer.close();
                        fallbackServer.unref();
                    });
                    fallbackServer.on("error", (e) => reject(e));
                    fallbackServer.on("close", () => resolve(port));
                } else {
                    reject(e);
                }
            });
            server.on("close", () => resolve(port));
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Load credentials from cache
 */
export async function loadAntigravityCachedCredentials(
    client: OAuth2Client,
): Promise<boolean> {
    try {
        const keyFile = getAntigravityCachedCredentialPath();

        const creds = await fs.readFile(keyFile, "utf-8");
        client.setCredentials(JSON.parse(creds));

        const { token } = await client.getAccessToken();
        if (!token) {
            return false;
        }

        const { email } = await client.getTokenInfo(token);
        cachedAccount = { email };
        return true;
    } catch {
        return false;
    }
}

/**
 * Cache credentials to disk
 */
export async function cacheAntigravityCredentials(credentials: Credentials) {
    const filePath = getAntigravityCachedCredentialPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const credString = JSON.stringify(credentials, null, 2);
    await fs.writeFile(filePath, credString, { mode: 0o600 });
}

/**
 * Clear cached credentials file
 */
export async function clearAntigravityCachedCredentialFile() {
    try {
        await fs.rm(getAntigravityCachedCredentialPath(), { force: true });
        cachedAccount = undefined;
    } catch {
        /* empty */
    }
}

/**
 * Fetch and cache user information
 */
export async function fetchAndCacheAntigravityUserInfo(
    client: OAuth2Client,
    logger: Logger,
): Promise<void> {
    try {
        const { token } = await client.getAccessToken();
        if (!token) {
            return;
        }

        const response = await fetch(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                signal: AbortSignal.timeout(ANTIGRAVITY_REQUEST_TIMEOUT_MS),
            },
        );

        if (!response.ok) {
            logger.error(
                `Failed to fetch user info:: ${chalk.bold(
                    response.status,
                )} ${chalk.bold(response.statusText)}`,
            );
            return;
        }

        const userInfo = (await response.json()) as { email?: string };
        if (userInfo.email) {
            cachedAccount = { email: userInfo.email };
            await cacheAntigravityAccount(userInfo.email);
        }
    } catch (err) {
        logger.error("Error retrieving user info:");
        if (err instanceof Error) {
            logger.error(err.message);
        }
    }
}

/**
 * Cache Google account info
 */
export async function cacheAntigravityAccount(email: string): Promise<void> {
    const filePath = getAntigravityAccountsCachePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const data = JSON.stringify({ email }, null, 2);
    await fs.writeFile(filePath, data, { mode: 0o600 });
}

/**
 * Get cached account
 */
export function getCachedAntigravityAccount(): AntigravityAccount | undefined {
    return cachedAccount;
}

/**
 * Check if browser launch is suppressed
 */
export function isAntigravityBrowserLaunchSuppressed(
    disableBrowserAuth: boolean,
): boolean {
    if (disableBrowserAuth) {
        return true;
    }

    if (process.env.CI || process.env.DEBIAN_FRONTEND === "noninteractive") {
        return true;
    }

    const isSSH = !!process.env.SSH_CONNECTION;

    if (process.platform === "linux") {
        const displayVariables = ["DISPLAY", "WAYLAND_DISPLAY", "MIR_SOCKET"];
        const hasDisplay = displayVariables.some((v) => !!process.env[v]);
        if (!hasDisplay) {
            return true;
        }
    }

    if (isSSH && process.platform !== "linux") {
        return true;
    }

    return false;
}
