export type FixtureFile = { path: string; content: string };

/**
 * Isolated sample project used as the starting state for every golden task.
 * Embedded inline so benchmarks never touch real user repositories.
 */
export const SAMPLE_PROJECT: readonly FixtureFile[] = [
  {
    path: "package.json",
    content: '{\n  "name": "sample-project",\n  "version": "1.0.0"\n}\n',
  },
  {
    path: "tsconfig.json",
    content: '{\n  "compilerOptions": {\n    "strict": true,\n    "target": "es2022"\n  }\n}\n',
  },
  {
    path: "src/calc.ts",
    content:
      'export function add(a: number, b: number): number {\n  return a - b;\n}\n',
  },
  {
    path: "README.md",
    content: '# sample-project\n\nFixture repository for Forge benchmarks.\n',
  },
];
