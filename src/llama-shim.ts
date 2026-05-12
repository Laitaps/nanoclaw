/**
 * Llama HTTP shim. Sits between Goose (or any OpenAI-compatible client)
 * and llama-server, captures `usage` + `timings` from every
 * /v1/chat/completions response, and calls onEvent with the per-request
 * truth. Pass-through for everything else.
 *
 * This is the single source of per-conversation, per-request metrics —
 * replaces the Prometheus counter-delta-around-docker-run path that
 * cross-contaminated with other slots and miscounted tool round-trips.
 */
import { createServer, request as httpRequest, IncomingMessage, Server } from 'http';
import { URL } from 'url';

import { logger } from './logger.js';

export interface LlamaEvent {
  conversation_id: string;
  slot_id: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  pp_tps: number;
  tg_tps: number;
  pp_ms: number;
  tg_ms: number;
  streamed: boolean;
}

export interface ShimOptions {
  upstreamUrl: string; // e.g. "http://192.168.68.70:8085"
  conversationId: string;
  onEvent: (event: LlamaEvent) => void;
}

export interface ShimHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the shim listening on an ephemeral localhost port.
 * Returns once the server is ready to accept connections.
 */
export async function startLlamaShim(opts: ShimOptions): Promise<ShimHandle> {
  const upstream = new URL(opts.upstreamUrl);

  const server: Server = createServer((clientReq, clientRes) => {
    const upstreamReq = httpRequest({
      host: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: upstream.host },
    });

    const isChat =
      clientReq.method === 'POST' &&
      (clientReq.url?.startsWith('/v1/chat/completions') ||
        clientReq.url?.startsWith('/chat/completions'));

    upstreamReq.on('response', (upstreamRes: IncomingMessage) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);

      if (!isChat) {
        upstreamRes.pipe(clientRes);
        return;
      }

      const isStream = String(upstreamRes.headers['content-type'] || '').includes('event-stream');

      if (isStream) {
        // Stream: forward verbatim, sniff the trailing chunk that carries
        // `timings` (llama-server emits timings on the final data frame
        // before [DONE]).
        let buffer = '';
        let captured: Record<string, unknown> | null = null;

        upstreamRes.on('data', (chunk: Buffer) => {
          clientRes.write(chunk);
          buffer += chunk.toString('utf8');
          // SSE frames are separated by blank lines. Drain complete frames.
          let nl: number;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const obj = JSON.parse(payload) as Record<string, unknown>;
                if (obj['timings'] || obj['usage']) captured = obj;
              } catch {
                /* ignore non-JSON */
              }
            }
          }
        });

        upstreamRes.on('end', () => {
          clientRes.end();
          if (captured) emit(opts, captured, true);
        });
        upstreamRes.on('error', () => clientRes.end());
      } else {
        // Non-stream: buffer the body so we can parse JSON, then forward.
        const chunks: Buffer[] = [];
        upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks);
          clientRes.end(body);
          try {
            const obj = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            if (obj['timings'] || obj['usage']) emit(opts, obj, false);
          } catch {
            /* ignore */
          }
        });
        upstreamRes.on('error', () => clientRes.end());
      }
    });

    upstreamReq.on('error', (err) => {
      logger.warn({ err: err.message, url: clientReq.url }, 'shim: upstream error');
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      clientRes.end(`upstream error: ${err.message}`);
    });

    clientReq.pipe(upstreamReq);
  });

  // Bind on all interfaces — when nanoclaw runs in a bridge-network
  // container and Goose runs with --network=host, Goose connects via
  // nanoclaw's container IP from the host's network namespace, not via
  // 127.0.0.1 (different namespaces). The caller (index.ts) supplies the
  // reachable IP to Goose in OPENAI_HOST.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('shim: failed to bind ephemeral port');
  }
  const port = address.port;
  logger.info({ port, upstream: opts.upstreamUrl, conv: opts.conversationId }, 'shim listening');

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function emit(
  opts: ShimOptions,
  resp: Record<string, unknown>,
  streamed: boolean,
): void {
  const timings = (resp['timings'] as Record<string, unknown>) || {};
  const usage = (resp['usage'] as Record<string, unknown>) || {};
  const promptDetails = (usage['prompt_tokens_details'] as Record<string, unknown>) || {};

  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

  const event: LlamaEvent = {
    conversation_id: opts.conversationId,
    slot_id: typeof resp['id_slot'] === 'number' ? (resp['id_slot'] as number) : null,
    prompt_tokens: num(usage['prompt_tokens']) || num(timings['prompt_n']),
    completion_tokens: num(usage['completion_tokens']) || num(timings['predicted_n']),
    cached_tokens: num(promptDetails['cached_tokens']) || num(timings['cache_n']),
    pp_tps: num(timings['prompt_per_second']),
    tg_tps: num(timings['predicted_per_second']),
    pp_ms: num(timings['prompt_ms']),
    tg_ms: num(timings['predicted_ms']),
    streamed,
  };

  try {
    opts.onEvent(event);
  } catch (err) {
    logger.warn({ err }, 'shim: onEvent threw');
  }
}
