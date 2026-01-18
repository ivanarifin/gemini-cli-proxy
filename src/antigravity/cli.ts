/**
 * Antigravity CLI for managing OAuth accounts
 * Separate from Gemini CLI account management
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
    ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET,
} from "./constant.js";
import {
    antigravityAuthWithUserCode,
    antigravityAuthWithWeb,
    isAntigravityBrowserLaunchSuppressed,
} from "./auth.js";
import {
    getAntigravityAccountsDirPath,
    getAntigravityRequestCountsPath,
    getAntigravityCachedCredentialPath,
} from "./paths.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("ANTIGRAVITY-CLI", chalk.magenta);

async function ensureAccountsDir() {
    const accountsDir = getAntigravityAccountsDirPath();
    if (!existsSync(accountsDir)) {
        await fs.mkdir(accountsDir, { recursive: true });
    }
}

async function getRequestCounts() {
    const countsPath = getAntigravityRequestCountsPath();
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
    const accountsDir = getAntigravityAccountsDirPath();
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
    const defaultPath = getAntigravityCachedCredentialPath();
    if (existsSync(defaultPath)) {
        const defaultCount = counts.requests["default"] || 0;
        table.push([
            chalk.magenta("default"),
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
        console.log(chalk.yellow("No Antigravity accounts found."));
        console.log(
            chalk.dim(
                "Run 'antigravity-auth add <id>' to add a new account.",
            ),
        );
    } else {
        console.log(chalk.bold("\nAntigravity OAuth Accounts:\n"));
        console.log(table.toString());
    }
}

async function addAccount(accountId: string) {
    await ensureAccountsDir();
    const accountsDir = getAntigravityAccountsDirPath();
    const targetPath = path.join(accountsDir, `oauth_creds_${accountId}.json`);

    if (existsSync(targetPath)) {
        logger.error(`Account with ID ${accountId} already exists.`);
        process.exit(1);
    }

    const client = new OAuth2Client({
        clientId: ANTIGRAVITY_CLIENT_ID,
        clientSecret: ANTIGRAVITY_CLIENT_SECRET,
    });

    const disableBrowserAuth = process.env.NO_BROWSER === "true";

    if (isAntigravityBrowserLaunchSuppressed(disableBrowserAuth)) {
        logger.info("Using code-based authentication...");
        const success = await antigravityAuthWithUserCode(client, logger);
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
                chalk.green(
                    `🎉 Antigravity account ${accountId} added successfully!`,
                ),
            );
        } else {
            logger.error("Authentication failed.");
            process.exit(1);
        }
    } else {
        const webLogin = await antigravityAuthWithWeb(client, logger);
        logger.info("Google login required for Antigravity.");
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
        logger.info(
            chalk.green(
                `🎉 Antigravity account ${accountId} added successfully!`,
            ),
        );
    }
}

async function removeAccount(accountId: string) {
    const accountsDir = getAntigravityAccountsDirPath();
    const targetPath = path.join(accountsDir, `oauth_creds_${accountId}.json`);

    if (!existsSync(targetPath)) {
        logger.error(`Account with ID ${accountId} not found.`);
        process.exit(1);
    }

    await fs.unlink(targetPath);
    logger.info(
        chalk.green(`✅ Antigravity account ${accountId} removed successfully!`),
    );
}

async function checkCounts() {
    await listAccounts();
}

const program = new Command();

program
    .name("antigravity-auth")
    .description("Manage Antigravity OAuth accounts")
    .version("1.0.0");

program
    .command("list")
    .description("List all authenticated Antigravity accounts")
    .action(listAccounts);

program
    .command("add <id>")
    .description("Add a new Antigravity account with a specific ID")
    .action(addAccount);

program
    .command("remove <id>")
    .description("Remove an Antigravity account by ID")
    .action(removeAccount);

program
    .command("counts")
    .description("Check request counts for all Antigravity accounts")
    .action(checkCounts);

program.parse(process.argv);
