import crypto from "node:crypto";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  db,
  moderatorChatMessagesTable,
  moderatorTranscriptChunksTable,
  moderatorParticipantsTable,
  ontologyClassesTable,
  projectMembersTable,
  projectModeratorTable,
  projectsTable,
  propertiesTable,
  usersTable,
  type ModeratorChatMessage,
  type ModeratorChatMessageType,
  type ModeratorInterventionEntry,
} from "@workspace/db";
import { decryptApiKey } from "./moderatorCrypto";
import { broadcastToProject } from "./wsHub";
import { logger } from "./logger";

// Condition 1 of the intervention trigger: "silence" means no one currently
// has new TEXT TRANSCRIPTION filling into their live caption box -- not
// "no finalized message yet" (see noteSpeechActivity below, which fires on
// every non-empty live caption update, i.e. raw/partial recognized speech
// as it streams in, not only on a finalized transcript POST). 2 continuous
// seconds of that is condition 1. This is deliberately distinct from
// condition 2 (a NEW, finalized message) below -- see generateIntervention.
const SILENCE_TIMEOUT_MS = 2_000;

// How long the "AI moderator is typing" indicator shows before the actual
// intervention message appears, once conditions 1-3 have all already been
// confirmed true (see generateIntervention) -- purely a display delay, the
// message itself is already generated and durably committed by this point.
// Set to 0: minimizing time-to-appear is the priority, not a naturalistic
// typing simulation, and the typing indicator still gets its own visible
// frame for free from the unavoidable gap before it (serializeChatMessage
// below does its own DB round trip), so no artificial hold is needed on
// top of that.
const INTERVENTION_TYPING_DELAY_MS = 0;

// A fresh, unguessable id minted every time a member turns their OWN
// participation on. This -- not any in-memory object identity, and not a
// timestamp -- is the durable source of truth for "which of this member's
// on-periods does this transcript chunk belong to". It's written to
// moderator_participants.activation_id and stamped onto every transcript
// chunk, so it survives a server restart and lets writes be made
// conditional on it directly in the database (see recordTranscriptChunk
// below), closing the check-then-act race a purely in-memory or pre-await
// check can't close.
export function generateActivationId(): string {
  return crypto.randomUUID();
}

// Fixed per-slot color names, in the same order as the --member-N hues
// defined in artifacts/onto-consensus/src/index.css (0 = Blue, 1 = Purple,
// 2 = Yellow) -- keep these two lists in sync if a color slot's hue ever
// changes, since members refer to each other by these color names in chat
// (see generateIntervention's color-legend usage below).
const COLOR_SLOT_NAMES = ["Blue", "Purple", "Yellow"];
function colorNameForSlot(slot: number): string {
  return COLOR_SLOT_NAMES[slot % COLOR_SLOT_NAMES.length] ?? COLOR_SLOT_NAMES[0]!;
}

// One silence timer per project, shared across every active participant --
// the AI moderator produces one running discussion per project (not one per
// person), so "60 seconds since the last chunk from ANYONE currently on" is
// what triggers the next intervention attempt.
const silenceTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function clearModeratorSilenceTimer(projectId: number) {
  const timer = silenceTimers.get(projectId);
  if (timer) clearTimeout(timer);
  silenceTimers.delete(projectId);
}

export async function getParticipant(projectId: number, userId: number) {
  return db.query.moderatorParticipantsTable.findFirst({
    where: and(
      eq(moderatorParticipantsTable.projectId, projectId),
      eq(moderatorParticipantsTable.userId, userId),
    ),
  });
}

// Turns the AI moderator on for exactly this member -- never touches any
// other member's row. Upserts since the very first activation for a given
// (project, user) pair has no existing row yet.
export async function activateParticipant(projectId: number, userId: number, activationId: string): Promise<void> {
  const existing = await getParticipant(projectId, userId);
  if (existing) {
    await db
      .update(moderatorParticipantsTable)
      .set({ active: true, activationId, updatedAt: new Date() })
      .where(eq(moderatorParticipantsTable.id, existing.id));
  } else {
    await db.insert(moderatorParticipantsTable).values({ projectId, userId, active: true, activationId });
  }
}

export async function deactivateParticipant(projectId: number, userId: number): Promise<void> {
  await db
    .update(moderatorParticipantsTable)
    .set({ active: false, activationId: null, updatedAt: new Date() })
    .where(
      and(
        eq(moderatorParticipantsTable.projectId, projectId),
        eq(moderatorParticipantsTable.userId, userId),
      ),
    );
}

// Every audio upload re-validates against this member's own DB row as
// ground truth (never a cached in-memory flag) -- so a disable that
// happened moments ago, or a server restart, is always caught.
export async function ensureActiveParticipant(
  projectId: number,
  userId: number,
): Promise<{ activationId: string } | null> {
  const participant = await getParticipant(projectId, userId);
  if (!participant?.active || !participant.activationId) return null;
  return { activationId: participant.activationId };
}

// The moderator always runs on the project CREATOR's saved API key, not
// anything stored on the project itself -- looked up fresh every time
// (transcription, summary generation) rather than cached, so a key update
// from the creator's account takes effect on the very next request.
//
// Projects created before API keys moved to the account level may still
// have a key on their own `project_moderator` row (now deprecated). Rather
// than a schema push silently dropping that data, we lazily migrate it the
// first time it's needed: if the owner has no account key yet but their
// project still has a legacy key, adopt it onto the owner's account (the
// ciphertext is portable as-is -- same AES-256-GCM scheme, same
// SESSION_SECRET-derived key, just relocated to a different row) and clear
// the legacy columns so this only ever runs once per project. If the owner
// already has an account key, or has already adopted a different project's
// legacy key, that key wins and the newer legacy key is left untouched --
// first-migrated-wins, since there is no way to know which of an owner's
// several old per-project keys should take priority.
async function migrateLegacyProjectKeyToOwner(projectId: number, ownerId: number): Promise<void> {
  const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, ownerId) });
  if (owner?.openaiApiKeyEncrypted) return; // Owner already has an account key -- nothing to migrate.

  const legacy = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!legacy?.encryptedApiKey || !legacy.apiKeyIv || !legacy.apiKeyAuthTag) return;

  await db
    .update(usersTable)
    .set({
      openaiApiKeyEncrypted: legacy.encryptedApiKey,
      openaiApiKeyIv: legacy.apiKeyIv,
      openaiApiKeyAuthTag: legacy.apiKeyAuthTag,
    })
    .where(eq(usersTable.id, ownerId));
  await db
    .update(projectModeratorTable)
    .set({ encryptedApiKey: null, apiKeyIv: null, apiKeyAuthTag: null })
    .where(eq(projectModeratorTable.projectId, projectId));
  logger.info({ projectId, ownerId }, "Migrated legacy project-level API key onto owner's account");
}

// Used by the moderator status/enable checks. Takes projectId (not just
// ownerId) so it can also trigger the legacy-key migration above -- a
// project whose creator never visited the new account-key field, but whose
// project still has a legacy migrated key, is treated as configured.
export async function projectOwnerHasApiKey(projectId: number, ownerId: number): Promise<boolean> {
  await migrateLegacyProjectKeyToOwner(projectId, ownerId);
  const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, ownerId) });
  return Boolean(owner?.openaiApiKeyEncrypted);
}

export async function getProjectOwnerApiKey(projectId: number): Promise<string | null> {
  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  if (!project) return null;

  await migrateLegacyProjectKeyToOwner(projectId, project.ownerId);

  const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, project.ownerId) });
  if (!owner?.openaiApiKeyEncrypted || !owner.openaiApiKeyIv || !owner.openaiApiKeyAuthTag) return null;
  try {
    return decryptApiKey({
      encryptedApiKey: owner.openaiApiKeyEncrypted,
      apiKeyIv: owner.openaiApiKeyIv,
      apiKeyAuthTag: owner.openaiApiKeyAuthTag,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Chat message log: the moderator's entire visible presence is this one
// persisted, ordered log per project (see moderator.ts schema doc for the
// meaning of each type). Every place a message is created also broadcasts
// it live, and serializes it the same way the fetch-all-history endpoint
// does, so a freshly-posted message and a rejoin/reload always render
// identically.
// ---------------------------------------------------------------------

export interface SerializedChatMessage {
  id: number;
  type: ModeratorChatMessageType;
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
}

async function serializeChatMessage(row: ModeratorChatMessage): Promise<SerializedChatMessage> {
  let username: string | null = null;
  let colorSlot: number | null = null;
  if (row.userId !== null) {
    const [user, membership] = await Promise.all([
      db.query.usersTable.findFirst({ where: eq(usersTable.id, row.userId) }),
      db.query.projectMembersTable.findFirst({
        where: and(
          eq(projectMembersTable.projectId, row.projectId),
          eq(projectMembersTable.userId, row.userId),
        ),
      }),
    ]);
    username = user?.username ?? "unknown";
    colorSlot = membership?.colorSlot ?? 0;
  }
  return {
    id: row.id,
    type: row.type,
    userId: row.userId,
    username,
    colorSlot,
    content: row.content,
    matched: row.matched,
    className: row.className,
    propertyName: row.propertyName,
    classId: row.classId,
    propertyId: row.propertyId,
    examples: row.examples ?? null,
    counterexamples: row.counterexamples ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listChatMessages(projectId: number): Promise<SerializedChatMessage[]> {
  const rows = await db.query.moderatorChatMessagesTable.findMany({
    where: eq(moderatorChatMessagesTable.projectId, projectId),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  });
  return Promise.all(rows.map(serializeChatMessage));
}

async function postChatMessage(
  projectId: number,
  fields: {
    type: ModeratorChatMessageType;
    userId?: number | null;
    content: string;
    matched?: boolean | null;
    className?: string | null;
    propertyName?: string | null;
    classId?: number | null;
    propertyId?: number | null;
    examples?: ModeratorInterventionEntry[] | null;
    counterexamples?: ModeratorInterventionEntry[] | null;
  },
  // Broadcast-only, never persisted -- see recordTranscriptChunk's own
  // utteranceId parameter for why this exists.
  broadcastUtteranceId?: number,
): Promise<void> {
  const [row] = await db
    .insert(moderatorChatMessagesTable)
    .values({ projectId, userId: fields.userId ?? null, ...fields })
    .returning();
  if (!row) return;
  const message = await serializeChatMessage(row);
  broadcastToProject(projectId, {
    type: "moderator_chat_message",
    message: broadcastUtteranceId === undefined ? message : { ...message, utteranceId: broadcastUtteranceId },
  });
}

// Posted exactly once per project, the moment the shared space opens (every
// expected member has marked ready) -- called from the ready route. A
// no-op on every subsequent call for the same project.
export async function ensureModeratorIntroMessage(projectId: number): Promise<void> {
  const existing = await db.query.moderatorChatMessagesTable.findFirst({
    where: and(
      eq(moderatorChatMessagesTable.projectId, projectId),
      eq(moderatorChatMessagesTable.type, "intro"),
    ),
  });
  if (existing) return;

  const introMessages = [
    "Hi, I'm the AI moderator for this discussion session. Feel free to talk with your peers about any properties you haven't yet agreed to keep or remove.",
    "I'll keep track of your discussion and step in to help whenever things stall.",
    "In order for me to do that, please turn on the microphone below.",
  ];
  for (const content of introMessages) {
    await postChatMessage(projectId, { type: "intro", userId: null, content });
  }
}

// Posted right after a member successfully turns their own mic on -- see
// the PUT /projects/:id/moderator route.
export async function postRecordingStartedMessage(projectId: number, userId: number, username: string): Promise<void> {
  await postChatMessage(projectId, {
    type: "system",
    userId,
    content: `${username} turned on their microphone.`,
  });
}

// Posted right after a member turns their own mic off -- see the
// POST /projects/:id/moderator/disable route. Every member should see when
// someone stops being heard by the moderator, not just when they start.
export async function postRecordingStoppedMessage(projectId: number, userId: number, username: string): Promise<void> {
  await postChatMessage(projectId, {
    type: "system",
    userId,
    content: `${username} turned off their microphone.`,
  });
}

// Posted exactly once, the first time a project is exported (see the
// GET /projects/:id/export route) -- always recorded regardless of whether
// this project has the AI moderator enabled, so it shows up in the
// conversation-export file either way. ModeratorChatPanel's own history
// filter is what keeps it out of the live chat UI for AI-disabled
// projects -- it is never filtered out here.
export async function postConsensusReachedMessage(projectId: number): Promise<void> {
  await postChatMessage(projectId, {
    type: "export_notice",
    userId: null,
    content: "Consensus has been reached. The AI moderator has been turned off and will not be restarted.",
  });
}

// Mirrors a transcribed chunk into the shared chat log the moment it's
// recorded, so every member sees it live regardless of their own mic state.
async function postTranscriptMessage(
  projectId: number,
  userId: number,
  text: string,
  utteranceId?: number,
): Promise<void> {
  await postChatMessage(projectId, { type: "transcript", userId, content: text }, utteranceId);
}

// Persists a transcribed chunk IFF this member is still an active
// participant under the same activationId the caller captured before
// starting the (slow) transcription request. Runs as a single transaction
// with a row lock on this member's participant row, so a concurrent
// disable/re-enable either fully commits before this check (and we
// correctly see the new activationId and reject) or fully commits after
// (and blocks on the lock until we're done) -- there is no interleaving
// where a write can land under a stale activationId. Returns true only if
// the chunk was actually committed. Chunks from members who never turned
// their own participation on are never recorded in the first place (the
// route rejects those uploads before this is ever called), so the
// moderator naturally only ever draws on speech from opted-in members.
export async function recordTranscriptChunk(
  projectId: number,
  userId: number,
  text: string,
  activationId: string,
  // Client-generated, per-browser-session utterance counter (see
  // useModeratorAudio's onFinalize) -- purely echoed back on the live
  // broadcast below, never persisted, so every viewer can tell whether the
  // speaker's live caption still belongs to THIS utterance or has already
  // moved on to a new one by the time this request's storage completes.
  utteranceId?: number,
): Promise<boolean> {
  const committed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(moderatorParticipantsTable)
      .where(
        and(
          eq(moderatorParticipantsTable.projectId, projectId),
          eq(moderatorParticipantsTable.userId, userId),
        ),
      )
      .for("update");
    if (!current || !current.active || current.activationId !== activationId) {
      return false;
    }
    await tx.insert(moderatorTranscriptChunksTable).values({ projectId, userId, text, activationId });
    return true;
  });
  if (committed) {
    // Broadcasting the chat message is independent of the transcript-chunk
    // transaction above (it doesn't need to be atomic with it -- worst case
    // a chat message shows up a moment after the row that backs it).
    await postTranscriptMessage(projectId, userId, text, utteranceId);
  }
  return committed;
}

// Called both after recordTranscriptChunk confirms a durable write for a
// finalized utterance, AND on every non-empty live caption update (see
// wsHub's "caption" message handling) -- the latter is what makes "silence"
// (condition 1) mean "no one has new TEXT TRANSCRIPTION filling into their
// live box right now" rather than "no one has finished a whole utterance
// yet". A member who's mid-sentence, still being recognized, must keep
// resetting this clock even though nothing has been persisted as a real
// message yet. Once condition 1's timer fires, it hands off straight to
// generateIntervention (via enqueueIntervention), which itself checks
// condition 2 (a new finalized message since the last checkpoint) before
// doing anything else -- there is no separate cooldown or other gate here.
export function noteSpeechActivity(projectId: number): void {
  clearModeratorSilenceTimer(projectId);
  const timer = setTimeout(() => {
    silenceTimers.delete(projectId);
    enqueueIntervention(projectId);
  }, SILENCE_TIMEOUT_MS);
  silenceTimers.set(projectId, timer);
}

// The definitive "has this project's conversation been frozen" check --
// every entry point that could otherwise let the AI moderator run again
// after export (mic enable, transcript persistence, intervention
// generation) reads this same column rather than each re-deriving it.
export async function isProjectExported(projectId: number): Promise<boolean> {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
    columns: { exportedAt: true },
  });
  return Boolean(project?.exportedAt);
}

// Two silence periods can legitimately occur close together -- someone
// speaks again just as an intervention request is still in flight, then
// goes quiet again before the first one finishes. Without serialization,
// both invocations would read the same `lastSummarizedAt` checkpoint,
// generate overlapping interventions, and race to advance it -- whichever
// commits last can even move it backwards, causing duplicated or dropped
// content. Chaining every attempt for a project onto a single promise tail
// guarantees they run one at a time, in order, so each one always reads the
// checkpoint left by the one before it.
const interventionQueues = new Map<number, Promise<void>>();

function enqueueIntervention(projectId: number): void {
  const previous = interventionQueues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateIntervention(projectId));
  interventionQueues.set(projectId, next);
  next
    .catch((err) => {
      logger.error({ err, projectId }, "Moderator intervention generation failed unexpectedly");
    })
    .finally(() => {
      // Avoid leaking a growing map entry once nothing else is queued behind us.
      if (interventionQueues.get(projectId) === next) interventionQueues.delete(projectId);
    });
}

interface CatalogEntry {
  classId: number;
  propertyId: number;
  className: string;
  propertyName: string;
}

async function callOpenAiJson(apiKey: string, model: string, systemPrompt: string, userContent: string): Promise<any | null> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Not passing "temperature" here on purpose -- some models (e.g.
      // reasoning models like o1/gpt-5) reject any non-default value
      // outright, and since `model` is user-configurable per project, a
      // hardcoded override isn't safe across all of them. Stability of
      // wording/attribution across rounds is instead enforced by the
      // prompt itself (see the extraction prompt's "MAXIMUM STABILITY"
      // instructions below) and the canonical-signature dedup in
      // generateIntervention's commit transaction, not by sampling
      // settings.
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body && typeof body === "object" && "error" in body && (body as any).error?.message) ||
      `OpenAI request failed with status ${response.status}`;
    throw new Error(message);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const rawContent = data.choices?.[0]?.message?.content?.trim();
  if (!rawContent) throw new Error("OpenAI returned an empty response.");

  try {
    const cleaned = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Could not understand the AI moderator's analysis of the discussion.");
  }
}

function formatChunksAsTranscript(
  chunks: { userId: number; text: string; createdAt: Date }[],
  usernameById: Map<number, string>,
): string {
  return chunks
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((chunk) => `${usernameById.get(chunk.userId) ?? `User ${chunk.userId}`}: ${chunk.text}`)
    .join("\n");
}

// Two-pass design, run every time the group has gone quiet:
//   Pass 1 (topic detection) looks ONLY at what's new since the last
//   checkpoint -- "what are they discussing right now" is inherently a
//   question about the most recent stretch of conversation.
//   Pass 2 (full-history extraction) runs ONLY once pass 1 resolves to a
//   real class+property in the workspace, and re-reads EVERY transcript
//   chunk ever tied to that same class+property (chunks are retroactively
//   tagged the first time they're attributed to a property, and that tag
//   is never overwritten) -- not just what's new -- so an example given
//   several rounds ago and never repeated since is never silently dropped,
//   and the summary always reflects the complete, current state of the
//   discussion rather than an incremental delta.
async function generateIntervention(projectId: number): Promise<void> {
  // Config and the owner's API key are independent lookups -- run them
  // together instead of one after another to shave a DB round trip off
  // the latency between "silence threshold met" and the intervention
  // actually being generated.
  const [project, config, apiKey] = await Promise.all([
    db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) }),
    db.query.projectModeratorTable.findFirst({
      where: eq(projectModeratorTable.projectId, projectId),
    }),
    getProjectOwnerApiKey(projectId),
  ]);
  // Consensus already reached and exported -- the conversation is frozen,
  // so no new intervention should ever be generated, even if this call was
  // already queued (see enqueueIntervention) before the export landed.
  if (project?.exportedAt) return;
  if (!config) return;
  if (!apiKey) return;

  // lastSummarizedAt is a DB column (not in-memory), so this checkpoint
  // survives a restart -- chunks already folded into an earlier
  // intervention are never re-sent as "new". It's shared across every
  // participant's chunks: one running discussion per project, not per
  // person.
  const sinceClause = config.lastSummarizedAt
    ? gt(moderatorTranscriptChunksTable.createdAt, config.lastSummarizedAt)
    : undefined;

  // None of these five reads depend on each other -- they only need
  // `config` (for the checkpoint clause) and `projectId`. Firing them
  // together instead of sequentially is a straightforward latency win on
  // every single intervention attempt.
  const lastPostedInterventionPromise = db
    .select({
      content: moderatorChatMessagesTable.content,
      classId: moderatorChatMessagesTable.classId,
      propertyId: moderatorChatMessagesTable.propertyId,
      createdAt: moderatorChatMessagesTable.createdAt,
      // Pulled along with the rest of this row (not just content/ids) so
      // the combined topic+extraction call below can reuse it directly as
      // "the existing points" when the round turns out to be a plain
      // continuation -- see isContinuation below -- without a second
      // round trip to re-fetch the exact same row by classId/propertyId.
      examples: moderatorChatMessagesTable.examples,
      counterexamples: moderatorChatMessagesTable.counterexamples,
    })
    .from(moderatorChatMessagesTable)
    .where(
      and(
        eq(moderatorChatMessagesTable.projectId, projectId),
        eq(moderatorChatMessagesTable.type, "intervention"),
        eq(moderatorChatMessagesTable.matched, true),
      ),
    )
    .orderBy(desc(moderatorChatMessagesTable.createdAt), desc(moderatorChatMessagesTable.id))
    .limit(1)
    .then((rows) => rows[0]);

  // "Every user message exchanged since" the last posted intervention (see
  // previousInterventionTopic's doc comment further down) -- chained
  // directly off lastPostedInterventionPromise, rather than awaited
  // separately afterwards, so its own DB round trip overlaps with
  // newChunks/users/projectMembers/classes/properties below instead of
  // only starting once every one of those has already finished. A `null`
  // lastPostedIntervention resolves this to `null` immediately (no query),
  // which the code below falls back to `newChunks` for.
  const sinceLastInterventionChunksPromise = lastPostedInterventionPromise.then((row) =>
    row
      ? db.query.moderatorTranscriptChunksTable.findMany({
          where: and(
            eq(moderatorTranscriptChunksTable.projectId, projectId),
            gt(moderatorTranscriptChunksTable.createdAt, row.createdAt),
          ),
        })
      : null,
  );

  // Latest matched intervention message for EVERY catalog property (not
  // just the one project-wide last posted) -- needed so the single combined
  // call below can perform extraction for WHICHEVER property it identifies
  // the topic to be, without a second round trip to fetch that specific
  // property's existing points only after the fact.
  const priorInterventionsByPropertyPromise = db
    .select({
      classId: moderatorChatMessagesTable.classId,
      propertyId: moderatorChatMessagesTable.propertyId,
      examples: moderatorChatMessagesTable.examples,
      counterexamples: moderatorChatMessagesTable.counterexamples,
      createdAt: moderatorChatMessagesTable.createdAt,
    })
    .from(moderatorChatMessagesTable)
    .where(
      and(
        eq(moderatorChatMessagesTable.projectId, projectId),
        eq(moderatorChatMessagesTable.type, "intervention"),
        eq(moderatorChatMessagesTable.matched, true),
      ),
    )
    .orderBy(desc(moderatorChatMessagesTable.createdAt), desc(moderatorChatMessagesTable.id));

  const [
    newChunks,
    users,
    projectMembers,
    [classes, properties],
    lastPostedIntervention,
    sinceLastInterventionChunksRaw,
    priorInterventionRows,
  ] = await Promise.all([
      db.query.moderatorTranscriptChunksTable.findMany({
        where: and(eq(moderatorTranscriptChunksTable.projectId, projectId), sinceClause),
      }),
      db.query.usersTable.findMany(),
      db.query.projectMembersTable.findMany({
        where: eq(projectMembersTable.projectId, projectId),
      }),
      Promise.all([
        db.query.ontologyClassesTable.findMany({ where: eq(ontologyClassesTable.projectId, projectId) }),
        db.query.propertiesTable.findMany({ where: eq(propertiesTable.projectId, projectId) }),
      ]),
      lastPostedInterventionPromise,
      sinceLastInterventionChunksPromise,
      priorInterventionsByPropertyPromise,
    ]);
  if (newChunks.length === 0) return; // Silence with nothing new to say — nothing to summarize.

  const usernameById = new Map(users.map((u) => [u.id, u.username]));

  // Members commonly refer to each other by their assigned color instead of
  // by name or by restating an opinion (e.g. "I agree with Blue") -- see
  // the color-legend usage in the Pass 2 extraction prompt below. Build the
  // username -> color-name mapping for THIS project specifically, since
  // colorSlot is per-membership, not global.
  const colorNameByUsername = new Map<string, string>();
  for (const m of projectMembers) {
    const uname = usernameById.get(m.userId);
    if (uname) colorNameByUsername.set(uname, colorNameForSlot(m.colorSlot));
  }
  const colorLegendText =
    colorNameByUsername.size > 0
      ? Array.from(colorNameByUsername.entries()).map(([name, color]) => `${name} (${color})`).join(", ")
      : "(no members yet)";

  // The model must only ever report a class/property that genuinely exists
  // in THIS project's shared workspace right now, using the exact same
  // spelling shown here -- never invent or paraphrase a name. This catalog
  // is also used below to verify/resolve the model's answer against real
  // rows (classId/propertyId), rather than trusting its free-form text.
  //
  // Every property in the workspace is eligible here, INCLUDING ones that
  // already reached full agreement -- a group can reopen discussion on a
  // settled property at any point (e.g. reconsidering it later), and when
  // they do, the moderator must recognize that and pick back up from
  // wherever its own last intervention message left off (see Pass 2 below)
  // rather than silently ignoring the conversation. This is safe from
  // "re-litigating" an untouched property on a passing mention alone: an
  // intervention only ever fires after real accumulated speech followed by
  // silence (see noteSpeechActivity above), never from topic-detection
  // matching by itself.
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const classLabelById = new Map(classes.map((c) => [c.id, c.label]));
  const catalog: CatalogEntry[] = properties
    .map((p) => ({
      classId: p.classId,
      propertyId: p.id,
      className: classLabelById.get(p.classId) ?? null,
      propertyName: p.name,
    }))
    .filter((entry): entry is CatalogEntry => entry.className !== null);

  const newChunksTranscript = formatChunksAsTranscript(newChunks, usernameById);
  const maxCreatedAt = newChunks.reduce(
    (max, c) => (c.createdAt > max ? c.createdAt : max),
    config.lastSummarizedAt ?? new Date(0),
  );

  const catalogText =
    catalog.length > 0
      ? catalog.map((entry) => `- ${entry.className}.${entry.propertyName}`).join("\n")
      : "(the workspace has no classes/properties yet)";

  // Most recent matched intervention row per property, keyed by
  // "classId:propertyId" -- priorInterventionRows is ordered newest-first,
  // so the first row seen for a given key IS that property's latest one.
  const priorInterventionByProperty = new Map<string, (typeof priorInterventionRows)[number]>();
  for (const row of priorInterventionRows) {
    if (row.classId === null || row.propertyId === null) continue;
    const key = `${row.classId}:${row.propertyId}`;
    if (!priorInterventionByProperty.has(key)) priorInterventionByProperty.set(key, row);
  }

  let matchedEntry: CatalogEntry | undefined;
  let interventionContent: string;
  let matched: boolean;
  let interventionExamples: ModeratorInterventionEntry[] | null = null;
  let interventionCounterexamples: ModeratorInterventionEntry[] | null = null;
  // True only for a matched property whose examples AND counterexamples
  // both came back completely empty -- i.e. the extraction pass has
  // nothing at all to show the group (this can happen when a supporter's
  // stance is misread as a full retraction on an ambiguous remark). An
  // interruption with nothing to say is worse than no interruption, so
  // this is treated the same as the exact-duplicate-content case below:
  // silently advance the checkpoint, never post.
  // The generic unmatched fallback ("I noticed the discussion has stalled,
  // but couldn't tell which class or property this was about...") gets the
  // exact same treatment and for the same reason -- it tells the group
  // nothing they can act on -- so this is also set true whenever pass 1
  // fails to resolve a class/property (see the `else` branch below).
  let hasNothingToShow = false;

  // "Every user message exchanged since" the last posted intervention --
  // project-wide. Already fetched above (overlapped with the other
  // independent reads via sinceLastInterventionChunksPromise) -- nothing
  // left to await here.
  const sinceLastInterventionChunks = sinceLastInterventionChunksRaw ?? newChunks;
  const sinceLastInterventionTranscript = formatChunksAsTranscript(sinceLastInterventionChunks, usernameById);

  // The bulk of the extraction rules (merge/stability/color-reference logic)
  // is written generically -- with no property name baked in -- because
  // topic identification and extraction now happen together in a SINGLE
  // model call (see the combined call below): the model doesn't have a
  // confirmed className/propertyName to hand this function until AFTER its
  // own response comes back, so the rules can only ever refer to "the
  // property you identified above" rather than a fixed name.
  function extractionRules(): string {
    return (
      "Extract every concrete EXAMPLE given in support of keeping/adding the property you identified above, " +
      "and every COUNTEREXAMPLE or objection given against it -- include something even if it was only " +
      "mentioned once and never repeated, but leave it out if someone explicitly retracted or contradicted " +
      "it. For each one, note who said it. " +
      "Write every \"text\" value in the SAME language the users are speaking in the transcript below (if the " +
      "transcript mixes languages, use whichever language is predominant) -- never translate it into English or " +
      "any other language. The one exception is class and property names themselves: whenever a class or " +
      "property name from the catalog above appears within that text, keep it exactly as it's spelled in the " +
      "catalog, untranslated and unchanged, even though the rest of the sentence around " +
      "it is written in the transcript's language. " +
      "If the SAME underlying point was made more than once -- whether by the same person repeating " +
      "themselves, or by different people independently making an equivalent point -- merge it into a " +
      "single entry rather than listing it twice, and list every person who made that point (in the order " +
      "they first raised it, no duplicate names even if someone repeated themselves). Only merge points " +
      "that are genuinely the same underlying reason; keep distinct reasons as separate entries even if " +
      "they're about the same property.\n\n" +
      "The points already listed in the EXISTING STATE section above, under whichever property you identified, " +
      "were ALREADY ESTABLISHED in a previous round -- you MUST treat their wording as frozen, and each " +
      "current supporter's agreement is assumed to STILL STAND unless the transcript shows otherwise. " +
      "For each one: if the transcript still supports it (repeated or not), return it with its EXACT SAME id " +
      "and EXACT SAME text (copy the text verbatim, do not rephrase it even slightly). ONLY change an " +
      "existing id's text if a member EXPLICITLY asks to reword, correct, or replace that specific existing " +
      "point in the transcript (e.g. \"can we change that example to say X instead\") -- in that case set " +
      "\"revise\": true and put the new wording in \"text\". Never reword an existing point just because you " +
      "found a slightly different way to phrase it; if you're not certain a member explicitly asked for a " +
      "reword, leave the text untouched. " +
      "List in \"by\" any NEW people (not already credited above) who now also back this point -- including " +
      "someone who never names the point directly but clearly implies backing it: stating a preference, " +
      "saying what seems better to them, describing their thinking shifting that way, or proposing something " +
      "that only makes sense if this point holds. " +
      "List in \"remove\" any of the CURRENTLY credited people (from the list above) who no longer stand " +
      "behind this specific point. Do NOT require explicit retraction language -- infer this from ANY clear " +
      "signal that their stance has moved away from the point, phrased however they like: stating a " +
      "preference for the opposite side, saying an alternative now seems better to them, describing a " +
      "change of mind in general terms (\"actually I don't think that's true anymore\", \"I take that back\", " +
      "\"I'm leaning the other way now\"), or proposing/backing something that directly contradicts what " +
      "this point said -- e.g. someone credited on a counterexample for removing this property later argues " +
      "to keep it, or backs an example that only makes sense if the property stays; that contradicts their " +
      "earlier counterexample, so remove them from it (and the same the other way around, from an example to " +
      "a counterexample). The bar is a genuine contradiction or a stated shift somewhere in the transcript -- " +
      "simply not repeating the point again, or staying quiet about it, is still NOT enough on its own and " +
      "must NOT put them in \"remove\". " +
      "A member often expresses agreement or disagreement by referring to ANOTHER member -- by name, or by " +
      "that member's assigned COLOR -- instead of restating the opinion itself (e.g. \"I agree with Blue\", " +
      "\"disagree with what Alice said\", \"the purple one has a point\", \"same as him\" replying to a " +
      "colored/named mention). Each project member has exactly one fixed color; resolve any such name/color " +
      `reference using this legend: ${colorLegendText}. Once resolved to a specific member, find which of ` +
      "the point(s) that SPECIFIC member is currently credited on (from the existing lists above, or newly " +
      "raised earlier in this same batch of messages) is being reacted to -- if they have only one, it's " +
      "that one; if they have several, use the surrounding context (what was just being discussed) to tell " +
      "which one, and if it's genuinely ambiguous which of their points is meant, do not guess -- treat it " +
      "the same as any other ambiguous remark (see below) and leave things as they were. Once resolved, " +
      "treat it exactly like directly restating that point: add the responding member to \"by\" if they now " +
      "agree with it, or to \"remove\" (naming the ORIGINAL member, not the responder) only if the responder " +
      "is the original author disagreeing with their own past point -- agreeing/disagreeing FROM one member " +
      "ABOUT another member's point never removes the original author, it only adds or withholds the " +
      "responder's own name in \"by\". " +
      "The overall goal across rounds is MAXIMUM STABILITY: this exact list, in this exact wording, is what " +
      "was shown to the group last time, and it should come back looking as close to identical as possible " +
      "this time, changing only where the transcript has genuinely, unambiguously moved. When a remark is " +
      "vague or general -- a bare \"I agree\", \"that's right\", \"I'm satisfied now\", or similar -- and it " +
      "is not clear from context which SPECIFIC existing point (by id) it endorses or contradicts, that " +
      "ambiguity is NOT evidence of anything: do not add the speaker to \"by\" and do not put them in " +
      "\"remove\" for ANY existing point on the strength of it alone. Whenever genuinely unsure whether " +
      "something clears the bar for \"remove\" or \"revise\", resolve the uncertainty by leaving the " +
      "existing point exactly as it was credited before, rather than changing it. " +
      "Any genuinely new point not covered by an existing id above should be returned with NO \"id\" field -- " +
      "BUT merge fairly liberally: before treating something as a brand-new point, check whether it's " +
      "broadly the same underlying idea as one of the existing points listed above, just phrased " +
      "differently (not necessarily word-for-word identical, close enough in meaning is enough). If so, " +
      "don't create a new point -- instead set \"mergeWithId\" to that existing point's id and put the new " +
      "speaker(s) in \"by\"; the merged-in wording is discarded and the existing point's frozen text wins. " +
      "This also applies to two of the EXISTING points above if you notice they're actually the same " +
      "underlying idea (this can happen from earlier rounds before this rule) -- return the newer/less-" +
      "supported one with its own \"id\" and \"mergeWithId\" set to the other's id, and its supporters will " +
      "be folded into that other point automatically; when merging two existing points this way, prefer " +
      "keeping (as the mergeWithId target) whichever one is more clearly and completely worded. " +
      "Do NOT copy the speaker's original sentence verbatim for a brand-new point -- condense it down to its " +
      "core point in your own words, as short and punchy as possible (aim for well under 10 words, phrased as " +
      "a plain statement, no filler like \"they said\" or \"because\"). "
    );
  }

  interface TransientPoint {
    id: number;
    text: string;
    by: string[];
  }
  const toTransientPoints = (entries: ModeratorInterventionEntry[] | null): TransientPoint[] =>
    (entries ?? []).map((e, i) => ({ id: i + 1, text: e.text, by: e.by }));
  const describeExisting = (points: TransientPoint[]) =>
    points.length === 0
      ? "(none yet)"
      : points.map((p) => `- id ${p.id}: "${p.text}" (currently credited to: ${p.by.join(", ") || "no one"})`).join("\n");
  const normalize = (s: string) => s.trim().toLowerCase();
  const resolveMatch = (rawClassName: string | null, rawPropertyName: string | null) =>
    rawClassName && rawPropertyName
      ? catalog.find(
          (entry) =>
            normalize(entry.className) === normalize(rawClassName) &&
            normalize(entry.propertyName) === normalize(rawPropertyName),
        )
      : undefined;

  let existingExamplePoints: TransientPoint[] = [];
  let existingCounterexamplePoints: TransientPoint[] = [];

  // Precompute EVERY catalog property's transient existing-points (id'd
  // 1..n, same scheme reused for reconcile() below) up front, once -- both
  // to render the EXISTING STATE section of the single combined prompt
  // below, and to look the matched property's own points back up after the
  // call returns, WITHOUT recomputing them (which could reassign different
  // ids than what the model was actually shown).
  const pointsByProperty = new Map<
    string,
    { examplePoints: TransientPoint[]; counterexamplePoints: TransientPoint[] }
  >();
  for (const entry of catalog) {
    const key = `${entry.classId}:${entry.propertyId}`;
    const prior = priorInterventionByProperty.get(key);
    pointsByProperty.set(key, {
      examplePoints: toTransientPoints(prior?.examples ?? null),
      counterexamplePoints: toTransientPoints(prior?.counterexamples ?? null),
    });
  }
  const priorStateText =
    catalog.length > 0
      ? catalog
          .map((entry) => {
            const { examplePoints, counterexamplePoints } = pointsByProperty.get(
              `${entry.classId}:${entry.propertyId}`,
            )!;
            if (examplePoints.length === 0 && counterexamplePoints.length === 0) {
              return `${entry.className}.${entry.propertyName}: (never discussed yet -- any point raised for it is brand new)`;
            }
            return (
              `${entry.className}.${entry.propertyName}:\n` +
              `  Examples:\n${describeExisting(examplePoints)}\n` +
              `  Counterexamples:\n${describeExisting(counterexamplePoints)}`
            );
          })
          .join("\n\n")
      : "(the workspace has no classes/properties yet)";

  try {
    // ONE model call performs BOTH jobs every time: (1) identify the
    // className/propertyName the speakers are currently discussing (or
    // null/null), the same way regardless of whether that turns out to be
    // a continuation of the last posted topic, a genuine switch to a
    // different property, or this project's first-ever intervention; and
    // (2) extract that property's updated examples/counterexamples in the
    // same response, using the EXISTING STATE section below (covering
    // every catalog property, not just the previous topic) as the
    // baseline for whichever one it lands on. There is no longer a
    // separate follow-up call for a topic switch or a first intervention.
    // Prompt sections below are deliberately ordered from MOST stable to
    // LEAST stable -- fully-static instructions/rules first, then the
    // catalog (only changes when the workspace's classes/properties
    // change), then EXISTING STATE (changes whenever any property's points
    // change, i.e. roughly every successful intervention), and finally the
    // transcript in the user turn (changes on every single call). Model
    // providers that support prompt caching discount whatever common
    // prefix matches the previous call byte-for-byte -- putting the most
    // volatile content (EXISTING STATE, transcript) last, instead of
    // interleaved with the static instructions/extractionRules() text,
    // maximizes how much of each call can hit that cache instead of being
    // billed at full price.
    const staticInstructions =
      "You are an AI moderator for a group ontology-design conversation, doing TWO jobs in ONE pass: " +
      "(1) identify the SINGLE class and property the speakers are currently discussing (whether it should " +
      "be retained, removed, or how it should be defined), and (2) extract an updated " +
      "examples/counterexamples list for THAT property -- see the SECOND section below for exactly when " +
      "that applies. Every message below is from real-time speech-to-text and can contain near-homophone " +
      "errors (a name or word transcribed as something that merely sounds alike); infer intended meaning " +
      "by sound and context rather than taking odd literal text at face value -- this applies throughout " +
      "both jobs below, not just topic identification. " +
      (lastPostedIntervention
        ? `Below (in the user turn) is the PREVIOUS INTERVENTION MESSAGE you already posted, followed by every ` +
          "user message exchanged since then. Base your topic decision ONLY on these two things -- not on any " +
          "earlier history beyond what that previous intervention message itself already states. Conversation " +
          "commonly continues about the same property without re-stating its name -- via pronouns (\"it\", " +
          "\"that\"), direct replies/agreement/disagreement/reactions, or follow-up refinements, even across " +
          "several more messages. If the messages since that intervention read as a natural continuation of " +
          "the same discussion, report that SAME className/propertyName again even though it isn't " +
          "explicitly named. Only report a DIFFERENT property if a message clearly and specifically names or " +
          "unambiguously describes a different one. Only report null/null if the messages have moved on to " +
          "something unrelated to any listed property entirely (small talk, a topic outside the catalog, " +
          "etc). "
        : "There is no previous intervention yet, so the user turn below is simply the transcript of what's " +
          "been said so far. Only report a className/propertyName if a message clearly names or unambiguously " +
          "describes one from the list; report null/null if nothing in the workspace catalog is being " +
          "discussed. ") +
      "\n\nYou MUST only report a className/propertyName from the catalog list below, copied with EXACTLY the " +
      "same spelling and capitalization shown there -- never invent, paraphrase, or guess a name that isn't in " +
      "the list. " +
      "\n\nSECOND, ONLY IF your className/propertyName answer above is NOT null/null: also perform an " +
      "extraction update for that property, using the same messages-since-then transcript in the user turn as " +
      "the source, and fill the \"examples\"/\"counterexamples\" fields of your response accordingly. If your " +
      "answer is null/null, leave \"examples\" and \"counterexamples\" as empty arrays. Once you've identified " +
      "className/propertyName, use ONLY that property's EXISTING STATE block below as the baseline for " +
      "extraction; ignore every other property's block entirely.\n\n" +
      extractionRules() +
      'Respond with ONLY a JSON object, no markdown fences, no prose, matching exactly this shape: ' +
      '{"className": string | null, "propertyName": string | null, ' +
      '"examples": [{"id": number | undefined, "text": string, "by": string[], "remove": string[] | undefined, "revise": boolean | undefined, "mergeWithId": number | undefined}], ' +
      '"counterexamples": [{"id": number | undefined, "text": string, "by": string[], "remove": string[] | undefined, "revise": boolean | undefined, "mergeWithId": number | undefined}]}. ' +
      "Use the exact usernames as they appear as speaker labels in the transcript.";

    const combined = await callOpenAiJson(
      apiKey,
      config.model,
      staticInstructions +
        "\n\nCATALOG -- the shared workspace CURRENTLY contains only the following class.property pairs:\n" +
        catalogText +
        "\n\nEXISTING STATE already recorded for each catalog property (examples/counterexamples established " +
        "in earlier rounds):\n" +
        priorStateText,
      `PREVIOUS INTERVENTION MESSAGE:\n${lastPostedIntervention?.content ?? "(none yet)"}\n\nMESSAGES SINCE THEN:\n${sinceLastInterventionTranscript || "(none)"}`,
    );

    const rawClassName = typeof combined?.className === "string" ? combined.className : null;
    const rawPropertyName = typeof combined?.propertyName === "string" ? combined.propertyName : null;

    matchedEntry = resolveMatch(rawClassName, rawPropertyName);
    matched = matchedEntry !== undefined;

    const extraction: { examples: unknown[]; counterexamples: unknown[] } = {
      examples: Array.isArray(combined?.examples) ? combined.examples : [],
      counterexamples: Array.isArray(combined?.counterexamples) ? combined.counterexamples : [],
    };

    if (matchedEntry) {
      const matchedPoints = pointsByProperty.get(`${matchedEntry.classId}:${matchedEntry.propertyId}`)!;
      existingExamplePoints = matchedPoints.examplePoints;
      existingCounterexamplePoints = matchedPoints.counterexamplePoints;
    }

    if (matched && matchedEntry) {
      const { classId, propertyId, className, propertyName } = matchedEntry;

      // Retroactively tag this round's chunks with the matched property --
      // only ones not already tagged under some earlier topic, so an
      // attribution is never overwritten once made.
      const newChunkIds = newChunks.filter((c) => c.classId === null && c.propertyId === null).map((c) => c.id);
      if (newChunkIds.length > 0) {
        await db
          .update(moderatorTranscriptChunksTable)
          .set({ classId, propertyId })
          .where(
            and(
              inArray(moderatorTranscriptChunksTable.id, newChunkIds),
              isNull(moderatorTranscriptChunksTable.classId),
            ),
          );
      }

      // Extraction was already performed in the single combined call above,
      // using this property's EXISTING STATE block as the baseline -- no
      // further OpenAI call needed here.
      const rawExamples = Array.isArray(extraction?.examples) ? extraction.examples : [];
      const rawCounterexamples = Array.isArray(extraction?.counterexamples) ? extraction.counterexamples : [];

      interface ParsedResponseEntry {
        id: number | null;
        text: string;
        by: string[];
        remove: string[];
        revise: boolean;
        mergeWithId: number | null;
      }
      const toResponseEntries = (entries: unknown[]): ParsedResponseEntry[] =>
        entries
          .filter(
            (e): e is { id?: unknown; text: string; by: unknown; remove?: unknown; revise?: unknown; mergeWithId?: unknown } =>
              Boolean(e) && typeof e === "object" && typeof (e as any).text === "string",
          )
          .map((e) => {
            const text = e.text.trim().replace(/[.\s]+$/, "");
            const normalizeNames = (raw: unknown) => {
              const rawNames = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
              return Array.from(
                new Set(rawNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0)),
              );
            };
            const by = normalizeNames(e.by);
            const remove = normalizeNames(e.remove);
            const id = typeof e.id === "number" && Number.isFinite(e.id) ? e.id : null;
            const mergeWithId =
              typeof e.mergeWithId === "number" && Number.isFinite(e.mergeWithId) ? e.mergeWithId : null;
            return { id, text, by, remove, revise: e.revise === true, mergeWithId };
          })
          .filter((e) => e.text.length > 0);

      // Reconcile the model's response against the previous round's points
      // (existing, from the previous intervention message -- see
      // TransientPoint above), enforcing in code -- not just by asking the
      // model -- that an existing point's wording can only change via an
      // explicit "revise" flag, and that a supporter is only ever dropped
      // via an explicit "remove" flag naming them. Anything else about an
      // existing id (silent rewording, or simply not being repeated this
      // round) is ignored: absence of evidence is never treated as
      // disagreement, so a user's prior position is retained by default. A
      // point that loses its last supporter this way is dropped outright.
      // Purely an in-memory merge -- there's no separate persisted point
      // store to write back to; the result becomes part of the new
      // intervention message row itself, which in turn becomes "existing"
      // for the NEXT round.
      function reconcile(existing: TransientPoint[], responseEntries: ParsedResponseEntry[]): ModeratorInterventionEntry[] {
        const byId = new Map(existing.map((p) => [p.id, p]));

        // --- Fold merges first, before doing anything else. ---
        // A response entry with a valid mergeWithId (pointing at a
        // DIFFERENT existing point) never becomes its own row: its
        // supporters are folded into the target id's aggregated extra
        // by/remove instead, whether the entry itself was a brand-new idea
        // (no own id) or an existing point the model recognized as a
        // duplicate of another one (own id present -- that row gets
        // deleted below, its accumulated supporters carried over).
        const mergedAwayIds = new Set<number>();
        const extraById = new Map<number, { by: Set<string>; remove: Set<string> }>();
        const addExtra = (targetId: number, by: string[], remove: string[]) => {
          const extra = extraById.get(targetId) ?? { by: new Set<string>(), remove: new Set<string>() };
          for (const n of by) extra.by.add(n);
          for (const n of remove) extra.remove.add(n);
          extraById.set(targetId, extra);
        };
        const normalResponses: ParsedResponseEntry[] = [];
        for (const response of responseEntries) {
          if (response.mergeWithId !== null && byId.has(response.mergeWithId) && response.mergeWithId !== response.id) {
            if (response.id !== null && byId.has(response.id)) {
              // Two previously-separate existing points turned out to be
              // the same idea -- carry the losing point's own supporters
              // (its stored `by`, not just this round's new names) into the
              // survivor, then drop the losing row entirely.
              const losing = byId.get(response.id)!;
              addExtra(response.mergeWithId, [...losing.by, ...response.by], response.remove);
              mergedAwayIds.add(response.id);
            } else {
              addExtra(response.mergeWithId, response.by, response.remove);
            }
            continue;
          }
          normalResponses.push(response);
        }

        const result: ModeratorInterventionEntry[] = [];

        // Existing points first, in their original stable order, so the
        // card's row order never reshuffles between interventions.
        for (const point of existing) {
          if (mergedAwayIds.has(point.id)) continue;
          const response = normalResponses.find((r) => r.id === point.id);
          const extra = extraById.get(point.id);
          let text = point.text;
          let by = point.by;
          if (response || extra) {
            const removeSet = new Set([...(response?.remove ?? []), ...(extra?.remove ?? [])].map((n) => n.toLowerCase()));
            by = Array.from(new Set([...point.by, ...(response?.by ?? []), ...(extra?.by ?? [])])).filter(
              (n) => !removeSet.has(n.toLowerCase()),
            );
            if (response?.revise && response.text.length > 0) {
              text = response.text;
            }
          }
          if (by.length === 0) {
            // Every current supporter explicitly disagreed -- the point no
            // longer has anyone standing behind it, so it's dropped rather
            // than shown as an orphaned, unsupported row.
            continue;
          }
          result.push({ text, by });
        }

        // Anything the model returned with no id (or an id that doesn't
        // match any existing point, e.g. a stale id from a previous prompt)
        // is a brand-new point.
        for (const response of normalResponses) {
          if (response.id !== null && byId.has(response.id)) continue;
          if (response.by.length === 0) continue;
          result.push({ text: response.text, by: response.by });
        }

        return result;
      }

      const exampleEntries = reconcile(existingExamplePoints, toResponseEntries(rawExamples));
      const counterexampleEntries = reconcile(existingCounterexamplePoints, toResponseEntries(rawCounterexamples));

      const formatEntriesText = (entries: ModeratorInterventionEntry[]) =>
        entries.map((e) => `${e.text}. — ${e.by.length > 0 ? e.by.join(", ") : "someone"}`).join("\n") ||
        "(none given yet)";

      // Fixed template: title/header lives in the client (always "AI
      // moderator"), so the content itself only carries the stalled-property
      // line, the two condensed pro/con lists, and the standing prompt to
      // keep discussing or move to a vote -- no extra framing or attribution
      // line, per the exact wording the moderator is expected to use.
      interventionContent =
        `Discussion stalled — ${className}.${propertyName}\n\n` +
        `I noticed the discussion has stalled on this property. Here's where things stand:\n\n` +
        `For keeping it:\n\n${formatEntriesText(exampleEntries)}\n\n` +
        `For removing it:\n\n${formatEntriesText(counterexampleEntries)}\n\n` +
        `Would you like to continue discussing, or move to a vote?`;
      interventionExamples = exampleEntries;
      interventionCounterexamples = counterexampleEntries;
      hasNothingToShow = exampleEntries.length === 0 && counterexampleEntries.length === 0;
    } else {
      interventionContent =
        "I noticed the discussion has stalled, but couldn't tell which class or property this was about. " +
        "Try focusing the discussion on properties already in this shared workspace.";
      // This generic fallback gives the group nothing to act on -- same
      // treatment as a matched property with no examples/counterexamples
      // at all: silently advance the checkpoint, never actually post it.
      hasNothingToShow = true;
    }
  } catch (err) {
    logger.error({ err, projectId }, "Moderator intervention generation errored");
    broadcastToProject(projectId, {
      type: "moderator_error",
      message: err instanceof Error ? err.message : "Could not reach OpenAI to generate a summary.",
    });
    return;
  }

  // Commit the intervention and advance the durable checkpoint atomically,
  // and only if the project's moderator config row is still the one we
  // generated this intervention for.
  const [insertedRow, committed] = await db.transaction(async (tx) => {
    // These two reads touch different tables and neither depends on the
    // other's result -- firing them together instead of sequentially saves
    // a DB round trip inside the transaction, on the critical path right
    // before the message is actually committed.
    const [[current], [previousIntervention]] = await Promise.all([
      tx
        .select()
        .from(projectModeratorTable)
        .where(eq(projectModeratorTable.projectId, projectId))
        .for("update"),
      tx
        .select({
          content: moderatorChatMessagesTable.content,
          matched: moderatorChatMessagesTable.matched,
          classId: moderatorChatMessagesTable.classId,
          propertyId: moderatorChatMessagesTable.propertyId,
          examples: moderatorChatMessagesTable.examples,
          counterexamples: moderatorChatMessagesTable.counterexamples,
        })
        .from(moderatorChatMessagesTable)
        .where(
          and(
            eq(moderatorChatMessagesTable.projectId, projectId),
            eq(moderatorChatMessagesTable.type, "intervention"),
            // The generic "couldn't tell which class or property this was
            // about" fallback carries no class/property/examples of its own,
            // so it can never meaningfully match or mismatch a freshly
            // generated intervention -- it's a "no signal" placeholder, not
            // a real prior round. Skip past any of those and compare against
            // the last intervention that actually landed on a topic, so a
            // fallback round in between two identical matched interventions
            // doesn't hide the fact that the second one is a repeat.
            eq(moderatorChatMessagesTable.matched, true),
          ),
        )
        .orderBy(desc(moderatorChatMessagesTable.createdAt), desc(moderatorChatMessagesTable.id))
        .limit(1),
    ]);
    if (!current) return [undefined, false] as const;

    // Never re-post over the same underlying content back-to-back -- e.g.
    // the group falls silent again without adding anything substantive,
    // or two consecutive rounds both fall through to the same generic
    // "couldn't tell what this was about" reminder. Either way showing it
    // again adds nothing and just reads as the moderator repeating itself.
    // The checkpoint still advances (these chunks WERE considered) so the
    // group doesn't get stuck being re-summarized forever; only the
    // redundant chat message is suppressed.
    //
    // Comparing the literal formatted content string is too fragile a
    // safeguard: the extraction pass re-derives examples/counterexamples
    // from scratch every round, so even when nothing meaningfully changed,
    // purely incidental artifacts of that re-derivation -- entries coming
    // back in a different order, stray whitespace -- would each register
    // as "new content" and defeat this guard. Instead compare a canonical
    // SIGNATURE: for a matched property, the same class/property plus the
    // same SET of example/counterexample points (sorted, case/whitespace-
    // normalized), where each point is its text together with its full,
    // order-independent set of supporters. A point being added or removed,
    // its wording changing, OR its supporter list changing (someone newly
    // backing it, or someone dropping off it) all count as a substantive
    // shift and change the signature -- only reordering/formatting is
    // ignored.
    const canonicalTextSet = (entries: ModeratorInterventionEntry[] | null) =>
      (entries ?? [])
        .map((e) => {
          const text = e.text.trim().toLowerCase().replace(/\s+/g, " ");
          const by = [...e.by].map((n) => n.trim().toLowerCase()).sort().join("\u0002");
          return `${text}\u0003${by}`;
        })
        .sort()
        .join("\u0001");
    // previousIntervention was already fetched above (filtered to matched
    // rows only -- see comment on that query), in parallel with the
    // row-locked `current` select.
    const isSameAsPrevious = (() => {
      if (!previousIntervention) return false;
      // A fresh unmatched round (the generic fallback) never counts as a
      // repeat: `previousIntervention` is always a matched row now, so it
      // has no class/property/examples to compare the fallback against.
      if (!matched) return false;
      return (
        previousIntervention.classId === (matchedEntry?.classId ?? null) &&
        previousIntervention.propertyId === (matchedEntry?.propertyId ?? null) &&
        canonicalTextSet(previousIntervention.examples) === canonicalTextSet(interventionExamples) &&
        canonicalTextSet(previousIntervention.counterexamples) === canonicalTextSet(interventionCounterexamples)
      );
    })();
    if (isSameAsPrevious) {
      await tx
        .update(projectModeratorTable)
        .set({ lastSummarizedAt: maxCreatedAt })
        .where(eq(projectModeratorTable.projectId, projectId));
      return [undefined, false] as const;
    }

    // Nothing to actually show the group (see hasNothingToShow's doc
    // comment above) -- same treatment as the duplicate-content case:
    // advance the checkpoint so these chunks aren't re-processed forever,
    // but don't interrupt the group with an empty-handed message.
    if (hasNothingToShow) {
      await tx
        .update(projectModeratorTable)
        .set({ lastSummarizedAt: maxCreatedAt })
        .where(eq(projectModeratorTable.projectId, projectId));
      return [undefined, false] as const;
    }

    const [row] = await tx
      .insert(moderatorChatMessagesTable)
      .values({
        projectId,
        type: "intervention",
        userId: null,
        content: interventionContent,
        matched,
        className: matchedEntry?.className ?? null,
        propertyName: matchedEntry?.propertyName ?? null,
        classId: matchedEntry?.classId ?? null,
        propertyId: matchedEntry?.propertyId ?? null,
        examples: interventionExamples,
        counterexamples: interventionCounterexamples,
      })
      .returning();
    await tx
      .update(projectModeratorTable)
      .set({ lastSummarizedAt: maxCreatedAt })
      .where(eq(projectModeratorTable.projectId, projectId));
    return [row, true] as const;
  });

  if (!committed || !insertedRow) return;

  // All three conditions are now confirmed true: (1) silence, checked
  // before this function was even queued; (2) a new finalized message,
  // checked via newChunks above; (3) genuinely new content, just confirmed
  // by the dedup check above. The message is already durably committed --
  // everything from here on is purely a display sequence: show the typing
  // indicator now, then reveal the message itself a beat later.
  broadcastToProject(projectId, { type: "moderator_intervention_typing" });
  const message = await serializeChatMessage(insertedRow);
  await new Promise((resolve) => setTimeout(resolve, INTERVENTION_TYPING_DELAY_MS));
  broadcastToProject(projectId, { type: "moderator_chat_message", message });
}
