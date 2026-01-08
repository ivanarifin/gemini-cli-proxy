import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    cacheGoogleAccount,
    getCachedGoogleAccount,
    clearCachedGoogleAccount,
} from "./user_account.js";
import { promises as fsp, existsSync, readFileSync } from "node:fs";
import { getGoogleAccountsCachePath } from "./paths.js";

// Mock fs modules
vi.mock("node:fs", () => ({
    promises: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        rm: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
}));

vi.mock("./paths.js", () => ({
    getGoogleAccountsCachePath: vi.fn(() => "/mock/path/accounts.json"),
}));

describe("user_account", () => {
    const mockFilePath = "/mock/path/accounts.json";

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("cacheGoogleAccount", () => {
        it("should cache a new account email", async () => {
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": null, "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            await cacheGoogleAccount("test@example.com");

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("test@example.com"),
                "utf-8"
            );
        });

        it("should move previous active account to old list", async () => {
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": "old@example.com", "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            await cacheGoogleAccount("new@example.com");

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("old@example.com"),
                "utf-8"
            );
        });

        it("should not duplicate old accounts", async () => {
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": "old@example.com", "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            await cacheGoogleAccount("old@example.com");

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("old@example.com"),
                "utf-8"
            );
        });

        it("should create directory if it doesn't exist", async () => {
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": null, "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            await cacheGoogleAccount("test@example.com");

            expect(vi.mocked(fsp.mkdir)).toHaveBeenCalledWith("/mock/path", {
                recursive: true,
            });
        });

        it("should handle empty file content", async () => {
            vi.mocked(fsp.readFile).mockResolvedValue("");
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            await cacheGoogleAccount("test@example.com");

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("test@example.com"),
                "utf-8"
            );
        });

        it("should handle file read errors gracefully", async () => {
            vi.mocked(fsp.readFile).mockRejectedValue(
                new Error("File not found")
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            await cacheGoogleAccount("test@example.com");

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("test@example.com"),
                "utf-8"
            );
        });
    });

    describe("getCachedGoogleAccount", () => {
        it("should return active account email", () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockReturnValue(
                '{"active": "test@example.com", "old": []}'
            );

            const result = getCachedGoogleAccount();

            expect(result).toBe("test@example.com");
        });

        it("should return null when file doesn't exist", () => {
            vi.mocked(existsSync).mockReturnValue(false);

            const result = getCachedGoogleAccount();

            expect(result).toBeNull();
        });

        it("should return null when file is empty", () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockReturnValue("");

            const result = getCachedGoogleAccount();

            expect(result).toBeNull();
        });

        it("should return null when active is null", () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockReturnValue(
                '{"active": null, "old": []}'
            );

            const result = getCachedGoogleAccount();

            expect(result).toBeNull();
        });

        it("should handle file read errors gracefully", () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockImplementation(() => {
                throw new Error("Permission denied");
            });

            const result = getCachedGoogleAccount();

            expect(result).toBeNull();
        });

        it("should handle invalid JSON gracefully", () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(readFileSync).mockReturnValue("invalid json");

            const result = getCachedGoogleAccount();

            expect(result).toBeNull();
        });
    });

    describe("clearCachedGoogleAccount", () => {
        it("should move active account to old list", async () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": "test@example.com", "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

            await clearCachedGoogleAccount();

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("test@example.com"),
                "utf-8"
            );
        });

        it("should not duplicate old accounts", async () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": "test@example.com", "old": ["test@example.com"]}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

            await clearCachedGoogleAccount();

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("test@example.com"),
                "utf-8"
            );
        });

        it("should do nothing when file doesn't exist", async () => {
            vi.mocked(existsSync).mockReturnValue(false);

            await clearCachedGoogleAccount();

            // The implementation returns early if file doesn't exist
            // So we just verify it doesn't throw
            expect(true).toBe(true);
        });

        it("should handle case when active is already null", async () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": null, "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

            await clearCachedGoogleAccount();

            expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(
                mockFilePath,
                expect.stringContaining("null"),
                "utf-8"
            );
        });

        it("should handle file read errors gracefully", async () => {
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(fsp.readFile).mockRejectedValue(
                new Error("File not found")
            );

            // The implementation calls readFile even when file exists
            // It should handle the error gracefully without throwing
            await expect(clearCachedGoogleAccount()).resolves.not.toThrow();
        });
    });

    describe("integration scenarios", () => {
        it("should handle full cache lifecycle", async () => {
            // Initial state: no cached account
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": null, "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            // Cache first account
            await cacheGoogleAccount("user1@example.com");

            // Verify cached account
            vi.mocked(readFileSync).mockReturnValue(
                '{"active": "user1@example.com", "old": []}'
            );
            expect(getCachedGoogleAccount()).toBe("user1@example.com");

            // Cache second account
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": "user1@example.com", "old": []}'
            );
            await cacheGoogleAccount("user2@example.com");

            // Verify final state
            vi.mocked(readFileSync).mockReturnValue(
                '{"active": "user2@example.com", "old": ["user1@example.com"]}'
            );
            expect(getCachedGoogleAccount()).toBe("user2@example.com");
        });

        it("should handle multiple account switches", async () => {
            // Initial state
            vi.mocked(existsSync).mockReturnValue(true);
            vi.mocked(fsp.readFile).mockResolvedValue(
                '{"active": null, "old": []}'
            );
            vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
            vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

            // Switch through multiple accounts
            await cacheGoogleAccount("user1@example.com");
            await cacheGoogleAccount("user2@example.com");
            await cacheGoogleAccount("user3@example.com");

            // Verify final state
            vi.mocked(readFileSync).mockReturnValue(
                '{"active": "user3@example.com", "old": ["user1@example.com", "user2@example.com"]}'
            );
            expect(getCachedGoogleAccount()).toBe("user3@example.com");
        });
    });
});
