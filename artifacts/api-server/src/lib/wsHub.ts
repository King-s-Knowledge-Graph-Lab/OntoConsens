import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  appendAudioChunk,
  closeTranscriptionSession,
  openTranscriptionSession,
} from "./realtimeTranscription";
import { logger } from "./logger";

interface Ticket {
  userId: number;
  // Absent for a user-scoped (dashboard) connection, which isn't tied to
  // any single project — see issueUserTicket.
  projectId?: number;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 30_000;

export function issueTicket(userId: number, projectId: number): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { userId, projectId, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

// Lets a client connect without picking a specific project — used by the
// dashboard so it can learn the instant one of the user's projects is
// deleted by someone else, instead of waiting on the next background poll.
export function issueUserTicket(userId: number): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function consumeTicket(ticket: string | null): Ticket | undefined {
  if (!ticket) return undefined;
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry;
}

interface ClientInfo {
  userId: number;
  // Absent for a dashboard (user-scoped) connection.
  projectId?: number;
  isAlive: boolean;
  // Token-bucket rate limit for binary audio frames (see the "message"
  // handler below) -- without this, a member's socket could forward
  // arbitrary binary data to the project owner's billed OpenAI Realtime
  // session as fast as the connection allows, running up their bill and/or
  // exhausting server resources. Only allocated the first time this client
  // sends a binary frame.
  audioBudget?: { tokens: number; lastRefillMs: number; violations: number };
}

const clients = new Map<WebSocket, ClientInfo>();

// Real audio chunks are raw PCM16 mono at 24kHz -- 48,000 bytes/second.
// Client-side chunking (see useModeratorAudio's PROCESSOR_BUFFER_SIZE) sends
// far smaller frames than this ceiling; it exists purely to reject anything
// wildly larger than any legitimate single frame could ever be, before it's
// even considered against the rate limit below.
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
// Sustained-rate cap matches the real PCM stream rate (48,000 bytes/sec);
// the bucket capacity allows a couple of seconds of burst so normal jitter
// in the client's send timing is never mistaken for abuse.
const AUDIO_BYTES_PER_SECOND = 48_000;
const AUDIO_BUCKET_CAPACITY_BYTES = AUDIO_BYTES_PER_SECOND * 2;
// A client that keeps exceeding the budget after this many consecutive
// dropped frames isn't hitting a one-off burst -- it's sending audio (or
// non-audio junk) far beyond what real mic capture could ever produce, so
// the connection itself is closed rather than silently dropping forever.
const MAX_AUDIO_VIOLATIONS = 20;

// Returns true if this frame is within budget (and should be forwarded),
// false if it must be dropped. Mutates the client's token bucket either way.
function allowAudioFrame(info: ClientInfo, byteLength: number): boolean {
  if (byteLength > MAX_AUDIO_FRAME_BYTES) return false;
  const now = Date.now();
  if (!info.audioBudget) {
    info.audioBudget = { tokens: AUDIO_BUCKET_CAPACITY_BYTES, lastRefillMs: now, violations: 0 };
  }
  const budget = info.audioBudget;
  const elapsedMs = now - budget.lastRefillMs;
  budget.lastRefillMs = now;
  budget.tokens = Math.min(AUDIO_BUCKET_CAPACITY_BYTES, budget.tokens + (elapsedMs / 1000) * AUDIO_BYTES_PER_SECOND);
  if (byteLength > budget.tokens) return false;
  budget.tokens -= byteLength;
  return true;
}

export type ServerEvent =
  | { type: "cursor"; userId: number; x: number; y: number }
  | { type: "cursor_left"; userId: number }
  | { type: "presence"; userIds: number[] }
  | { type: "property_created" }
  | { type: "property_updated" }
  | { type: "property_deleted" }
  | { type: "agreement_changed" }
  | { type: "member_joined" }
  | { type: "member_ready" }
  | { type: "project_deleted"; projectId?: number }
  | { type: "member_count_changed"; projectId: number; memberCount: number }
  | { type: "speaker_volume"; userId: number; level: number }
  | { type: "live_caption"; userId: number; text: string; utteranceId: number }
  | {
      type: "moderator_chat_message";
      // A single, fully-serialized row from the persisted moderator chat
      // log -- intro/system/transcript/intervention -- ready to render or
      // append as-is, identical in shape to what GET
      // /projects/:id/moderator/messages returns for reload/rejoin.
      message: {
        id: number;
        type: "intro" | "system" | "transcript" | "intervention" | "export_notice";
        userId: number | null;
        username: string | null;
        colorSlot: number | null;
        content: string;
        matched: boolean | null;
        className: string | null;
        propertyName: string | null;
        classId: number | null;
        propertyId: number | null;
        createdAt: string;
        // Only present on a freshly-broadcast "transcript" message -- echoes
        // back the client-generated utteranceId the speaker submitted it
        // with, so every viewer's live-caption cleanup can tell whether the
        // speaker's caption box still shows THIS utterance or has already
        // moved on to a new one. Never persisted to the DB, so it's absent
        // from history replay.
        utteranceId?: number;
      };
    }
  | { type: "moderator_error"; message: string }
  // Server-to-caller-only ack that a "mic_stop" control message (see
  // socket.on("message") below) has finished its teardown -- including
  // durably persisting any last utterance OpenAI was still transcribing.
  // Never broadcast to the rest of the project, only sent back down the
  // same socket that asked to stop.
  | { type: "mic_stop_ack" }
  // Broadcast once all three intervention conditions (silence, a new
  // finalized message, and genuinely new content) are already confirmed
  // true and the message itself is durably committed -- purely tells
  // clients to show the "AI moderator is typing" indicator for the short
  // beat before the real "moderator_chat_message" (type "intervention")
  // follows. See generateIntervention in moderatorEngine.ts.
  | { type: "moderator_intervention_typing" };

function onlineUserIds(projectId: number): number[] {
  const ids = new Set<number>();
  for (const info of clients.values()) {
    if (info.projectId === projectId) ids.add(info.userId);
  }
  return Array.from(ids);
}

function broadcastPresence(projectId: number) {
  broadcastToProject(projectId, { type: "presence", userIds: onlineUserIds(projectId) });
}

export function broadcastToProject(
  projectId: number,
  event: ServerEvent,
  exclude?: WebSocket,
) {
  const payload = JSON.stringify(event);
  for (const [socket, info] of clients) {
    if (info.projectId === projectId && socket !== exclude && socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

// Pushes an event straight to specific users' dashboard connections,
// regardless of which project (if any) they're currently viewing. Used so a
// project's other members see it disappear from their project list the
// instant it's deleted, instead of waiting for the next background poll.
export function broadcastToUsers(userIds: number[], event: ServerEvent) {
  if (userIds.length === 0) return;
  const targets = new Set(userIds);
  const payload = JSON.stringify(event);
  for (const [socket, info] of clients) {
    if (
      info.projectId === undefined &&
      targets.has(info.userId) &&
      socket.readyState === socket.OPEN
    ) {
      socket.send(payload);
    }
  }
}

const HEARTBEAT_INTERVAL_MS = 20_000;

export function setupWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  function leaveProject(socket: WebSocket) {
    const info = clients.get(socket);
    if (!info) return;
    clients.delete(socket);
    if (info.projectId === undefined) return; // dashboard connection, nothing to broadcast
    // A tab closed/navigated away without ever sending "mic_stop" (e.g. a
    // crash, or just closing the tab mid-sentence) must still tear down any
    // OpenAI realtime session this member had open -- otherwise it leaks
    // until it eventually errors out on its own.
    closeTranscriptionSession(info.projectId, info.userId).catch((err) => {
      logger.error({ err, projectId: info.projectId, userId: info.userId }, "Failed to close transcription session on disconnect");
    });
    // Let everyone still in the project know this cursor is gone immediately,
    // instead of leaving a stale cursor on screen until it times out client-side.
    broadcastToProject(info.projectId, { type: "cursor_left", userId: info.userId });
    broadcastPresence(info.projectId);
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const ticket = consumeTicket(url.searchParams.get("ticket"));

    if (!ticket) {
      socket.close(4001, "Invalid or expired ticket");
      return;
    }

    clients.set(socket, { userId: ticket.userId, projectId: ticket.projectId, isAlive: true });
    if (ticket.projectId !== undefined) {
      // Tell everyone (including this new connection) who's currently online,
      // so avatar "in this project now" rings update live with no refresh.
      broadcastPresence(ticket.projectId);
    }

    socket.on("pong", () => {
      const info = clients.get(socket);
      if (info) info.isAlive = true;
    });

    socket.on("message", (raw, isBinary) => {
      if (ticket.projectId === undefined) return; // dashboard connections don't send anything

      // Raw PCM16/24kHz audio chunks for live transcription arrive as
      // binary frames -- never JSON -- and are forwarded straight into
      // this member's OpenAI realtime session (if one is open).
      if (isBinary) {
        const info = clients.get(socket);
        if (!info) return;
        const buffer = raw as Buffer;
        if (!allowAudioFrame(info, buffer.length)) {
          const budget = info.audioBudget!;
          budget.violations += 1;
          logger.warn(
            { projectId: ticket.projectId, userId: ticket.userId, byteLength: buffer.length },
            "Dropped over-budget audio frame",
          );
          if (budget.violations > MAX_AUDIO_VIOLATIONS) {
            logger.warn(
              { projectId: ticket.projectId, userId: ticket.userId },
              "Closing socket for sustained audio rate-limit abuse",
            );
            socket.close(1008, "Audio rate limit exceeded");
          }
          return;
        }
        appendAudioChunk(ticket.projectId, ticket.userId, buffer);
        return;
      }

      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        (data as { type: unknown }).type === "cursor" &&
        "x" in data &&
        "y" in data
      ) {
        const { x, y } = data as { x: number; y: number };
        broadcastToProject(
          ticket.projectId,
          { type: "cursor", userId: ticket.userId, x, y },
          socket,
        );
      } else if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        (data as { type: unknown }).type === "volume" &&
        "level" in data &&
        typeof (data as { level: unknown }).level === "number"
      ) {
        const { level } = data as { level: number };
        // Unlike cursor moves, the speaker themself also needs this event --
        // it drives their own "you are speaking" indicator, not just
        // everyone else's pulsing border -- so it is NOT excluded from the
        // sending socket.
        broadcastToProject(ticket.projectId, { type: "speaker_volume", userId: ticket.userId, level });
      } else if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        (data as { type: unknown }).type === "mic_start"
      ) {
        // Fire-and-forget: audio chunks that arrive before this resolves are
        // buffered by appendAudioChunk until the session is ready (see
        // realtimeTranscription.ts).
        openTranscriptionSession(ticket.projectId, ticket.userId).catch((err) => {
          logger.error({ err, projectId: ticket.projectId, userId: ticket.userId }, "Failed to open transcription session");
        });
      } else if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        (data as { type: unknown }).type === "mic_stop"
      ) {
        closeTranscriptionSession(ticket.projectId, ticket.userId)
          .catch((err) => {
            logger.error({ err, projectId: ticket.projectId, userId: ticket.userId }, "Failed to close transcription session");
          })
          .finally(() => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "mic_stop_ack" }));
            }
          });
      }
    });

    socket.on("close", () => {
      leaveProject(socket);
    });
    socket.on("error", () => {
      leaveProject(socket);
    });
  });

  // Detect zombie connections (e.g. a laptop that went to sleep, or a network
  // drop that never sent a close frame) so their cursors don't linger forever
  // and so the server's client list stays accurate for broadcasts.
  const heartbeat = setInterval(() => {
    for (const [socket, info] of clients) {
      if (!info.isAlive) {
        socket.terminate();
        leaveProject(socket);
        continue;
      }
      info.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
