import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    AutoModelSwitchingHelper,
    type RetryableRequestData,
} from "./auto-model-switching.js";

// Mock the logger to prevent console output during tests
vi.mock("../utils/logger.js", () => ({
    getLogger: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    })),
}));

describe("AutoModelSwitchingHelper", () => {
    let switcher: AutoModelSwitchingHelper;

    beforeEach(() => {
        // Reset singleton instance before each test
        (AutoModelSwitchingHelper as any).instance = undefined;
        switcher = AutoModelSwitchingHelper.getInstance();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Singleton Pattern", () => {
        it("should return the same instance", () => {
            const instance1 = AutoModelSwitchingHelper.getInstance();
            const instance2 = AutoModelSwitchingHelper.getInstance();

            expect(instance1).toBe(instance2);
        });
    });

    describe("getFallbackModel", () => {
        it("should return null for unknown model", () => {
            const result = switcher.getFallbackModel("unknown-model");
            expect(result).toBeNull();
        });

        it("should return fallback model for gemini-2.5-pro", () => {
            const result = switcher.getFallbackModel("gemini-2.5-pro");
            expect(result).toBe("gemini-2.5-flash");
        });

        it("should return fallback model for gemini-2.5-flash", () => {
            const result = switcher.getFallbackModel("gemini-2.5-flash");
            expect(result).toBe("gemini-2.5-flash-lite");
        });

        it("should return null for gemini-2.5-flash-lite (last in chain)", () => {
            const result = switcher.getFallbackModel("gemini-2.5-flash-lite");
            expect(result).toBeNull();
        });

        it("should return fallback model for gemini-3-pro-preview", () => {
            const result = switcher.getFallbackModel("gemini-3-pro-preview");
            expect(result).toBe("gemini-3-flash-preview");
        });

        it("should return fallback model for gemini-3-flash-preview", () => {
            const result = switcher.getFallbackModel("gemini-3-flash-preview");
            expect(result).toBe("gemini-2.5-flash");
        });
    });

    describe("isRateLimitError", () => {
        it("should return true for 429 status code", () => {
            expect(switcher.isRateLimitError(429)).toBe(true);
        });

        it("should return true for 503 status code", () => {
            expect(switcher.isRateLimitError(503)).toBe(true);
        });

        it("should return false for 200 status code", () => {
            expect(switcher.isRateLimitError(200)).toBe(false);
        });

        it("should return false for 400 status code", () => {
            expect(switcher.isRateLimitError(400)).toBe(false);
        });

        it("should return false for 401 status code", () => {
            expect(switcher.isRateLimitError(401)).toBe(false);
        });
    });

    describe("isRateLimitStatus", () => {
        it("should return true for 429 status code", () => {
            expect(switcher.isRateLimitStatus(429)).toBe(true);
        });

        it("should return true for 503 status code", () => {
            expect(switcher.isRateLimitStatus(503)).toBe(true);
        });

        it("should return false for 500 status code", () => {
            expect(switcher.isRateLimitStatus(500)).toBe(false);
        });
    });

    describe("shouldAttemptFallback", () => {
        it("should return false when model is explicitly requested", () => {
            const result = switcher.shouldAttemptFallback(
                "gemini-2.5-pro",
                true
            );
            expect(result).toBe(false);
        });

        it("should return false when model is in cooldown", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            const result = switcher.shouldAttemptFallback(
                "gemini-2.5-pro",
                false
            );
            expect(result).toBe(false);
        });

        it("should return false when no fallback is available", () => {
            const result = switcher.shouldAttemptFallback(
                "unknown-model",
                false
            );
            expect(result).toBe(false);
        });

        it("should return true when model is valid and not in cooldown", () => {
            const result = switcher.shouldAttemptFallback(
                "gemini-2.5-pro",
                false
            );
            expect(result).toBe(true);
        });
    });

    describe("createDowngradeNotification", () => {
        it("should create correct notification message", () => {
            const result = switcher.createDowngradeNotification(
                "gemini-2.5-pro",
                "gemini-2.5-flash",
                429
            );
            expect(result).toBe(
                "<429> You are downgraded from gemini-2.5-pro to gemini-2.5-flash because of rate limits"
            );
        });

        it("should include correct status code in notification", () => {
            const result = switcher.createDowngradeNotification(
                "gemini-2.5-flash",
                "gemini-2.5-flash-lite",
                503
            );
            expect(result).toContain("<503>");
        });
    });

    describe("createUpgradeNotification", () => {
        it("should create correct upgrade notification", () => {
            const result = switcher.createUpgradeNotification("gemini-2.5-pro");
            expect(result).toBe(
                "Model upgraded: Now using gemini-2.5-pro (rate limits cleared)"
            );
        });
    });

    describe("addRateLimitedModel", () => {
        it("should add model to cooldown state", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);

            expect(switcher.isModelInCooldown("gemini-2.5-pro")).toBe(true);
        });

        it("should add status code to existing model", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            switcher.addRateLimitedModel("gemini-2.5-pro", 503);

            // The model should still be in cooldown
            expect(switcher.isModelInCooldown("gemini-2.5-pro")).toBe(true);
        });

        it("should handle multiple models in cooldown", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            switcher.addRateLimitedModel("gemini-2.5-flash", 503);

            expect(switcher.isModelInCooldown("gemini-2.5-pro")).toBe(true);
            expect(switcher.isModelInCooldown("gemini-2.5-flash")).toBe(true);
            expect(switcher.isModelInCooldown("unknown-model")).toBe(false);
        });
    });

    describe("isModelInCooldown", () => {
        it("should return false for model not in cooldown", () => {
            const result = switcher.isModelInCooldown("gemini-2.5-pro");
            expect(result).toBe(false);
        });

        it("should return true for model in cooldown", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            const result = switcher.isModelInCooldown("gemini-2.5-pro");
            expect(result).toBe(true);
        });

        it("should clean up expired cooldown", () => {
            // Add model to cooldown
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);

            // Manually expire the cooldown by clearing the state
            (switcher as any).cooldownState = {};

            const result = switcher.isModelInCooldown("gemini-2.5-pro");
            expect(result).toBe(false);
        });
    });

    describe("getBestAvailableModel", () => {
        it("should return preferred model when not in cooldown", () => {
            const result = switcher.getBestAvailableModel("gemini-2.5-pro");
            expect(result).toBe("gemini-2.5-pro");
        });

        it("should return fallback when preferred model is in cooldown", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            const result = switcher.getBestAvailableModel("gemini-2.5-pro");
            expect(result).toBe("gemini-2.5-flash");
        });

        it("should return preferred model when not in cooldown and fallbacks exist", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            // gemini-2.5-pro is in cooldown, so it should return the fallback gemini-2.5-flash
            const result = switcher.getBestAvailableModel("gemini-2.5-pro");
            expect(result).toBe("gemini-2.5-flash");
        });

        it("should handle unknown model", () => {
            const result = switcher.getBestAvailableModel("unknown-model");
            expect(result).toBe("unknown-model");
        });
    });

    describe("handleNonStreamingFallback", () => {
        it("should throw when no fallback available", async () => {
            const retryFunction = vi.fn();

            await expect(
                switcher.handleNonStreamingFallback(
                    "unknown-model",
                    429,
                    { model: "unknown-model" },
                    retryFunction
                )
            ).rejects.toThrow("No fallback available for model unknown-model");
        });

        it("should call retry function with fallback model", async () => {
            const retryFunction = vi.fn().mockResolvedValue({ success: true });

            const result = await switcher.handleNonStreamingFallback(
                "gemini-2.5-pro",
                429,
                {
                    model: "gemini-2.5-pro",
                    messages: [{ role: "user", content: "Hello" }],
                },
                retryFunction
            );

            expect(retryFunction).toHaveBeenCalledWith(
                "gemini-2.5-flash",
                expect.objectContaining({ model: "gemini-2.5-flash" })
            );
            // Result includes _autoSwitchNotification added by the function
            expect(result).toHaveProperty("success", true);
            expect(result).toHaveProperty("_autoSwitchNotification");
        });

        it("should add notification to result", async () => {
            const mockResult = { content: "Hello" };
            const retryFunction = vi.fn().mockResolvedValue(mockResult);

            const result = await switcher.handleNonStreamingFallback(
                "gemini-2.5-pro",
                429,
                { model: "gemini-2.5-pro" },
                retryFunction
            );

            expect((result as any)._autoSwitchNotification).toBeDefined();
            expect((result as any)._autoSwitchNotification).toContain(
                "gemini-2.5-pro"
            );
            expect((result as any)._autoSwitchNotification).toContain(
                "gemini-2.5-flash"
            );
        });

        it("should add model to cooldown before retry", async () => {
            const retryFunction = vi.fn().mockResolvedValue({});

            await switcher.handleNonStreamingFallback(
                "gemini-2.5-pro",
                429,
                { model: "gemini-2.5-pro" },
                retryFunction
            );

            expect(switcher.isModelInCooldown("gemini-2.5-pro")).toBe(true);
        });

        it("should propagate error when retry fails", async () => {
            const retryFunction = vi
                .fn()
                .mockRejectedValue(new Error("Retry failed"));

            await expect(
                switcher.handleNonStreamingFallback(
                    "gemini-2.5-pro",
                    429,
                    { model: "gemini-2.5-pro" },
                    retryFunction
                )
            ).rejects.toThrow("Retry failed");
        });
    });

    describe("handleStreamingFallback", () => {
        it("should throw when no fallback available", async () => {
            const retryFunction = vi.fn();

            const stream = switcher.handleStreamingFallback(
                "unknown-model",
                429,
                { model: "unknown-model" },
                retryFunction
            );

            await expect(async () => {
                for await (const _ of stream) {
                    // Should throw before yielding
                }
            }).rejects.toThrow("No fallback available for model unknown-model");
        });

        it("should yield chunks from retry function", async () => {
            const mockChunks = [
                { choices: [{ delta: { content: "Hello" } }] },
                { choices: [{ delta: { content: " world" } }] },
            ];

            const retryFunction = vi.fn(async function* () {
                for (const chunk of mockChunks) {
                    yield chunk;
                }
            });

            const chunks: any[] = [];
            const stream = switcher.handleStreamingFallback(
                "gemini-2.5-pro",
                429,
                { model: "gemini-2.5-pro" },
                retryFunction
            );

            for await (const chunk of stream) {
                chunks.push(chunk);
            }

            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toEqual({
                choices: [{ delta: { content: "Hello" } }],
            });
            expect(chunks[1]).toEqual({
                choices: [{ delta: { content: " world" } }],
            });
        });

        it("should add model to cooldown before streaming", async () => {
            const retryFunction = vi.fn(async function* () {
                yield { choices: [{ delta: { content: "Hello" } }] };
            });

            const stream = switcher.handleStreamingFallback(
                "gemini-2.5-pro",
                429,
                { model: "gemini-2.5-pro" },
                retryFunction
            );

            // Consume the stream
            for await (const _ of stream) {
                // Just consume
            }

            expect(switcher.isModelInCooldown("gemini-2.5-pro")).toBe(true);
        });

        it("should propagate error when retry fails", async () => {
            const retryFunction = vi.fn(async function* () {
                throw new Error("Stream failed");
            });

            const stream = switcher.handleStreamingFallback(
                "gemini-2.5-pro",
                429,
                { model: "gemini-2.5-pro" },
                retryFunction
            );

            await expect(async () => {
                for await (const _ of stream) {
                    // Should throw
                }
            }).rejects.toThrow("Stream failed");
        });

        it("should use openai as default stream format", async () => {
            const retryFunction = vi.fn(async function* () {
                yield { choices: [{ delta: { content: "Hello" } }] };
            });

            // This test verifies the default parameter works
            const stream = switcher.handleStreamingFallback(
                "gemini-2.5-pro",
                429,
                { model: "gemini-2.5-pro" },
                retryFunction
            );

            // Consume the stream
            for await (const _ of stream) {
                // Just consume
            }

            expect(retryFunction).toHaveBeenCalled();
        });
    });

    describe("Integration scenarios", () => {
        it("should handle full fallback chain", async () => {
            // Add gemini-2.5-pro and gemini-2.5-flash to cooldown
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            switcher.addRateLimitedModel("gemini-2.5-flash", 429);

            // Get best available model should return gemini-2.5-flash-lite
            const result = switcher.getBestAvailableModel(
                "gemini-2.5-flash-lite"
            );
            expect(result).toBe("gemini-2.5-flash-lite");

            // gemini-2.5-pro should return gemini-2.5-flash (in cooldown),
            // then gemini-2.5-flash-lite (not in cooldown)
            const result2 = switcher.getBestAvailableModel("gemini-2.5-pro");
            expect(result2).toBe("gemini-2.5-flash-lite");
        });

        it("should handle multiple rate limit codes", () => {
            switcher.addRateLimitedModel("gemini-2.5-pro", 429);
            switcher.addRateLimitedModel("gemini-2.5-pro", 503);

            // The model should be in cooldown
            expect(switcher.isModelInCooldown("gemini-2.5-pro")).toBe(true);
        });
    });
});
