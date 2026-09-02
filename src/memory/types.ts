export type MemoryType =
  | "PROJECT_FACT"
  | "DECISION"
  | "FAILURE_PATTERN"
  | "SOLUTION";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "PROJECT_FACT",
  "DECISION",
  "FAILURE_PATTERN",
  "SOLUTION",
];

export type MemorySource =
  | "VERIFICATION"
  | "OBSERVATION"
  | "USER"
  | "REPO";

export const MEMORY_SOURCES: readonly MemorySource[] = [
  "VERIFICATION",
  "OBSERVATION",
  "USER",
  "REPO",
];

export type MemoryItem = {
  id: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  confidence: number;
  keywords: readonly string[];
  createdAt: number;
  updatedAt: number;
  taskRefs: readonly string[];
};

export type MemoryFile = {
  version: 1;
  items: readonly MemoryItem[];
};
