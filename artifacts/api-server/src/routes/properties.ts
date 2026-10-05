import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  ontologyClassesTable,
  MAX_PROJECT_MEMBERS,
  projectMembersTable,
  projectsTable,
  propertiesTable,
  propertyAgreementsTable,
  usersTable,
} from "@workspace/db";
import { CreatePropertyBody, UpdatePropertyBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { broadcastToProject } from "../lib/wsHub";

const router: IRouter = Router();

router.use(requireAuth);

// Each member gets their OWN fixed budget of distinct properties per class,
// based on how many members the project has and this member's join order
// (colorSlot, assigned once at first join and never reassigned — see
// projectMembersTable). Budgets always sum to 7 regardless of member count.
// There is deliberately no shared/global cap and no cross-member duplicate
// check: two members can independently propose the same name for the same
// class, and each one's budget is spent purely on their own distinct
// proposals. Surfaced on GET /projects/:id as each class's `atPropertyCap`
// (computed for the requesting viewer specifically) so the client can hide
// the "add" affordance once THIS member is out of budget for a class.
const PROPERTY_QUOTAS_BY_MEMBER_COUNT: Record<number, number[]> = {
  1: [7],
  2: [4, 3],
  3: [3, 2, 2],
};

// The per-member budgets above always sum to this — it's the total number of
// properties a class can ever hold. Before the shared space opens that total
// is split into fixed per-member slices; once shared, the split goes away
// but the total itself doesn't, so this same number becomes a single
// class-wide cap shared by everyone instead.
const TOTAL_PROPERTY_CAP = 7;

export function getPropertyQuota(memberCount: number, colorSlot: number): number {
  const quotas =
    PROPERTY_QUOTAS_BY_MEMBER_COUNT[memberCount] ??
    PROPERTY_QUOTAS_BY_MEMBER_COUNT[MAX_PROJECT_MEMBERS];
  return quotas[colorSlot] ?? quotas[quotas.length - 1];
}

async function getMembership(projectId: number, userId: number) {
  return db.query.projectMembersTable.findFirst({
    where: and(
      eq(projectMembersTable.projectId, projectId),
      eq(projectMembersTable.userId, userId),
    ),
  });
}

// Marking yourself ready is a one-way commitment (see the `/ready` route —
// it can't be undone): the moment you do, your own private space is locked
// as-is and you can no longer add, rename, or delete your own proposals
// while waiting for the others. This only applies during the private phase
// — once the shared space is open, "your individual space" no longer exists
// as a concept and agree/retract there are ordinary shared-consensus
// actions, not edits to a private space.
async function isOwnSpaceLocked(
  projectId: number,
  membership: { ready: boolean },
): Promise<boolean> {
  if (!membership.ready) return false;
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  return !(await isProjectFullyReady(projectId, members));
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// Duplicate checking is scoped to a single member's own proposals only — by
// design there is no cross-member check, so two different members may
// independently propose the exact same name for the same class and both
// rows stand on their own. If the SAME member proposes (or renames into) a
// name that already matches one of their own existing properties in this
// class, that's treated as a no-op repeat rather than a new property.
async function findMatchingOwnProperty(
  projectId: number,
  classId: number,
  proposedByUserId: number,
  name: string,
  excludePropertyId?: number,
) {
  const normalized = normalizeName(name);
  const candidates = await db.query.propertiesTable.findMany({
    where: and(
      eq(propertiesTable.projectId, projectId),
      eq(propertiesTable.classId, classId),
      eq(propertiesTable.proposedByUserId, proposedByUserId),
    ),
  });
  return candidates.find(
    (p) => p.id !== excludePropertyId && normalizeName(p.name) === normalized,
  );
}

// Same idea as `findMatchingOwnProperty`, but across every proposer — only
// safe to use once the shared space is open (allReady), since before that a
// member must not be able to detect that someone else already proposed the
// same name (that's exactly the private-phase leak `serializePropertyPrivate`
// exists to prevent).
async function findMatchingPropertyAnyProposer(
  projectId: number,
  classId: number,
  name: string,
) {
  const normalized = normalizeName(name);
  const candidates = await db.query.propertiesTable.findMany({
    where: and(eq(propertiesTable.projectId, projectId), eq(propertiesTable.classId, classId)),
  });
  return candidates.find((p) => normalizeName(p.name) === normalized);
}

async function serializeProperty(
  property: typeof propertiesTable.$inferSelect,
  totalMembers: number,
) {
  // Ordered oldest-first (createdAt, then id as a tiebreaker for same-
  // millisecond agreements) since the frontend stacks fills bottom-to-top
  // in exactly this array order — a new agreement is always meant to append
  // at the top and stay there. Without an explicit ORDER BY, Postgres does
  // not guarantee row order is stable across queries, so a freshly added
  // agreement could come back in a different position on the very next
  // fetch (e.g. right after the optimistic write is reconciled), which
  // looked like the new color jumping from the top of the stack to the
  // bottom a moment later.
  const agreements = await db.query.propertyAgreementsTable.findMany({
    where: eq(propertyAgreementsTable.propertyId, property.id),
    orderBy: [asc(propertyAgreementsTable.createdAt), asc(propertyAgreementsTable.id)],
  });
  const users = await db.query.usersTable.findMany();
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, property.projectId),
  });
  const usersById = new Map(users.map((u) => [u.id, u]));
  const membersByUserId = new Map(members.map((m) => [m.userId, m]));

  const proposer = usersById.get(property.proposedByUserId);
  const proposerMembership = membersByUserId.get(property.proposedByUserId);

  return {
    id: property.id,
    classId: property.classId,
    name: property.name,
    proposedByUserId: property.proposedByUserId,
    proposedByUsername: proposer?.username ?? "unknown",
    proposedByColorSlot: proposerMembership?.colorSlot ?? 0,
    createdAt: property.createdAt.toISOString(),
    agreements: agreements.map((a) => ({
      userId: a.userId,
      username: usersById.get(a.userId)?.username ?? "unknown",
      colorSlot: membersByUserId.get(a.userId)?.colorSlot ?? 0,
    })),
    agreedByAll: agreements.length >= totalMembers,
  };
}

// Before everyone in the project is ready, a member must not be able to see
// anything about anyone else's activity on a property — not the real
// proposer, not who else has agreed, not the true agreement count. That
// includes properties that merged in one of your own proposals: from your
// point of view it should look exactly like your own private proposal until
// the shared space opens. This function builds that masked view.
async function serializePropertyPrivate(
  property: typeof propertiesTable.$inferSelect,
  userId: number,
) {
  const viewer = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, userId),
  });
  const viewerMembership = await db.query.projectMembersTable.findFirst({
    where: and(
      eq(projectMembersTable.projectId, property.projectId),
      eq(projectMembersTable.userId, userId),
    ),
  });

  return {
    id: property.id,
    classId: property.classId,
    name: property.name,
    proposedByUserId: userId,
    proposedByUsername: viewer?.username ?? "you",
    proposedByColorSlot: viewerMembership?.colorSlot ?? 0,
    createdAt: property.createdAt.toISOString(),
    agreements: [
      {
        userId,
        username: viewer?.username ?? "you",
        colorSlot: viewerMembership?.colorSlot ?? 0,
      },
    ],
    agreedByAll: false,
  };
}

// Picks the masked or real serialization for a single viewer, consistently
// across every endpoint that can return a property (list, create, rename,
// agree) — so a member never learns about someone else's proposal or
// agreement through an API response before the shared space opens, even if
// their own action happened to merge into that property.
async function getProjectMaxMembers(projectId: number): Promise<number> {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
  });
  return project?.maxMembers ?? MAX_PROJECT_MEMBERS;
}

// The shared space only opens once exactly the SPECIFIED number of members
// (project.maxMembers) have joined and all marked ready — not just however
// many happen to have joined so far. A 1-of-3-expected member being "ready"
// must never flip the whole project into shared mode.
async function isProjectFullyReady(projectId: number, members: (typeof projectMembersTable.$inferSelect)[]) {
  const maxMembers = await getProjectMaxMembers(projectId);
  return members.length === maxMembers && members.every((m) => m.ready);
}

// The moment the shared space opens (every expected member has marked
// ready) is the one point where two members' independently-proposed but
// identically-named properties on the same class stop being separate
// per-member proposals and become a single shared claim — so this runs once
// at that transition and physically merges the duplicate rows: the
// earliest-created one survives as canonical, every other duplicate's
// agreements (plus its own proposer, who implicitly "agrees" by having
// proposed the same thing) are copied onto the canonical row, and the
// duplicate rows are deleted. Cascading FKs take the duplicates' own
// agreement rows with them, so there's no manual cleanup needed there.
// Idempotent: once no class has more than one row per normalized name, this
// is a no-op, so calling it more than once (e.g. if this endpoint is ever
// hit again after the project is already fully ready) is harmless.
export async function mergeDuplicatePropertiesOnReady(projectId: number) {
  const allProperties = await db.query.propertiesTable.findMany({
    where: eq(propertiesTable.projectId, projectId),
  });
  const groups = new Map<string, typeof allProperties>();
  for (const p of allProperties) {
    const key = `${p.classId}::${normalizeName(p.name)}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [canonical, ...duplicates] = [...group].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
    );
    if (!canonical) continue;

    const canonicalAgreements = await db.query.propertyAgreementsTable.findMany({
      where: eq(propertyAgreementsTable.propertyId, canonical.id),
    });
    const alreadyAgreed = new Set(canonicalAgreements.map((a) => a.userId));

    for (const duplicate of duplicates) {
      const duplicateAgreements = await db.query.propertyAgreementsTable.findMany({
        where: eq(propertyAgreementsTable.propertyId, duplicate.id),
      });
      const userIdsToCarryOver = new Set(duplicateAgreements.map((a) => a.userId));
      // The proposer implicitly agrees with their own proposal even on the
      // rare chance their own agreement row is somehow missing.
      userIdsToCarryOver.add(duplicate.proposedByUserId);

      for (const userId of userIdsToCarryOver) {
        if (alreadyAgreed.has(userId)) continue;
        await db
          .insert(propertyAgreementsTable)
          .values({ propertyId: canonical.id, userId })
          .onConflictDoNothing();
        alreadyAgreed.add(userId);
      }

      await db.delete(propertiesTable).where(eq(propertiesTable.id, duplicate.id));
    }
  }
}

async function serializePropertyForViewer(
  property: typeof propertiesTable.$inferSelect,
  userId: number,
  projectId: number,
) {
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const allReady = await isProjectFullyReady(projectId, members);
  return allReady
    ? serializeProperty(property, await getProjectMaxMembers(projectId))
    : serializePropertyPrivate(property, userId);
}

router.get("/projects/:id/properties", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  // The shared consensus space only appears once exactly the project's
  // specified number of members have joined and all marked ready — until
  // then everyone only sees their own proposals.
  const allReady = await isProjectFullyReady(projectId, members);

  const allProperties = await db.query.propertiesTable.findMany({
    where: eq(propertiesTable.projectId, projectId),
  });
  // A property proposed by someone else can still be "yours" if your own
  // proposal merged into it (same name, same class) — you should keep seeing
  // it even before everyone is ready, since it reflects your own action.
  const myAgreements = await db.query.propertyAgreementsTable.findMany({
    where: eq(propertyAgreementsTable.userId, userId),
  });
  const myAgreedPropertyIds = new Set(myAgreements.map((a) => a.propertyId));
  const visible = allProperties.filter(
    (p) => p.proposedByUserId === userId || myAgreedPropertyIds.has(p.id) || allReady,
  );

  const maxMembers = await getProjectMaxMembers(projectId);
  const serialized = await Promise.all(
    visible.map((p) =>
      allReady ? serializeProperty(p, maxMembers) : serializePropertyPrivate(p, userId),
    ),
  );
  res.json(serialized);
});

router.post("/projects/:id/properties", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }
  if (await isOwnSpaceLocked(projectId, membership)) {
    res.status(403).json({ error: "You marked yourself ready, so you can no longer add properties" });
    return;
  }

  const parsed = CreatePropertyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const cls = await db.query.ontologyClassesTable.findFirst({
    where: and(
      eq(ontologyClassesTable.id, parsed.data.classId),
      eq(ontologyClassesTable.projectId, projectId),
    ),
  });
  if (!cls) {
    res.status(400).json({ error: "Class not found in this project" });
    return;
  }

  const trimmedName = parsed.data.name.trim();

  // Re-proposing a name you've already used for this class is a no-op: the
  // repeat is silently dropped (no new row, no error) and the existing one
  // is returned as-is — there's no cross-member check here at all, so this
  // never looks at anyone else's properties.
  const ownDuplicate = await findMatchingOwnProperty(
    projectId,
    parsed.data.classId,
    userId,
    trimmedName,
  );
  if (ownDuplicate) {
    const result = await serializePropertyForViewer(ownDuplicate, userId, projectId);
    res.status(200).json(result);
    return;
  }

  // Once the shared space is open, proposing a name someone else already
  // proposed for this class is the exact same "already claimed" situation
  // as the own-duplicate case above — it must merge into that existing
  // property (just add your own agreement to it) instead of creating a
  // second competing row, the same way `mergeDuplicatePropertiesOnReady`
  // collapses names that collided BEFORE the space opened. This has to
  // check every proposer, not just your own, which is only safe to do once
  // `allReady` — before that, checking anyone else's names at all would
  // leak who proposed what ahead of the private-phase reveal. Merging
  // doesn't spend any of your own propose quota, since it's not a new
  // property.
  const membersForReadyCheck = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const isSharedSpaceOpen = await isProjectFullyReady(projectId, membersForReadyCheck);
  if (isSharedSpaceOpen) {
    const crossMemberMatch = await findMatchingPropertyAnyProposer(
      projectId,
      parsed.data.classId,
      trimmedName,
    );
    if (crossMemberMatch) {
      const alreadyAgreed = await db.query.propertyAgreementsTable.findFirst({
        where: and(
          eq(propertyAgreementsTable.propertyId, crossMemberMatch.id),
          eq(propertyAgreementsTable.userId, userId),
        ),
      });
      if (!alreadyAgreed) {
        await db
          .insert(propertyAgreementsTable)
          .values({ propertyId: crossMemberMatch.id, userId })
          .onConflictDoNothing();
        broadcastToProject(projectId, { type: "agreement_changed" });
      }
      const result = await serializePropertyForViewer(crossMemberMatch, userId, projectId);
      res.status(200).json(result);
      return;
    }
  }

  // Two different caps apply depending on phase:
  // - Before the shared space opens, each member is limited to their own
  //   fixed per-member budget (see PROPERTY_QUOTAS_BY_MEMBER_COUNT), which
  //   keeps things fair while no one can see anyone else's proposals.
  // - Once shared, the per-member split no longer makes sense (proposals are
  //   visible to everyone and same-name ones merge instead of competing —
  //   see above), but the class as a whole is still capped at the same
  //   TOTAL_PROPERTY_CAP of 7 properties every project has always budgeted
  //   for that class, shared collectively across all members now instead of
  //   split into fixed per-member slices. A merge (cross-member match above)
  //   never reaches this check, since it doesn't create a new row.
  if (isSharedSpaceOpen) {
    const classTotalCount = await db.query.propertiesTable.findMany({
      where: and(
        eq(propertiesTable.projectId, projectId),
        eq(propertiesTable.classId, parsed.data.classId),
      ),
    });
    if (classTotalCount.length >= TOTAL_PROPERTY_CAP) {
      res
        .status(400)
        .json({ error: `This class has reached its limit of ${TOTAL_PROPERTY_CAP} properties` });
      return;
    }
  } else {
    const myExistingCount = await db.query.propertiesTable.findMany({
      where: and(
        eq(propertiesTable.projectId, projectId),
        eq(propertiesTable.classId, parsed.data.classId),
        eq(propertiesTable.proposedByUserId, userId),
      ),
    });
    const quota = getPropertyQuota(await getProjectMaxMembers(projectId), membership.colorSlot);
    if (myExistingCount.length >= quota) {
      res
        .status(400)
        .json({ error: `You've reached your limit of ${quota} propert${quota === 1 ? "y" : "ies"} for this class` });
      return;
    }
  }

  const [property] = await db
    .insert(propertiesTable)
    .values({
      projectId,
      classId: parsed.data.classId,
      name: trimmedName,
      proposedByUserId: userId,
    })
    .returning();
  if (!property) {
    res.status(500).json({ error: "Failed to create property" });
    return;
  }

  await db
    .insert(propertyAgreementsTable)
    .values({ propertyId: property.id, userId });

  const result = await serializePropertyForViewer(property, userId, projectId);

  broadcastToProject(projectId, { type: "property_created" });

  res.status(201).json(result);
});

router.patch("/projects/:id/properties/:propertyId", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const propertyId = Number(req.params.propertyId);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }
  if (await isOwnSpaceLocked(projectId, membership)) {
    res.status(403).json({ error: "You marked yourself ready, so you can no longer edit properties" });
    return;
  }

  const parsed = UpdatePropertyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const property = await db.query.propertiesTable.findFirst({
    where: and(eq(propertiesTable.id, propertyId), eq(propertiesTable.projectId, projectId)),
  });
  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }
  if (property.proposedByUserId !== userId) {
    res.status(403).json({ error: "You can only edit your own property" });
    return;
  }

  const trimmedName = parsed.data.name.trim();

  const existingMatch = await findMatchingOwnProperty(
    projectId,
    property.classId,
    userId,
    trimmedName,
    property.id,
  );
  if (existingMatch) {
    // Renaming into a name you've already used elsewhere in this class
    // merges the two: fold this property's agreements into the matching
    // one and drop the duplicate. Still scoped to your own properties only
    // — this never looks at another member's proposals.
    const existingAgreements = await db.query.propertyAgreementsTable.findMany({
      where: eq(propertyAgreementsTable.propertyId, propertyId),
    });
    for (const agreement of existingAgreements) {
      const already = await db.query.propertyAgreementsTable.findFirst({
        where: and(
          eq(propertyAgreementsTable.propertyId, existingMatch.id),
          eq(propertyAgreementsTable.userId, agreement.userId),
        ),
      });
      if (!already) {
        await db
          .insert(propertyAgreementsTable)
          .values({ propertyId: existingMatch.id, userId: agreement.userId });
      }
    }
    await db
      .delete(propertyAgreementsTable)
      .where(eq(propertyAgreementsTable.propertyId, propertyId));
    await db.delete(propertiesTable).where(eq(propertiesTable.id, propertyId));

    const result = await serializePropertyForViewer(existingMatch, userId, projectId);
    broadcastToProject(projectId, { type: "property_deleted" });
    broadcastToProject(projectId, { type: "agreement_changed" });
    res.json(result);
    return;
  }

  const [updated] = await db
    .update(propertiesTable)
    .set({ name: trimmedName })
    .where(eq(propertiesTable.id, propertyId))
    .returning();

  const result = await serializePropertyForViewer(updated ?? property, userId, projectId);

  broadcastToProject(projectId, { type: "property_updated" });

  res.json(result);
});

router.delete("/projects/:id/properties/:propertyId", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const propertyId = Number(req.params.propertyId);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }
  if (await isOwnSpaceLocked(projectId, membership)) {
    res.status(403).json({ error: "You marked yourself ready, so you can no longer remove properties" });
    return;
  }

  const property = await db.query.propertiesTable.findFirst({
    where: and(eq(propertiesTable.id, propertyId), eq(propertiesTable.projectId, projectId)),
  });
  if (!property) {
    res.status(204).end();
    return;
  }

  await db
    .delete(propertyAgreementsTable)
    .where(
      and(
        eq(propertyAgreementsTable.propertyId, propertyId),
        eq(propertyAgreementsTable.userId, userId),
      ),
    );

  const remaining = await db.query.propertyAgreementsTable.findMany({
    where: eq(propertyAgreementsTable.propertyId, propertyId),
  });
  if (remaining.length === 0) {
    await db.delete(propertiesTable).where(eq(propertiesTable.id, propertyId));
  }

  broadcastToProject(projectId, { type: "property_deleted" });

  res.status(204).end();
});

router.post("/projects/:id/properties/:propertyId/agree", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const propertyId = Number(req.params.propertyId);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const property = await db.query.propertiesTable.findFirst({
    where: and(eq(propertiesTable.id, propertyId), eq(propertiesTable.projectId, projectId)),
  });
  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }

  const existing = await db.query.propertyAgreementsTable.findFirst({
    where: and(
      eq(propertyAgreementsTable.propertyId, propertyId),
      eq(propertyAgreementsTable.userId, userId),
    ),
  });
  if (!existing) {
    await db.insert(propertyAgreementsTable).values({ propertyId, userId });
  }

  const result = await serializePropertyForViewer(property, userId, projectId);

  broadcastToProject(projectId, { type: "agreement_changed" });

  res.json(result);
});

export default router;
