import path from "node:path";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { decryptApiKey } from "./moderatorCrypto";

export interface ParsedClass {
  uri: string;
  label: string;
}

export interface ParsedRelation {
  childUri: string;
  parentUri: string;
}

export interface ParsedOntology {
  classes: ParsedClass[];
  relations: ParsedRelation[];
}

// Project creation happens before a project (and therefore a
// project_moderator row with its own model choice) exists, so there's no
// per-project setting to read yet -- this mirrors that table's own default
// model id (see lib/db schema/moderator.ts) purely for consistency.
const ONTOLOGY_EXTRACTION_MODEL = "gpt-5.6-terra";

export async function getUserApiKey(userId: number): Promise<string | null> {
  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
  if (!user?.openaiApiKeyEncrypted || !user.openaiApiKeyIv || !user.openaiApiKeyAuthTag) return null;
  try {
    return decryptApiKey({
      encryptedApiKey: user.openaiApiKeyEncrypted,
      apiKeyIv: user.openaiApiKeyIv,
      apiKeyAuthTag: user.openaiApiKeyAuthTag,
    });
  } catch {
    return null;
  }
}

const TEXT_LIKE_EXTENSIONS = new Set([
  ".ttl", ".owl", ".rdf", ".xml", ".txt", ".json", ".jsonld", ".csv", ".tsv",
  ".md", ".markdown", ".n3", ".nt", ".nq", ".trig", ".yaml", ".yml", ".html", ".htm",
]);
const BINARY_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// The OpenAI Responses API (used for anything that isn't plain text --
// PDFs, images, office documents, etc.) needs to know which of its two
// native file-input content types to use for a given upload. Everything
// else that reaches the file-input path is treated as a generic document.
function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

// Whether this upload's content can just be decoded and pasted into a
// normal chat prompt as text, vs. needing OpenAI's own native file
// ingestion (Files API + Responses API) because it's some binary format
// only OpenAI itself knows how to read. Known extensions decide it outright;
// for anything unrecognized, sample the bytes and guess -- null bytes or a
// high proportion of non-printable control characters mean it's binary.
function looksTextLike(filename: string, buffer: Buffer): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_LIKE_EXTENSIONS.has(ext)) return true;
  if (BINARY_EXTENSIONS.has(ext)) return false;

  const sample = buffer.subarray(0, 4096);
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

const EXTRACTION_INSTRUCTIONS =
  "You are extracting a CLASS HIERARCHY (an ontology's classes and subclass-of relationships) from the " +
  "material provided. Identify every distinct CLASS (a concept or category, not a specific instance/individual, " +
  "not an attribute/property, not a relation other than subclass-of). Then identify every SUBCLASS-OF " +
  "relationship: which classes are a more specific kind of which other class. " +
  "Respond with ONLY a single JSON object, no commentary, no markdown code fences, of exactly this shape: " +
  '{"classes": [{"id": "short_stable_slug", "label": "Human Readable Name"}], ' +
  '"relations": [{"child": "<id of the more specific subclass>", "parent": "<id of the more general class>"}]}. ' +
  "Every id used in \"relations\" must also appear in \"classes\". Use short, stable, lowercase slug ids " +
  "(letters/digits/underscores only) generated from each class's label. Do not include instances, properties, " +
  "or any relation type other than subclass-of. Each class's \"label\" must be plain, space-separated words " +
  "(e.g. \"Postgraduate Student\") -- never a concatenated naming style such as camelCase " +
  "(\"PostgraduateStudent\"), underscore-joined (\"Postgraduate_Student\"), hyphen-joined " +
  "(\"Postgraduate-Student\"), or any other joined-without-spaces form, even if the source material names it " +
  "that way. If nothing resembling a class hierarchy is present, respond with {\"classes\": [], \"relations\": []}.";

interface RawAiOntology {
  classes?: { id?: unknown; label?: unknown }[];
  relations?: { child?: unknown; parent?: unknown }[];
}

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
}

async function extractFromText(apiKey: string, content: string): Promise<RawAiOntology> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ONTOLOGY_EXTRACTION_MODEL,
      messages: [
        { role: "system", content: EXTRACTION_INSTRUCTIONS },
        { role: "user", content },
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
    return JSON.parse(stripCodeFence(rawContent));
  } catch {
    throw new Error("Could not understand the AI's analysis of the uploaded file.");
  }
}

async function uploadFileToOpenAi(apiKey: string, filename: string, buffer: Buffer, mimeType: string | undefined): Promise<string> {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType || "application/octet-stream" }), filename);
  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body && typeof body === "object" && "error" in body && (body as any).error?.message) ||
      `OpenAI file upload failed with status ${response.status}`;
    throw new Error(message);
  }
  const data = (await response.json()) as { id?: string };
  if (!data.id) throw new Error("OpenAI did not return a file id for the upload.");
  return data.id;
}

function extractResponsesOutputText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
          return part.text;
        }
      }
    }
  }
  throw new Error("OpenAI returned an empty response.");
}

async function extractFromFile(apiKey: string, filename: string, buffer: Buffer, mimeType: string | undefined): Promise<RawAiOntology> {
  const fileId = await uploadFileToOpenAi(apiKey, filename, buffer, mimeType);
  const contentPart = isImageFile(filename)
    ? { type: "input_image", file_id: fileId }
    : { type: "input_file", file_id: fileId };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ONTOLOGY_EXTRACTION_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: EXTRACTION_INSTRUCTIONS },
            contentPart,
          ],
        },
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
  const data = await response.json();
  const rawText = extractResponsesOutputText(data);
  try {
    return JSON.parse(stripCodeFence(rawText));
  } catch {
    throw new Error("Could not understand the AI's analysis of the uploaded file.");
  }
}

// Slugs are generated by the model itself and aren't guaranteed unique or
// well-formed -- normalize defensively rather than trusting them, and drop
// anything that doesn't look like a real class before it ever reaches the
// connected-components filter below.
function normalizeAiOntology(raw: RawAiOntology): ParsedOntology {
  const seenIds = new Set<string>();
  const classes: ParsedClass[] = [];
  for (const entry of raw.classes ?? []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    if (!id || !label || seenIds.has(id)) continue;
    seenIds.add(id);
    classes.push({ uri: `ai:${id}`, label });
  }

  const relations: ParsedRelation[] = [];
  const seenRelations = new Set<string>();
  for (const entry of raw.relations ?? []) {
    const child = typeof entry?.child === "string" ? entry.child.trim() : "";
    const parent = typeof entry?.parent === "string" ? entry.parent.trim() : "";
    if (!child || !parent || child === parent) continue;
    if (!seenIds.has(child) || !seenIds.has(parent)) continue;
    const key = `${child}\u0000${parent}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key);
    relations.push({ childUri: `ai:${child}`, parentUri: `ai:${parent}` });
  }

  return { classes, relations };
}

// Keeps only the largest connected component of the class graph (treating
// subclass-of edges as undirected for connectivity purposes) so the
// resulting workspace is a single coherent hierarchy instead of several
// unrelated fragments -- any class that's isolated, or only connected to a
// smaller cluster, is discarded along with the relations that touch it.
export function keepLargestConnectedComponent(ontology: ParsedOntology): ParsedOntology {
  if (ontology.classes.length <= 1) return ontology;

  const parent = new Map<string, string>();
  for (const cls of ontology.classes) parent.set(cls.uri, cls.uri);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const rel of ontology.relations) {
    if (parent.has(rel.childUri) && parent.has(rel.parentUri)) {
      union(rel.childUri, rel.parentUri);
    }
  }

  const sizeByRoot = new Map<string, number>();
  for (const cls of ontology.classes) {
    const root = find(cls.uri);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }

  // First-encountered root wins ties, keeping the result deterministic.
  let bestRoot: string | null = null;
  let bestSize = 0;
  for (const cls of ontology.classes) {
    const root = find(cls.uri);
    const size = sizeByRoot.get(root)!;
    if (size > bestSize) {
      bestSize = size;
      bestRoot = root;
    }
  }
  if (bestRoot === null) return ontology;

  const keep = new Set(ontology.classes.filter((c) => find(c.uri) === bestRoot).map((c) => c.uri));
  return {
    classes: ontology.classes.filter((c) => keep.has(c.uri)),
    relations: ontology.relations.filter((r) => keep.has(r.childUri) && keep.has(r.parentUri)),
  };
}

export async function extractOntologyWithAI(
  apiKey: string,
  filename: string,
  buffer: Buffer,
  mimeType: string | undefined,
): Promise<ParsedOntology> {
  const raw = looksTextLike(filename, buffer)
    ? await extractFromText(apiKey, buffer.toString("utf-8"))
    : await extractFromFile(apiKey, filename, buffer, mimeType);
  const ontology = normalizeAiOntology(raw);
  return keepLargestConnectedComponent(ontology);
}
