/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from "commander";
import { OAuth2Client } from "google-auth-library";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import qrcode from "qrcode-terminal";
import open from "open";
import {
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    authWithUserCode,
    authWithWeb,
    isBrowserLaunchSuppressed,
    fetchAndCacheUserInfo,
} from "./auth.js";
import {
    getAccountsDirPath,
    getRequestCountsPath,
    getCachedCredentialPath,
} from "../utils/paths.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("AUTH-CLI", chalk.cyan);

async function ensureAccountsDir() {
    const accountsDir = getAccountsDirPath();
    if (!existsSync(accountsDir)) {
        await fs.mkdir(accountsDir, { recursive: true });
    }
}

async function getRequestCounts() {
    const countsPath = getRequestCountsPath();
    if (!existsSync(countsPath)) {
        return { requests: {} };
    }
    try {
        const data = await fs.readFile(countsPath, "utf-8");
        return JSON.parse(data);
    } catch {
        return { requests: {} };
    }
}

async function listAccounts() {
    await ensureAccountsDir();
    const accountsDir = getAccountsDirPath();
    const files = await fs.readdir(accountsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const counts = await getRequestCounts();
    const table = new Table({
        head: [
            chalk.bold("Account ID"),
            chalk.bold("Status"),
            chalk.bold("Requests Today"),
            chalk.bold("File"),
        ],
        colWidths: [20, 15, 20, 40],
    });

    // Check default account
    const defaultPath = getCachedCredentialPath();
    if (existsSync(defaultPath)) {
        const defaultCount = counts.requests["default"] || 0;
        table.push([
            chalk.cyan("default"),
            chalk.green("✅ Active"),
            `${defaultCount}/1000`,
            path.basename(defaultPath),
        ]);
    }

    for (const file of jsonFiles) {
        const accountId = file.replace("oauth_creds_", "").replace(".json", "");
        const count = counts.requests[accountId] || 0;
        table.push([accountId, chalk.green("✅ Valid"), `${count}/1000`, file]);
    }

    if (table.length === 0) {
        console.log(chalk.yellow("No accounts found."));
    } else {
        console.log(table.toString());
    }
}

async function addAccount(accountId: string) {
    await ensureAccountsDir();
    const accountsDir = getAccountsDirPath();
    const targetPath = path.join(accountsDir, `oauth_creds_${accountId}.json`);

    if (existsSync(targetPath)) {
        logger.error(`Account with ID ${accountId} already exists.`);
        process.exit(1);
    }

    const client = new OAuth2Client({
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
    });

    const disableBrowserAuth = process.env.NO_BROWSER === "true";

    if (isBrowserLaunchSuppressed(disableBrowserAuth)) {
        logger.info("Using code-based authentication...");
        const success = await authWithUserCode(client, logger);
        if (success) {
            const credentials = client.credentials;
            await fs.writeFile(
                targetPath,
                JSON.stringify(credentials, null, 2),
                {
                    mode: 0o600,
                },
            );
            logger.info(
                chalk.green(`🎉 Account ${accountId} added successfully!`),
            );
        } else {
            logger.error("Authentication failed.");
            process.exit(1);
        }
    } else {
        const webLogin = await authWithWeb(client, logger);
        logger.info("Google login required.");
        logger.info("Opening auth page, otherwise navigate to:");
        logger.info(chalk.underline(webLogin.authUrl));

        // Generate QR code
        qrcode.generate(webLogin.authUrl, { small: true });

        try {
            await open(webLogin.authUrl);
        } catch {
            logger.warn("Failed to open browser automatically.");
        }

        logger.info("Waiting for authentication...");
        await webLogin.loginCompletePromise;

        const credentials = client.credentials;
        await fs.writeFile(targetPath, JSON.stringify(credentials, null, 2), {
            mode: 0o600,
        });
        logger.info(chalk.green(`🎉 Account ${accountId} added successfully!`));
    }
}

async function removeAccount(accountId: string) {
    const accountsDir = getAccountsDirPath();
    const targetPath = path.join(accountsDir, `oauth_creds_${accountId}.json`);

    if (!existsSync(targetPath)) {
        logger.error(`Account with ID ${accountId} not found.`);
        process.exit(1);
    }

    await fs.unlink(targetPath);
    logger.info(chalk.green(`✅ Account ${accountId} removed successfully!`));
}

async function checkCounts() {
    await listAccounts();
}

const program = new Command();

program
    .name("gemini-auth")
    .description("Manage Gemini OAuth accounts")
    .version("1.0.0");

program
    .command("list")
    .description("List all authenticated accounts")
    .action(listAccounts);

program
    .command("add <id>")
    .description("Add a new account with a specific ID")
    .action(addAccount);

program
    .command("remove <id>")
    .description("Remove an account by ID")
    .action(removeAccount);

program
    .command("counts")
    .description("Check request counts for all accounts")
    .action(checkCounts);

program.parse(process.argv);
