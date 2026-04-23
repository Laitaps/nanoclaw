import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  HOST_GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { NullChannel } from './channels/null.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { startGooseMcpServer } from './goose-mcp-server.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessageMediaBlob,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, Record<string, string>> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/**
 * Determine the model family from a group's model.conf.
 * Returns 'local' for non-Claude models,
 * otherwise 'claude'.
 */
const LOCAL_MODEL_FAMILIES = new Set(['local']);

// Pinned to 2026-03-31 build — update digest intentionally, not via :latest drift
const GOOSE_IMAGE = 'ghcr.io/block/goose@sha256:f92c0b5fa49ba6e96820535d9ac331781721a2cb4593d73ff6d15a51a4c75c13';

// Research assistant host — all MCP and API URLs derive from this
// For Goose containers (--network host): use the host's real IP so MCP
// URLs are reachable.  host.docker.internal doesn't resolve on host network.
const RESEARCH_HOST = process.env.RESEARCH_HOST || 'http://192.168.68.70';
const MCP_RESEARCH_URL = `${RESEARCH_HOST}:8000/mcp`;
const DASHBOARD_API_URL = `${RESEARCH_HOST}:3000/api`;

// AI model config cache (fetched from settings API)
interface AiModelConfig {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  endpoint: string;
  context_limit?: number;
  compact_threshold?: number;
  max_subagents?: number;
  api_key?: string;
  enabled: boolean;
}
let aiModelsCache: AiModelConfig[] | null = null;
let aiModelsCacheTime = 0;
const AI_MODELS_CACHE_TTL = 30_000; // 30s

async function getAiModels(): Promise<AiModelConfig[]> {
  const now = Date.now();
  if (aiModelsCache && now - aiModelsCacheTime < AI_MODELS_CACHE_TTL) {
    return aiModelsCache;
  }
  try {
    const resp = await fetch(`${DASHBOARD_API_URL}/ai-models`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json() as { models: AiModelConfig[] };
    aiModelsCache = data.models;
    aiModelsCacheTime = now;
    return data.models;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch AI models from settings API, using cache');
    return aiModelsCache || [];
  }
}

async function getModelConfig(modelId: string): Promise<AiModelConfig | undefined> {
  const models = await getAiModels();
  return models.find((m) => m.id === modelId);
}

function getModelFamily(groupFolder: string): string {
  const modelConfPath = path.join(GROUPS_DIR, groupFolder, 'model.conf');
  try {
    const value = fs.readFileSync(modelConfPath, 'utf-8').trim().toLowerCase();
    return LOCAL_MODEL_FAMILIES.has(value) ? 'local' : 'claude';
  } catch {
    return 'claude';
  }
}

function getModelName(groupFolder: string): string {
  const modelConfPath = path.join(GROUPS_DIR, groupFolder, 'model.conf');
  try {
    return fs.readFileSync(modelConfPath, 'utf-8').trim().toLowerCase();
  } catch {
    return 'haiku';
  }
}

/**
 * Run Goose CLI in a Docker container for non-Claude models.
 * Returns the text result from Goose.
 */
/**
 * Tell the RA that Goose just compacted the session. The RA uses this
 * to replace (instead of add to) its ``session_ctx_used`` accumulator
 * on the next ``/chat/turn-stats`` call — the first post-compaction
 * turn's ``pp_tokens`` is the accurate new baseline since cache-reuse
 * misses after a summary rewrite. Fire-and-forget; we don't block the
 * agent loop on the RA's availability.
 */
function signalCompactionToRa(groupName: string): void {
  fetch(`${DASHBOARD_API_URL}/chat/turn-stats/compacted`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  }).catch((err) =>
    logger.warn({ group: groupName, err }, 'Failed to signal compaction to RA'),
  );
}

async function runGooseAgent(
  group: RegisteredGroup,
  prompt: string,
  modelName: string,
  chatJid: string,
  onResult: (text: string) => void,
): Promise<ContainerOutput> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const groupDir = path.join(GROUPS_DIR, group.folder);

  // Fetch model config from settings API
  const modelConfig = await getModelConfig(modelName);
  if (!modelConfig) {
    logger.error({ group: group.name, modelName }, 'Model config not found in AI Models settings');
    return { status: 'error', result: null, modelFamily: 'local', error: `Model '${modelName}' not found in settings` };
  }
  const endpoint = modelConfig.endpoint;
  const modelId = modelConfig.model_id;
  const contextLimit = modelConfig.context_limit;
  if (!contextLimit) {
    logger.error({ group: group.name, modelName }, 'Model is missing context_limit in AI Models settings — set it in Settings > AI Models');
    return { status: 'error', result: null, modelFamily: 'local', error: `Model '${modelName}' has no context_limit configured` };
  }
  const compactThreshold = modelConfig.compact_threshold ?? 0.7;

  // Query the llama-server's live slot state so we can (a) cap subagents
  // and (b) refuse to start if no slots are free. Each slot in the /slots
  // list has `is_processing: true/false`. If every slot is busy, we can't
  // even run the main agent — return an error so the user knows.
  let totalSlots: number | null = null;
  let idleSlots = 0;
  try {
    const resp = await fetch(`${endpoint}/slots`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const slotList = await resp.json() as { id: number; is_processing: boolean }[];
      if (Array.isArray(slotList) && slotList.length > 0) {
        totalSlots = slotList.length;
        idleSlots = slotList.filter(s => !s.is_processing).length;
      }
    }
  } catch {
    // endpoint unreachable — try /props as fallback for just total_slots
    try {
      const resp2 = await fetch(`${endpoint}/props`, { signal: AbortSignal.timeout(2000) });
      if (resp2.ok) {
        const data = await resp2.json() as { total_slots?: number };
        if (typeof data.total_slots === 'number') {
          totalSlots = data.total_slots;
          idleSlots = totalSlots; // assume all idle if /slots is unreachable
        }
      }
    } catch { /* give up */ }
  }

  // Hard check: refuse to start if no idle slots at all
  if (totalSlots !== null && idleSlots < 1) {
    logger.warn({ group: group.name, totalSlots, idleSlots }, 'All local model slots are busy — deferring request');
    return {
      status: 'error',
      result: null,
      modelFamily: 'local',
      error: 'The local model server has no free slots right now — all are in use by other sessions. Please try again in a moment.',
    };
  }

  // Cap subagents: min(configured, idle_slots - 1, total_slots - 1)
  // The main agent needs 1 slot, and other concurrent users may be consuming
  // slots we can't use. idle_slots reflects reality.
  const configuredMax = modelConfig.max_subagents;
  const slotCap = totalSlots !== null ? Math.max(0, totalSlots - 1) : Infinity;
  const idleCap = Math.max(0, idleSlots - 1); // leave 1 for the main agent
  const maxSubagents = configuredMax != null
    ? Math.min(Math.max(0, configuredMax), slotCap, idleCap)
    : (totalSlots !== null ? Math.min(slotCap, idleCap) : 0);

  // Load system prompt from CLAUDE.md
  let systemPrompt = '';
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
  }
  // Inject the subagent cap into the system prompt so Skippy knows the
  // hard limit. We can't stop Goose from spawning more internally, but
  // telling the model up front is the only control we have.
  const subagentRule = maxSubagents === 0
    ? 'SUBAGENT POLICY: You MUST NOT spawn any subagents — the local model does not have spare capacity. Do all work in your own session.'
    : `SUBAGENT POLICY: You MAY spawn at most ${maxSubagents} subagent${maxSubagents === 1 ? '' : 's'} at once. The local model server has ${totalSlots ?? '?'} parallel slots total and 1 is reserved for this main agent. Never ask Goose to spawn more than ${maxSubagents} parallel tasks.`;
  systemPrompt = systemPrompt ? `${systemPrompt}\n\n${subagentRule}` : subagentRule;
  logger.info(
    { group: group.name, totalSlots, configuredMax, maxSubagents },
    'Local model subagent policy computed',
  );

  // Start a temporary HTTP MCP server so Goose has access to nanoclaw
  // tools (send_message, send_image, schedule_task, etc.)
  let mcpHandle: { url: string; close: () => Promise<void> } | null = null;
  try {
    mcpHandle = await startGooseMcpServer({
      chatJid,
      groupFolder: group.folder,
      isMain,
    });
    logger.info({ group: group.name, url: mcpHandle.url }, 'Started Goose MCP server');
  } catch (err) {
    logger.error({ group: group.name, err }, 'Failed to start Goose MCP server, continuing without nanoclaw tools');
  }

  const containerName = `goose-${group.folder}-${Date.now()}`;
  const gooseSessionName = `skippy-${group.folder}`;

  // Persistent storage for Goose sessions — survives container destruction
  const gooseDataDir = path.join(GROUPS_DIR, group.folder, 'goose');
  const gooseShareDir = path.join(gooseDataDir, 'share');
  const gooseStateDir = path.join(gooseDataDir, 'state');
  fs.mkdirSync(gooseShareDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(gooseStateDir, { recursive: true, mode: 0o777 });
  // Ensure writable by Goose (uid 1000) even when orchestrator runs as root
  for (const d of [gooseDataDir, gooseShareDir, gooseStateDir]) {
    try { fs.chmodSync(d, 0o777); } catch { /* best effort */ }
  }

  // Host paths for sibling container volume mounts (Docker resolves -v
  // against the host filesystem, not the calling container)
  const hostGroupDir = path.join(HOST_GROUPS_DIR, group.folder);
  const hostGooseDataDir = path.join(hostGroupDir, 'goose');
  const hostGooseShareDir = path.join(hostGooseDataDir, 'share');
  const hostGooseStateDir = path.join(hostGooseDataDir, 'state');

  // Check if a prior session exists so we can resume it
  const hasExistingSession = fs.existsSync(path.join(gooseShareDir, 'sessions', 'sessions.db'));

  const args = [
    'run', '--rm', '-i',
    '--name', containerName,
    '--network', 'host',
    '-e', `GOOSE_PROVIDER=openai`,
    '-e', `GOOSE_MODEL=${modelId}`,
    '-e', `OPENAI_HOST=${endpoint}`,
    '-e', `OPENAI_API_KEY=${modelConfig.api_key || 'not-needed'}`,
    '-e', `GOOSE_CONTEXT_LIMIT=${contextLimit}`,
    '-e', `GOOSE_AUTO_COMPACT_THRESHOLD=${compactThreshold}`,
    '-e', 'GOOSE_TOOL_PAIR_SUMMARIZATION=true',
    // Mount group directory for file access
    '-v', `${hostGroupDir}:/workspace/group`,
    '-w', '/workspace/group',
    // Mount tool-images output directory
    '-v', `${path.resolve('dashboard/dist/tool-images')}:/workspace/tool-images`,
    // Persistent Goose session storage
    '-v', `${hostGooseShareDir}:/home/goose/.local/share/goose`,
    '-v', `${hostGooseStateDir}:/home/goose/.local/state/goose`,
    GOOSE_IMAGE,
    'run',
    '--no-profile',
    // --quiet: prints only the final model response to stdout (suppresses tool-call traces).
    // Previously paired with --debug to also disable length truncation, but --debug turned out
    // to feed the MCP tool-response Rust Debug struct into the model's context, causing
    // Skippy to echo "Annotated { raw: Text(RawTextContent { ... }) }" blocks in replies.
    // Dropping --debug for now; long-SVG truncation is handled by post-processing the
    // "(N more lines → /tmp/goose-XXXX.txt)" pointer below.
    '--quiet',
    '--name', gooseSessionName,
    ...(hasExistingSession ? ['--resume'] : []),
    '--max-tool-repetitions', '3',
    // System prompt from CLAUDE.md — Goose does NOT persist --system across
    // --resume, so it must be re-passed on every run or the personality is
    // lost on the second and subsequent messages of any session.
    ...(systemPrompt ? ['--system', systemPrompt] : []),
    // MCP extensions: nanoclaw (local HTTP), research, mast, viz, ai
    ...(mcpHandle ? ['--with-streamable-http-extension', mcpHandle.url] : []),
    '--with-streamable-http-extension', MCP_RESEARCH_URL,
    '--with-streamable-http-extension', `${RESEARCH_HOST}:8001/mcp`,
    '--with-streamable-http-extension', `${RESEARCH_HOST}:8002/mcp`,
    '--with-streamable-http-extension', `${RESEARCH_HOST}:8003/mcp`,
    '-t', prompt,
  ];

  // Snapshot llama-server's cumulative counters before and after the Goose run.
  // Deltas give us exact per-turn totals — immune to cache-reuse distortion,
  // lifetime-average gauges, and the 500ms-polling race the prior code had.
  interface MetricsSnapshot {
    promptTokens: number;
    promptSeconds: number;
    predictedTokens: number;
    predictedSeconds: number;
  }

  const readMetricsSnapshot = async (): Promise<MetricsSnapshot | null> => {
    try {
      const resp = await fetch(`${endpoint}/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return null;
      const text = await resp.text();
      const pull = (name: string): number | null => {
        const m = text.match(new RegExp(`^${name}\\s+([\\d.]+)`, 'm'));
        return m ? parseFloat(m[1]) : null;
      };
      const pt = pull('llamacpp:prompt_tokens_total');
      const ps = pull('llamacpp:prompt_seconds_total');
      const gt = pull('llamacpp:tokens_predicted_total');
      const gs = pull('llamacpp:tokens_predicted_seconds_total');
      if (pt === null || ps === null || gt === null || gs === null) return null;
      return { promptTokens: pt, promptSeconds: ps, predictedTokens: gt, predictedSeconds: gs };
    } catch {
      return null;
    }
  };

  const startSnapshot = await readMetricsSnapshot();

  return new Promise<ContainerOutput>((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('docker', args);
    logger.info({ group: group.name, containerName }, 'Spawning Goose container');

    let compactionNotified = false;

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;

      // Detect Goose compaction and notify the user in chat
      if (!compactionNotified && chunk.includes('Compacting to continue conversation')) {
        compactionNotified = true;
        logger.info({ group: group.name }, 'Goose is compacting conversation context');
        signalCompactionToRa(group.name);
        storeMessage({
          id: `sys-compact-${Date.now()}`,
          chat_jid: chatJid,
          sender: 'system',
          sender_name: 'System',
          content: `${ASSISTANT_NAME}: _[Context limit approaching — compacting conversation history]_`,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;

      // Compaction messages may appear on stderr too
      if (!compactionNotified && chunk.includes('Compacting to continue conversation')) {
        compactionNotified = true;
        logger.info({ group: group.name }, 'Goose is compacting conversation context');
        signalCompactionToRa(group.name);
        storeMessage({
          id: `sys-compact-${Date.now()}`,
          chat_jid: chatJid,
          sender: 'system',
          sender_name: 'System',
          content: `${ASSISTANT_NAME}: _[Context limit approaching — compacting conversation history]_`,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
    });

    proc.on('close', async (code) => {
      // Clean up the HTTP MCP server
      if (mcpHandle) {
        await mcpHandle.close().catch((err) =>
          logger.warn({ group: group.name, err }, 'Error closing Goose MCP server'),
        );
      }

      // Strip Goose tool execution traces from output.
      // Goose outputs tool traces like:
      //   ──────────────
      //   ▸ tool_name extension
      //     param: value
      //   (blank lines)
      //   Actual response text
      // Strategy: find the last ▸ block and take everything after it.
      // If no ▸ blocks, use the full output.
      let result = stdout;
      // Strip Goose startup banner (duck ASCII art + session info)
      result = result.replace(/^[\s\S]*?goose is ready\n?/m, '');
      const lastTrace = result.lastIndexOf('\u25B8'); // ▸ character
      if (lastTrace !== -1) {
        // Find the end of the ▸ line and any indented params after it
        let pos = result.indexOf('\n', lastTrace);
        if (pos !== -1) {
          // Skip indented continuation lines (params)
          while (pos < result.length) {
            const nextLine = result.indexOf('\n', pos + 1);
            const line = nextLine !== -1
              ? result.slice(pos + 1, nextLine)
              : result.slice(pos + 1);
            if (line.match(/^\s{2,}\S/)) {
              pos = nextLine !== -1 ? nextLine : result.length;
            } else {
              break;
            }
          }
          result = result.slice(pos);
        }
      }
      // Remove any remaining ─── lines
      result = result.replace(/^[\s\u2500]+$/gm, '').trim();

      // Dedupe fenced code blocks. When the model does a tool-call retry loop
      // (--max-tool-repetitions, or the create_note tool bouncing), it may
      // emit the same ```svg/```dot/```mermaid block in two separate assistant
      // turns. Both turns' text gets concatenated in stdout. Keep only the
      // first occurrence of each identical block — later duplicates get
      // dropped, interleaved prose stays.
      {
        const fenceRe = /```(\w*)\n([\s\S]*?)\n```/g;
        const seen = new Set<string>();
        result = result.replace(fenceRe, (match, lang, content) => {
          const key = (lang || '') + '::' + content.trim();
          if (seen.has(key)) return '';
          seen.add(key);
          return match;
        });
        // Collapse any 3+ consecutive newlines from removed blocks back to 2.
        result = result.replace(/\n{3,}/g, '\n\n').trim();
      }

      // Log compaction outcome
      if (compactionNotified) {
        const failed = stdout.includes('Compaction failed') || stderr.includes('Compaction failed');
        logger.info(
          { group: group.name, containerName, compactionResult: failed ? 'failed' : 'complete' },
          `Goose compaction ${failed ? 'failed' : 'complete'}`,
        );
      }

      // Snapshot counters after Goose exits. Delta from startSnapshot gives
      // exact per-turn totals, which we POST to the dashboard for accurate
      // pp/tg rates and running session-context accumulation.
      const endSnapshot = await readMetricsSnapshot();
      if (startSnapshot && endSnapshot) {
        const dPromptTokens = endSnapshot.promptTokens - startSnapshot.promptTokens;
        const dPromptSeconds = endSnapshot.promptSeconds - startSnapshot.promptSeconds;
        const dPredictedTokens = endSnapshot.predictedTokens - startSnapshot.predictedTokens;
        const dPredictedSeconds = endSnapshot.predictedSeconds - startSnapshot.predictedSeconds;
        // Guard against llama-server restart mid-turn (counters reset → negative deltas).
        if (dPromptTokens >= 0 && dPredictedTokens >= 0) {
          logger.info(
            { group: group.name, dPromptTokens, dPromptSeconds, dPredictedTokens, dPredictedSeconds },
            'Goose turn metrics captured',
          );
          await fetch(`${DASHBOARD_API_URL}/chat/turn-stats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pp_tokens: dPromptTokens,
              pp_seconds: dPromptSeconds,
              tg_tokens: dPredictedTokens,
              tg_seconds: dPredictedSeconds,
            }),
            signal: AbortSignal.timeout(3000),
          }).catch((err) =>
            logger.warn({ group: group.name, err }, 'Failed to POST turn-stats to dashboard'),
          );
        } else {
          logger.warn(
            { group: group.name, dPromptTokens, dPredictedTokens },
            'Negative counter delta detected (llama-server restart?) — skipping turn-stats POST',
          );
        }
      }

      // Detect Goose's truncated-tool-call error and rewrite it to a
      // user-actionable message instead of leaking the JSON-RPC code.
      // Triggered when llama-server hits its per-request generation cap
      // (--n-predict) mid-tool-call: the JSON closes unterminated and
      // Goose's MCP layer raises -32602. The cap was bumped to 32768 on
      // the server side, but if Skippy ever gets asked for a bigger
      // single output (or a future model has a tighter default), this
      // catches it and tells the user what to do instead of dumping a
      // raw error code into chat. Pattern is specific enough that it
      // can't false-positive on legitimate text.
      if (
        result.includes('-32602: Could not interpret tool use parameters') &&
        result.includes('EOF while parsing')
      ) {
        logger.warn(
          { group: group.name, containerName, originalLen: result.length },
          'Detected truncated tool-call error from Goose (-32602); rewriting to friendly message',
        );
        result = (
          "Sorry — my response got cut off mid-tool-call. The model hit its " +
          "per-request output cap before finishing. Try one of:\n\n" +
          "• Ask for a smaller chunk (e.g. \"just the function signatures\" " +
          "or \"only the first 200 lines\").\n" +
          "• Ask me to write the result to a file in pieces instead of one shot.\n" +
          "• If the slot is also nearly full (check the chat header), hit " +
          "Clear Chat and re-ask."
        );
      }

      logger.info(
        { group: group.name, containerName, code, resultLen: result.length, resultPreview: result.slice(0, 200), stdoutLen: stdout.length, stderrLen: stderr.length },
        'Goose container finished',
      );
      if (stderr.length > 0) {
        logger.info({ group: group.name, stderr: stderr.slice(0, 2000) }, 'Goose stderr');
      }

      if (code !== 0 && !result) {
        resolve({
          status: 'error',
          result: null,
          modelFamily: 'local',
          error: `Goose exited with code ${code}: ${stderr.slice(0, 500)}`,
        });
        return;
      }

      onResult(result);
      resolve({
        status: 'success',
        result,
        modelFamily: 'local',
      });
    });

    proc.on('error', async (err) => {
      if (mcpHandle) {
        await mcpHandle.close().catch(() => {});
      }
      resolve({
        status: 'error',
        result: null,
        modelFamily: 'local',
        error: `Failed to spawn Goose: ${err.message}`,
      });
    });
  });
}

let whatsapp: NullChannel;
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Save image attachments from messages to disk so the agent container can access them.
 * Sets msg.imagePath to the container-accessible path for each image.
 */
function saveMessageImages(messages: NewMessage[], groupFolder: string): void {
  for (const msg of messages) {
    if (msg.media_type) {
      const blob = getMessageMediaBlob(msg.id, msg.chat_jid);
      if (blob) {
        const ext = (msg.media_type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/g, '');
        const filename = `${msg.id}.${ext}`;
        const imageDir = path.join(GROUPS_DIR, groupFolder, 'images');
        fs.mkdirSync(imageDir, { recursive: true });
        fs.writeFileSync(path.join(imageDir, filename), blob);
        msg.imagePath = `/workspace/group/images/${filename}`;
        logger.info({ msgId: msg.id, path: msg.imagePath }, 'Saved image for agent access');
      }
    }
  }
}

/**
 * For messages with images, check if the local model supports vision.
 * If not, send each image to the GLM-vision server via the research
 * assistant's /api/vision/describe endpoint and replace the image
 * reference with a text description that the chat model can understand.
 */
async function describeImagesViaGlm(
  messages: NewMessage[],
  groupFolder: string,
): Promise<void> {
  // First check if the local model actually supports vision — if so, skip
  const modelConfig = await getModelConfig('local');
  if (!modelConfig?.endpoint) return;
  try {
    const resp = await fetch(`${modelConfig.endpoint}/props`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json() as { modalities?: { vision?: boolean } };
      if (data.modalities?.vision) {
        logger.info('Local model supports vision natively, skipping GLM routing');
        return;
      }
    }
  } catch {
    // Can't reach the model — proceed with GLM routing as a safe fallback
  }

  for (const msg of messages) {
    if (!msg.imagePath) continue;

    // Resolve the host-side path from the container path
    const relativePath = msg.imagePath.replace('/workspace/group/', '');
    const fullPath = path.join(GROUPS_DIR, groupFolder, relativePath);
    if (!fs.existsSync(fullPath)) {
      logger.warn({ msgId: msg.id, path: fullPath }, 'Image file not found for GLM routing');
      continue;
    }

    try {
      const imgBuf = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath).slice(1).toLowerCase();
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg',
        png: 'image/png', webp: 'image/webp',
        gif: 'image/gif',
      };
      const mime = mimeMap[ext] || 'image/jpeg';

      const form = new FormData();
      form.append('image', new Blob([imgBuf], { type: mime }), path.basename(fullPath));
      const userCaption = msg.content && msg.content !== '[image]' ? msg.content : '';
      const prompt = userCaption
        ? `The user shared this image with the caption: "${userCaption}". Describe what you see in the image concisely.`
        : 'Describe this image concisely. Focus on what is shown, any text visible, and the key visual elements.';
      form.append('prompt', prompt);

      logger.info({ msgId: msg.id }, 'Routing image to GLM-vision for description');
      const resp = await fetch(`${DASHBOARD_API_URL}/vision/describe`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const data = await resp.json() as { ok: boolean; description?: string; error?: string };

      if (data.ok && data.description) {
        const caption = userCaption ? `${userCaption}\n\n` : '';
        msg.content = `${caption}[The user shared an image. Vision analysis: ${data.description}]`;
        delete msg.imagePath;
        logger.info({ msgId: msg.id }, 'Image described by GLM-vision, injected into message');
      } else {
        logger.error({ msgId: msg.id, error: data.error }, 'GLM-vision describe failed');
        msg.content = `${msg.content || ''}\n[An image was shared but the vision server could not analyze it: ${data.error || 'unknown error'}]`;
        delete msg.imagePath;
      }
    } catch (err) {
      logger.error({ msgId: msg.id, err }, 'Failed to route image to GLM-vision');
      msg.content = `${msg.content || ''}\n[An image was shared but could not be analyzed — vision server unreachable]`;
      delete msg.imagePath;
    }
  }
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // Save any image attachments to disk for agent access
  saveMessageImages(missedMessages, group.folder);

  // If any messages have images and the current model lacks vision support,
  // route images to GLM-vision for text descriptions before the agent sees them.
  const modelName = getModelName(group.folder);
  if (LOCAL_MODEL_FAMILIES.has(modelName)) {
    const hasImages = missedMessages.some(m => m.imagePath);
    if (hasImages) {
      await describeImagesViaGlm(missedMessages, group.folder);
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  let prompt = formatMessages(missedMessages);

  // Check for pending architect notifications (main group only)
  if (isMainGroup) {
    try {
      const notifResp = await fetch(`${DASHBOARD_API_URL}/chat/pending-notifications`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      const notifData = await notifResp.json() as { notifications?: Array<{ title: string; summary: string }> };
      if (notifData.notifications && notifData.notifications.length > 0) {
        const notifContext = notifData.notifications.map(
          (n) => `[ARCHITECT TASK COMPLETED: "${n.title}"]\n${n.summary}`
        ).join('\n\n');
        prompt = `${prompt}\n\n[System context — The Architect completed the following task(s) while you were idle. Mention this naturally in your response.]\n${notifContext}`;
        logger.info({ count: notifData.notifications.length }, 'Injected architect notifications into prompt');
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to fetch architect notifications (non-fatal)');
    }
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await whatsapp.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      // Lenient closing tag: matches </internal>, </interactive>, </intern>, etc.
      const text = raw.replace(/<internal>[\s\S]*?<\/inter\w*>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Always record the bot reply in the DB so dashboard chat works
        // even when WhatsApp is disconnected.
        const prefixed = `${ASSISTANT_NAME}: ${text}`;
        storeMessage({
          id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: ASSISTANT_NAME.toLowerCase(),
          sender_name: ASSISTANT_NAME,
          content: prefixed,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
        await whatsapp.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await whatsapp.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const modelName = getModelName(group.folder);
  const modelFamily = LOCAL_MODEL_FAMILIES.has(modelName) ? 'local' : 'claude';
  const sessionId = sessions[group.folder]?.[modelFamily];

  // Non-Claude models: use Goose CLI instead of the Claude SDK container
  if (LOCAL_MODEL_FAMILIES.has(modelName)) {
    logger.info({ group: group.name, model: modelName }, 'Using Goose for non-Claude model');
    const output = await runGooseAgent(group, prompt, modelName, chatJid, (text) => {
      if (onOutput) {
        onOutput({ status: 'success', result: text, modelFamily: 'local' });
      }
    });
    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Goose agent error');
      return 'error';
    }
    return 'success';
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          const family = output.modelFamily || modelFamily;
          if (!sessions[group.folder]) sessions[group.folder] = {};
          sessions[group.folder][family] = output.newSessionId;
          setSession(group.folder, family, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        modelFamily,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      const family = output.modelFamily || modelFamily;
      if (!sessions[group.folder]) sessions[group.folder] = {};
      sessions[group.folder][family] = output.newSessionId;
      setSession(group.folder, family, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          saveMessageImages(messagesToSend, group.folder);
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            whatsapp.setTyping(chatJid, true);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }

  // Kill and clean up orphaned NanoClaw agent containers from previous runs.
  // Agent containers are named nanoclaw-{group}-{ts} by container-runner.
  // Use ^nanoclaw- regex to avoid matching the orchestrator (research_assistant-nanoclaw-1).
  try {
    const output = execSync('docker ps --filter "name=^nanoclaw-" --format "{{.Names}}"', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  whatsapp = new NullChannel();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    sendImage: (jid, image, caption) => whatsapp.sendImage(jid, image, caption),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
