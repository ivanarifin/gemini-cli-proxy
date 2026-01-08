import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuthRotator } from "./oauth-rotator.js";
import { promises as fs } from "node:fs";
import path from "node:path";

// Mock fs module
vi.mock("node:fs", () => ({
    promises: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        readdir: vi.fn(),
    },
}));

describe("OAuthRotator", () => {
    let rotator: OAuthRotator;

    beforeEach(() => {
        // Reset singleton instance before each test
        (OAuthRotator as any).instance = undefined;
        rotator = OAuthRotator.getInstance();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Singleton Pattern", () => {
        it("should return the same instance", () => {
            const instance1 = OAuthRotator.getInstance();
            const instance2 = OAuthRotator.getInstance();

            expect(instance1).toBe(instance2);
        });
    });

    describe("initialize", () => {
        it("should initialize with credential paths", () => {
            const paths = ["/path/to/creds1.json", "/path/to/creds2.json"];

            rotator.initialize(paths);

            expect(rotator.isRotationEnabled()).toBe(true);
            expect(rotator.getAccountCount()).toBe(2);
        });

        it("should disable rotation with empty paths", () => {
            rotator.initialize([]);

            expect(rotator.isRotationEnabled()).toBe(false);
        });

        it("should disable rotation with undefined paths", () => {
            rotator.initialize(undefined as any);

            expect(rotator.isRotationEnabled()).toBe(false);
        });

        it("should disable rotation with single path", () => {
            rotator.initialize(["/path/to/creds.json"]);

            expect(rotator.isRotationEnabled()).toBe(false);
        });
    });

    describe("initializeWithFolder", () => {
        it("should initialize with folder path containing JSON files", async () => {
            const mockFiles = ["creds1.json", "creds2.json"];

            vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);

            await rotator.initializeWithFolder("/path/to/creds");

            expect(rotator.isRotationEnabled()).toBe(true);
            expect(rotator.getAccountCount()).toBe(2);
            expect(rotator.getFolderPath()).toBe("/path/to/creds");
        });

        it("should disable rotation with empty folder", async () => {
            vi.mocked(fs.readdir).mockResolvedValue([]);

            await rotator.initializeWithFolder("/path/to/creds");

            expect(rotator.isRotationEnabled()).toBe(false);
        });

        it("should disable rotation with invalid folder path", async () => {
            await rotator.initializeWithFolder("");

            expect(rotator.isRotationEnabled()).toBe(false);
        });

        it("should handle folder read errors gracefully", async () => {
            vi.mocked(fs.readdir).mockRejectedValue(
                new Error("Permission denied")
            );

            await rotator.initializeWithFolder("/path/to/creds");

            expect(rotator.isRotationEnabled()).toBe(false);
        });

        it("should filter non-JSON files", async () => {
            const mockFiles = ["creds1.json", "readme.txt", "creds2.json"];

            vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);

            await rotator.initializeWithFolder("/path/to/creds");

            expect(rotator.getAccountCount()).toBe(2);
        });
    });

    describe("getFolderPath", () => {
        it("should return null when initialized with paths", () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            expect(rotator.getFolderPath()).toBeNull();
        });

        it("should return folder path when initialized with folder", async () => {
            const mockFiles = ["creds1.json"];

            vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);

            await rotator.initializeWithFolder("/path/to/creds");

            expect(rotator.getFolderPath()).toBe("/path/to/creds");
        });

        it("should return null when not initialized", () => {
            expect(rotator.getFolderPath()).toBeNull();
        });
    });

    describe("rotateCredentials", () => {
        beforeEach(() => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);
        });

        it("should rotate to next credential", async () => {
            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ access_token: "test-token" })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            const newPath = await rotator.rotateCredentials();

            expect(newPath).toBe("/path/to/creds2.json");
            expect(rotator.getCurrentIndex()).toBe(1);
        });

        it("should cycle back to first credential", async () => {
            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ access_token: "test-token" })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            // First rotation
            await rotator.rotateCredentials();
            expect(rotator.getCurrentIndex()).toBe(1);

            // Second rotation - should cycle back
            const newPath = await rotator.rotateCredentials();
            expect(newPath).toBe("/path/to/creds1.json");
            expect(rotator.getCurrentIndex()).toBe(0);
        });

        it("should return null when rotation is disabled", async () => {
            const disabledRotator = OAuthRotator.getInstance();
            disabledRotator.initialize([]);

            const result = await disabledRotator.rotateCredentials();

            expect(result).toBeNull();
        });

        it("should validate credential file before rotation", async () => {
            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ invalid: "data" })
            );

            await expect(rotator.rotateCredentials()).rejects.toThrow(
                "Invalid credential file"
            );
        });

        it("should handle concurrent rotations", async () => {
            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ access_token: "test-token" })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            // Start two concurrent rotations
            const rotation1 = rotator.rotateCredentials();
            const rotation2 = rotator.rotateCredentials();

            const [result1, result2] = await Promise.all([
                rotation1,
                rotation2,
            ]);

            // Both should return the same result (second rotation waits for first)
            expect(result1).toBe(result2);
        });

        it("should continue cycling when all accounts are exhausted", async () => {
            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ access_token: "test-token" })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            // Simulate exhausting all accounts by cycling through
            // First rotation: index 0 -> 1
            await rotator.rotateCredentials();
            expect(rotator.getCurrentIndex()).toBe(1);

            // Second rotation: index 1 -> 0 (cycles back, sets exhausted flag)
            await rotator.rotateCredentials();
            expect(rotator.getCurrentIndex()).toBe(0);

            // Third rotation: should continue cycling (not throw), index 0 -> 1
            const newPath = await rotator.rotateCredentials();
            expect(newPath).toBe("/path/to/creds2.json");
            expect(rotator.getCurrentIndex()).toBe(1);
        });
    });

    describe("getCurrentAccountPath", () => {
        it("should return current account path", () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            expect(rotator.getCurrentAccountPath()).toBe(
                "/path/to/creds1.json"
            );
        });

        it("should return null when not initialized", () => {
            expect(rotator.getCurrentAccountPath()).toBeNull();
        });

        it("should return null when disabled", () => {
            rotator.initialize([]);

            expect(rotator.getCurrentAccountPath()).toBeNull();
        });
    });

    describe("getCurrentIndex", () => {
        it("should return current index", () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            expect(rotator.getCurrentIndex()).toBe(0);
        });
    });

    describe("getAccountCount", () => {
        it("should return account count", () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            expect(rotator.getAccountCount()).toBe(2);
        });

        it("should return 0 when not initialized", () => {
            expect(rotator.getAccountCount()).toBe(0);
        });
    });

    describe("resetExhaustionState", () => {
        it("should reset exhaustion state", () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            // This should not throw
            rotator.resetExhaustionState();
            expect(true).toBe(true);
        });
    });

    describe("credential validation", () => {
        it("should validate credentials with access_token", async () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ access_token: "test-token" })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            const result = await rotator.rotateCredentials();

            expect(result).toBe("/path/to/creds2.json");
        });

        it("should validate credentials with refresh_token", async () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({ refresh_token: "test-refresh" })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            const result = await rotator.rotateCredentials();

            expect(result).toBe("/path/to/creds2.json");
        });

        it("should validate credentials with client_id and client_secret", async () => {
            rotator.initialize([
                "/path/to/creds1.json",
                "/path/to/creds2.json",
            ]);

            vi.mocked(fs.readFile).mockResolvedValue(
                JSON.stringify({
                    client_id: "test-client",
                    client_secret: "test-secret",
                })
            );
            vi.mocked(fs.mkdir).mockResolvedValue(undefined);
            vi.mocked(fs.writeFile).mockResolvedValue(undefined);

            const result = await rotator.rotateCredentials();

            expect(result).toBe("/path/to/creds2.json");
        });
    });
});
