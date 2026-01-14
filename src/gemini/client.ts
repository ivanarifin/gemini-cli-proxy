import { OAuth2Client, Credentials } from "google-auth-library";
import * as OpenAI from "../types/openai.js";
import * as Gemini from "../types/gemini.js";
import {
    CODE_ASSIST_API_VERSION,
    CODE_ASSIST_ENDPOINT,
    OPENAI_CHAT_COMPLETION_OBJECT,
} from "../utils/constant.js";
import {
    AutoModelSwitchingHelper,
    type RetryableRequestData,
} from "./auto-model-switching.js";
import { getLogger, Logger } from "../utils/logger.js";
import { OAuthRotator } from "../utils/oauth-rotator.js";
import { getCachedCredentialPath } from "../utils/paths.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";

/**
 * Custom error class for Gemini API errors with status code information
 */
export class GeminiApiError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly responseText?: string
    ) {
        super(message);
        this.name = "GeminiApiError";
    }
}

/**
 * Handles communication with Google's Gemini API through the Code Assist endpoint.
 */
export class GeminiApiClient {
    private projectId: string | null = null;
    private projectIdPromise: Promise<string | null> | null = null;
    private firstChunk: boolean = true;
    private readonly creationTime: number;
    private readonly chatID: string;
    private readonly autoSwitcher: AutoModelSwitchingHelper;
    private readonly logger: Logger;

    constructor(
        private readonly authClient: OAuth2Client,
        private readonly googleCloudProject: string | undefined,
        private readonly disableAutoModelSwitch: boolean
    ) {
        this.googleCloudProject = googleCloudProject;
        this.chatID = `chat-${crypto.randomUUID()}`;
        this.creationTime = Math.floor(Date.now() / 1000);
        this.autoSwitcher = AutoModelSwitchingHelper.getInstance();
        this.logger = getLogger("GEMINI-CLIENT", chalk.blue);

        // Eagerly start project discovery to reduce latency on the first request
        void this.discoverProjectId();
    }

    /**
     * Reload credentials from disk after OAuth rotation
     * Always triggers token refresh to ensure valid access token
     * Writes refreshed credentials back to the source file and cache
     * Also resets cached projectId to prevent 403 errors from stale project IDs
     * @param sourceFilePath Path to the original OAuth credential file (optional)
     */
    private async reloadCredentials(
        sourceFilePath?: string | null
    ): Promise<void> {
        const credentialPath = getCachedCredentialPath();

        try {
            const creds = await fs.readFile(credentialPath, "utf-8");
            const credentials = JSON.parse(creds) as Credentials;
            this.authClient.setCredentials(credentials);
            this.logger.info("Credentials reloaded from disk after rotation");

            // IMPORTANT: Reset cached projectId to prevent 403 errors
            // Each OAuth account may have a different associated project
            this.projectId = null;
            this.logger.info("Project ID cache cleared for new OAuth account");

            // Always trigger token refresh after rotation
            // This ensures the new OAuth credentials have a valid access token
            this.logger.info(
                "Triggering token refresh after OAuth rotation..."
            );
            try {
                // Force refresh by clearing access token first
                this.authClient.credentials.access_token = undefined;

                const refreshed = await this.authClient.refreshAccessToken();
                this.logger.info("Access token refreshed successfully");

                // Update credentials with refreshed tokens
                this.authClient.setCredentials(refreshed.credentials);

                // Write refreshed credentials to cache
                await fs.writeFile(
                    credentialPath,
                    JSON.stringify(refreshed.credentials, null, 2),
                    { mode: 0o600 }
                );
                this.logger.info(
                    "Refreshed credentials cached to: " + credentialPath
                );

                // Also write back to source file if provided
                if (sourceFilePath) {
                    try {
                        // Merge with existing credential file to preserve other fields
                        const existingContent = await fs.readFile(
                            sourceFilePath,
                            "utf-8"
                        );
                        const existingCreds = JSON.parse(existingContent);
                        const updatedCreds = {
                            ...existingCreds,
                            ...refreshed.credentials,
                        };
                        await fs.writeFile(
                            sourceFilePath,
                            JSON.stringify(updatedCreds, null, 2),
                            { mode: 0o600 }
                        );
                        this.logger.info(
                            "Refreshed credentials written back to source: " +
                                sourceFilePath
                        );
                    } catch (sourceError) {
                        this.logger.warn(
                            "Failed to write refreshed credentials to source file: " +
                                sourceFilePath,
                            sourceError
                        );
                        // Continue anyway - cache is updated
                    }
                }
            } catch (refreshError) {
                this.logger.warn(
                    "Failed to refresh access token after rotation",
                    refreshError
                );
                // Continue anyway - the API call will handle 401 and retry
            }
        } catch (error) {
            this.logger.error("Failed to reload credentials from disk", error);
            throw error;
        }
    }

    /**
     * Discovers the Google Cloud project ID.
     * Returns null if project ID is not required or cannot be discovered.
     * This is optional - many OAuth setups don't require a project ID.
     */
    public async discoverProjectId(): Promise<string | null> {
        if (this.googleCloudProject) {
            return this.googleCloudProject;
        }
        if (this.projectId) {
            return this.projectId;
        }

        if (this.projectIdPromise) {
            return this.projectIdPromise;
        }

        this.projectIdPromise = (async () => {
            try {
                const initialProjectId = "default-project";
                const loadResponse = (await this.callEndpoint(
                    "loadCodeAssist",
                    {
                        cloudaicompanionProject: initialProjectId,
                        metadata: { duetProject: initialProjectId },
                    }
                )) as Gemini.ProjectDiscoveryResponse;

                if (loadResponse.cloudaicompanionProject) {
                    this.projectId = loadResponse.cloudaicompanionProject;
                    return this.projectId;
                }

                const defaultTier = loadResponse.allowedTiers?.find(
                    (tier) => tier.isDefault
                );
                const tierId = defaultTier?.id ?? "free-tier";
                const onboardRequest = {
                    tierId,
                    cloudaicompanionProject: initialProjectId,
                };

                // Poll until operation is complete with timeout protection
                const MAX_RETRIES = 30;
                let retryCount = 0;
                let lroResponse: Gemini.OnboardUserResponse | undefined;
                while (retryCount < MAX_RETRIES) {
                    lroResponse = (await this.callEndpoint(
                        "onboardUser",
                        onboardRequest
                    )) as Gemini.OnboardUserResponse;
                    if (lroResponse.done) {
                        break;
                    }
                    // Reduced polling interval for faster discovery
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    retryCount++;
                }

                if (!lroResponse?.done) {
                    this.logger.warn(
                        "Project discovery timed out, continuing without project ID"
                    );
                    return null;
                }

                this.projectId =
                    lroResponse.response?.cloudaicompanionProject?.id ?? null;
                return this.projectId;
            } catch (error: unknown) {
                // Project ID discovery is optional - log warning but don't throw
                this.logger.warn(
                    "Failed to discover project ID (this is optional)",
                    error
                );
                return null;
            } finally {
                this.projectIdPromise = null;
            }
        })();

        return this.projectIdPromise;
    }

    private async callEndpoint(
        method: string,
        body: Record<string, unknown>,
        retryCount: number = 0
    ): Promise<unknown> {
        const { token } = await this.authClient.getAccessToken();
        const response = await fetch(
            `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();

            // Handle 429 rate limit and 403 forbidden errors with OAuth rotation
            if (
                (response.status === 429 || response.status === 403) &&
                retryCount < OAuthRotator.getInstance().getAccountCount() &&
                OAuthRotator.getInstance().isRotationEnabled()
            ) {
                const currentAccount =
                    OAuthRotator.getInstance().getCurrentAccountPath();
                const filename = currentAccount
                    ? path.basename(currentAccount)
                    : "unknown";
                this.logger.warn(
                    `Error ${response.status} detected on account ${filename}. Message: ${errorText}`
                );
                this.logger.info(
                    `Attempting OAuth rotation due to ${response.status}...`
                );

                try {
                    // Rotate to next account
                    const rotatedPath =
                        await OAuthRotator.getInstance().rotateCredentials();

                    if (rotatedPath) {
                        this.logger.info(
                            `OAuth rotation complete, using: ${rotatedPath}`
                        );

                        // Reload credentials from disk after rotation
                        await this.reloadCredentials(rotatedPath);

                        // Re-discover project ID for the new OAuth account
                        const newProjectId = await this.discoverProjectId();
                        this.logger.info(
                            `Project ID re-discovered after rotation: ${
                                newProjectId ?? "none"
                            }`
                        );

                        // Update the request body with new project ID if discovery succeeded
                        if (newProjectId && body.cloudaicompanionProject) {
                            body.cloudaicompanionProject = newProjectId;
                            this.logger.info(
                                `Updated request with new project ID: ${newProjectId}`
                            );
                        }

                        // Retry request with new credentials
                        try {
                            return await this.callEndpoint(
                                method,
                                body,
                                retryCount + 1
                            );
                        } catch (retryError) {
                            // If the retry failed, we check if we should continue rotating
                            // The recursive call will handle further rotations if applicable
                            // We only throw here if we've exhausted retries or rotation is disabled
                            if (
                                retryCount + 1 >=
                                OAuthRotator.getInstance().getAccountCount()
                            ) {
                                const accountCount =
                                    OAuthRotator.getInstance().getAccountCount();
                                throw new GeminiApiError(
                                    `All ${accountCount} OAuth accounts have been exhausted. Last error: ${response.status}`,
                                    response.status,
                                    errorText
                                );
                            }
                            throw retryError;
                        }
                    }
                } catch (rotationError) {
                    // Rotation failed, log and proceed with original error
                    this.logger.error(
                        "OAuth rotation failed, proceeding with original error",
                        rotationError
                    );
                }
            }

            throw new GeminiApiError(
                `API call failed with status ${response.status}: ${errorText}`,
                response.status,
                errorText
            );
        }

        return response.json();
    }

    /**
     * Get non-streaming completion from Gemini API.
     */
    async getCompletion(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        retryCount: number = 0,
        isExplicitModelRequest: boolean = false
    ): Promise<{
        content: string;
        reasoning?: string;
        tool_calls?: OpenAI.ToolCall[];
        usage?: {
            inputTokens: number;
            outputTokens: number;
        };
        _autoSwitchNotification?: string;
    }> {
        try {
            const chunks: OpenAI.StreamChunk[] = [];
            for await (const chunk of this.streamContent(
                geminiCompletionRequest,
                retryCount,
                isExplicitModelRequest
            )) {
                chunks.push(chunk);
            }

            let content = "";
            let reasoning = "";
            const tool_calls: OpenAI.ToolCall[] = [];
            let usage:
                | { inputTokens: number; outputTokens: number }
                | undefined;

            for (const chunk of chunks) {
                if (chunk.choices[0].delta.content) {
                    content += chunk.choices[0].delta.content;
                }
                if (chunk.choices[0].delta.reasoning) {
                    reasoning += chunk.choices[0].delta.reasoning;
                }
                if (chunk.choices[0].delta.tool_calls) {
                    tool_calls.push(...chunk.choices[0].delta.tool_calls);
                }
                if (chunk.usage) {
                    usage = {
                        inputTokens: chunk.usage.prompt_tokens,
                        outputTokens: chunk.usage.completion_tokens,
                    };
                }
            }

            return {
                content,
                reasoning: reasoning || undefined,
                tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
                usage,
            };
        } catch (error) {
            if (
                error instanceof GeminiApiError &&
                !this.disableAutoModelSwitch &&
                this.autoSwitcher.isRateLimitError(error.statusCode) &&
                this.autoSwitcher.shouldAttemptFallback(
                    geminiCompletionRequest.model,
                    isExplicitModelRequest
                )
            ) {
                // Attempt fallback using auto-switching helper
                return (await this.autoSwitcher.handleNonStreamingFallback(
                    geminiCompletionRequest.model,
                    error.statusCode,
                    geminiCompletionRequest,
                    async (model: string, data: RetryableRequestData) => {
                        const updatedRequest = {
                            ...data,
                            model,
                        } as Gemini.ChatCompletionRequest;
                        return await this.getCompletion(
                            updatedRequest,
                            retryCount
                        );
                    }
                )) as Promise<{
                    content: string;
                    tool_calls?: OpenAI.ToolCall[];
                    usage?: {
                        inputTokens: number;
                        outputTokens: number;
                    };
                    _autoSwitchNotification?: string;
                }>;
            }
            throw error;
        }
    }

    /**
     * Stream content from Gemini API.
     */
    async *streamContent(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        retryCount: number = 0,
        isExplicitModelRequest: boolean = false
    ): AsyncGenerator<OpenAI.StreamChunk> {
        try {
            yield* this.streamContentInternal(
                geminiCompletionRequest,
                retryCount
            );
        } catch (error) {
            if (
                error instanceof GeminiApiError &&
                !this.disableAutoModelSwitch &&
                this.autoSwitcher.isRateLimitError(error.statusCode) &&
                this.autoSwitcher.shouldAttemptFallback(
                    geminiCompletionRequest.model,
                    isExplicitModelRequest
                )
            ) {
                // eslint-disable-next-line @typescript-eslint/no-this-alias
                const self = this;
                yield* this.autoSwitcher.handleStreamingFallback(
                    geminiCompletionRequest.model,
                    error.statusCode,
                    geminiCompletionRequest,
                    async function* (
                        model: string,
                        data: RetryableRequestData
                    ) {
                        const updatedRequest = {
                            ...data,
                            model,
                        } as Gemini.ChatCompletionRequest;
                        // Create new client instance to reset firstChunk state
                        const fallbackClient = new GeminiApiClient(
                            self.authClient,
                            self.googleCloudProject,
                            self.disableAutoModelSwitch
                        );
                        yield* fallbackClient.streamContent(
                            updatedRequest,
                            retryCount
                        );
                    },
                    "openai"
                ) as AsyncIterable<OpenAI.StreamChunk>;
                return;
            }
            throw error;
        }
    }

    /**
     * Internal streaming method with no retry logic
     */
    private async *streamContentInternal(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        retryCount: number = 0
    ): AsyncGenerator<OpenAI.StreamChunk> {
        const { token } = await this.authClient.getAccessToken();
        const response = await fetch(
            `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(geminiCompletionRequest),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();

            // Handle 401 errors with token refresh
            if (response.status === 401 && retryCount === 0) {
                this.logger.info(
                    "Got 401 error, forcing token refresh and retrying..."
                );
                this.authClient.credentials.access_token = undefined;
                yield* this.streamContentInternal(
                    geminiCompletionRequest,
                    retryCount + 1
                );
                return;
            }

            // Handle 429 rate limit and 403 forbidden errors with OAuth rotation
            if (
                (response.status === 429 || response.status === 403) &&
                retryCount < OAuthRotator.getInstance().getAccountCount() &&
                OAuthRotator.getInstance().isRotationEnabled()
            ) {
                const currentAccount =
                    OAuthRotator.getInstance().getCurrentAccountPath();
                const filename = currentAccount
                    ? path.basename(currentAccount)
                    : "unknown";
                this.logger.warn(
                    `Error ${response.status} detected in stream on account ${filename}. Message: ${errorText}`
                );
                this.logger.info(
                    `Attempting OAuth rotation in stream due to ${response.status}...`
                );

                try {
                    // Rotate to next account
                    const rotatedPath =
                        await OAuthRotator.getInstance().rotateCredentials();

                    if (rotatedPath) {
                        this.logger.info(
                            `OAuth rotation complete (stream), using: ${rotatedPath}`
                        );

                        // Reload credentials from disk after rotation
                        await this.reloadCredentials(rotatedPath);

                        // Re-discover project ID for the new OAuth account
                        const newProjectId = await this.discoverProjectId();
                        this.logger.info(
                            `Project ID re-discovered after rotation: ${
                                newProjectId ?? "none"
                            }`
                        );

                        // Update the request with new project ID
                        if (newProjectId) {
                            geminiCompletionRequest.project = newProjectId;
                            this.logger.info(
                                `Updated stream request with new project ID: ${newProjectId}`
                            );
                        }

                        // Retry stream with new credentials
                        try {
                            yield* this.streamContentInternal(
                                geminiCompletionRequest,
                                retryCount + 1
                            );
                            return;
                        } catch (retryError) {
                            // Check if all accounts are exhausted
                            if (
                                retryCount + 1 >=
                                OAuthRotator.getInstance().getAccountCount()
                            ) {
                                const accountCount =
                                    OAuthRotator.getInstance().getAccountCount();
                                throw new GeminiApiError(
                                    `All ${accountCount} OAuth accounts have been exhausted. Last error: ${response.status}`,
                                    response.status,
                                    errorText
                                );
                            }
                            throw retryError;
                        }
                    }
                } catch (rotationError) {
                    // Rotation failed, log and proceed with original error
                    this.logger.error(
                        "OAuth rotation failed in stream, proceeding with original error",
                        rotationError
                    );
                }
            }

            throw new GeminiApiError(
                `Stream request failed: ${response.status} ${errorText}`,
                response.status,
                errorText
            );
        }

        if (!response.body) {
            throw new Error("Response has no body");
        }

        let toolCallId: string | undefined = undefined;
        let usageData: OpenAI.UsageData | undefined;
        let reasoningTokens = 0;

        for await (const jsonData of this.parseSSEStream(response.body)) {
            const candidate = jsonData.response?.candidates?.[0];

            if (candidate?.content?.parts) {
                for (const part of candidate.content.parts as Gemini.Part[]) {
                    if ("text" in part) {
                        // Handle text content
                        if (part.thought === true) {
                            // Handle thinking/reasoning content from Gemini
                            // Send as separate reasoning field for Kilo Code compatibility
                            const reasoningDelta: OpenAI.StreamDelta = {
                                reasoning: part.text,
                            };
                            if (this.firstChunk) {
                                reasoningDelta.role = "assistant";
                                this.firstChunk = false;
                            }
                            yield this.createOpenAIChunk(
                                reasoningDelta,
                                geminiCompletionRequest.model
                            );
                        } else {
                            // Handle regular content
                            const delta: OpenAI.StreamDelta = {
                                content: part.text,
                            };
                            if (this.firstChunk) {
                                delta.role = "assistant";
                                this.firstChunk = false;
                            }
                            yield this.createOpenAIChunk(
                                delta,
                                geminiCompletionRequest.model
                            );
                        }
                    } else if ("functionCall" in part) {
                        // Handle function calls from Gemini
                        toolCallId = `call_${crypto.randomUUID()}`;
                        const delta: OpenAI.StreamDelta = {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: toolCallId,
                                    type: "function",
                                    function: {
                                        name: part.functionCall.name,
                                        arguments: JSON.stringify(
                                            part.functionCall.args
                                        ),
                                    },
                                },
                            ],
                        };

                        if (this.firstChunk) {
                            delta.role = "assistant";
                            delta.content = null;
                            this.firstChunk = false;
                        }

                        yield this.createOpenAIChunk(
                            delta,
                            geminiCompletionRequest.model
                        );
                    }
                }
            }

            if (jsonData.response?.usageMetadata) {
                const usage = jsonData.response.usageMetadata;
                const prompt_tokens = usage.promptTokenCount ?? 0;
                const completion_tokens = usage.candidatesTokenCount ?? 0;
                reasoningTokens = usage.thoughtsTokenCount ?? 0;
                usageData = {
                    prompt_tokens,
                    completion_tokens,
                    total_tokens: prompt_tokens + completion_tokens,
                };
            }
        }

        // Send final chunk with usage data
        const finishReason = toolCallId ? "tool_calls" : "stop";
        const finalChunk = this.createOpenAIChunk(
            {},
            geminiCompletionRequest.model,
            finishReason
        );

        if (usageData) {
            finalChunk.usage = usageData;
            // Include reasoning tokens in usage if available
            if (reasoningTokens > 0) {
                finalChunk.usage.completion_tokens += reasoningTokens;
                finalChunk.usage.total_tokens += reasoningTokens;
            }
        }

        yield finalChunk;
    }

    /**
     * Creates an OpenAI stream chunk with the given delta
     */
    private createOpenAIChunk(
        delta: OpenAI.StreamDelta,
        modelId: string,
        finishReason: string | null = null
    ): OpenAI.StreamChunk {
        return {
            id: this.chatID,
            object: OPENAI_CHAT_COMPLETION_OBJECT,
            created: this.creationTime,
            model: modelId,
            choices: [
                {
                    index: 0,
                    delta,
                    finish_reason: finishReason,
                    logprobs: null,
                },
            ],
            usage: null,
        };
    }

    /**
     * Parses a server-sent event (SSE) stream from the Gemini API.
     */
    private async *parseSSEStream(
        stream: ReadableStream<Uint8Array>
    ): AsyncGenerator<Gemini.Response> {
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let objectBuffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                if (objectBuffer) {
                    try {
                        yield JSON.parse(objectBuffer);
                    } catch (e) {
                        this.logger.error(
                            "Error parsing final SSE JSON object",
                            e
                        );
                    }
                }
                break;
            }

            buffer += value;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim() === "") {
                    if (objectBuffer) {
                        try {
                            yield JSON.parse(objectBuffer);
                        } catch (e) {
                            this.logger.error(
                                "Error parsing SSE JSON object",
                                e
                            );
                        }
                        objectBuffer = "";
                    }
                } else if (line.startsWith("data: ")) {
                    objectBuffer += line.substring(6);
                }
            }
        }
    }
}
