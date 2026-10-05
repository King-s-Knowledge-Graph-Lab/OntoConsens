import { integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ontologyClassesTable } from "./ontology";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

export const propertiesTable = pgTable("properties", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  classId: integer("class_id")
    .notNull()
    .references(() => ontologyClassesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  proposedByUserId: integer("proposed_by_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertPropertySchema = createInsertSchema(propertiesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type Property = typeof propertiesTable.$inferSelect;

export const propertyAgreementsTable = pgTable(
  "property_agreements",
  {
    id: serial("id").primaryKey(),
    propertyId: integer("property_id")
      .notNull()
      .references(() => propertiesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.propertyId, table.userId)],
);

export const insertPropertyAgreementSchema = createInsertSchema(
  propertyAgreementsTable,
).omit({ id: true, createdAt: true });
export type InsertPropertyAgreement = z.infer<
  typeof insertPropertyAgreementSchema
>;
export type PropertyAgreement = typeof propertyAgreementsTable.$inferSelect;
