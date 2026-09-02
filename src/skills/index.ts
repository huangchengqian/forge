export type { Skill, SkillMatch } from "./types.ts";
export { SkillRegistry } from "./registry.ts";
export type { MatchOptions } from "./registry.ts";
export {
  FILE_CREATION_SKILL,
  TYPESCRIPT_PROJECT_SKILL,
  BUG_FIX_SKILL,
} from "./built-in.ts";
export { getGlobalSkillRegistry } from "./global.ts";
