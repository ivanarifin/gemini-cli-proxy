/**
 * Antigravity Router
 * OpenAI-compatible endpoint at /antigravity
 */

import express from "express";
import { AntigravityApiClient, AntigravityApiError } from "./client.js";
import * as Antigravity from "./types.js";
import * as OpenAI from "../types/openai.js";
import { mapOpenAIToAntigravity } from "./openai-mapper.js";
import { getLogger } from "../utils/logger.js";
import chalk from "chalk";

export function createAntigravityRouter(
    antigravityClient: AntigravityApiClient,
    enableGoogleSearch: boolean = false,
): express.Router {
    const router = express.Router();
    const logger = getLogger("ANTIGRAVITY-ROUTER", chalk.magenta);

    // List available models
    router.get("/models", (_req, res) => {
        const antigravityModels = Object.values(Antigravity.AntigravityModel);
        const geminiCliModels = Object.values(Antigravity.GeminiCliModel);

        const modelData = [
            ...antigravityModels.map((modelId) => ({
                id: modelId,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "Google-Antigravity",
            })),
            ...geminiCliModels.map((modelId) => ({
                id: modelId,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "Google-GeminiCLI",
            })),
        ];

        res.json({
            object: "list",
            data: modelData,
        });
    });

    // Chat completions endpoint
    router.post("/chat/completions", async (req, res) => {
        try {
            const body = req.body as OpenAI.ChatCompletionRequest;
            if (!body.messages || !body.messages.length) {
                return res
                    .status(400)
                    .json({ error: "messages is a required field" });
            }

            const projectId = await antigravityClient.discoverProjectId();

            // Check if explicit model was requested
            const isExplicitModelRequest = Boolean(
                body.model &&
                    body.model !== "auto" &&
                    body.model.trim() !== "",
            );

            const antigravityRequest = mapOpenAIToAntigravity(
                projectId ?? "default-project",
                body,
                enableGoogleSearch,
                antigravityClient.lastThoughtSignature,
            );

            if (body.stream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader(
                    "Access-Control-Allow-Headers",
                    "Content-Type, Authorization",
                );
                res.setHeader("Access-Control-Allow-Origin", "*");

                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const reader = readable.getReader();

                void (async () => {
                    try {
                        const stream = antigravityClient.streamContent(
                            antigravityRequest,
                            0,
                            isExplicitModelRequest,
                        );
                        for await (const chunk of stream) {
                            await writer.write(chunk);
                        }
                        await writer.close();
                    } catch (error) {
                        logger.error("stream error", error);
                        await writer.abort(error);
                    }
                })();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        res.write("data: [DONE]\n\n");
                        res.end();
                        break;
                    }
                    res.write(`data: ${JSON.stringify(value)}\n\n`);
                }
            } else {
                // Non-streaming response
                try {
                    const completion = await antigravityClient.getCompletion(
                        antigravityRequest,
                        0,
                        isExplicitModelRequest,
                    );

                    // Build message content - include reasoning if present
                    let messageContent: string | null =
                        completion.content || null;
                    if (completion.reasoning) {
                        messageContent = `<thinking>\n${
                            completion.reasoning
                        }\n</thinking>\n\n${completion.content || ""}`;
                    }

                    const response: OpenAI.ChatCompletionResponse = {
                        id: `chatcmpl-${crypto.randomUUID()}`,
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000),
                        model: antigravityRequest.model,
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: "assistant",
                                    content: messageContent,
                                    tool_calls: completion.tool_calls,
                                },
                                finish_reason:
                                    completion.tool_calls &&
                                    completion.tool_calls.length > 0
                                        ? "tool_calls"
                                        : "stop",
                            },
                        ],
                    };

                    if (completion.usage) {
                        response.usage = {
                            prompt_tokens: completion.usage.inputTokens,
                            completion_tokens: completion.usage.outputTokens,
                            total_tokens:
                                completion.usage.inputTokens +
                                completion.usage.outputTokens,
                        };
                    }

                    res.json(response);
                } catch (completionError: unknown) {
                    logger.error("completion error", completionError);

                    let statusCode = 500;
                    let errorMessage = "An unknown error occurred";
                    let errorDetails: unknown = undefined;

                    if (completionError instanceof AntigravityApiError) {
                        statusCode = completionError.statusCode;
                        errorMessage = completionError.message;
                        if (completionError.responseText) {
                            try {
                                const parsed = JSON.parse(
                                    completionError.responseText,
                                );
                                if (parsed.error) {
                                    errorDetails = parsed.error;
                                }
                            } catch {
                                // ignore parsing error
                            }
                        }
                    } else if (completionError instanceof Error) {
                        errorMessage = completionError.message;
                    } else {
                        errorMessage = String(completionError);
                    }

                    res.status(statusCode).json({
                        error: errorDetails || {
                            message: errorMessage,
                            code: statusCode,
                        },
                    });
                }
            }
        } catch (error) {
            logger.error("request error", error);

            let statusCode = 500;
            let errorMessage = "An unknown error occurred";
            let errorDetails: unknown = undefined;

            if (error instanceof AntigravityApiError) {
                statusCode = error.statusCode;
                errorMessage = error.message;
                if (error.responseText) {
                    try {
                        const parsed = JSON.parse(error.responseText);
                        if (parsed.error) {
                            errorDetails = parsed.error;
                        }
                    } catch {
                        // ignore parsing error
                    }
                }
            } else if (error instanceof Error) {
                errorMessage = error.message;
            } else {
                errorMessage = String(error);
            }

            if (!res.headersSent) {
                res.status(statusCode).json({
                    error: errorDetails || {
                        message: errorMessage,
                        code: statusCode,
                    },
                });
            } else {
                res.end();
            }
        }
    });

    return router;
}
