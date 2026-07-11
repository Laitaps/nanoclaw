// Agent-pipeline notifications (delivered via /chat/pending-notifications).
// kind/payload is the current shape; bare title/summary rows come from the
// one-time legacy-queue drain and older API versions.
export interface AgentNotification {
  kind?: string;
  payload?: Record<string, unknown>;
  title?: string;
  summary?: string;
}

/** Render a single notification into prompt context for Skippy. */
export function formatAgentNotification(n: AgentNotification): string {
  const p = (n.payload ?? n) as Record<string, unknown>;
  switch (n.kind ?? 'task_complete') {
    case 'pr_awaiting_decision':
      return (
        `[PR #${p.pr_number} PROMOTED — AWAITING YOUR DECISION]\n` +
        `Repo: ${p.repo || 'unknown'}, round ${p.round}, head ${p.head_sha || 'unknown'}` +
        (p.comment ? `, note from ${p.promoted_by || 'the Architect'}: ${p.comment}` : '') +
        '.\nThe whole review chain has approved at this head SHA. Run your PR Approval ' +
        'Workflow gates now (get_pr_approval_state first) and call approve_pr or ' +
        'reject_pr this turn — the Architect is blocked until you decide.'
      );
    case 'deploy_failed':
      return (
        `[DEPLOY FAILED for commit ${p.sha}]\n${p.run_url || ''}\n` +
        'The merge landed but the code is NOT live in production. Tell Christian ' +
        'immediately, including the commit SHA and the run link. Silence ≠ success.'
      );
    case 'deploy_succeeded': {
      const supersedes = Number(p.supersedes ?? 0);
      const resolved =
        supersedes > 0
          ? ` (retired ${supersedes} stale failure alert${supersedes === 1 ? '' : 's'})`
          : '';
      return `[Deploy succeeded for commit ${p.sha}]${resolved} ${p.subject || ''} — the new code is live.`;
    }
    default:
      return `[ARCHITECT TASK COMPLETED: "${p.title}"]\n${p.summary}`;
  }
}

/**
 * Render a resolved deploy failure: a deploy_failed that a later
 * deploy_succeeded (in the same consumed batch) has already recovered.
 */
function formatResolvedDeployFailure(
  failure: AgentNotification,
  success: AgentNotification,
): string {
  const fp = (failure.payload ?? failure) as Record<string, unknown>;
  const sp = (success.payload ?? success) as Record<string, unknown>;
  return (
    `[DEPLOY FAILED for commit ${fp.sha} — since RESOLVED]\n` +
    `A later deploy for commit ${sp.sha} succeeded, so production is live again. ` +
    'No action needed — mention only if Christian asks about the earlier failure.'
  );
}

/**
 * Format a whole consumed batch of notifications.
 *
 * The queue drains in chronological order, so a deploy_failed followed
 * later in the same batch by a deploy_succeeded describes a failure we
 * have already recovered from. Render such a failure as resolved rather
 * than screaming "DEPLOY FAILED" about stale state — belt-and-suspenders
 * with notify_deploy_event.sh, which normally retires pending failures
 * before the batch is ever consumed.
 */
export function formatAgentNotifications(notifs: AgentNotification[]): string {
  const hasLaterSuccess = notifs.map((n, i) => {
    if (n.kind !== 'deploy_failed') return undefined;
    return notifs.slice(i + 1).find((m) => m.kind === 'deploy_succeeded');
  });
  return notifs
    .map((n, i) => {
      const success = hasLaterSuccess[i];
      return success ? formatResolvedDeployFailure(n, success) : formatAgentNotification(n);
    })
    .join('\n\n');
}
