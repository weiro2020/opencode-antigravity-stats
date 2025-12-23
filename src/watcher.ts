/**
 * Watcher for Antigravity accounts file
 * Monitors changes in isRateLimited status
 */

import { watch, type FSWatcher } from "chokidar";
import type { AccountStateMap, AntigravityAccount, RateLimitEntry } from "./types.js";
import { loadAccounts, getAccountsFilePath } from "./storage.js";

export type RateLimitCallback = (entry: RateLimitEntry) => Promise<void>;

export class AccountsWatcher {
  private watcher: FSWatcher | null = null;
  private previousState: AccountStateMap = {};
  private onRateLimit: RateLimitCallback | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  /**
   * Starts watching the accounts file
   */
  async start(onRateLimit: RateLimitCallback): Promise<void> {
    this.onRateLimit = onRateLimit;

    // Load initial state
    await this.loadInitialState();

    // Start watching
    const accountsPath = getAccountsFilePath();
    this.watcher = watch(accountsPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on("change", () => {
      this.handleChange();
    });

    this.watcher.on("error", () => {
      // Silently ignore watcher errors
    });
  }

  /**
   * Stops watching
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Loads initial account state
   */
  private async loadInitialState(): Promise<void> {
    const data = await loadAccounts();
    if (!data) return;

    this.previousState = {};
    for (const account of data.accounts) {
      this.previousState[account.email] = {
        email: account.email,
        isRateLimited: account.isRateLimited,
        rateLimitResetTime: account.rateLimitResetTime,
        lastUsed: account.lastUsed,
      };
    }
  }

  /**
   * Handles file change with debouncing
   */
  private handleChange(): void {
    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      await this.checkForRateLimitChanges();
    }, 200);
  }

  /**
   * Checks for rate limit status changes
   */
  private async checkForRateLimitChanges(): Promise<void> {
    const data = await loadAccounts();
    if (!data) return;

    for (const account of data.accounts) {
      const prev = this.previousState[account.email];
      const wasRateLimited = prev?.isRateLimited ?? false;
      const isNowRateLimited = account.isRateLimited;

      // Detect transition from not-rate-limited to rate-limited
      if (!wasRateLimited && isNowRateLimited) {
        const entry: RateLimitEntry = {
          timestamp: new Date().toISOString(),
          account: account.email,
          resetTime: account.rateLimitResetTime
            ? new Date(account.rateLimitResetTime).toISOString()
            : new Date().toISOString(),
        };

        if (this.onRateLimit) {
          await this.onRateLimit(entry);
        }
      }

      // Update state
      this.previousState[account.email] = {
        email: account.email,
        isRateLimited: account.isRateLimited,
        rateLimitResetTime: account.rateLimitResetTime,
        lastUsed: account.lastUsed,
      };
    }
  }

  /**
   * Gets current account that was most recently used
   */
  async getActiveAccount(): Promise<string | null> {
    const data = await loadAccounts();
    if (!data || data.accounts.length === 0) return null;

    // Find most recently used account
    let mostRecent = data.accounts[0];
    for (const account of data.accounts) {
      if (account.lastUsed > mostRecent.lastUsed) {
        mostRecent = account;
      }
    }

    return mostRecent.email;
  }

  /**
   * Maps a project ID to account email
   */
  async getAccountByProject(projectId: string): Promise<string | null> {
    const data = await loadAccounts();
    if (!data) return null;

    for (const account of data.accounts) {
      if (
        account.projectId === projectId ||
        account.managedProjectId === projectId
      ) {
        return account.email;
      }
    }

    return null;
  }

  /**
   * Gets all accounts with their current state
   */
  async getAllAccounts(): Promise<AntigravityAccount[]> {
    const data = await loadAccounts();
    if (!data) return [];
    return data.accounts;
  }
}
