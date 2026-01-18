/**
 * Antigravity-specific types and model definitions
 */

// Available Antigravity models (Claude + Gemini 3)
export enum AntigravityModel {
    // Claude models via Antigravity
    CLAUDE_SONNET_4_5 = "claude-sonnet-4-5",
    CLAUDE_SONNET_4_5_THINKING = "claude-sonnet-4-5-thinking",
    CLAUDE_OPUS_4_5_THINKING = "claude-opus-4-5-thinking",

    // Gemini 3 models via Antigravity
    GEMINI_3_PRO_HIGH = "gemini-3-pro-high",
    GEMINI_3_PRO_LOW = "gemini-3-pro-low",
    GEMINI_3_FLASH_HIGH = "gemini-3-flash-high",
    GEMINI_3_FLASH_MEDIUM = "gemini-3-flash-medium",
    GEMINI_3_FLASH_LOW = "gemini-3-flash-low",
    GEMINI_3_FLASH_MINIMAL = "gemini-3-flash-minimal",

    // GPT-OSS models
    GPT_OSS_120B_MEDIUM = "gpt-oss-120b-medium",
}

// Gemini CLI quota models (separate quota from Antigravity)
export enum GeminiCliModel {
    GEMINI_2_5_FLASH = "gemini-2.5-flash",
    GEMINI_2_5_PRO = "gemini-2.5-pro",
    GEMINI_3_FLASH_PREVIEW = "gemini-3-flash-preview",
    GEMINI_3_PRO_PREVIEW = "gemini-3-pro-preview",
}

// Request part types
export interface TextPart {
    text: string;
    thought?: boolean;
    thoughtSignature?: string;
}

export interface FunctionCallPart {
    functionCall: {
        name: string;
        args: Record<string, unknown>;
        id?: string;
    };
    thoughtSignature?: string;
}

export interface FunctionResponsePart {
    functionResponse: {
        name: string;
        id?: string;
        response: Record<string, unknown>;
    };
    thoughtSignature?: string;
}

export type Part = TextPart | FunctionCallPart | FunctionResponsePart;

// Content structure
export interface Content {
    role: "user" | "model";
    parts: Part[];
}

// System instruction
export interface SystemInstruction {
    parts: TextPart[];
}

// Function declaration
export interface FunctionDeclaration {
    name: string;
    description?: string;
    parameters?: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

// Tool definition
export interface Tool {
    functionDeclarations?: FunctionDeclaration[];
}

// Thinking config for extended reasoning
export interface ThinkingConfig {
    thinkingBudget?: number;
    includeThoughts?: boolean;
}

// Generation config
export interface GenerationConfig {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    thinkingConfig?: ThinkingConfig;
}

// Request structure (inner request object)
export interface AntigravityRequest {
    contents: Content[];
    systemInstruction?: SystemInstruction;
    generationConfig?: GenerationConfig;
    tools?: Tool[];
}

// Full API request
export interface AntigravityChatCompletionRequest {
    project: string;
    model: string;
    request: AntigravityRequest;
    userAgent?: string;
    requestId?: string;
}

// Response candidate
export interface ResponseCandidate {
    content: {
        role: "model";
        parts: Part[];
    };
    finishReason?: "STOP" | "MAX_TOKENS" | "OTHER";
}

// Usage metadata
export interface UsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
}

// API response
export interface AntigravityResponse {
    response: {
        candidates: ResponseCandidate[];
        usageMetadata?: UsageMetadata;
        modelVersion?: string;
        responseId?: string;
    };
    traceId?: string;
}

// Project discovery response
export interface ProjectDiscoveryResponse {
    cloudaicompanionProject?: string | { id: string };
    allowedTiers?: { id: string; isDefault?: boolean }[];
}

// Onboard user response
export interface OnboardUserResponse {
    done?: boolean;
    response?: {
        cloudaicompanionProject?: {
            id: string;
        };
    };
}

// Determine if a model is Antigravity or Gemini CLI
export function isAntigravityModel(model: string): boolean {
    // Check if it's a known Antigravity model
    const antigravityModels = Object.values(AntigravityModel) as string[];
    if (antigravityModels.includes(model)) {
        return true;
    }

    // Models with ":antigravity" suffix use Antigravity quota
    if (model.endsWith(":antigravity")) {
        return true;
    }

    // Claude models always use Antigravity
    if (model.startsWith("claude-")) {
        return true;
    }

    // Gemini 3 without preview suffix uses Antigravity
    if (
        model.startsWith("gemini-3-") &&
        !model.includes("preview") &&
        !model.includes("cli")
    ) {
        return true;
    }

    return false;
}

// Get the actual model ID for Antigravity API
export function getAntigravityModelId(model: string): string {
    // Remove :antigravity suffix if present
    if (model.endsWith(":antigravity")) {
        return model.replace(":antigravity", "");
    }
    return model;
}

// Model fallback mapping for rate limits
export const ANTIGRAVITY_MODEL_FALLBACK: Record<string, string | null> = {
    "claude-opus-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-sonnet-4-5-thinking": "claude-sonnet-4-5",
    "claude-sonnet-4-5": null,
    "gemini-3-pro-high": "gemini-3-pro-low",
    "gemini-3-pro-low": "gemini-3-flash-high",
    "gemini-3-flash-high": "gemini-3-flash-medium",
    "gemini-3-flash-medium": "gemini-3-flash-low",
    "gemini-3-flash-low": "gemini-3-flash-minimal",
    "gemini-3-flash-minimal": null,
};
