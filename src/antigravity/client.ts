/**
 * Antigravity API Client with endpoint fallbacks
 * Supports both Antigravity quota (Claude, Gemini 3) and Gemini CLI quota
 */

import { OAuth2Client, Credentials } from "google-auth-library";
import { Agent } from "undici";
import * as OpenAI from "../types/openai.js";
import * as Antigravity from "./types.js";
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_LOAD_ENDPOINTS,
    ANTIGRAVITY_API_VERSION,
    ANTIGRAVITY_HEADERS,
    GEMINI_CLI_HEADERS,
    ANTIGRAVITY_REQUEST_TIMEOUT_MS,
    ANTIGRAVITY_DEFAULT_PROJECT_ID,
    ANTIGRAVITY_CHAT_COMPLETION_OBJECT,
    ANTIGRAVITY_ENDPOINT_PROD,
} from "./constant.js";
import {
    getAntigravityCachedCredentialPath,
    getAntigravityRequestCountsPath,
} from "./paths.js";
import { AntigravityOAuthRotator } from "./oauth-rotator.js";
import { getLogger, Logger } from "../utils/logger.js";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";

/**
 * Custom error class for Antigravity API errors
 */
export class AntigravityApiError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly responseText?: string,
        public readonly endpoint?: string,
    ) {
        super(message);
        this.name = "AntigravityApiError";
    }
}

/**
 * Header style for API requests
 */
export type HeaderStyle = "antigravity" | "gemini-cli";

/**
 * Antigravity API Client
 */
export class AntigravityApiClient {
    private static readonly dispatcher = new Agent({
        headersTimeout: 300000, // 5 minutes
        bodyTimeout: ANTIGRAVITY_REQUEST_TIMEOUT_MS,
    });

    private projectId: string | null = null;
    private projectIdPromise: Promise<string | null> | null = null;
    private firstChunk: boolean = true;
    private readonly creationTime: number;
    private readonly chatID: string;
    private readonly logger: Logger;
    private _lastThoughtSignature: string | undefined = undefined;
    private currentEndpointIndex: number = 0;

    constructor(
        private readonly authClient: OAuth2Client,
        private readonly googleCloudProject: string | undefined,
        private readonly disableAutoModelSwitch: boolean,
    ) {
        this.googleCloudProject = googleCloudProject;
        this.chatID = `chat-${crypto.randomUUID()}`;
        this.creationTime = Math.floor(Date.now() / 1000);
        this.logger = getLogger("ANTIGRAVITY-CLIENT", chalk.magenta);

        // Eagerly start project discovery
        void this.discoverProjectId();
    }

    /**
     * Increment request count for the current account
     */
    private async incrementRequestCount(): Promise<void> {
        try {
            const currentAccountPath =
                AntigravityOAuthRotator.getInstance().getCurrentAccountPath();
            let accountId = "default";

            if (currentAccountPath) {
                accountId = path
                    .basename(currentAccountPath)
                    .replace("oauth_creds_", "")
                    .replace(".json", "");
            }

            const countsPath = getAntigravityRequestCountsPath();
            let counts = {
                requests: {} as Record<string, number>,
                lastReset: new Date().toDateString(),
            };

            if (existsSync(countsPath)) {
                const data = await fs.readFile(countsPath, "utf-8");
                counts = JSON.parse(data);
            }

            const today = new Date().toDateString();
            if (counts.lastReset !== today) {
                counts.requests = {};
                counts.lastReset = today;
            }

            counts.requests[accountId] = (counts.requests[accountId] || 0) + 1;

            await fs.writeFile(countsPath, JSON.stringify(counts, null, 2));
        } catch (error) {
            this.logger.warn("Failed to increment request count", error);
        }
    }

    public get lastThoughtSignature(): string | undefined {
        return this._lastThoughtSignature;
    }

    /**
     * Get the current endpoint based on fallback index
     */
    private getCurrentEndpoint(isAntigravityModel: boolean): string {
        if (!isAntigravityModel) {
            // Gemini CLI models use prod endpoint
            return ANTIGRAVITY_ENDPOINT_PROD;
        }
        return ANTIGRAVITY_ENDPOINT_FALLBACKS[this.currentEndpointIndex];
    }

    /**
     * Get headers based on model type
     */
    private getHeaders(
        token: string,
        isAntigravityModel: boolean,
    ): Record<string, string> {
        const baseHeaders = isAntigravityModel
            ? ANTIGRAVITY_HEADERS
            : GEMINI_CLI_HEADERS;
        return {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...baseHeaders,
        };
    }

    /**
     * Reload credentials from disk after OAuth rotation
     */
    private async reloadCredentials(
        sourceFilePath?: string | null,
    ): Promise<void> {
        const credentialPath = getAntigravityCachedCredentialPath();

        try {
            const creds = await fs.readFile(credentialPath, "utf-8");
            const credentials = JSON.parse(creds) as Credentials;
            this.authClient.setCredentials(credentials);
            this.logger.info(
                "Credentials reloaded from disk after rotation",
            );

            // Reset cached projectId
            this.projectId = null;
            this.logger.info("Project ID cache cleared for new OAuth account");

            // Force token refresh
            this.logger.info(
                "Triggering token refresh after OAuth rotation...",
            );
            try {
                this.authClient.credentials.access_token = undefined;

                const refreshed = await this.authClient.refreshAccessToken();
                this.logger.info("Access token refreshed successfully");

                this.authClient.setCredentials(refreshed.credentials);

                await fs.writeFile(
                    credentialPath,
                    JSON.stringify(refreshed.credentials, null, 2),
                    { mode: 0o600 },
                );

                if (sourceFilePath) {
                    try {
                        const existingContent = await fs.readFile(
                            sourceFilePath,
                            "utf-8",
                        );
                        const existingCreds = JSON.parse(existingContent);
                        const updatedCreds = {
                            ...existingCreds,
                            ...refreshed.credentials,
                        };
                        await fs.writeFile(
                            sourceFilePath,
                            JSON.stringify(updatedCreds, null, 2),
                            { mode: 0o600 },
                        );
                    } catch (sourceError) {
                        this.logger.warn(
                            "Failed to write refreshed credentials to source file",
                            sourceError,
                        );
                    }
                }
            } catch (refreshError) {
                this.logger.warn(
                    "Failed to refresh access token after rotation",
                    refreshError,
                );
            }
        } catch (error) {
            this.logger.error(
                "Failed to reload credentials from disk",
                error,
            );
            throw error;
        }
    }

    /**
     * Discovers the Google Cloud project ID
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
                const { token } = await this.authClient.getAccessToken();
                if (!token) {
                    this.logger.warn("No access token available for project discovery");
                    return ANTIGRAVITY_DEFAULT_PROJECT_ID;
                }

                // Try each endpoint for loadCodeAssist
                for (const endpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
                    try {
                        const response = await fetch(
                            `${endpoint}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`,
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    Authorization: `Bearer ${token}`,
                                    ...ANTIGRAVITY_HEADERS,
                                },
                                body: JSON.stringify({
                                    metadata: {
                                        ideType: "IDE_UNSPECIFIED",
                                        platform: "PLATFORM_UNSPECIFIED",
                                        pluginType: "GEMINI",
                                    },
                                }),
                                signal: AbortSignal.timeout(10000),
                            },
                        );

                        if (!response.ok) {
                            continue;
                        }

                        const data =
                            (await response.json()) as Antigravity.ProjectDiscoveryResponse;

                        if (typeof data.cloudaicompanionProject === "string") {
                            this.projectId = data.cloudaicompanionProject;
                            this.logger.info(
                                `Project ID discovered: ${this.projectId}`,
                            );
                            return this.projectId;
                        }

                        if (
                            data.cloudaicompanionProject &&
                            typeof data.cloudaicompanionProject === "object" &&
                            "id" in data.cloudaicompanionProject
                        ) {
                            this.projectId = data.cloudaicompanionProject.id;
                            this.logger.info(
                                `Project ID discovered: ${this.projectId}`,
                            );
                            return this.projectId;
                        }
                    } catch (e) {
                        this.logger.warn(
                            `Failed to discover project ID from ${endpoint}`,
                            e,
                        );
                    }
                }

                // Fallback to default
                this.logger.warn(
                    "Using default project ID as discovery failed",
                );
                this.projectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
                return this.projectId;
            } catch (error) {
                this.logger.warn(
                    "Project discovery failed, using default",
                    error,
                );
                return ANTIGRAVITY_DEFAULT_PROJECT_ID;
            } finally {
                this.projectIdPromise = null;
            }
        })();

        return this.projectIdPromise;
    }

    /**
     * Make API request with endpoint fallback
     */
    private async makeRequest(
        method: string,
        body: Antigravity.AntigravityChatCompletionRequest,
        isAntigravityModel: boolean,
        retryCount: number = 0,
    ): Promise<Response> {
        const { token } = await this.authClient.getAccessToken();
        if (!token) {
            throw new AntigravityApiError("No access token available", 401);
        }

        const endpoints = isAntigravityModel
            ? ANTIGRAVITY_ENDPOINT_FALLBACKS
            : [ANTIGRAVITY_ENDPOINT_PROD];

        let lastError: AntigravityApiError | null = null;

        for (let i = 0; i < endpoints.length; i++) {
            const endpoint = endpoints[i];
            const url = `${endpoint}/${ANTIGRAVITY_API_VERSION}:${method}`;

            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: this.getHeaders(token, isAntigravityModel),
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(ANTIGRAVITY_REQUEST_TIMEOUT_MS),
                    // @ts-ignore
                    dispatcher: AntigravityApiClient.dispatcher,
                });

                if (response.ok) {
                    void this.incrementRequestCount();
                    this.currentEndpointIndex = i;
                    return response;
                }

                const errorText = await response.text();

                // Handle rate limiting with OAuth rotation
                if (
                    (response.status === 429 || response.status === 403 || response.status === 504) &&
                    retryCount < AntigravityOAuthRotator.getInstance().getAccountCount() &&
                    AntigravityOAuthRotator.getInstance().isRotationEnabled()
                ) {
                    this.logger.warn(
                        `Error ${response.status} on ${endpoint}, attempting OAuth rotation...`,
                    );

                    try {
                        const rotatedPath =
                            await AntigravityOAuthRotator.getInstance().rotateCredentials();

                        if (rotatedPath) {
                            await this.reloadCredentials(rotatedPath);
                            const newProjectId = await this.discoverProjectId();
                            if (newProjectId) {
                                body.project = newProjectId;
                            }
                            return await this.makeRequest(
                                method,
                                body,
                                isAntigravityModel,
                                retryCount + 1,
                            );
                        }
                    } catch (rotationError) {
                        this.logger.error(
                            "OAuth rotation failed",
                            rotationError,
                        );
                    }
                }

                lastError = new AntigravityApiError(
                    `API call failed: ${response.status}`,
                    response.status,
                    errorText,
                    endpoint,
                );

                // Try next endpoint for 5xx errors
                if (response.status >= 500 && i < endpoints.length - 1) {
                    this.logger.warn(
                        `Endpoint ${endpoint} returned ${response.status}, trying next...`,
                    );
                    continue;
                }

                throw lastError;
            } catch (error: any) {
                if (error instanceof AntigravityApiError) {
                    throw error;
                }
                if (
                    error.name === "TimeoutError" ||
                    error.name === "AbortError"
                ) {
                    lastError = new AntigravityApiError(
                        "Request timed out",
                        408,
                        undefined,
                        endpoint,
                    );
                    if (i < endpoints.length - 1) {
                        continue;
                    }
                    throw lastError;
                }
                throw error;
            }
        }

        throw (
            lastError ||
            new AntigravityApiError("All endpoints failed", 503)
        );
    }

    /**
     * Get non-streaming completion
     */
    async getCompletion(
        request: Antigravity.AntigravityChatCompletionRequest,
        retryCount: number = 0,
        isExplicitModelRequest: boolean = false,
    ): Promise<{
        content: string;
        reasoning?: string;
        tool_calls?: OpenAI.ToolCall[];
        usage?: {
            inputTokens: number;
            outputTokens: number;
        };
    }> {
        const chunks: OpenAI.StreamChunk[] = [];
        for await (const chunk of this.streamContent(
            request,
            retryCount,
            isExplicitModelRequest,
        )) {
            chunks.push(chunk);
        }

        let content = "";
        let reasoning = "";
        const tool_calls: OpenAI.ToolCall[] = [];
        let usage: { inputTokens: number; outputTokens: number } | undefined;

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
    }

    /**
     * Stream content from Antigravity API
     */
    async *streamContent(
        request: Antigravity.AntigravityChatCompletionRequest,
        retryCount: number = 0,
        isExplicitModelRequest: boolean = false,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        const isAntigravityModel = Antigravity.isAntigravityModel(
            request.model,
        );

        const { token } = await this.authClient.getAccessToken();
        if (!token) {
            throw new AntigravityApiError("No access token available", 401);
        }

        const endpoints = isAntigravityModel
            ? ANTIGRAVITY_ENDPOINT_FALLBACKS
            : [ANTIGRAVITY_ENDPOINT_PROD];

        let response: Response | null = null;
        let lastError: AntigravityApiError | null = null;

        for (let i = 0; i < endpoints.length; i++) {
            const endpoint = endpoints[i];
            const url = `${endpoint}/${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`;

            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: {
                        ...this.getHeaders(token, isAntigravityModel),
                        Accept: "text/event-stream",
                    },
                    body: JSON.stringify(request),
                    signal: AbortSignal.timeout(ANTIGRAVITY_REQUEST_TIMEOUT_MS),
                    // @ts-ignore
                    dispatcher: AntigravityApiClient.dispatcher,
                });

                if (response.ok) {
                    void this.incrementRequestCount();
                    this.currentEndpointIndex = i;
                    break;
                }

                const errorText = await response.text();

                // Handle rate limiting with OAuth rotation
                if (
                    (response.status === 429 || response.status === 403 || response.status === 504) &&
                    retryCount < AntigravityOAuthRotator.getInstance().getAccountCount() &&
                    AntigravityOAuthRotator.getInstance().isRotationEnabled()
                ) {
                    this.logger.warn(
                        `Error ${response.status} in stream, attempting OAuth rotation...`,
                    );

                    try {
                        const rotatedPath =
                            await AntigravityOAuthRotator.getInstance().rotateCredentials();

                        if (rotatedPath) {
                            await this.reloadCredentials(rotatedPath);
                            const newProjectId = await this.discoverProjectId();
                            if (newProjectId) {
                                request.project = newProjectId;
                            }
                            yield* this.streamContent(
                                request,
                                retryCount + 1,
                                isExplicitModelRequest,
                            );
                            return;
                        }
                    } catch (rotationError) {
                        this.logger.error(
                            "OAuth rotation failed",
                            rotationError,
                        );
                    }
                }

                lastError = new AntigravityApiError(
                    `Stream request failed: ${response.status}`,
                    response.status,
                    errorText,
                    endpoint,
                );

                if (response.status >= 500 && i < endpoints.length - 1) {
                    this.logger.warn(
                        `Endpoint ${endpoint} returned ${response.status}, trying next...`,
                    );
                    continue;
                }

                throw lastError;
            } catch (error: any) {
                if (error instanceof AntigravityApiError) {
                    throw error;
                }
                if (
                    error.name === "TimeoutError" ||
                    error.name === "AbortError"
                ) {
                    lastError = new AntigravityApiError(
                        "Stream request timed out",
                        408,
                        undefined,
                        endpoint,
                    );
                    if (i < endpoints.length - 1) {
                        continue;
                    }
                    throw lastError;
                }
                throw error;
            }
        }

        if (!response || !response.ok) {
            throw (
                lastError ||
                new AntigravityApiError("All endpoints failed", 503)
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
                for (const part of candidate.content
                    .parts as Antigravity.Part[]) {
                    if ("text" in part) {
                        if (part.thought === true) {
                            const delta: OpenAI.StreamDelta = {
                                reasoning: part.text,
                            };
                            if (this.firstChunk) {
                                delta.role = "assistant";
                                this.firstChunk = false;
                            }
                            yield this.createOpenAIChunk(delta, request.model);
                        } else {
                            const delta: OpenAI.StreamDelta = {
                                content: part.text,
                            };
                            if (this.firstChunk) {
                                delta.role = "assistant";
                                this.firstChunk = false;
                            }
                            yield this.createOpenAIChunk(delta, request.model);
                        }
                        if (part.thoughtSignature) {
                            this._lastThoughtSignature = part.thoughtSignature;
                        }
                    } else if ("functionCall" in part) {
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
                                            part.functionCall.args,
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

                        yield this.createOpenAIChunk(delta, request.model);
                        if (part.thoughtSignature) {
                            this._lastThoughtSignature = part.thoughtSignature;
                        }
                    } else if ("functionResponse" in part) {
                        if (part.thoughtSignature) {
                            this._lastThoughtSignature = part.thoughtSignature;
                        }
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

        let finishReason = toolCallId ? "tool_calls" : "stop";
        if (toolCallId && this._lastThoughtSignature && finishReason === "stop") {
            finishReason = "tool_calls";
        }

        const finalChunk = this.createOpenAIChunk(
            {},
            request.model,
            finishReason,
        );

        if (usageData) {
            finalChunk.usage = usageData;
            if (reasoningTokens > 0) {
                finalChunk.usage.completion_tokens += reasoningTokens;
                finalChunk.usage.total_tokens += reasoningTokens;
            }
        }

        yield finalChunk;
    }

    /**
     * Creates an OpenAI stream chunk
     */
    private createOpenAIChunk(
        delta: OpenAI.StreamDelta,
        modelId: string,
        finishReason: string | null = null,
    ): OpenAI.StreamChunk {
        return {
            id: this.chatID,
            object: ANTIGRAVITY_CHAT_COMPLETION_OBJECT,
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
     * Parses a server-sent event (SSE) stream
     */
    private async *parseSSEStream(
        stream: ReadableStream<Uint8Array>,
    ): AsyncGenerator<Antigravity.AntigravityResponse> {
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
                            e,
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
                                e,
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
