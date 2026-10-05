import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const MAX_PROJECT_MEMBERS = 3;

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  inviteCode: text("invite_code").notNull().unique(),
  // Chosen by the creator at project setup and fixed afterward — this is
  // the exact number of members the project is FOR (1-3), not just an
  // upper bound. Joining is capped at this number, the shared consensus
  // space only opens once exactly this many members have all marked ready
  // (not just however many happen to have joined), and each member's
  // private property budget is computed from this number from the very
  // start, not from however many members are currently in the project.
  // Defaults to the historical global cap for rows created before this
  // column existed.
  maxMembers: integer("max_members").notNull().default(MAX_PROJECT_MEMBERS),
  // Chosen by the creator at project setup and fixed afterward -- there is
  // no route to toggle this later. The AI moderator itself keeps running in
  // the background either way (it still listens, transcribes, and
  // generates interventions); this only controls whether its "intro" and
  // "intervention" messages are ever rendered in the live chat window for
  // this project. Defaults to true both for the column default and for rows
  // created before this setting existed, matching prior behavior.
  moderatorEnabled: boolean("moderator_enabled").notNull().default(true),
  // Set exactly once, the moment any member successfully downloads the
  // ontology export (see GET /projects/:id/export) -- this is the
  // project's permanent "consensus reached" marker. From this point on the
  // AI moderator must never run again for this project (no new mic
  // sessions, transcript chunks, or interventions -- see moderatorEngine.ts
  // and wsHub.ts's mic_start handling, which all check this column), and
  // the conversation displayed to members is exactly the history frozen at
  // this instant. Null means the project hasn't been exported yet.
  exportedAt: timestamp("exported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;

export const projectMembersTable = pgTable(
  "project_members",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    colorSlot: integer("color_slot").notNull(),
    ready: boolean("ready").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.projectId, table.userId)],
);

export const insertProjectMemberSchema = createInsertSchema(
  projectMembersTable,
).omit({ id: true, joinedAt: true });
export type InsertProjectMember = z.infer<typeof insertProjectMemberSchema>;
export type ProjectMember = typeof projectMembersTable.$inferSelect;
