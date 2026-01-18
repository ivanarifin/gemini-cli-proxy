/**
 * Antigravity OAuth Token Rotator
 * Separate from Gemini CLI OAuth rotation
 */

import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { getLogger } from "../utils/logger.js";
import chalk from "chalk";
import { getAntigravityCachedCredentialPath } from "./paths.js";

/**
 * Antigravity OAuth Token Rotator
 * Implements round-robin rotation across multiple OAuth credential files
 */
export class AntigravityOAuthRotator {
    private static instance: AntigravityOAuthRotator;
    private currentIndex: number = 0;
    private credentialFilePaths: string[] = [];
    private logger = getLogger("ANTIGRAVITY-ROTATOR", chalk.magenta);
    private isEnabled: boolean = false;
    private folderPath: string | null = null;
    private allAccountsExhausted: boolean = false;
    private rotationInProgress: boolean = false;
    private rotationPromise: Promise<string | null> | null = null;
    private folderWatcher: FSWatcher | null = null;
    private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastResetTime: number = Date.now();
    private resetTimezoneOffset: number = -8; // Pacific Time by default
    private resetHour: number = 0; // Midnight by default

    /**
     * Singleton pattern
     */
    public static getInstance(): AntigravityOAuthRotator {
        if (!AntigravityOAuthRotator.instance) {
            AntigravityOAuthRotator.instance = new AntigravityOAuthRotator();
        }
        return AntigravityOAuthRotator.instance;
    }

    /**
     * Set timezone and hour for time-based index reset
     */
    public setTimeBasedReset(timezoneOffset: number, hour: number = 0): void {
        this.resetTimezoneOffset = timezoneOffset;
        this.resetHour = hour;
        this.logger.info(
            `Time-based reset configured: GMT${
                timezoneOffset >= 0 ? "+" : ""
            }${timezoneOffset} at ${hour}:00`,
        );
    }

    /**
     * Initialize with an array of credential file paths
     */
    public initialize(paths: string[]): void {
        if (!paths || paths.length === 0) {
            this.isEnabled = false;
            this.logger.info(
                "Antigravity OAuth rotation disabled: No credential paths provided",
            );
            return;
        }

        this.stopFolderWatcher();
        this.credentialFilePaths = paths;
        this.currentIndex = 0;
        this.isEnabled = true;
        this.logger.info(
            `Antigravity OAuth rotation enabled with ${paths.length} account(s)`,
        );
    }

    /**
     * Initialize with a folder containing credential files
     */
    public async initializeWithFolder(folderPath: string): Promise<void> {
        if (!folderPath || folderPath.trim() === "") {
            this.isEnabled = false;
            this.stopFolderWatcher();
            this.logger.info(
                "Antigravity OAuth rotation disabled: No folder path provided",
            );
            return;
        }

        try {
            const files = await fs.readdir(folderPath);
            const jsonFiles = files
                .filter((file) => file.endsWith(".json"))
                .map((file) => path.join(folderPath, file));

            if (jsonFiles.length === 0) {
                this.isEnabled = false;
                this.stopFolderWatcher();
                this.logger.info(
                    `Antigravity OAuth rotation disabled: No JSON files found in ${folderPath}`,
                );
                return;
            }

            this.stopFolderWatcher();
            this.credentialFilePaths = jsonFiles;
            this.currentIndex = 0;
            this.folderPath = folderPath;
            this.isEnabled = true;
            this.logger.info(
                `Antigravity OAuth rotation enabled with ${jsonFiles.length} account(s) from: ${folderPath}`,
            );

            await this.copyFirstCredentialToCache();
            this.startFolderWatcher(folderPath);
        } catch (error) {
            this.isEnabled = false;
            this.stopFolderWatcher();
            this.logger.error(
                `Failed to initialize Antigravity OAuth rotation from ${folderPath}`,
                error,
            );
        }
    }

    /**
     * Copy first credential to cache
     */
    private async copyFirstCredentialToCache(): Promise<void> {
        if (this.credentialFilePaths.length === 0) {
            return;
        }

        const firstCredentialPath = this.credentialFilePaths[0];
        const defaultPath = getAntigravityCachedCredentialPath();

        try {
            const content = await fs.readFile(firstCredentialPath, "utf-8");
            await fs.mkdir(path.dirname(defaultPath), { recursive: true });
            await fs.writeFile(defaultPath, content, { mode: 0o600 });

            this.logger.info(
                `Initial Antigravity credentials set from: ${path.basename(
                    firstCredentialPath,
                )}`,
            );
        } catch (error) {
            this.logger.warn(
                "Failed to copy first credential to cache",
                error,
            );
        }
    }

    /**
     * Start watching folder for changes
     */
    private startFolderWatcher(folderPath: string): void {
        try {
            this.stopFolderWatcher();

            this.folderWatcher = watch(
                folderPath,
                { recursive: false },
                (eventType, filename) => {
                    if (eventType === "rename" && filename?.endsWith(".json")) {
                        this.handleFolderChange(folderPath);
                    }
                },
            );

            this.logger.info(
                `Started watching folder for Antigravity OAuth changes: ${folderPath}`,
            );
        } catch (error) {
            this.logger.warn(
                `Failed to start folder watcher for ${folderPath}`,
                error,
            );
        }
    }

    /**
     * Stop the folder watcher
     */
    private stopFolderWatcher(): void {
        if (this.folderWatcher) {
            try {
                this.folderWatcher.close();
                this.logger.info("Stopped watching Antigravity OAuth folder");
            } catch (error) {
                this.logger.warn("Error closing folder watcher", error);
            }
            this.folderWatcher = null;
        }
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = null;
        }
    }

    /**
     * Handle folder changes with debouncing
     */
    private handleFolderChange(folderPath: string): void {
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
        }

        this.refreshDebounceTimer = setTimeout(async () => {
            try {
                const files = await fs.readdir(folderPath);
                const jsonFiles = files
                    .filter((file) => file.endsWith(".json"))
                    .map((file) => path.join(folderPath, file));

                const currentFiles = new Set(this.credentialFilePaths);
                const newFiles = jsonFiles.filter((f) => !currentFiles.has(f));
                const removedFiles = this.credentialFilePaths.filter(
                    (f) => !jsonFiles.includes(f),
                );

                if (newFiles.length > 0 || removedFiles.length > 0) {
                    const oldCount = this.credentialFilePaths.length;
                    this.credentialFilePaths = jsonFiles;
                    this.currentIndex = 0;
                    this.allAccountsExhausted = false;

                    this.logger.info(
                        `Antigravity OAuth credentials refreshed: ${oldCount} -> ${jsonFiles.length} account(s)`,
                    );
                }
            } catch (error) {
                this.logger.error(
                    "Failed to refresh Antigravity OAuth credentials",
                    error,
                );
            }
        }, 1000);
    }

    /**
     * Validate credential file
     */
    private async validateCredentialFile(filePath: string): Promise<boolean> {
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const credentials = JSON.parse(content);

            const hasRequiredFields =
                credentials.access_token ||
                credentials.refresh_token ||
                credentials.client_id ||
                credentials.client_secret;

            if (!hasRequiredFields) {
                this.logger.warn(
                    `Invalid credential file: ${path.basename(
                        filePath,
                    )} - missing required fields`,
                );
                return false;
            }

            return true;
        } catch (error) {
            this.logger.warn(
                `Failed to validate credential file: ${path.basename(
                    filePath,
                )}`,
                error,
            );
            return false;
        }
    }

    /**
     * Check if time-based reset should occur
     */
    private shouldResetIndex(): boolean {
        const now = new Date();
        const utcNow = new Date(
            now.getTime() + now.getTimezoneOffset() * 60000,
        );
        const localNow = new Date(
            utcNow.getTime() + this.resetTimezoneOffset * 3600000,
        );

        const currentHour = localNow.getHours();
        const currentDay = localNow.getDate();
        const currentMonth = localNow.getMonth();
        const currentYear = localNow.getFullYear();

        const lastReset = new Date(this.lastResetTime);
        const lastResetDay = lastReset.getDate();
        const lastResetMonth = lastReset.getMonth();
        const lastResetYear = lastReset.getFullYear();

        if (
            currentHour === this.resetHour &&
            (currentDay !== lastResetDay ||
                currentMonth !== lastResetMonth ||
                currentYear !== lastResetYear)
        ) {
            this.currentIndex = 0;
            this.lastResetTime = Date.now();
            this.allAccountsExhausted = false;
            this.logger.info(
                `Time-based reset: Index reset to 0 at ${
                    this.resetHour
                }:00 GMT${this.resetTimezoneOffset >= 0 ? "+" : ""}${
                    this.resetTimezoneOffset
                }`,
            );
            return true;
        }

        return false;
    }

    /**
     * Check if rotation is enabled
     */
    public isRotationEnabled(): boolean {
        return this.isEnabled && this.credentialFilePaths.length > 1;
    }

    /**
     * Get folder path being used
     */
    public getFolderPath(): string | null {
        return this.folderPath;
    }

    /**
     * Rotate to next OAuth credential file
     */
    public async rotateCredentials(): Promise<string | null> {
        if (!this.isRotationEnabled()) {
            return null;
        }

        this.shouldResetIndex();

        if (this.rotationInProgress && this.rotationPromise) {
            this.logger.info(
                "Rotation already in progress, waiting for completion...",
            );
            return this.rotationPromise;
        }

        this.rotationInProgress = true;
        this.rotationPromise = this.performRotation();

        try {
            const result = await this.rotationPromise;
            return result;
        } finally {
            this.rotationInProgress = false;
            this.rotationPromise = null;
        }
    }

    /**
     * Perform actual rotation
     */
    private async performRotation(): Promise<string | null> {
        if (this.allAccountsExhausted) {
            this.logger.warn(
                "All Antigravity OAuth accounts exhausted. Cycling back to first.",
            );
            this.resetExhaustionState();
        }

        this.currentIndex =
            (this.currentIndex + 1) % this.credentialFilePaths.length;
        const newCredentialPath = this.credentialFilePaths[this.currentIndex];

        if (this.currentIndex === 0) {
            this.allAccountsExhausted = true;
            this.logger.warn(
                "All Antigravity OAuth accounts exhausted. Will continue cycling.",
            );
        }

        try {
            const isValid = await this.validateCredentialFile(
                newCredentialPath,
            );
            if (!isValid) {
                throw new Error(
                    `Invalid credential file: ${path.basename(
                        newCredentialPath,
                    )}`,
                );
            }

            const defaultCredentialPath = getAntigravityCachedCredentialPath();
            const credentialContent = await fs.readFile(
                newCredentialPath,
                "utf-8",
            );

            await fs.mkdir(path.dirname(defaultCredentialPath), {
                recursive: true,
            });
            await fs.writeFile(defaultCredentialPath, credentialContent, {
                mode: 0o600,
            });

            const filename = path.basename(newCredentialPath);
            this.logger.info(
                `Antigravity OAuth switch: ${filename} (account ${
                    this.currentIndex + 1
                } of ${this.credentialFilePaths.length})`,
            );

            return newCredentialPath;
        } catch (error) {
            this.logger.error(
                `Failed to rotate Antigravity credentials to ${newCredentialPath}`,
                error,
            );
            throw error;
        }
    }

    /**
     * Get current account index
     */
    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    /**
     * Get total account count
     */
    public getAccountCount(): number {
        return this.credentialFilePaths.length;
    }

    /**
     * Reset exhaustion state
     */
    public resetExhaustionState(): void {
        this.allAccountsExhausted = false;
        this.logger.info(
            "Antigravity exhaustion state reset. Will use all accounts again.",
        );
    }

    /**
     * Get current account path
     */
    public getCurrentAccountPath(): string | null {
        if (!this.isEnabled || this.credentialFilePaths.length === 0) {
            return null;
        }
        return this.credentialFilePaths[this.currentIndex];
    }

    /**
     * Clean up resources
     */
    public dispose(): void {
        this.stopFolderWatcher();
    }
}
