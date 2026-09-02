import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryFile, MemoryItem, MemorySource, MemoryType } from "./types.ts";

export const MEMORY_PATH = resolve(
  process.env.FORGE_MEMORY_PATH ?? `${process.env.HOME ?? "/tmp"}/.forge/memory.json`,
);

const EMPTY_FILE: MemoryFile = { version: 1, items: [] };

export async function loadMemoryFile(): Promise<MemoryFile> {
  try {
    const text = await readFile(MEMORY_PATH, "utf8");
    const parsed = JSON.parse(text) as Partial<MemoryFile>;
    if (!parsed || typeof parsed !== "object") return EMPTY_FILE;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return { version: 1, items };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_FILE;
    throw err;
  }
}

async function saveMemoryFile(file: MemoryFile): Promise<void> {
  await mkdir(dirname(MEMORY_PATH), { recursive: true });
  const tmp = `${MEMORY_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  await rename(tmp, MEMORY_PATH);
}

export type AddMemoryInput = {
  type: MemoryType;
  content: string;
  source: MemorySource;
  confidence: number;
  keywords: readonly string[];
  taskRefs: readonly string[];
};

export async function addMemory(input: AddMemoryInput): Promise<MemoryItem> {
  const file = await loadMemoryFile();
  const now = Date.now();
  const item: MemoryItem = {
    id: randomUUID(),
    type: input.type,
    content: input.content,
    source: input.source,
    confidence: clampConfidence(input.confidence),
    keywords: dedupeKeywords(input.keywords),
    createdAt: now,
    updatedAt: now,
    taskRefs: [...input.taskRefs],
  };
  const next: MemoryFile = { version: 1, items: [...file.items, item] };
  await saveMemoryFile(next);
  return item;
}

export async function listMemory(): Promise<readonly MemoryItem[]> {
  const file = await loadMemoryFile();
  return file.items;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const file = await loadMemoryFile();
  const next = file.items.filter((it) => it.id !== id);
  if (next.length === file.items.length) return false; // not found
  await saveMemoryFile({ version: 1, items: next });
  return true;
}

export async function clearMemory(): Promise<void> {
  await saveMemoryFile(EMPTY_FILE);
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 100) / 100;
}

function dedupeKeywords(kws: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of kws) {
    const t = k.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

void join;
