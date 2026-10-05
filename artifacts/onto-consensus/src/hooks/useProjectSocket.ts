import { useCallback, useEffect, useRef, useState } from "react";
import { useCreateWsTicket } from "@workspace/api-client-react";

export interface RemoteCursor {
  userId: number;
  x: number;
  y: number;
  updatedAt: number;
}

export interface SpeakerVolume {
  userId: number;
  level: number;
  updatedAt: number;
}

// One point raised for/against a property, plus everyone who made it --
// mirrors ModeratorInterventionEntry in the OpenAPI schema.
export interface ModeratorInterventionEntry {
  text: string;
  by: string[];
}

// One entry in the persistent moderator chat log -- mirrors
// SerializedChatMessage on the server (see moderatorEngine.ts) and the
// ModeratorChatMessage OpenAPI schema, so a live-broadcast message and one
// fetched from GET /projects/:id/moderator/messages render identically.
export interface ModeratorChatMessage {
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
  examples: ModeratorInterventionEntry[] | null;
  counterexamples: ModeratorInterventionEntry[] | null;
  createdAt: string;
  /** Only present on a freshly-broadcast "transcript" message, echoing back
   *  the same per-browser-session utterance counter the speaker's client
   *  sent along with it (see useModeratorAudio's onFinalize) -- never
   *  persisted, so it's absent from history fetched via GET
   *  /projects/:id/moderator/messages. Lets every viewer's "a real message
   *  landed" handling tell whether the speaker's live caption still shows
   *  THIS utterance (safe to clear) or has already moved on to a new one
   *  (must be left alone). */
  utteranceId?: number;
}

type ServerEvent =
  | { type: "cursor"; userId: number; x: number; y: number }
  | { type: "cursor_left"; userId: number }
  | { type: "presence"; userIds: number[] }
  | { type: "property_created" }
  | { type: "property_updated" }
  | { type: "property_deleted" }
  | { type: "agreement_changed" }
  | { type: "member_joined" }
  | { type: "member_ready" }
  | { type: "project_deleted" }
  | { type: "speaker_volume"; userId: number; level: number }
  | { type: "live_caption"; userId: number; text: string; utteranceId: number }
  | { type: "moderator_chat_message"; message: ModeratorChatMessage }
  | { type: "moderator_error"; message: string }
  | { type: "moderator_intervention_typing" }
  | { type: "mic_stop_ack" };

export interface LiveCaption {
  userId: number;
  text: string;
  updatedAt: number;
  /** Which utterance (per the speaker's own useModeratorAudio session) this
   *  text belongs to -- see clearLiveCaption below for why this matters. */
  utteranceId: number;
}

interface UseProjectSocketOptions {
  projectId: number;
  enabled: boolean;
  onProjectChanged?: () => void;
  onPropertiesChanged?: () => void;
  onProjectDeleted?: () => void;
  onModeratorChatMessage?: (message: ModeratorChatMessage) => void;
  onModeratorError?: (message: string) => void;
  onModeratorInterventionTyping?: () => void;
}

// Speaker volume readings older than this are dropped even if no new
// message arrives to trigger a re-render — e.g. someone's tab crashed
// mid-sentence and no further "speaking stopped" signal ever comes in.
const SPEAKER_VOLUME_TTL_MS = 1_200;
const SPEAKER_VOLUME_PRUNE_INTERVAL_MS = 500;

// A live caption is cleared this long after its last update -- but only as
// a last-resort cleanup for a truly abandoned utterance (e.g. a tab crashed
// mid-sentence and no finalize/clear ever arrives). It must stay well above
// SILENCE_FINALIZE_MS (2s): once that fires, the box's last update stops
// advancing while the finalized text makes its full round trip to the
// server and back as a permanent message -- if this TTL were close to that
// 2s window, a slow round trip could prune the box (making it vanish) just
// before the real message arrives (making it reappear), a visible
// disappear-then-reappear flash. The gap here needs to comfortably outlast
// that whole round trip, not just the silence window that triggers it.
const LIVE_CAPTION_TTL_MS = 12_000;
const LIVE_CAPTION_PRUNE_INTERVAL_MS = 500;

// Cursors older than this are considered stale and pruned even if no new
// socket message ever arrives to trigger a re-render.
const CURSOR_TTL_MS = 8_000;
const CURSOR_PRUNE_INTERVAL_MS = 2_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
// After this many failed reconnect attempts in a row, surface "disconnected"
// instead of "reconnecting" — a couple of quick retries look like a blip, but
// a long streak of failures means the user should know sync has actually
// stopped, not just briefly stuttered.
const DISCONNECTED_AFTER_ATTEMPTS = 3;

export type SocketStatus = "connected" | "reconnecting" | "disconnected";

export function useProjectSocket({
  projectId,
  enabled,
  onProjectChanged,
  onPropertiesChanged,
  onProjectDeleted,
  onModeratorChatMessage,
  onModeratorError,
  onModeratorInterventionTyping,
}: UseProjectSocketOptions) {
  const createTicket = useCreateWsTicket();
  const socketRef = useRef<WebSocket | null>(null);
  const [cursors, setCursors] = useState<Map<number, RemoteCursor>>(new Map());
  const [status, setStatus] = useState<SocketStatus>("reconnecting");
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(new Set());
  const [speakerVolumes, setSpeakerVolumes] = useState<Map<number, SpeakerVolume>>(new Map());
  const [liveCaptions, setLiveCaptions] = useState<Map<number, LiveCaption>>(new Map());
  // Resolves whichever sendMicStop() promise is currently pending, once the
  // server confirms it has finished tearing the transcription session down
  // (see the "mic_stop_ack" case below). Only ever one at a time -- a
  // member can't be turning their mic off twice concurrently.
  const micStopAckRef = useRef<(() => void) | null>(null);
  // Whether this member's mic is currently supposed to be on. The server
  // tears down a member's transcription session the instant their project
  // socket disconnects (see wsHub's leaveProject), so a reconnect after any
  // drop -- not just an explicit toggle-off -- silently ends transcription
  // unless something re-sends mic_start on the fresh socket. Tracking it
  // here (rather than relying on useModeratorAudio's effect to notice and
  // resend) means it happens automatically on every reconnect, including
  // ones that occur without any React re-render of the component that owns
  // the mic.
  const micActiveRef = useRef(false);
  const callbacksRef = useRef({
    onProjectChanged,
    onPropertiesChanged,
    onProjectDeleted,
    onModeratorChatMessage,
    onModeratorError,
    onModeratorInterventionTyping,
  });
  callbacksRef.current = {
    onProjectChanged,
    onPropertiesChanged,
    onProjectDeleted,
    onModeratorChatMessage,
    onModeratorError,
    onModeratorInterventionTyping,
  };

  useEffect(() => {
    if (!enabled) {
      setCursors(new Map());
      setStatus("reconnecting");
      setOnlineUserIds(new Set());
      setSpeakerVolumes(new Map());
      setLiveCaptions(new Map());
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    function scheduleReconnect() {
      if (stopped) return;
      setStatus(reconnectAttempt >= DISCONNECTED_AFTER_ATTEMPTS ? "disconnected" : "reconnecting");
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    async function connect() {
      if (stopped) return;
      let ticket: string;
      try {
        ticket = (await createTicket.mutateAsync({ id: projectId })).ticket;
      } catch {
        // Fetching a ticket failed (e.g. transient network issue) — keep
        // retrying with backoff instead of leaving the user permanently
        // disconnected until they refresh the page.
        scheduleReconnect();
        return;
      }
      if (stopped) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?ticket=${ticket}`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (stopped) return;
        reconnectAttempt = 0;
        setStatus("connected");
        // Reconnecting after a drop means we may have missed events while
        // offline (a new member joined, someone marked ready, a property
        // changed) — catch up immediately rather than waiting for the next
        // live event, since a missed broadcast would otherwise go unnoticed
        // until something else happens to trigger a refetch.
        callbacksRef.current.onProjectChanged?.();
        callbacksRef.current.onPropertiesChanged?.();
        // The mic itself (getUserMedia/AudioContext capture) never noticed
        // the drop and keeps streaming audio the whole time -- only the
        // server-side transcription session was lost with the old socket.
        // Re-arm it here so a brief reconnect blip doesn't permanently end
        // transcription for the rest of the call.
        if (micActiveRef.current) {
          socket?.send(JSON.stringify({ type: "mic_start" }));
        }
      });

      socket.addEventListener("message", (event) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (data.type) {
          case "cursor":
            setCursors((prev) => {
              const next = new Map(prev);
              next.set(data.userId, { userId: data.userId, x: data.x, y: data.y, updatedAt: Date.now() });
              return next;
            });
            break;
          case "cursor_left":
            setCursors((prev) => {
              if (!prev.has(data.userId)) return prev;
              const next = new Map(prev);
              next.delete(data.userId);
              return next;
            });
            break;
          case "presence":
            setOnlineUserIds(new Set(data.userIds));
            break;
          case "property_created":
          case "property_updated":
          case "property_deleted":
          case "agreement_changed":
            callbacksRef.current.onPropertiesChanged?.();
            break;
          case "member_joined":
          case "member_ready":
            // Membership/readiness changes can flip who is allowed to see
            // which properties (the shared space only opens once everyone is
            // ready), so both queries need to refresh together — refreshing
            // only the project would leave the properties list stale until
            // some unrelated property edit happened to trigger it.
            callbacksRef.current.onProjectChanged?.();
            callbacksRef.current.onPropertiesChanged?.();
            break;
          case "project_deleted":
            callbacksRef.current.onProjectDeleted?.();
            break;
          case "speaker_volume":
            setSpeakerVolumes((prev) => {
              const next = new Map(prev);
              next.set(data.userId, { userId: data.userId, level: data.level, updatedAt: Date.now() });
              return next;
            });
            break;
          case "live_caption":
            setLiveCaptions((prev) => {
              const next = new Map(prev);
              next.set(data.userId, {
                userId: data.userId,
                text: data.text,
                updatedAt: Date.now(),
                utteranceId: data.utteranceId,
              });
              return next;
            });
            break;
          case "moderator_chat_message":
            callbacksRef.current.onModeratorChatMessage?.(data.message);
            break;
          case "moderator_error":
            callbacksRef.current.onModeratorError?.(data.message);
            break;
          case "moderator_intervention_typing":
            callbacksRef.current.onModeratorInterventionTyping?.();
            break;
          case "mic_stop_ack":
            micStopAckRef.current?.();
            break;
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (!stopped) scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled]);

  // A cursor's owner may have gone idle, closed their tab without a clean
  // close event reaching us yet, or lost connectivity — prune anything stale
  // on a timer so it disappears on its own instead of only when some other
  // cursor message happens to trigger a re-render.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setCursors((prev) => {
        const cutoff = Date.now() - CURSOR_TTL_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [userId, cursor] of prev) {
          if (cursor.updatedAt < cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, CURSOR_PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // Mirrors the cursor-pruning effect above: a speaker's tab can vanish
  // mid-word (crash, lost connectivity) with no final "stopped speaking"
  // message ever arriving, so the pulsing border needs its own timeout
  // rather than waiting on the next volume update to clear it.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setSpeakerVolumes((prev) => {
        const cutoff = Date.now() - SPEAKER_VOLUME_TTL_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [userId, volume] of prev) {
          if (volume.updatedAt < cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, SPEAKER_VOLUME_PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // A live caption with no update in a while means the speaker either
  // finished their sentence and the recognizer went quiet, or their tab
  // disappeared mid-word -- either way it should fade rather than linger
  // forever waiting for an utterance that may never resume.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setLiveCaptions((prev) => {
        const cutoff = Date.now() - LIVE_CAPTION_TTL_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [userId, caption] of prev) {
          if (caption.updatedAt < cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, LIVE_CAPTION_PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  const sendCursor = useCallback((x: number, y: number) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cursor", x, y }));
    }
  }, []);

  const sendVolume = useCallback((level: number) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "volume", level }));
    }
  }, []);

  // Tells the server to open this member's OpenAI realtime transcription
  // session -- see useModeratorAudio, which calls this the moment mic
  // access is granted. The model handles whatever language is spoken on
  // its own, so there's no hint to pass.
  const sendMicStart = useCallback(() => {
    micActiveRef.current = true;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "mic_start" }));
    }
  }, []);

  // Raw PCM16/24kHz audio, resampled client-side (see useModeratorAudio) and
  // sent as a binary WebSocket frame -- forwarded straight into this
  // member's realtime transcription session (see wsHub.ts/
  // realtimeTranscription.ts).
  const sendAudioChunk = useCallback((chunk: Int16Array) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(chunk.buffer as ArrayBuffer);
    }
  }, []);

  // Comfortably above the server's own worst-case drain time (see
  // CLOSE_GRACE_MS in realtimeTranscription.ts, currently 3s) plus margin
  // for the round trip itself. If this were shorter than the server could
  // legitimately still be taking to flush the last utterance, the client
  // would give up and disable the participant BEFORE the server's write
  // lands -- reintroducing exactly the drop-the-last-utterance race this
  // whole request/ack handshake exists to prevent.
  const MIC_STOP_ACK_TIMEOUT_MS = 5_000;

  // Resolves once the server confirms it has finished tearing this member's
  // transcription session down -- including durably persisting whatever
  // last utterance OpenAI was still transcribing. The moderator toggle-off
  // flow awaits this BEFORE calling the disable-participant endpoint (see
  // ModeratorChatPanel's handleToggleClick): deactivating first would let
  // that last utterance's write land under an already-inactive participant
  // and get silently rejected. Falls back to resolving after a timeout so a
  // lost ack (dropped socket, server restart) can never hang the caller
  // forever -- by then the best-effort persistence already happened or
  // didn't, and there's nothing further to wait for.
  const sendMicStop = useCallback((): Promise<void> => {
    micActiveRef.current = false;
    return new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (micStopAckRef.current === done) micStopAckRef.current = null;
        resolve();
      };
      micStopAckRef.current = done;
      setTimeout(done, MIC_STOP_ACK_TIMEOUT_MS);
      socket.send(JSON.stringify({ type: "mic_stop" }));
    });
  }, []);

  // Clears this user's live caption once their real, persisted transcript
  // message shows up in the chat -- otherwise the interim caption bubble
  // can briefly linger under/above the final message until its own TTL
  // expires. Only clears it if it's STILL showing the utterance that just
  // got persisted: finalizing an utterance and storing it are independent,
  // parallel processes (see useModeratorAudio's onFinalize), so by the time
  // this arrives the speaker may already be several words into a new
  // utterance. Deleting unconditionally would wipe out that in-progress
  // caption every time -- a visible stutter/loss right as someone resumes
  // talking -- instead of just tidying up the one that's now redundant.
  const clearLiveCaption = useCallback((userId: number, utteranceId: number) => {
    setLiveCaptions((prev) => {
      const current = prev.get(userId);
      if (!current || current.utteranceId !== utteranceId) return prev;
      const next = new Map(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  return {
    cursors,
    sendCursor,
    status,
    onlineUserIds,
    speakerVolumes,
    sendVolume,
    liveCaptions,
    sendMicStart,
    sendAudioChunk,
    sendMicStop,
    clearLiveCaption,
  };
}
