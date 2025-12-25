/**
 * Configuration schema for opencode-antigravity-auth plugin.
 * 
 * Config file locations (in priority order, highest wins):
 * - Project: .opencode/antigravity.json
 * - User: ~/.config/opencode/antigravity.json (Linux/Mac)
 *         %APPDATA%\opencode\antigravity.json (Windows)
 * 
 * Environment variables always override config file values.
 */

import { z } from "zod";

/**
 * Signature cache configuration for persisting thinking block signatures to disk.
 */
export const SignatureCacheConfigSchema = z.object({
  /** Enable disk caching of signatures (default: true) */
  enabled: z.boolean().default(true),
  
  /** In-memory TTL in seconds (default: 3600 = 1 hour) */
  memory_ttl_seconds: z.number().min(60).max(86400).default(3600),
  
  /** Disk TTL in seconds (default: 172800 = 48 hours) */
  disk_ttl_seconds: z.number().min(3600).max(604800).default(172800),
  
  /** Background write interval in seconds (default: 60) */
  write_interval_seconds: z.number().min(10).max(600).default(60),
});

/**
 * Main configuration schema for the Antigravity OAuth plugin.
 */
export const AntigravityConfigSchema = z.object({
  /** JSON Schema reference for IDE support */
  $schema: z.string().optional(),
  
  // =========================================================================
  // General Settings
  // =========================================================================
  
  /** 
   * Suppress most toast notifications (rate limit, account switching, etc.)
   * Recovery toasts are always shown regardless of this setting.
   * Env override: OPENCODE_ANTIGRAVITY_QUIET=1
   * @default false
   */
  quiet_mode: z.boolean().default(false),
  
  /**
   * Enable debug logging to file.
   * Env override: OPENCODE_ANTIGRAVITY_DEBUG=1
   * @default false
   */
  debug: z.boolean().default(false),
  
  /**
   * Custom directory for debug logs.
   * Env override: OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs
   * @default OS-specific config dir + "/antigravity-logs"
   */
  log_dir: z.string().optional(),
  
  // =========================================================================
  // Thinking Blocks
  // =========================================================================
  
  /**
   * Preserve thinking blocks for Claude models using signature caching.
   * 
   * When false (default): Thinking blocks are stripped for reliability.
   * When true: Full context preserved, but may encounter signature errors.
   * 
   * Env override: OPENCODE_ANTIGRAVITY_KEEP_THINKING=1
   * @default false
   */
  keep_thinking: z.boolean().default(false),
  
  // =========================================================================
  // Session Recovery
  // =========================================================================
  
  /**
   * Enable automatic session recovery from tool_result_missing errors.
   * When enabled, shows a toast notification when recoverable errors occur.
   * 
   * @default true
   */
  session_recovery: z.boolean().default(true),
  
  /**
   * Automatically send a "continue" prompt after successful recovery.
   * Only applies when session_recovery is enabled.
   * 
   * When false: Only shows toast notification, user must manually continue.
   * When true: Automatically sends "continue" to resume the session.
   * 
   * @default true
   */
  auto_resume: z.boolean().default(true),
  
  /**
   * Custom text to send when auto-resuming after recovery.
   * Only used when auto_resume is enabled.
   * 
   * @default "continue"
   */
  resume_text: z.string().default("continue"),
  
  // =========================================================================
  // Signature Caching
  // =========================================================================
  
  /**
   * Signature cache configuration for persisting thinking block signatures.
   * Only used when keep_thinking is enabled.
   */
  signature_cache: SignatureCacheConfigSchema.optional(),
  
  // =========================================================================
  // Auto-Update
  // =========================================================================
  
  /**
   * Enable automatic plugin updates.
   * @default true
   */
  auto_update: z.boolean().default(true),
});

export type AntigravityConfig = z.infer<typeof AntigravityConfigSchema>;
export type SignatureCacheConfig = z.infer<typeof SignatureCacheConfigSchema>;

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: AntigravityConfig = {
  quiet_mode: false,
  debug: false,
  keep_thinking: false,
  session_recovery: true,
  auto_resume: true,
  resume_text: "continue",
  auto_update: true,
  signature_cache: {
    enabled: true,
    memory_ttl_seconds: 3600,
    disk_ttl_seconds: 172800,
    write_interval_seconds: 60,
  },
};
