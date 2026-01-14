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
import chalk from "chalk";

const program = new Command()
    .option("-p, --port <port>", "Server port", DEFAULT_PORT)
    .option(
        "-g --google-cloud-project <googleCloudProject>",
        process.env.GOOGLE_CLOUD_PROJECT
    )
    .option(
        "--enable-browser-auth",
        "Enables browser auth flow",
        !DISABLE_BROWSER_AUTH
    )
    .option(
        "--enable-google-search",
        "Enables native Google Search tool",
        !DISABLE_GOOGLE_SEARCH
    )
    .option(
        "--disable-auto-model-switch",
        "Disables auto model switching in case of rate limiting",
        DISABLE_AUTO_MODEL_SWITCH
    )
    .option(
        "--oauth-rotation-paths <paths>",
        "Comma-separated paths to OAuth credential files for rotation",
        ""
    )
    .option(
        "--oauth-rotation-folder <folder>",
        "Path to folder containing OAuth credential files for rotation",
        ""
    )
    .option(
        "--oauth-reset-timezone <offset>",
        "Timezone offset for time-based index reset (e.g., -8 for Pacific Time)",
        "-8"
    )
    .option(
        "--oauth-reset-hour <hour>",
        "Hour of day to reset OAuth index (0-23, default 0 for midnight)",
        "0"
    )
    .parse(process.argv);

const opts = program.opts();

export async function startServer() {
    const logger = getLogger("SERVER", chalk.green);
    logger.info("starting server...");

    try {
        // Initialize OAuth rotation if paths or folder are provided
        if (opts.oauthRotationPaths) {
            const paths = opts.oauthRotationPaths
                .split(",")
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
            if (paths.length > 0) {
                OAuthRotator.getInstance().initialize(paths);
            }
        }

        // Initialize OAuth rotation from folder if provided
        if (opts.oauthRotationFolder) {
            await OAuthRotator.getInstance().initializeWithFolder(
                opts.oauthRotationFolder
            );
        }

        // Configure time-based reset if OAuth rotation is enabled
        if (opts.oauthRotationPaths || opts.oauthRotationFolder) {
            const timezoneOffset = parseInt(
                opts.oauthResetTimezone || "-8",
                10
            );
            const resetHour = parseInt(opts.oauthResetHour || "0", 10);
            OAuthRotator.getInstance().setTimeBasedReset(
                timezoneOffset,
                resetHour
            );
        }

        const authClient = await setupAuthentication(!opts.enableBrowserAuth);
        const geminiClient = new GeminiApiClient(
            authClient,
            opts.googleCloudProject ?? process.env.GOOGLE_CLOUD_PROJECT,
            opts.disableAutoModelSwitch
        );

        const app = express();

        // Add request logging middleware
        app.use((req, res, next) => {
            logger.info(
                `${new Date().toISOString()} - ${req.method} ${req.url}`
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
            res.type("text/plain").send(
                "Available endpoints:\n" +
                    `* OpenAI compatible endpoint: http://localhost:${opts.port}/openai\n` +
                    `* Anthropic compatible endpoint: http://localhost:${opts.port}/anthropic`
            );
        });

        app.get("/health", (_req, res) => {
            res.status(200).json({ status: "ok" });
        });
        const openAIRouter = createOpenAIRouter(
            geminiClient,
            opts.enableGoogleSearch
        );
        app.use("/openai", openAIRouter);

        const anthropicRouter = createAnthropicRouter(
            geminiClient,
            opts.enableGoogleSearch
        );
        app.use("/anthropic", anthropicRouter);

        // 6. Start server
        const server = app.listen(opts.port, () => {
            logger.info("server started");
            logger.info(
                `OpenAI compatible endpoint: http://localhost:${opts.port}/openai`
            );
            logger.info(
                `Anthropic compatible endpoint: http://localhost:${opts.port}/anthropic`
            );
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
