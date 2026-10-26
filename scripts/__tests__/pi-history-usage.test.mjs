import { describe, expect, it } from 'vitest';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { estimateContextTokens as estimateModelContext } from '../../node_modules/@earendil-works/pi-ai/dist/utils/estimate.js';
const timestamp = 1_000;
const assistant = usage => ({ role: 'assistant', content: [{ type: 'text', text: 'Historical answer without billing metadata' }], stopReason: 'stop', timestamp, ...(usage === undefined ? {} : { usage }) });
const usage = { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 100, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 } };
function contextSession({ compact = false, withUsage = false } = {}) {
  const sessionManager = SessionManager.inMemory('/fixture');
  sessionManager.appendMessage({ role: 'user', content: 'Saved question', timestamp: 1 });
  const kept = sessionManager.appendMessage(assistant());
  if (compact) sessionManager.appendCompaction('Saved summary', kept, 20);
  if (withUsage) sessionManager.appendMessage({ ...assistant(usage), timestamp: timestamp + 1 });
  const session = { sessionManager, _limitsModel: () => ({ contextWindow: 1_000 }), getContextUsage() { return AgentSession.prototype.getContextUsage.call(this); } };
  return { session, sessionManager };
}
describe('actual Pi SDK historical usage compatibility', () => {
  it.each([undefined, null])('estimates context with absent usage (%s) without changing historical messages', value => {
    const messages = [{ role: 'user', content: 'Question', timestamp: 1 }, assistant(value)];
    const before = JSON.stringify(messages);
    expect(estimateModelContext(messages)).toMatchObject({ tokens: expect.any(Number), usageTokens: 0, lastUsageIndex: null });
    expect(estimateModelContext(messages).tokens).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('retains exact reported totals and estimates later text', () => {
    const result = estimateModelContext([assistant(usage), { role: 'user', content: 'Next question', timestamp: timestamp + 1 }]);
    expect(result.usageTokens).toBe(100); expect(result.lastUsageIndex).toBe(0);
    expect(result.tokens).toBeGreaterThan(100);
  });
  it('keeps context unknown after compaction when no later reported usage exists', () => {
    const { session } = contextSession({ compact: true });
    expect(session.getContextUsage()).toEqual({ tokens: null, contextWindow: 1_000, percent: null });
  });
  it('reads valid post-compaction usage despite earlier missing metadata', () => {
    const { session } = contextSession({ compact: true, withUsage: true });
    expect(session.getContextUsage()).toMatchObject({ tokens: 100, percent: 10 });
  });
  it('counts historical messages without inventing their cost or rewriting entries', () => {
    const { session, sessionManager } = contextSession({ withUsage: true });
    const before = JSON.stringify(sessionManager.getEntries());
    const stats = AgentSession.prototype.getSessionStats.call(session);
    expect(stats).toMatchObject({ assistantMessages: 2, userMessages: 1, cost: 0.31, tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, total: 100 } });
    expect(JSON.stringify(sessionManager.getEntries())).toBe(before);
  });
});
