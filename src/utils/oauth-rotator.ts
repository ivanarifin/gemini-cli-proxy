import { promises as fs } from "node:fs";
import path from "node:path";
import { getLogger } from "./logger.js";
import chalk from "chalk";

/**
 * OAuth Token Rotator for handling rate limit (429) errors
 * Implements round-robin rotation across multiple OAuth credential files
 */
export class OAuthRotator {
    private static instance: OAuthRotator;
    private currentIndex: number = 0;
    private credentialFilePaths: string[] = [];
    private logger = getLogger("ROTATOR", chalk.magenta);
    private isEnabled: boolean = false;

    /**
     * Singleton pattern - get the global instance
     */
    public static getInstance(): OAuthRotator {
        if (!OAuthRotator.instance) {
            OAuthRotator.instance = new OAuthRotator();
        }
        return OAuthRotator.instance;
    }

    /**
     * Initialize the rotator with an array of OAuth credential file paths
     * @param paths Array of paths to OAuth JSON credential files
     */
    public initialize(paths: string[]): void {
        if (!paths || paths.length === 0) {
            this.isEnabled = false;
            this.logger.info(
                "OAuth rotation disabled: No credential paths provided"
            );
            return;
        }

        this.credentialFilePaths = paths;
        this.currentIndex = 0;
        this.isEnabled = true;
        this.logger.info(
            `OAuth rotation enabled with ${paths.length} account(s)`
        );
    }

    /**
     * Check if rotation is enabled
     */
    public isRotationEnabled(): boolean {
        return this.isEnabled && this.credentialFilePaths.length > 1;
    }

    /**
     * Rotate to the next OAuth credential file
     * @returns Path to the new credential file, or null if rotation is disabled
     */
    public async rotateCredentials(): Promise<string | null> {
        if (!this.isRotationEnabled()) {
            return null;
        }

        // Move to next account in round-robin fashion
        this.currentIndex =
            (this.currentIndex + 1) % this.credentialFilePaths.length;
        const newCredentialPath = this.credentialFilePaths[this.currentIndex];

        try {
            // Get the default gemini-cli credential path
            const defaultCredentialPath = this.getDefaultCredentialPath();

            // Read the new credential file
            const credentialContent = await fs.readFile(
                newCredentialPath,
                "utf-8"
            );

            // Write to the default location (synchronously to ensure it's available immediately)
            await fs.mkdir(path.dirname(defaultCredentialPath), {
                recursive: true,
            });
            await fs.writeFile(defaultCredentialPath, credentialContent, {
                mode: 0o600,
            });

            const filename = path.basename(newCredentialPath);
            this.logger.info(
                `Rate limit hit. Switched to account: ${filename}`
            );

            return newCredentialPath;
        } catch (error) {
            this.logger.error(
                `Failed to rotate credentials to ${newCredentialPath}`,
                error
            );
            return null;
        }
    }

    /**
     * Get the default gemini-cli credential path
     * @returns Path to the default credential file
     */
    private getDefaultCredentialPath(): string {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "";
        return path.join(homeDir, ".gemini", "oauth_creds.json");
    }

    /**
     * Get the current account index
     */
    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    /**
     * Get the total number of configured accounts
     */
    public getAccountCount(): number {
        return this.credentialFilePaths.length;
    }

    /**
     * Get the path of the current account
     */
    public getCurrentAccountPath(): string | null {
        if (!this.isEnabled || this.credentialFilePaths.length === 0) {
            return null;
        }
        return this.credentialFilePaths[this.currentIndex];
    }
}
