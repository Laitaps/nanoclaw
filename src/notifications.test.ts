import { describe, it, expect } from 'vitest';

import {
  type AgentNotification,
  formatAgentNotification,
  formatAgentNotifications,
} from './notifications.js';

// --- formatAgentNotification (single item) ---

describe('formatAgentNotification', () => {
  it('formats a deploy failure as an alarm', () => {
    const out = formatAgentNotification({
      kind: 'deploy_failed',
      payload: { sha: 'abc123', run_url: 'https://ci/run/1' },
    });
    expect(out).toContain('DEPLOY FAILED for commit abc123');
    expect(out).toContain('https://ci/run/1');
    expect(out).toContain('NOT live');
  });

  it('formats a deploy success without a supersedes note when none', () => {
    const out = formatAgentNotification({
      kind: 'deploy_succeeded',
      payload: { sha: 'def456', subject: 'feat: thing' },
    });
    expect(out).toContain('Deploy succeeded for commit def456');
    expect(out).toContain('the new code is live');
    expect(out).not.toContain('retired');
  });

  it('notes retired failure alerts when supersedes is set', () => {
    expect(
      formatAgentNotification({
        kind: 'deploy_succeeded',
        payload: { sha: 'def456', supersedes: 1 },
      }),
    ).toContain('retired 1 stale failure alert)');
    expect(
      formatAgentNotification({
        kind: 'deploy_succeeded',
        payload: { sha: 'def456', supersedes: 3 },
      }),
    ).toContain('retired 3 stale failure alerts)');
  });

  it('falls back to task-complete for legacy title/summary rows', () => {
    const out = formatAgentNotification({ title: 'Ship it', summary: 'done' });
    expect(out).toContain('ARCHITECT TASK COMPLETED: "Ship it"');
    expect(out).toContain('done');
  });
});

// --- formatAgentNotifications (whole batch) ---

describe('formatAgentNotifications', () => {
  it('renders a lone failure as an alarm (no later success)', () => {
    const batch: AgentNotification[] = [
      { kind: 'deploy_failed', payload: { sha: 'aaa' } },
    ];
    const out = formatAgentNotifications(batch);
    expect(out).toContain('DEPLOY FAILED for commit aaa');
    expect(out).not.toContain('RESOLVED');
  });

  it('resolves a failure superseded by a later success in the batch', () => {
    const batch: AgentNotification[] = [
      { kind: 'deploy_failed', payload: { sha: 'aaa' } },
      { kind: 'deploy_succeeded', payload: { sha: 'bbb' } },
    ];
    const out = formatAgentNotifications(batch);
    expect(out).toContain('DEPLOY FAILED for commit aaa — since RESOLVED');
    expect(out).toContain('commit bbb succeeded');
    // The alarming standalone failure phrasing must not appear.
    expect(out).not.toContain('Silence ≠ success');
  });

  it('does not resolve a failure that comes after the success', () => {
    // success first, then a fresh failure — the failure is real.
    const batch: AgentNotification[] = [
      { kind: 'deploy_succeeded', payload: { sha: 'bbb' } },
      { kind: 'deploy_failed', payload: { sha: 'ccc' } },
    ];
    const out = formatAgentNotifications(batch);
    expect(out).toContain('DEPLOY FAILED for commit ccc');
    expect(out).toContain('Silence ≠ success');
    expect(out).not.toContain('RESOLVED');
  });

  it('leaves unrelated notifications untouched', () => {
    const batch: AgentNotification[] = [
      { kind: 'pr_awaiting_decision', payload: { pr_number: 42, round: 1 } },
      { kind: 'deploy_failed', payload: { sha: 'aaa' } },
      { kind: 'deploy_succeeded', payload: { sha: 'bbb' } },
    ];
    const out = formatAgentNotifications(batch);
    expect(out).toContain('PR #42 PROMOTED');
    expect(out).toContain('DEPLOY FAILED for commit aaa — since RESOLVED');
  });
});
