import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const ontologyClassesTable = pgTable("ontology_classes", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  uri: text("uri").notNull(),
  label: text("label").notNull(),
});

export const insertOntologyClassSchema = createInsertSchema(
  ontologyClassesTable,
).omit({ id: true });
export type InsertOntologyClass = z.infer<typeof insertOntologyClassSchema>;
export type OntologyClass = typeof ontologyClassesTable.$inferSelect;

export const ontologyRelationsTable = pgTable("ontology_relations", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  childId: integer("child_id")
    .notNull()
    .references(() => ontologyClassesTable.id, { onDelete: "cascade" }),
  parentId: integer("parent_id")
    .notNull()
    .references(() => ontologyClassesTable.id, { onDelete: "cascade" }),
});

export const insertOntologyRelationSchema = createInsertSchema(
  ontologyRelationsTable,
).omit({ id: true });
export type InsertOntologyRelation = z.infer<
  typeof insertOntologyRelationSchema
>;
export type OntologyRelation = typeof ontologyRelationsTable.$inferSelect;
