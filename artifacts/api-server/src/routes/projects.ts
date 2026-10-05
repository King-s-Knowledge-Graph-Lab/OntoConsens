import { Router, type IRouter } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  ontologyClassesTable,
  ontologyRelationsTable,
  projectMembersTable,
  projectsTable,
  usersTable,
  MAX_PROJECT_MEMBERS,
} from "@workspace/db";
import { JoinProjectBody, SetReadyBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { extractOntologyWithAI, getUserApiKey } from "../lib/aiOntologyExtractor";
import { issueTicket, issueUserTicket, broadcastToProject, broadcastToUsers } from "../lib/wsHub";
import { getPropertyQuota, mergeDuplicatePropertiesOnReady } from "./properties";
import { ensureModeratorIntroMessage } from "../lib/moderatorEngine";
import { clearModeratorSilenceTimer, postConsensusReachedMessage } from "../lib/moderatorEngine";

const router: IRouter = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);

function serializeProject(project: typeof projectsTable.$inferSelect, memberCount: number) {
  return {
    id: project.id,
    name: project.name,
    inviteCode: project.inviteCode,
    ownerId: project.ownerId,
    memberCount,
    maxMembers: project.maxMembers,
    moderatorEnabled: project.moderatorEnabled,
    exportedAt: project.exportedAt ? project.exportedAt.toISOString() : null,
    createdAt: project.createdAt.toISOString(),
  };
}

async function getMembership(projectId: number, userId: number) {
  return db.query.projectMembersTable.findFirst({
    where: and(
      eq(projectMembersTable.projectId, projectId),
      eq(projectMembersTable.userId, userId),
    ),
  });
}

router.get("/projects", async (req, res) => {
  const userId = req.userId!;
  const memberships = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.userId, userId),
  });
  const projectIds = memberships.map((m) => m.projectId);
  if (projectIds.length === 0) {
    res.json([]);
    return;
  }
  const projects = await db.query.projectsTable.findMany();
  const relevant = projects.filter((p) => projectIds.includes(p.id));
  const counts = await Promise.all(
    relevant.map(async (p) => {
      const members = await db.query.projectMembersTable.findMany({
        where: eq(projectMembersTable.projectId, p.id),
      });
      return serializeProject(p, members.length);
    }),
  );
  res.json(counts);
});

router.post("/projects", upload.single("file"), async (req, res) => {
  const userId = req.userId!;
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const file = req.file;
  // Multipart text fields always arrive as strings, even for a numeric field.
  const memberCount = Number(req.body.memberCount);
  // Multipart booleans arrive as strings too, and this field is optional for
  // backward compatibility (older clients that predate this setting) --
  // anything other than the literal string "false" defaults to enabled.
  const moderatorEnabled = req.body.moderatorEnabled !== "false";

  if (!name) {
    res.status(400).json({ error: "Project name is required" });
    return;
  }
  if (!file) {
    res.status(400).json({ error: "Ontology file is required" });
    return;
  }
  if (!Number.isInteger(memberCount) || memberCount < 1 || memberCount > MAX_PROJECT_MEMBERS) {
    res.status(400).json({ error: `Number of members must be between 1 and ${MAX_PROJECT_MEMBERS}` });
    return;
  }

  const apiKey = await getUserApiKey(userId);
  if (!apiKey) {
    res.status(400).json({ error: "Add your OpenAI API key before creating a project (see the API Key button above)." });
    return;
  }

  let parsed;
  try {
    parsed = await extractOntologyWithAI(apiKey, file.originalname, file.buffer, file.mimetype);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "Could not parse the ontology file" });
    return;
  }

  if (parsed.classes.length === 0) {
    res.status(400).json({ error: "No connected class hierarchy was found in the uploaded file" });
    return;
  }

  // Project names must be unique across the whole app, not just per-owner —
  // compared case-insensitively so "Foo" and "foo" still collide.
  const allProjects = await db.query.projectsTable.findMany();
  const nameTaken = allProjects.some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) {
    res.status(409).json({ error: "Project name already exists" });
    return;
  }

  const inviteCode = crypto.randomBytes(4).toString("hex");

  const [project] = await db
    .insert(projectsTable)
    .values({ name, ownerId: userId, inviteCode, maxMembers: memberCount, moderatorEnabled })
    .returning();
  if (!project) {
    res.status(500).json({ error: "Failed to create project" });
    return;
  }

  await db
    .insert(projectMembersTable)
    .values({ projectId: project.id, userId, colorSlot: 0, ready: false });

  const classIdByUri = new Map<string, number>();
  for (const cls of parsed.classes) {
    const [inserted] = await db
      .insert(ontologyClassesTable)
      .values({ projectId: project.id, uri: cls.uri, label: cls.label })
      .returning();
    if (inserted) {
      classIdByUri.set(cls.uri, inserted.id);
    }
  }

  for (const relation of parsed.relations) {
    const childId = classIdByUri.get(relation.childUri);
    const parentId = classIdByUri.get(relation.parentUri);
    if (childId && parentId) {
      await db
        .insert(ontologyRelationsTable)
        .values({ projectId: project.id, childId, parentId });
    }
  }

  res.status(201).json(serializeProject(project, 1));
});

router.post("/projects/join", async (req, res) => {
  const userId = req.userId!;
  const parsed = JoinProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.inviteCode, parsed.data.inviteCode),
  });
  if (!project) {
    res.status(400).json({ error: "Invalid invite code" });
    return;
  }

  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, project.id),
  });

  const existing = members.find((m) => m.userId === userId);
  if (existing) {
    res.json(serializeProject(project, members.length));
    return;
  }

  if (members.length >= project.maxMembers) {
    res.status(400).json({ error: "This project already has the maximum number of members" });
    return;
  }

  await db.insert(projectMembersTable).values({
    projectId: project.id,
    userId,
    colorSlot: members.length,
    ready: false,
  });

  broadcastToProject(project.id, { type: "member_joined" });
  // Existing members (the owner is already a project_members row from
  // creation) may be looking at the dashboard rather than inside the
  // project itself -- push the new count straight to them too, so the
  // member count updates immediately there instead of waiting on a poll.
  const memberUserIds = [...members.map((m) => m.userId), userId];
  broadcastToUsers(memberUserIds, {
    type: "member_count_changed",
    projectId: project.id,
    memberCount: members.length + 1,
  });

  res.json(serializeProject(project, members.length + 1));
});

router.get("/projects/:id", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const memberRows = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const users = await db.query.usersTable.findMany();
  const usersById = new Map(users.map((u) => [u.id, u]));

  // colorSlot is assigned once, at first join, and never changes — sorting by
  // it (rather than trusting row order from the DB) guarantees each member's
  // avatar always renders in the same fixed position, regardless of rejoins,
  // reconnects, or query plan differences.
  const members = memberRows
    .slice()
    .sort((a, b) => a.colorSlot - b.colorSlot)
    .map((m) => ({
      userId: m.userId,
      username: usersById.get(m.userId)?.username ?? "unknown",
      colorSlot: m.colorSlot,
      ready: m.ready,
      isOwner: m.userId === project.ownerId,
    }));

  const classes = await db.query.ontologyClassesTable.findMany({
    where: eq(ontologyClassesTable.projectId, projectId),
  });
  const relations = await db.query.ontologyRelationsTable.findMany({
    where: eq(ontologyRelationsTable.projectId, projectId),
  });

  // Each member has their own fixed property budget per class (see
  // getPropertyQuota) — there is no shared/global cap, so "at cap" is
  // computed against THIS viewer's own proposals only, never anyone else's.
  // That also means this never has to peek at properties the viewer isn't
  // allowed to see yet (private, pre-consensus proposals from other
  // members) to answer the question.
  const { propertiesTable } = await import("@workspace/db");
  const myProperties = await db.query.propertiesTable.findMany({
    where: and(eq(propertiesTable.projectId, projectId), eq(propertiesTable.proposedByUserId, userId)),
  });
  const myPropertyCountByClass = new Map<number, number>();
  for (const p of myProperties) {
    myPropertyCountByClass.set(p.classId, (myPropertyCountByClass.get(p.classId) ?? 0) + 1);
  }
  // The budget is derived from the project's SPECIFIED member count, not
  // however many have actually joined so far — a solo member of a
  // 3-member project gets the 3-member first-joiner budget from the start,
  // not the larger solo budget, since two more members are expected.
  const myQuota = getPropertyQuota(project.maxMembers, membership.colorSlot);

  res.json({
    id: project.id,
    name: project.name,
    inviteCode: project.inviteCode,
    ownerId: project.ownerId,
    maxMembers: project.maxMembers,
    moderatorEnabled: project.moderatorEnabled,
    exportedAt: project.exportedAt ? project.exportedAt.toISOString() : null,
    createdAt: project.createdAt.toISOString(),
    members,
    classes: classes.map((c) => {
      const propertyCount = myPropertyCountByClass.get(c.id) ?? 0;
      return {
        id: c.id,
        uri: c.uri,
        label: c.label,
        propertyCount,
        atPropertyCap: propertyCount >= myQuota,
      };
    }),
    relations: relations.map((r) => ({ childId: r.childId, parentId: r.parentId })),
  });
});

router.delete("/projects/:id", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId !== userId) {
    res.status(403).json({ error: "Only the project owner can delete this project" });
    return;
  }

  // Grab who needs to be notified before the cascade wipes the membership
  // rows out from under us.
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const memberUserIds = members.map((m) => m.userId);

  // Every child table (members, classes, relations, properties,
  // agreements) references projects with onDelete: "cascade", so removing
  // this one row cleans up everything for every member automatically.
  await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
  clearModeratorSilenceTimer(projectId);

  broadcastToProject(projectId, { type: "project_deleted" });
  // Members who are sitting on the dashboard (not inside this project) only
  // hold a project-scoped socket while viewing the project itself, so also
  // push to their dashboard connections to drop the card immediately there.
  broadcastToUsers(memberUserIds, { type: "project_deleted", projectId });

  res.status(204).end();
});

router.patch("/projects/:id/ready", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const parsed = SetReadyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  if (membership.ready && !parsed.data.ready) {
    res.status(400).json({ error: "You cannot unmark yourself as ready once you have marked ready" });
    return;
  }

  const [updated] = await db
    .update(projectMembersTable)
    .set({ ready: parsed.data.ready })
    .where(
      and(
        eq(projectMembersTable.projectId, projectId),
        eq(projectMembersTable.userId, userId),
      ),
    )
    .returning();

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });

  // Re-check readiness against the just-written state (not the pre-update
  // `membership`/`members` snapshot) — this is the one moment the shared
  // space opens for the whole project, so it's also the one moment
  // duplicate same-name properties proposed by different members collapse
  // into a single merged property. Safe to call every time all members
  // happen to already be ready (e.g. re-fetching this route), since the
  // merge is a no-op once no duplicates remain.
  const membersAfterUpdate = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const nowFullyReady =
    project != null &&
    membersAfterUpdate.length === project.maxMembers &&
    membersAfterUpdate.every((m) => m.ready);
  if (nowFullyReady) {
    await mergeDuplicatePropertiesOnReady(projectId);
    await ensureModeratorIntroMessage(projectId);
  }

  broadcastToProject(projectId, { type: "member_ready" });

  res.json({
    userId,
    username: user?.username ?? "unknown",
    colorSlot: updated?.colorSlot ?? membership.colorSlot,
    ready: updated?.ready ?? membership.ready,
    isOwner: project?.ownerId === userId,
  });
});

router.post("/ws-ticket", async (req, res) => {
  const userId = req.userId!;
  const ticket = issueUserTicket(userId);
  res.json({ ticket });
});

router.post("/projects/:id/ws-ticket", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const ticket = issueTicket(userId, projectId);
  res.json({ ticket });
});

router.get("/projects/:id/export", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  // The Export button click is what permanently freezes AI interventions
  // for this project: the very first time ANYONE successfully hits this
  // route, stamp exportedAt (idempotent -- later calls just re-download
  // the same frozen export). From this point on generateIntervention in
  // moderatorEngine.ts refuses to call the AI again for this project.
  // Mic access, transcript recording, and manually toggling one's own
  // participation on/off are all unaffected -- only the AI intervention
  // API call itself is blocked.
  if (!project.exportedAt) {
    project.exportedAt = new Date();
    await db
      .update(projectsTable)
      .set({ exportedAt: project.exportedAt })
      .where(eq(projectsTable.id, projectId));
    clearModeratorSilenceTimer(projectId);
    // Always recorded (shows up in the conversation-export file either
    // way) -- ModeratorChatPanel's own filter is what keeps it out of the
    // live chat UI for AI-disabled projects.
    await postConsensusReachedMessage(projectId);
  }

  // Full agreement requires every SPECIFIED member to agree, not just
  // however many have joined so far.
  const totalMembers = project.maxMembers;

  const classes = await db.query.ontologyClassesTable.findMany({
    where: eq(ontologyClassesTable.projectId, projectId),
  });
  const {
    propertiesTable,
    propertyAgreementsTable,
    ontologyRelationsTable: relationsTable,
  } = await import("@workspace/db");
  const properties = await db.query.propertiesTable.findMany({
    where: eq(propertiesTable.projectId, projectId),
  });
  const agreements = await db.query.propertyAgreementsTable.findMany();
  const relations = await db.query.ontologyRelationsTable.findMany({
    where: eq(relationsTable.projectId, projectId),
  });

  const agreementCountByProperty = new Map<number, number>();
  for (const agreement of agreements) {
    if (properties.some((p) => p.id === agreement.propertyId)) {
      agreementCountByProperty.set(
        agreement.propertyId,
        (agreementCountByProperty.get(agreement.propertyId) ?? 0) + 1,
      );
    }
  }

  // The hierarchy is represented structurally (nesting), not by a
  // parent-label field: each class's own `children` array holds its direct
  // subclasses, recursively, exactly mirroring the uploaded ontology's
  // rdfs:subClassOf relations. A class can only have one parent per the
  // ontology parser, so every class appears exactly once in the tree —
  // either nested under its parent, or at the top level if it has none.
  const childIdsByParentId = new Map<number, number[]>();
  const childIds = new Set<number>();
  for (const relation of relations) {
    const siblings = childIdsByParentId.get(relation.parentId) ?? [];
    siblings.push(relation.childId);
    childIdsByParentId.set(relation.parentId, siblings);
    childIds.add(relation.childId);
  }
  const classById = new Map(classes.map((c) => [c.id, c]));

  // Fixed, minimal schema: every class's label, only the properties every
  // specified member has actually agreed on for it, and its subclasses
  // nested inside `children` — no project metadata, URIs, or
  // partially-agreed properties leak into the export.
  function buildNode(cls: (typeof classes)[number]): {
    label: string;
    properties: string[];
    children: ReturnType<typeof buildNode>[];
  } {
    return {
      label: cls.label,
      properties: properties
        .filter(
          (p) =>
            p.classId === cls.id &&
            (agreementCountByProperty.get(p.id) ?? 0) >= totalMembers,
        )
        .map((p) => p.name),
      children: (childIdsByParentId.get(cls.id) ?? [])
        .map((id) => classById.get(id))
        .filter((c): c is (typeof classes)[number] => c !== undefined)
        .map(buildNode),
    };
  }

  const exportClasses = classes.filter((c) => !childIds.has(c.id)).map(buildNode);

  // Meta sits alongside `classes`, never inside it — it describes the
  // export file itself (which project, when, how many members it took to
  // reach these agreements), not any individual class, so it stays out of
  // the fixed per-class schema entirely.
  res.json({
    meta: {
      projectName: project.name,
      exportedAt: new Date().toISOString(),
      memberCount: project.maxMembers,
    },
    classes: exportClasses,
  });
});

export default router;
