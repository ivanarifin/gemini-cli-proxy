/**
 * Antigravity OAuth and API Constants
 * These are separate from Gemini CLI credentials
 */

// Antigravity OAuth Client ID
export const ANTIGRAVITY_CLIENT_ID =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

// Antigravity OAuth Client Secret
export const ANTIGRAVITY_CLIENT_SECRET = "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";

// OAuth Scopes for Antigravity
export const ANTIGRAVITY_SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;

// Antigravity API Endpoints (in fallback order)
export const ANTIGRAVITY_ENDPOINT_DAILY =
    "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH =
    "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

// Endpoint fallback order for requests (daily -> autopush -> prod)
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_AUTOPUSH,
    ANTIGRAVITY_ENDPOINT_PROD,
] as const;

// Endpoint order for loadCodeAssist (prod first, then fallbacks)
export const ANTIGRAVITY_LOAD_ENDPOINTS = [
    ANTIGRAVITY_ENDPOINT_PROD,
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;

// Primary endpoint to use
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_DAILY;

// API Version
export const ANTIGRAVITY_API_VERSION = "v1internal";

// Default project ID when Antigravity doesn't return one
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

// Antigravity-specific headers
export const ANTIGRAVITY_HEADERS = {
    "User-Agent": "antigravity/1.11.5 windows/amd64",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata":
        '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;

// Gemini CLI headers (for Gemini CLI quota models)
export const GEMINI_CLI_HEADERS = {
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata":
        "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
} as const;

// Request timeout
export const ANTIGRAVITY_REQUEST_TIMEOUT_MS = 600000; // 10 minutes

// OpenAI compatibility
export const ANTIGRAVITY_CHAT_COMPLETION_OBJECT = "chat.completion.chunk";

// System instruction for Antigravity
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>
`;

// Tool description prompt for parameter injection
export const CLAUDE_DESCRIPTION_PROMPT = "\n\n⚠️ STRICT PARAMETERS: {params}.";

// Empty schema placeholder
export const EMPTY_SCHEMA_PLACEHOLDER_NAME = "_placeholder";
export const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION =
    "Placeholder. Always pass true.";

// Skip thought signature sentinel
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
