/**
 * Antigravity OpenAI Mapper
 * Maps OpenAI Chat Completion requests to Antigravity format
 */

import * as OpenAI from "../types/openai.js";
import * as Antigravity from "./types.js";
import {
    ANTIGRAVITY_SYSTEM_INSTRUCTION,
    CLAUDE_DESCRIPTION_PROMPT,
    EMPTY_SCHEMA_PLACEHOLDER_NAME,
    EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
    SKIP_THOUGHT_SIGNATURE,
} from "./constant.js";

/**
 * Map OpenAI Chat Completion request to Antigravity format
 */
export function mapOpenAIToAntigravity(
    projectId: string,
    request: OpenAI.ChatCompletionRequest,
    enableGoogleSearch: boolean = false,
    lastThoughtSignature?: string,
): Antigravity.AntigravityChatCompletionRequest {
    const modelId = Antigravity.getAntigravityModelId(request.model);
    const isThinkingModel = modelId.includes("thinking");
    const isClaudeModel = modelId.startsWith("claude-");

    // Map messages to Antigravity contents
    const contents: Antigravity.Content[] = [];
    let systemInstruction: Antigravity.SystemInstruction | undefined;

    for (const message of request.messages) {
        if (message.role === "system") {
            // Combine with Antigravity system instruction for Claude
            const systemText = isClaudeModel
                ? `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n${getMessageContent(message)}`
                : getMessageContent(message);

            systemInstruction = {
                parts: [{ text: systemText }],
            };
        } else if (message.role === "user") {
            contents.push({
                role: "user",
                parts: mapUserMessageParts(message),
            });
        } else if (message.role === "assistant") {
            contents.push({
                role: "model",
                parts: mapAssistantMessageParts(message, lastThoughtSignature),
            });
        } else if (message.role === "tool") {
            // Tool responses go as user messages with functionResponse
            const toolName = message.tool_call_id || "unknown";
            contents.push({
                role: "user",
                parts: [
                    {
                        functionResponse: {
                            name: toolName,
                            id: message.tool_call_id,
                            response: parseToolResponse(
                                typeof message.content === "string"
                                    ? message.content
                                    : null,
                            ),
                        },
                    },
                ],
            });
        }
    }

    // Add default system instruction if none provided
    if (!systemInstruction && isClaudeModel) {
        systemInstruction = {
            parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }],
        };
    }

    // Build generation config
    const generationConfig: Antigravity.GenerationConfig = {};

    if (request.max_tokens) {
        generationConfig.maxOutputTokens = request.max_tokens;
    }

    if (request.temperature !== undefined) {
        generationConfig.temperature = request.temperature;
    }

    // Add thinking config for thinking models
    if (isThinkingModel) {
        const thinkingBudget = getThinkingBudget(modelId, request);
        generationConfig.thinkingConfig = {
            thinkingBudget,
            includeThoughts: true,
        };

        // Ensure maxOutputTokens > thinkingBudget
        if (
            !generationConfig.maxOutputTokens ||
            generationConfig.maxOutputTokens <= thinkingBudget
        ) {
            generationConfig.maxOutputTokens = thinkingBudget + 8192;
        }
    }

    // Map tools
    let tools: Antigravity.Tool[] | undefined;
    if (request.tools && request.tools.length > 0) {
        tools = [
            {
                functionDeclarations: request.tools.map((tool) =>
                    mapToolToFunctionDeclaration(tool, isClaudeModel),
                ),
            },
        ];
    }

    // Build the Antigravity request
    const antigravityRequest: Antigravity.AntigravityChatCompletionRequest = {
        project: projectId,
        model: modelId,
        request: {
            contents,
            generationConfig,
        },
        userAgent: "antigravity",
        requestId: `agent-${crypto.randomUUID()}`,
    };

    if (systemInstruction) {
        antigravityRequest.request.systemInstruction = systemInstruction;
    }

    if (tools) {
        antigravityRequest.request.tools = tools;
    }

    return antigravityRequest;
}

/**
 * Get message content as string
 */
function getMessageContent(message: OpenAI.ChatMessage): string {
    if (typeof message.content === "string") {
        return message.content;
    }
    if (Array.isArray(message.content)) {
        return message.content
            .filter((part): part is OpenAI.MessageContent & { type: "text" } =>
                part.type === "text",
            )
            .map((part) => part.text || "")
            .join("\n");
    }
    return "";
}

/**
 * Map user message parts
 */
function mapUserMessageParts(message: OpenAI.ChatMessage): Antigravity.Part[] {
    if (typeof message.content === "string") {
        return [{ text: message.content }];
    }

    if (Array.isArray(message.content)) {
        return message.content.map((part) => {
            if (part.type === "text") {
                return { text: part.text || "" };
            }
            // For image_url, we'd need to handle base64 encoding
            if (part.type === "image_url") {
                return { text: "[Image content not yet supported]" };
            }
            return { text: "" };
        });
    }

    return [{ text: "" }];
}

/**
 * Map assistant message parts
 */
function mapAssistantMessageParts(
    message: OpenAI.ChatMessage,
    lastThoughtSignature?: string,
): Antigravity.Part[] {
    const parts: Antigravity.Part[] = [];

    // Handle thinking/reasoning content
    if (message.reasoning_content) {
        parts.push({
            text: message.reasoning_content,
            thought: true,
            thoughtSignature: lastThoughtSignature || SKIP_THOUGHT_SIGNATURE,
        });
    }

    // Handle regular content
    if (message.content) {
        if (typeof message.content === "string") {
            parts.push({ text: message.content });
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text" && part.text) {
                    parts.push({ text: part.text });
                }
            }
        }
    }

    // Handle tool calls
    if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
            if (toolCall.type === "function") {
                parts.push({
                    functionCall: {
                        name: toolCall.function.name,
                        args: JSON.parse(toolCall.function.arguments || "{}"),
                        id: toolCall.id,
                    },
                    thoughtSignature: lastThoughtSignature,
                });
            }
        }
    }

    // Ensure at least one part
    if (parts.length === 0) {
        parts.push({ text: "" });
    }

    return parts;
}

/**
 * Parse tool response content
 */
function parseToolResponse(
    content: string | null | undefined,
): Record<string, unknown> {
    if (!content) {
        return { result: null };
    }

    try {
        return JSON.parse(content);
    } catch {
        return { result: content };
    }
}

/**
 * Get thinking budget based on model and request
 */
function getThinkingBudget(
    modelId: string,
    request: OpenAI.ChatCompletionRequest,
): number {
    // Check reasoning effort
    const effort = request.reasoning_effort || request.reasoning?.effort;
    if (effort) {
        switch (effort) {
            case OpenAI.ReasoningEffort.low:
                return 8192;
            case OpenAI.ReasoningEffort.medium:
                return 16384;
            case OpenAI.ReasoningEffort.high:
                return 32768;
            case OpenAI.ReasoningEffort.xhigh:
                return 65536;
        }
    }

    // Default budgets based on model
    if (modelId.includes("opus")) {
        return 32768; // max for Opus
    }
    if (modelId.includes("sonnet")) {
        return 16384; // medium for Sonnet
    }
    if (modelId.includes("gemini-3-pro")) {
        return 16384;
    }
    if (modelId.includes("gemini-3-flash")) {
        return 8192;
    }

    return 8192; // default
}

/**
 * Map OpenAI tool to Antigravity function declaration
 */
function mapToolToFunctionDeclaration(
    tool: OpenAI.Tool,
    isClaudeModel: boolean,
): Antigravity.FunctionDeclaration {
    const fn = tool.function;

    // Sanitize function name (must start with letter/underscore, no slashes)
    const name = sanitizeFunctionName(fn.name);

    // Build description with parameter hints for Claude
    let description = fn.description || "";
    if (isClaudeModel && fn.parameters) {
        const paramHints = buildParameterHints(
            fn.parameters as Record<string, unknown>,
        );
        if (paramHints) {
            description += CLAUDE_DESCRIPTION_PROMPT.replace(
                "{params}",
                paramHints,
            );
        }
    }

    // Transform parameters schema
    const parameters = fn.parameters
        ? transformSchema(fn.parameters as Record<string, unknown>)
        : undefined;

    const declaration: Antigravity.FunctionDeclaration = {
        name,
        description: description || undefined,
    };

    if (parameters) {
        declaration.parameters = parameters as {
            type: string;
            properties?: Record<string, unknown>;
            required?: string[];
        };
    }

    return declaration;
}

/**
 * Sanitize function name for Antigravity API
 */
function sanitizeFunctionName(name: string): string {
    // Replace slashes with colons (MCP style)
    let sanitized = name.replace(/\//g, ":");

    // Ensure starts with letter or underscore
    if (!/^[a-zA-Z_]/.test(sanitized)) {
        sanitized = "_" + sanitized;
    }

    // Remove invalid characters (keep alphanumeric, underscore, dot, colon, dash)
    sanitized = sanitized.replace(/[^a-zA-Z0-9_.:–-]/g, "_");

    // Truncate to max 64 characters
    if (sanitized.length > 64) {
        sanitized = sanitized.substring(0, 64);
    }

    return sanitized;
}

/**
 * Build parameter hints for Claude
 */
function buildParameterHints(parameters: Record<string, unknown>): string {
    if (!parameters.properties) {
        return "";
    }

    const props = parameters.properties as Record<
        string,
        { type?: string; description?: string }
    >;
    const required = (parameters.required as string[]) || [];

    const hints: string[] = [];
    for (const [name, prop] of Object.entries(props)) {
        const type = prop.type || "any";
        const isRequired = required.includes(name);
        hints.push(`${name} (${type}${isRequired ? ", REQUIRED" : ""})`);
    }

    return hints.join(", ");
}

/**
 * Transform JSON schema for Antigravity compatibility
 */
function transformSchema(
    schema: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
        // Skip unsupported fields
        if (
            [
                "$schema",
                "$id",
                "$ref",
                "$defs",
                "definitions",
                "default",
                "examples",
                "title",
            ].includes(key)
        ) {
            continue;
        }

        // Convert const to enum
        if (key === "const") {
            result["enum"] = [value];
            continue;
        }

        // Convert anyOf/allOf/oneOf naming
        if (key === "anyOf") {
            result["any_of"] = (value as unknown[]).map((v) =>
                transformSchema(v as Record<string, unknown>),
            );
            continue;
        }
        if (key === "allOf") {
            result["all_of"] = (value as unknown[]).map((v) =>
                transformSchema(v as Record<string, unknown>),
            );
            continue;
        }
        if (key === "oneOf") {
            result["one_of"] = (value as unknown[]).map((v) =>
                transformSchema(v as Record<string, unknown>),
            );
            continue;
        }

        // Recursively transform nested objects
        if (value && typeof value === "object" && !Array.isArray(value)) {
            result[key] = transformSchema(value as Record<string, unknown>);
        } else if (Array.isArray(value)) {
            result[key] = value.map((v) =>
                v && typeof v === "object"
                    ? transformSchema(v as Record<string, unknown>)
                    : v,
            );
        } else {
            result[key] = value;
        }
    }

    return result;
}
