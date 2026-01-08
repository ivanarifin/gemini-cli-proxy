import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    getCachedCredentialPath,
    getGoogleAccountsCachePath,
    GEMINI_DIR,
    CREDENTIAL_FILENAME,
    GOOGLE_ACCOUNTS_FILENAME,
} from "./paths.js";
import * as os from "node:os";
import * as path from "node:path";

// Mock os and path modules
vi.mock("node:os", () => ({
    homedir: vi.fn(),
}));

vi.mock("node:path", async () => {
    const actual = await vi.importActual("node:path");
    return {
        ...actual,
        join: vi.fn(),
    };
});

describe("paths", () => {
    const mockHomeDir = "/mock/home/dir";

    beforeEach(() => {
        vi.mocked(os.homedir).mockReturnValue(mockHomeDir);
        vi.mocked(path.join).mockImplementation((...args: string[]) => {
            return args.join("/");
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Constants", () => {
        it("should have correct GEMINI_DIR constant", () => {
            expect(GEMINI_DIR).toBe(".gemini");
        });

        it("should have correct CREDENTIAL_FILENAME constant", () => {
            expect(CREDENTIAL_FILENAME).toBe("oauth_creds.json");
        });

        it("should have correct GOOGLE_ACCOUNTS_FILENAME constant", () => {
            expect(GOOGLE_ACCOUNTS_FILENAME).toBe("accounts.json");
        });
    });

    describe("getCachedCredentialPath", () => {
        it("should return correct credential path", () => {
            const result = getCachedCredentialPath();

            expect(os.homedir).toHaveBeenCalled();
            expect(path.join).toHaveBeenCalledWith(
                mockHomeDir,
                GEMINI_DIR,
                CREDENTIAL_FILENAME
            );
            expect(result).toBe(
                `${mockHomeDir}/${GEMINI_DIR}/${CREDENTIAL_FILENAME}`
            );
        });

        it("should use correct path segments", () => {
            const result = getCachedCredentialPath();

            expect(result).toContain(".gemini");
            expect(result).toContain("oauth_creds.json");
        });

        it("should be consistent across multiple calls", () => {
            const result1 = getCachedCredentialPath();
            const result2 = getCachedCredentialPath();

            expect(result1).toBe(result2);
        });
    });

    describe("getGoogleAccountsCachePath", () => {
        it("should return correct accounts cache path", () => {
            const result = getGoogleAccountsCachePath();

            expect(os.homedir).toHaveBeenCalled();
            expect(path.join).toHaveBeenCalledWith(
                mockHomeDir,
                GEMINI_DIR,
                GOOGLE_ACCOUNTS_FILENAME
            );
            expect(result).toBe(
                `${mockHomeDir}/${GEMINI_DIR}/${GOOGLE_ACCOUNTS_FILENAME}`
            );
        });

        it("should use correct path segments", () => {
            const result = getGoogleAccountsCachePath();

            expect(result).toContain(".gemini");
            expect(result).toContain("accounts.json");
        });

        it("should be consistent across multiple calls", () => {
            const result1 = getGoogleAccountsCachePath();
            const result2 = getGoogleAccountsCachePath();

            expect(result1).toBe(result2);
        });
    });

    describe("path relationships", () => {
        it("should have both paths in same directory", () => {
            const credPath = getCachedCredentialPath();
            const accountsPath = getGoogleAccountsCachePath();

            const credDir = credPath.substring(0, credPath.lastIndexOf("/"));
            const accountsDir = accountsPath.substring(
                0,
                accountsPath.lastIndexOf("/")
            );

            expect(credDir).toBe(accountsDir);
        });

        it("should have different filenames", () => {
            const credPath = getCachedCredentialPath();
            const accountsPath = getGoogleAccountsCachePath();

            const credFilename = credPath.substring(
                credPath.lastIndexOf("/") + 1
            );
            const accountsFilename = accountsPath.substring(
                accountsPath.lastIndexOf("/") + 1
            );

            expect(credFilename).not.toBe(accountsFilename);
            expect(credFilename).toBe(CREDENTIAL_FILENAME);
            expect(accountsFilename).toBe(GOOGLE_ACCOUNTS_FILENAME);
        });
    });

    describe("edge cases", () => {
        it("should handle home directory with special characters", () => {
            const specialHomeDir = "/home/user with spaces";
            vi.mocked(os.homedir).mockReturnValue(specialHomeDir);

            const result = getCachedCredentialPath();

            expect(result).toContain(specialHomeDir);
            expect(result).toContain(".gemini");
        });

        it("should handle home directory with unicode characters", () => {
            const unicodeHomeDir = "/home/用户";
            vi.mocked(os.homedir).mockReturnValue(unicodeHomeDir);

            const result = getCachedCredentialPath();

            expect(result).toContain(unicodeHomeDir);
            expect(result).toContain(".gemini");
        });

        it("should handle empty home directory gracefully", () => {
            vi.mocked(os.homedir).mockReturnValue("");

            const result = getCachedCredentialPath();

            expect(result).toBe(`/${GEMINI_DIR}/${CREDENTIAL_FILENAME}`);
        });
    });
});
