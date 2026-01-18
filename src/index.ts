#!/usr/bin/env node
import express from "express";
import { Command } from "@commander-js/extra-typings";

import { setupAuthentication } from "./auth/auth.js";
import { GeminiApiClient } from "./gemini/client.js";
import { createOpenAIRouter } from "./routes/openai.js";
import { createAnthropicRouter } from "./routes/anthropic.js";
import {
    DEFAULT_PORT,
    DISABLE_AUTO_MODEL_SWITCH,
    DISABLE_BROWSER_AUTH,
    DISABLE_GOOGLE_SEARCH,
} from "./utils/constant.js";
import { OAuthRotator } from "./utils/oauth-rotator.js";
import { getLogger } from "./utils/logger.js";
import { getAccountsDirPath } from "./utils/paths.js";
import { existsSync } from "node:fs";
import chalk from "chalk";

// Antigravity imports
import { setupAntigravityAuthentication } from "./antigravity/auth.js";
import { AntigravityApiClient } from "./antigravity/client.js";
import { createAntigravityRouter } from "./antigravity/router.js";
import { AntigravityOAuthRotator } from "./antigravity/oauth-rotator.js";
import { getAntigravityAccountsDirPath } from "./antigravity/paths.js";

const program = new Command()
    .option("-p, --port <port>", "Server port", DEFAULT_PORT)
    .option(
        "-g --google-cloud-project <googleCloudProject>",
        process.env.GOOGLE_CLOUD_PROJECT,
    )
    .option(
        "--disable-browser-auth",
        "Disables browser auth flow and uses code based auth",
        DISABLE_BROWSER_AUTH,
    )
    .option(
        "--enable-google-search",
        "Enables native Google Search tool",
        !DISABLE_GOOGLE_SEARCH,
    )
    .option(
        "--disable-auto-model-switch",
        "Disables auto model switching in case of rate limiting",
        DISABLE_AUTO_MODEL_SWITCH,
    )
    .option(
        "--oauth-rotation-paths <paths>",
        "Comma-separated paths to OAuth credential files for rotation",
        "",
    )
    .option(
        "--oauth-rotation-folder <folder>",
        "Path to folder containing OAuth credential files for rotation",
        "",
    )
    .option(
        "--oauth-reset-timezone <offset>",
        "Timezone offset for time-based index reset (e.g., -8 for Pacific Time)",
        "-8",
    )
    .option(
        "--oauth-reset-hour <hour>",
        "Hour of day to reset OAuth index (0-23, default 0 for midnight)",
        "0",
    )
    // Antigravity-specific options
    .option(
        "--antigravity-oauth-rotation-folder <folder>",
        "Path to folder containing Antigravity OAuth credential files for rotation",
        "",
    )
    .option(
        "--disable-antigravity",
        "Disable Antigravity endpoint",
        false,
    )
    .parse(process.argv);

const opts = program.opts();

export async function startServer() {
    const logger = getLogger("SERVER", chalk.green);
    logger.info("starting server...");

    try {
        // Initialize Gemini CLI OAuth rotation if paths or folder are provided
        if (opts.oauthRotationPaths) {
            const paths = opts.oauthRotationPaths
                .split(",")
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
            if (paths.length > 0) {
                OAuthRotator.getInstance().initialize(paths);
            }
        }

        // Initialize Gemini CLI OAuth rotation from folder if provided
        if (opts.oauthRotationFolder) {
            await OAuthRotator.getInstance().initializeWithFolder(
                opts.oauthRotationFolder,
            );
        } else {
            // Automatically use managed accounts folder if it exists and has accounts
            const managedAccountsDir = getAccountsDirPath();
            if (existsSync(managedAccountsDir)) {
                await OAuthRotator.getInstance().initializeWithFolder(
                    managedAccountsDir,
                );
            }
        }

        // Configure time-based reset for Gemini CLI OAuth rotation
        if (opts.oauthRotationPaths || opts.oauthRotationFolder) {
            const timezoneOffset = parseInt(
                opts.oauthResetTimezone || "-8",
                10,
            );
            const resetHour = parseInt(opts.oauthResetHour || "0", 10);
            OAuthRotator.getInstance().setTimeBasedReset(
                timezoneOffset,
                resetHour,
            );
        }

        // Antigravity is enabled by default, check if disabled
        const antigravityEnabled = !opts.disableAntigravity;

        // Initialize Antigravity OAuth rotation if enabled
        if (antigravityEnabled) {
            if (opts.antigravityOauthRotationFolder) {
                await AntigravityOAuthRotator.getInstance().initializeWithFolder(
                    opts.antigravityOauthRotationFolder,
                );
            } else {
                // Automatically use Antigravity managed accounts folder if it exists
                const antigravityAccountsDir = getAntigravityAccountsDirPath();
                if (existsSync(antigravityAccountsDir)) {
                    await AntigravityOAuthRotator.getInstance().initializeWithFolder(
                        antigravityAccountsDir,
                    );
                }
            }

            // Configure time-based reset for Antigravity OAuth rotation
            if (opts.antigravityOauthRotationFolder) {
                const timezoneOffset = parseInt(
                    opts.oauthResetTimezone || "-8",
                    10,
                );
                const resetHour = parseInt(opts.oauthResetHour || "0", 10);
                AntigravityOAuthRotator.getInstance().setTimeBasedReset(
                    timezoneOffset,
                    resetHour,
                );
            }
        }

        // Setup Gemini CLI authentication
        const authClient = await setupAuthentication(
            opts.disableBrowserAuth ?? false,
        );
        const geminiClient = new GeminiApiClient(
            authClient,
            opts.googleCloudProject ?? process.env.GOOGLE_CLOUD_PROJECT,
            opts.disableAutoModelSwitch,
        );

        // Setup Antigravity authentication if enabled
        let antigravityClient: AntigravityApiClient | null = null;
        if (antigravityEnabled) {
            logger.info("Setting up Antigravity authentication...");
            const antigravityAuthClient = await setupAntigravityAuthentication(
                opts.disableBrowserAuth ?? false,
            );
            antigravityClient = new AntigravityApiClient(
                antigravityAuthClient,
                opts.googleCloudProject ?? process.env.GOOGLE_CLOUD_PROJECT,
                opts.disableAutoModelSwitch,
            );
        }

        const app = express();

        // Add request logging middleware
        app.use((req, res, next) => {
            logger.info(
                `${new Date().toISOString()} - ${req.method} ${req.url}`,
            );
            next();
        });

        // Custom JSON parsing with better error handling
        app.use((req, res, next) => {
            if (req.headers["content-type"]?.includes("application/json")) {
                let body = "";
                req.on("data", (chunk) => {
                    body += chunk.toString();
                });
                req.on("end", () => {
                    try {
                        if (body) {
                            req.body = JSON.parse(body);
                        }
                        next();
                    } catch (err) {
                        if (err instanceof Error) {
                            logger.error(`json parse error: ${err.message}`);
                            res.status(400).json({
                                error: "Invalid JSON in request body",
                                details: err.message,
                                position:
                                    body.length > 0
                                        ? Math.min(500, body.length)
                                        : 0,
                            });
                        } else {
                            logger.error(err as string);
                        }
                    }
                });
            } else {
                next();
            }
        });

        app.get("/", (_req, res) => {
            const endpoints = [
                `* OpenAI compatible endpoint (Gemini CLI): http://localhost:${opts.port}/openai`,
                `* Anthropic compatible endpoint (Gemini CLI): http://localhost:${opts.port}/anthropic`,
            ];

            if (antigravityEnabled) {
                endpoints.push(
                    `* Antigravity endpoint (Claude/Gemini 3): http://localhost:${opts.port}/antigravity`,
                );
            }

            res.type("text/plain").send(
                "Available endpoints:\n" + endpoints.join("\n"),
            );
        });

        app.get("/health", (_req, res) => {
            res.status(200).json({ status: "ok" });
        });

        // Gemini CLI endpoints
        const openAIRouter = createOpenAIRouter(
            geminiClient,
            opts.enableGoogleSearch,
        );
        app.use("/openai", openAIRouter);

        const anthropicRouter = createAnthropicRouter(
            geminiClient,
            opts.enableGoogleSearch,
        );
        app.use("/anthropic", anthropicRouter);

        // Antigravity endpoint (enabled by default)
        if (antigravityEnabled && antigravityClient) {
            const antigravityRouter = createAntigravityRouter(
                antigravityClient,
                opts.enableGoogleSearch,
            );
            app.use("/antigravity", antigravityRouter);
        }

        // Start server
        const server = app.listen(opts.port, () => {
            logger.info("server started");
            logger.info(
                `OpenAI compatible endpoint (Gemini CLI): http://localhost:${opts.port}/openai`,
            );
            logger.info(
                `Anthropic compatible endpoint (Gemini CLI): http://localhost:${opts.port}/anthropic`,
            );
            if (antigravityEnabled) {
                logger.info(
                    `Antigravity endpoint (Claude/Gemini 3): http://localhost:${opts.port}/antigravity`,
                );
            }
            logger.info("press Ctrl+C to stop the server");
        });

        // Handle graceful shutdown
        let isShuttingDown = false;
        const gracefulShutdown = (signal: string) => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            logger.info(`\n${signal} received. Shutting down gracefully...`);

            // Clean up OAuth rotator resources
            OAuthRotator.getInstance().dispose();
            if (antigravityEnabled) {
                AntigravityOAuthRotator.getInstance().dispose();
            }

            server.close(() => {
                logger.info("Server closed.");
                process.exit(0);
            });
        };

        process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
        process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    } catch (err) {
        if (err instanceof Error) {
            logger.error(err.message);
        } else {
            logger.error(err as string);
        }

        process.exit(1);
    }
}

startServer();
