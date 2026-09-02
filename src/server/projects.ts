import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number;
};

export type ProjectsFile = {
  version: 1;
  activeProjectId: string | null;
  projects: readonly ProjectRecord[];
};

const EMPTY: ProjectsFile = { version: 1, activeProjectId: null, projects: [] };

export class ProjectsRegistry {
  private filePath: string;

  constructor(forgeHome: string) {
    this.filePath = join(forgeHome, "projects.json");
  }

  private async load(): Promise<ProjectsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
      if (!parsed || typeof parsed !== "object") return EMPTY;
      return {
        version: 1,
        activeProjectId: typeof parsed.activeProjectId === "string" ? parsed.activeProjectId : null,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      throw err;
    }
  }

  private async save(file: ProjectsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    await rename(tmp, this.filePath);
  }

  async register(input: { path: string; name?: string }): Promise<ProjectRecord> {
    if (!input.path || !input.path.startsWith("/")) {
      throw new Error("project path must be absolute");
    }
    let pathStat;
    try {
      pathStat = await stat(input.path);
    } catch {
      throw new Error(`project path does not exist: ${input.path}`);
    }
    if (!pathStat.isDirectory()) {
      throw new Error(`project path is not a directory: ${input.path}`);
    }

    const file = await this.load();
    const existing = file.projects.find((p) => p.path === input.path);
    if (existing) {
      const touched: ProjectRecord = { ...existing, lastOpenedAt: Date.now() };
      await this.save({
        ...file,
        activeProjectId: touched.id,
        projects: file.projects.map((p) => (p.id === touched.id ? touched : p)),
      });
      return touched;
    }

    const now = Date.now();
    const project: ProjectRecord = {
      id: `prj_${randomUUID().slice(0, 8)}`,
      name: input.name?.trim() || input.path.split("/").filter(Boolean).pop() || input.path,
      path: input.path,
      createdAt: now,
      lastOpenedAt: now,
    };
    const next: ProjectsFile = {
      version: 1,
      activeProjectId: project.id,
      projects: [...file.projects, project],
    };
    await this.save(next);
    return project;
  }

  async list(): Promise<{ projects: readonly ProjectRecord[]; activeProjectId: string | null }> {
    const file = await this.load();
    return { projects: file.projects, activeProjectId: file.activeProjectId };
  }

  async select(id: string): Promise<ProjectRecord> {
    const file = await this.load();
    const target = file.projects.find((p) => p.id === id);
    if (!target) throw new Error(`no such project: ${id}`);
    const touched: ProjectRecord = { ...target, lastOpenedAt: Date.now() };
    await this.save({
      ...file,
      activeProjectId: touched.id,
      projects: file.projects.map((p) => (p.id === touched.id ? touched : p)),
    });
    return touched;
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const file = await this.load();
    return file.projects.find((p) => p.id === id) ?? null;
  }

  async active(): Promise<ProjectRecord | null> {
    const file = await this.load();
    if (!file.activeProjectId) return null;
    return file.projects.find((p) => p.id === file.activeProjectId) ?? null;
  }
}
