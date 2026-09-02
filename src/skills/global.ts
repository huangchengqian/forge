import { SkillRegistry } from "./registry.ts";
import { FILE_CREATION_SKILL, TYPESCRIPT_PROJECT_SKILL, BUG_FIX_SKILL } from "./built-in.ts";

let singleton: SkillRegistry | null = null;

export function getGlobalSkillRegistry(): SkillRegistry {
  if (singleton) return singleton;
  const reg = new SkillRegistry();
  reg.register(FILE_CREATION_SKILL);
  reg.register(TYPESCRIPT_PROJECT_SKILL);
  reg.register(BUG_FIX_SKILL);
  singleton = reg;
  return singleton;
}

export function resetGlobalSkillRegistry(): void {
  singleton = null;
}
