import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GeminiApiClient, GeminiApiError } from "./client.js";
import { OAuth2Client } from "google-auth-library";
import { OAuthRotator } from "../utils/oauth-rotator.js";

// Mock dependencies
vi.mock("google-auth-library", () => ({
    OAuth2Client: vi.fn(),
}));

vi.mock("../utils/oauth-rotator.js", () => ({
    OAuthRotator: {
        getInstance: vi.fn(),
    },
}));

describe("GeminiApiClient", () => {
    let mockAuthClient: any;
    let mockOAuthRotator: any;

    beforeEach(() => {
        mockAuthClient = {
            getAccessToken: vi.fn(),
            credentials: {},
        };

        mockOAuthRotator = {
            isRotationEnabled: vi.fn().mockReturnValue(false),
            rotateCredentials: vi.fn(),
        };

        vi.mocked(OAuth2Client).mockImplementation(() => mockAuthClient);
        vi.mocked(OAuthRotator.getInstance).mockReturnValue(mockOAuthRotator);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("constructor", () => {
        it("should create client with auth client", () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                undefined,
                false
            );

            expect(client).toBeDefined();
            expect(client).toBeInstanceOf(GeminiApiClient);
        });

        it("should accept googleCloudProject parameter", () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            expect(client).toBeDefined();
        });

        it("should accept disableAutoModelSwitch parameter", () => {
            const client = new GeminiApiClient(mockAuthClient, undefined, true);

            expect(client).toBeDefined();
        });
    });

    describe("discoverProjectId", () => {
        it("should return provided googleCloudProject", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "provided-project",
                false
            );

            const projectId = await client.discoverProjectId();

            expect(projectId).toBe("provided-project");
        });

        it("should cache and return discovered project ID", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                undefined,
                false
            );

            // Mock successful project discovery - return cloudaicompanionProject directly
            // This avoids the onboardUser polling loop
            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    cloudaicompanionProject: "discovered-project",
                    allowedTiers: [{ id: "tier-1", isDefault: true }],
                }),
            } as Response);
            vi.stubGlobal("fetch", mockFetch);

            const projectId = await client.discoverProjectId();

            expect(projectId).toBe("discovered-project");
            expect(mockFetch).toHaveBeenCalled();

            vi.unstubAllGlobals();
        });

        it("should handle API errors during discovery", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                undefined,
                false
            );

            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                text: async () => "Internal Server Error",
            } as Response);

            await expect(client.discoverProjectId()).rejects.toThrow(
                "Could not discover project ID."
            );
        });
    });

    describe("getCompletion", () => {
        it("should return completion with content", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            // Create a proper mock stream that simulates SSE format
            const mockStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    const encoder = new TextEncoder();
                    // Send SSE data with proper format
                    controller.enqueue(
                        encoder.encode(
                            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}\n\n'
                        )
                    );
                    controller.enqueue(
                        encoder.encode(
                            'data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}}\n\n'
                        )
                    );
                    controller.close();
                },
            });

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                body: mockStream,
            } as unknown as Response);

            const result = await client.getCompletion({
                model: "test-model",
                contents: [{ role: "user", parts: [{ text: "Hello" }] }],
            } as any);

            expect(result).toBeDefined();
            expect(result.content).toBe("Hello");
            expect(result.usage).toEqual({
                inputTokens: 10,
                outputTokens: 5,
            });
        });

        it("should handle API errors", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                text: async () => "Internal Server Error",
            } as Response);

            await expect(
                client.getCompletion({
                    model: "test-model",
                    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
                } as any)
            ).rejects.toThrow(GeminiApiError);
        });
    });

    describe("streamContent", () => {
        it("should yield stream chunks", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            // Create a proper mock stream that simulates SSE format
            const mockStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    const encoder = new TextEncoder();
                    // Send SSE data with proper format
                    controller.enqueue(
                        encoder.encode(
                            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}\n\n'
                        )
                    );
                    controller.enqueue(
                        encoder.encode(
                            'data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}}\n\n'
                        )
                    );
                    controller.close();
                },
            });

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                body: mockStream,
            } as unknown as Response);

            const chunks = [];
            for await (const chunk of client.streamContent({
                model: "test-model",
                contents: [{ role: "user", parts: [{ text: "Hello" }] }],
            } as any)) {
                chunks.push(chunk);
            }

            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks[0].choices[0].delta.content).toBe("Hello");
        });

        it("should handle API errors in stream", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                text: async () => "Internal Server Error",
            } as Response);

            const stream = client.streamContent({
                model: "test-model",
                contents: [{ role: "user", parts: [{ text: "Hello" }] }],
            } as any);

            await expect(async () => {
                for await (const _ of stream) {
                    // Should throw before yielding
                }
            }).rejects.toThrow(GeminiApiError);
        });
    });

    describe("OAuth rotation", () => {
        it("should attempt OAuth rotation on 429 errors", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            mockOAuthRotator.isRotationEnabled.mockReturnValue(true);
            mockOAuthRotator.rotateCredentials.mockResolvedValue(
                "/path/to/creds.json"
            );

            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 429,
                text: async () => "Rate limit exceeded",
            } as Response);

            await expect(
                client.getCompletion({
                    model: "test-model",
                    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
                } as any)
            ).rejects.toThrow();

            expect(mockOAuthRotator.rotateCredentials).toHaveBeenCalled();
        });

        it("should not attempt OAuth rotation when disabled", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            mockOAuthRotator.isRotationEnabled.mockReturnValue(false);

            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 429,
                text: async () => "Rate limit exceeded",
            } as Response);

            await expect(
                client.getCompletion({
                    model: "test-model",
                    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
                } as any)
            ).rejects.toThrow();

            expect(mockOAuthRotator.rotateCredentials).not.toHaveBeenCalled();
        });
    });

    describe("GeminiApiError", () => {
        it("should create error with message and status code", () => {
            const error = new GeminiApiError(
                "Test error",
                500,
                "Error details"
            );

            expect(error.message).toBe("Test error");
            expect(error.statusCode).toBe(500);
            expect(error.responseText).toBe("Error details");
            expect(error.name).toBe("GeminiApiError");
        });

        it("should create error without response text", () => {
            const error = new GeminiApiError("Test error", 404);

            expect(error.message).toBe("Test error");
            expect(error.statusCode).toBe(404);
            expect(error.responseText).toBeUndefined();
        });
    });

    describe("token refresh", () => {
        it("should handle 401 errors with token refresh", async () => {
            const client = new GeminiApiClient(
                mockAuthClient,
                "test-project",
                false
            );

            mockAuthClient.getAccessToken.mockResolvedValue({
                token: "test-token",
            });

            let callCount = 0;
            global.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: false,
                        status: 401,
                        text: async () => "Unauthorized",
                    } as Response);
                }
                // Second call succeeds
                const mockStream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        const encoder = new TextEncoder();
                        controller.enqueue(
                            encoder.encode(
                                'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}\n\n'
                            )
                        );
                        controller.enqueue(
                            encoder.encode(
                                'data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}}\n\n'
                            )
                        );
                        controller.close();
                    },
                });
                return Promise.resolve({
                    ok: true,
                    body: mockStream,
                } as unknown as Response);
            });

            const result = await client.getCompletion({
                model: "test-model",
                contents: [{ role: "user", parts: [{ text: "Hello" }] }],
            } as any);

            expect(result).toBeDefined();
            expect(result.content).toBe("Hello");
            expect(callCount).toBe(2); // First call failed, second succeeded
        });
    });
});
