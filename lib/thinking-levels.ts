/** Pi 0.84 supports these levels; provider aliases do not add SDK capabilities. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const THINKING_LEVEL_OPTIONS = ["auto", ...PI_THINKING_LEVELS] as const;
export type ThinkingLevelOption = typeof THINKING_LEVEL_OPTIONS[number];
