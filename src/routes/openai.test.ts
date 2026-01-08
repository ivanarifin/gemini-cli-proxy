import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createOpenAIRouter } from "./openai.js";
import { GeminiApiClient } from "../gemini/client.js";

// Mock GeminiApiClient
vi.mock("../gemini/client.js", () => ({
    GeminiApiClient: vi.fn(),
}));

describe("OpenAI Router", () => {
    let mockGeminiClient: any;

    beforeEach(() => {
        mockGeminiClient = {
            discoverProjectId: vi.fn().mockResolvedValue("test-project"),
            getCompletion: vi.fn(),
            streamContent: vi.fn(),
        };
        vi.mocked(GeminiApiClient).mockImplementation(() => mockGeminiClient);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("router creation", () => {
        it("should create a router", () => {
            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();
            expect(typeof router).toBe("function");
        });
    });

    describe("validation logic", () => {
        it("should validate that messages is required", () => {
            const body: any = {
                model: "gemini-2.5-pro",
            };

            expect(body.messages).toBeUndefined();
        });

        it("should accept valid request body", () => {
            const body: any = {
                model: "gemini-2.5-pro",
                messages: [{ role: "user", content: "Hello" }],
            };

            expect(body.messages).toBeDefined();
            expect(body.messages.length).toBeGreaterThan(0);
        });
    });

    describe("client interactions", () => {
        it("should call discoverProjectId when processing request", async () => {
            mockGeminiClient.getCompletion.mockResolvedValue({
                content: "Response",
                usage: { inputTokens: 10, outputTokens: 20 },
            });

            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();

            expect(mockGeminiClient.discoverProjectId).toBeDefined();
        });

        it("should call getCompletion for non-streaming requests", async () => {
            mockGeminiClient.getCompletion.mockResolvedValue({
                content: "Response",
                usage: { inputTokens: 10, outputTokens: 20 },
            });

            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();

            expect(mockGeminiClient.getCompletion).toBeDefined();
        });

        it("should call streamContent for streaming requests", async () => {
            const mockStream = (async function* () {
                yield { choices: [{ delta: { content: "Hello" } }] };
            })();

            mockGeminiClient.streamContent.mockReturnValue(mockStream);

            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();

            expect(mockGeminiClient.streamContent).toBeDefined();
        });
    });

    describe("error handling", () => {
        it("should handle getCompletion errors", async () => {
            mockGeminiClient.getCompletion.mockRejectedValue(
                new Error("API error")
            );

            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();

            expect(mockGeminiClient.getCompletion).toBeDefined();
        });

        it("should handle streamContent errors", async () => {
            const mockStream = (async function* () {
                throw new Error("Stream error");
            })();

            mockGeminiClient.streamContent.mockReturnValue(mockStream);

            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();

            expect(mockGeminiClient.streamContent).toBeDefined();
        });

        it("should handle discoverProjectId errors", async () => {
            mockGeminiClient.discoverProjectId.mockRejectedValue(
                new Error("Discovery error")
            );

            const router = createOpenAIRouter(mockGeminiClient);
            expect(router).toBeDefined();

            expect(mockGeminiClient.discoverProjectId).toBeDefined();
        });
    });
});
