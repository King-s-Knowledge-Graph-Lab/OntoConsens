// Per-(project, member) speech-to-text, streamed live to OpenAI's Realtime
// API (model: gpt-live-transcribe) instead of relying on the browser's own
// SpeechRecognition -- see task #25. One WebSocket connection to OpenAI is
// opened per active mic (keyed by projectId+userId) the moment that member
// sends "mic_start" over the project socket (see wsHub.ts), and every raw
// PCM16 audio chunk they stream up is forwarded into it via
// input_audio_buffer.append. OpenAI's own server-side VAD (turn_detection)
// decides where one utterance ends and the next begins -- there is no
// custom silence-timer/stuck-recognizer logic here at all, unlike the old
// browser-recognition code, because that complexity was entirely a
// workaround for SpeechRecognition's own quirks.
import WebSocket from "ws";
import { and, eq } from "drizzle-orm";
import { db, ontologyClassesTable, propertiesTable } from "@workspace/db";
import { logger } from "./logger";
import {
  ensureActiveParticipant,
  getProjectOwnerApiKey,
  noteSpeechActivity,
  recordTranscriptChunk,
} from "./moderatorEngine";
import { broadcastToProject } from "./wsHub";

// `intent=transcription` is required on the connection URL itself for a
// transcription-only session -- without it, the socket defaults to a
// conversational session and the later `session.update` (type:
// "transcription", model in `audio.input.transcription.model`) is rejected
// with an `invalid_model` error for every transcription model, closing the
// socket before any audio can be transcribed. Do NOT also add `&model=...`
// here: that query param selects a *conversation* session's model and
// triggers the same invalid_model rejection for a transcription intent --
// the model belongs only in the session.update payload below.
const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const TRANSCRIPTION_MODEL = "gpt-live-transcribe";

// Bounded so the prompt/keywords payload never grows unbounded on a large
// ontology -- OpenAI's own keyword-hint field is meant for a modest
// vocabulary boost, not a full dump of every term in the project.
const MAX_KEYWORDS = 40;
// OpenAI rejects the ENTIRE session.update (not just the offending keyword)
// if any keyword contains '<', '>', or a line break, or is excessively
// long. Class labels and property names are free-form user input with no
// such restriction of their own, so a single ordinary-looking ontology term
// could otherwise silently take down transcription for the whole session --
// this filters those out rather than trusting the source data is already
// safe for this specific downstream API.
const MAX_KEYWORD_LENGTH = 64;
function isValidKeyword(value: string): boolean {
  return value.length > 0 && value.length <= MAX_KEYWORD_LENGTH && !/[<>\r\n]/.test(value);
}

interface Session {
  ws: WebSocket;
  projectId: number;
  userId: number;
  activationId: string;
  // True once closeTranscriptionSession has taken over teardown -- lets the
  // ws "close"/"error" handlers below tell an intentional close apart from
  // an unexpected one (only the latter is worth surfacing to the user).
  expectedClose: boolean;
  // OpenAI's `item_id` identifies one in-progress utterance. Neither of
  // these maps is bounded by more than "however many utterances are
  // mid-flight at once" (in practice 0-1 per session), and both entries are
  // deleted the moment that item's transcription completes.
  itemUtteranceIds: Map<string, number>;
  itemTexts: Map<string, string>;
  nextUtteranceId: number;
  // Every recordTranscriptChunk() call kicked off while tearing a session
  // down is tracked here so closeTranscriptionSession can wait for the very
  // last utterance's write to actually land before resolving -- otherwise a
  // member who turns their mic off could have their last few words dropped
  // by a disable-participant race (recordTranscriptChunk rejects writes
  // once the participant is inactive).
  pendingWrites: Set<Promise<unknown>>;
  // Set only while closeTranscriptionSession is waiting for an in-flight
  // utterance's real `...completed` event to arrive (see there) -- resolved
  // the instant that event lands, so teardown only falls back to the fixed
  // grace-period timer if OpenAI never actually confirms completion (e.g. a
  // dropped connection), instead of that timer being the primary signal.
  onDrain: (() => void) | null;
  // True the moment any audio has been appended since the last commit --
  // covers the case where the mic is stopped after speech started but
  // before OpenAI has emitted even one delta for it (so itemTexts is still
  // empty). Without this, that audio would just sit in OpenAI's buffer and
  // be silently discarded when the socket closes, dropping the very last
  // thing the member said. Cleared once a commit is actually sent.
  hasUncommittedAudio: boolean;
  // gpt-live-transcribe rejects `turn_detection` entirely (confirmed live:
  // "Turn detection is not supported for this transcription model") -- so
  // unlike a conversational Realtime session, OpenAI never decides on its
  // own when one utterance ends and the next begins. This server-side
  // silence timer (see maybeAutoCommit/appendAudioChunk's RMS check) plays
  // that role instead: the last time a chunk looked like actual speech
  // rather than near-silence.
  lastVoiceActivity: number;
  // Polls whether enough silence has passed since lastVoiceActivity to
  // finalize the current utterance with a manual commit. Cleared on
  // teardown (closeTranscriptionSession, or an unexpected ws close) so it
  // never outlives its session.
  silenceInterval: ReturnType<typeof setInterval> | null;
}

const sessions = new Map<string, Session>();

// Audio queued for a member whose mic is already streaming but whose
// OpenAI socket isn't open yet -- covers the whole async setup window
// (participant check, API key lookup, keyword query, then the WebSocket
// handshake itself) plus any brief gap around a language-change replace.
// Without this, the very first words spoken right after enabling the mic --
// exactly the ones most likely to land in that window -- would be silently
// dropped by appendAudioChunk instead of ever reaching OpenAI. Flushed the
// moment the new session's socket opens (see openTranscriptionSession) and
// discarded on an explicit stop (see closeTranscriptionSession) so it never
// gets replayed into an unrelated later session.
const pendingAudio = new Map<string, Buffer[]>();
// ~5s of 24kHz mono PCM16 (48,000 bytes/sec) -- generous headroom for
// realistic setup latency without letting a stuck/slow open buffer audio
// forever.
const MAX_PENDING_AUDIO_BYTES = 240_000;

function sessionKey(projectId: number, userId: number): string {
  return `${projectId}:${userId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long a session must look silent (see rmsOf below) before its current
// utterance is force-finalized with a manual commit. Matches the pause
// length the previous browser-based recognizer used to treat as "sentence
// over" (see the LIVE_CAPTION_TTL_MS comment in useProjectSocket.ts).
const SILENCE_COMMIT_MS = 2_000;
// How often to check whether SILENCE_COMMIT_MS has elapsed since the last
// voice-like chunk. Short enough that a commit fires close to on time,
// long enough not to matter for CPU cost against a handful of concurrent
// mics.
const SILENCE_CHECK_INTERVAL_MS = 250;
// A chunk's RMS (root-mean-square of its Int16 samples) above this is
// treated as speech rather than background noise/silence. Int16 samples
// range +/-32767; this is a conservative floor picked to reject typical
// room-noise floors and mic self-noise without requiring near-total
// silence, not a calibrated voice-activity model.
const VOICE_RMS_THRESHOLD = 400;

function rmsOf(chunk: Buffer): number {
  const sampleCount = chunk.length >> 1;
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = chunk.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

// Sends a manual commit (forcing OpenAI to finalize whatever's currently
// buffered into a completed transcription item) once the session has gone
// quiet for SILENCE_COMMIT_MS. This is the ENTIRE turn-taking mechanism for
// this integration -- gpt-live-transcribe has no VAD/turn_detection of its
// own (see the Session.lastVoiceActivity comment), so without this an
// entire call's audio would only ever finalize once, at mic-off.
function startSilenceWatch(session: Session): void {
  session.silenceInterval = setInterval(() => {
    if (!session.hasUncommittedAudio) return;
    if (session.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - session.lastVoiceActivity < SILENCE_COMMIT_MS) return;
    session.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    session.hasUncommittedAudio = false;
  }, SILENCE_CHECK_INTERVAL_MS);
}

function stopSilenceWatch(session: Session): void {
  if (session.silenceInterval) {
    clearInterval(session.silenceInterval);
    session.silenceInterval = null;
  }
}

// Ontology class labels and property names already in this project, used as
// a vocabulary hint so uncommon domain terms are more likely to be
// recognized correctly -- a value-add straight from a documented model
// field, deliberately without any new settings UI (members already name
// these classes/properties themselves).
async function getKeywordHints(projectId: number): Promise<string[]> {
  const [classes, properties] = await Promise.all([
    db
      .select({ label: ontologyClassesTable.label })
      .from(ontologyClassesTable)
      .where(eq(ontologyClassesTable.projectId, projectId)),
    db
      .select({ name: propertiesTable.name })
      .from(propertiesTable)
      .where(eq(propertiesTable.projectId, projectId)),
  ]);
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const row of [...classes.map((c) => c.label), ...properties.map((p) => p.name)]) {
    const trimmed = row.trim();
    if (!trimmed || seen.has(trimmed) || !isValidKeyword(trimmed)) continue;
    seen.add(trimmed);
    keywords.push(trimmed);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

// Guards against a start/stop race: openTranscriptionSession does several
// awaits (participant check, API key lookup, keyword query) before it ever
// registers a session in `sessions`, so a mic_stop that arrives during that
// window would otherwise find nothing to close (closeTranscriptionSession
// is a no-op when `sessions.get(key)` is empty) and the open would go on to
// register itself anyway once its awaits finish -- an orphaned OpenAI
// session left running after the member has already turned their mic off,
// with no way to ever close it since the client believes it's closed.
// Bumped by both open and close so whichever call is currently in flight
// can tell it's been superseded and bail out instead of finishing its
// setup.
const generations = new Map<string, number>();
function nextGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

function utteranceIdForItem(session: Session, itemId: string): number {
  let id = session.itemUtteranceIds.get(itemId);
  if (id === undefined) {
    id = session.nextUtteranceId++;
    session.itemUtteranceIds.set(itemId, id);
  }
  return id;
}

// Opens (or, if one is already active for this member, replaces) the
// OpenAI Realtime transcription session backing their mic. Fire-and-forget
// from the caller's point of view: audio chunks that arrive before this
// resolves are buffered (see pendingAudio/appendAudioChunk) rather than
// dropped.
export async function openTranscriptionSession(projectId: number, userId: number): Promise<void> {
  const key = sessionKey(projectId, userId);
  const existing = sessions.get(key);
  if (existing) await closeTranscriptionSession(projectId, userId);
  // Stamped now, after the possible close above (which bumps the
  // generation itself) -- everything below checks this before taking any
  // action visible outside this function, so a mic_stop that lands while
  // this is still awaiting always wins.
  const myGeneration = nextGeneration(key);

  const active = await ensureActiveParticipant(projectId, userId);
  if (!active) return; // Not an opted-in participant -- nothing to do.
  if (generations.get(key) !== myGeneration) return; // Superseded while awaiting.

  const apiKey = await getProjectOwnerApiKey(projectId);
  if (!apiKey) {
    broadcastToProject(projectId, {
      type: "moderator_error",
      message: "The project creator hasn't saved an OpenAI API key yet.",
    });
    return;
  }
  if (generations.get(key) !== myGeneration) return;

  const keywords = await getKeywordHints(projectId);
  if (generations.get(key) !== myGeneration) return;

  const ws = new WebSocket(REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (generations.get(key) !== myGeneration) {
    // Superseded in the instant between the check above and creating the
    // socket -- there is no session object yet for a stop to have found,
    // so this is the only place left that can close it.
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    return;
  }

  const session: Session = {
    ws,
    projectId,
    userId,
    activationId: active.activationId,
    expectedClose: false,
    itemUtteranceIds: new Map(),
    itemTexts: new Map(),
    nextUtteranceId: 1,
    pendingWrites: new Set(),
    onDrain: null,
    hasUncommittedAudio: false,
    lastVoiceActivity: Date.now(),
    silenceInterval: null,
  };
  sessions.set(key, session);

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: TRANSCRIPTION_MODEL,
                // No `languages` hint -- gpt-live-transcribe adapts to
                // whatever language is actually spoken on its own, so
                // there's nothing for a per-member picker to configure.
                ...(keywords.length ? { keywords } : {}),
              },
              // gpt-live-transcribe rejects any non-null turn_detection
              // outright ("Turn detection is not supported for this
              // transcription model") -- confirmed live, not just inferred
              // from docs. Turn-taking is handled entirely server-side
              // instead, via startSilenceWatch below.
              turn_detection: null,
            },
          },
        },
      }),
    );
    // Flush whatever audio queued up while this session was still being
    // set up (see pendingAudio) -- sent right after session.update, the
    // same ordering the documented quickstart flow uses for audio sent
    // immediately upon connecting.
    const buffered = pendingAudio.get(key);
    if (buffered && buffered.length) {
      pendingAudio.delete(key);
      for (const chunk of buffered) {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
      }
      session.hasUncommittedAudio = true;
    }
    // Treat connection setup itself as "recent activity" so the silence
    // watch doesn't fire on its very first tick before any real audio (or
    // silence) has had a chance to be observed post-connect.
    session.lastVoiceActivity = Date.now();
    startSilenceWatch(session);
  });

  ws.on("message", (raw) => {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const type = event?.type as string | undefined;
    const itemId = event?.item_id as string | undefined;

    if (type === "conversation.item.input_audio_transcription.delta" && itemId) {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const accumulated = (session.itemTexts.get(itemId) ?? "") + delta;
      session.itemTexts.set(itemId, accumulated);
      const utteranceId = utteranceIdForItem(session, itemId);
      broadcastToProject(projectId, {
        type: "live_caption",
        userId,
        text: accumulated,
        utteranceId,
      });
      if (accumulated.trim()) noteSpeechActivity(projectId);
    } else if (type === "conversation.item.input_audio_transcription.completed" && itemId) {
      const text = (typeof event.transcript === "string" ? event.transcript : "").trim();
      const utteranceId = utteranceIdForItem(session, itemId);
      session.itemTexts.delete(itemId);
      session.itemUtteranceIds.delete(itemId);
      if (text) {
        const write = recordTranscriptChunk(projectId, userId, text, session.activationId, utteranceId).catch(
          (err) => {
            logger.error({ err, projectId, userId }, "Failed to record realtime transcript chunk");
          },
        );
        session.pendingWrites.add(write);
        // Once settled, a write's promise has nothing left for anyone to
        // await -- drop it so a long-running mic (many utterances over a
        // long session) doesn't accumulate one retained promise per
        // utterance for as long as the session stays open.
        write.finally(() => session.pendingWrites.delete(write));
        noteSpeechActivity(projectId);
      }
      // No utterance left in flight -- if closeTranscriptionSession is
      // waiting on this (see there), let it proceed immediately instead of
      // riding out the fallback grace-period timer.
      if (session.itemTexts.size === 0 && session.onDrain) {
        const drain = session.onDrain;
        session.onDrain = null;
        drain();
      }
    } else if (type === "error") {
      // Benign: a manual commit (see commitPendingAudio / closeTranscriptionSession)
      // can land on a buffer that's technically non-empty but still under
      // OpenAI's 100ms minimum -- e.g. a trailing sliver of audio right
      // before finalize/close. This is an expected race, not a real
      // failure, so it must not be logged as an error or surfaced to the
      // client as one.
      const isBufferTooSmall = event.error?.code === "input_audio_buffer_commit_empty"
        || /buffer too small/i.test(event.error?.message ?? "");
      if (!isBufferTooSmall) {
        logger.error({ projectId, userId, error: event.error }, "OpenAI realtime transcription error");
        broadcastToProject(projectId, {
          type: "moderator_error",
          message: event.error?.message || "Live transcription hit an error.",
        });
      }
      // An error while closing (e.g. the manual commit below was rejected
      // because there was nothing buffered) must not hang teardown until
      // the fallback timer -- there is nothing further to drain for.
      if (session.onDrain) {
        const drain = session.onDrain;
        session.onDrain = null;
        drain();
      }
    }
  });

  ws.on("close", () => {
    stopSilenceWatch(session);
    if (sessions.get(key) === session) sessions.delete(key);
    if (!session.expectedClose) {
      logger.warn({ projectId, userId }, "OpenAI realtime transcription session closed unexpectedly");
    }
  });
  ws.on("error", (err) => {
    logger.error({ err, projectId, userId }, "OpenAI realtime transcription socket error");
    if (!session.expectedClose) {
      broadcastToProject(projectId, {
        type: "moderator_error",
        message: "Lost connection to live transcription.",
      });
    }
  });
}

// Appends one raw PCM16/24kHz audio chunk (already resampled client-side)
// to whichever session is currently active for this member. Silently drops
// the chunk if no session exists yet/anymore (mic just started, or the
// session already errored out) -- there is nothing useful to do with audio
// that has nowhere to go.
export function appendAudioChunk(projectId: number, userId: number, chunk: Buffer): void {
  const key = sessionKey(projectId, userId);
  const session = sessions.get(key);
  if (session && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
    session.hasUncommittedAudio = true;
    if (rmsOf(chunk) > VOICE_RMS_THRESHOLD) {
      session.lastVoiceActivity = Date.now();
    }
    return;
  }
  // No open session for this member yet -- queue it (see pendingAudio)
  // instead of dropping it outright.
  let buffered = pendingAudio.get(key);
  if (!buffered) {
    buffered = [];
    pendingAudio.set(key, buffered);
  }
  const queuedBytes = buffered.reduce((sum, b) => sum + b.length, 0);
  if (queuedBytes + chunk.length > MAX_PENDING_AUDIO_BYTES) {
    // Setup is taking unusually long (or has stalled) -- stop growing the
    // queue rather than buffering indefinitely. The bulk of a normal
    // setup's audio is already safely queued by this point.
    return;
  }
  buffered.push(chunk);
}

// Fallback ceiling on how long to wait for OpenAI's real completion event
// after a manual commit, in case it never arrives (dropped connection,
// OpenAI-side hang). The normal path resolves via onDrain the instant the
// actual `...completed` event lands, almost always well under this.
const CLOSE_GRACE_MS = 3_000;

// Commits whatever's left in the input buffer -- even with server VAD
// enabled, a manual commit is the documented way to force-finalize
// whatever's currently buffered rather than waiting for OpenAI to detect
// silence on its own, which would never happen here since no more audio is
// sent once the mic is off -- then waits for OpenAI's real
// `conversation.item.input_audio_transcription.completed` event for that
// utterance (not a blind timer) before tearing the socket down. Resolves
// only once every recordTranscriptChunk() write kicked off during that
// window has settled -- callers that need "the last few words are durably
// persisted before doing anything else" (see wsHub's mic_stop handling) can
// safely await this. A no-op if no session is currently open for this
// member.
export async function closeTranscriptionSession(projectId: number, userId: number): Promise<void> {
  const key = sessionKey(projectId, userId);
  // Bumped unconditionally, even if no session is registered yet -- this is
  // what cancels an openTranscriptionSession call that's still in its
  // pre-registration awaits (see the generation checks there) when mic_stop
  // arrives before mic_start has finished setting up.
  nextGeneration(key);
  // Anything still queued for a not-yet-open (or now-superseded) session
  // belongs only to this stopped mic, not whatever opens next for this
  // member -- discard rather than let it replay into an unrelated session.
  pendingAudio.delete(key);
  const session = sessions.get(key);
  if (!session) return;
  session.expectedClose = true;
  sessions.delete(key);
  stopSilenceWatch(session);

  // Anything appended since the last commit -- whether or not OpenAI has
  // emitted a single delta for it yet -- must be committed and drained, or
  // it's silently discarded the instant the socket closes below.
  if (session.ws.readyState === WebSocket.OPEN && (session.hasUncommittedAudio || session.itemTexts.size > 0)) {
    try {
      session.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      session.hasUncommittedAudio = false;
      await Promise.race([
        new Promise<void>((resolve) => {
          session.onDrain = resolve;
        }),
        sleep(CLOSE_GRACE_MS),
      ]);
    } catch {
      // Nothing to flush (e.g. buffer was already empty) -- fall through
      // to closing immediately.
    } finally {
      session.onDrain = null;
    }
  }
  try {
    session.ws.close();
  } catch {
    // Already closed/closing.
  }
  await Promise.allSettled(session.pendingWrites);
}
