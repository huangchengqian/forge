import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname, extname } from "node:path";

const ROOT = process.cwd();
const SCAN = ["src", "desktop/src"];
const EXTS = [".ts", ".tsx"];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      walk(p, out);
    } else if (EXTS.includes(extname(e))) out.push(p);
  }
  return out;
}

const files = SCAN.filter(existsSync).flatMap((d) => walk(join(ROOT, d)));

const importRe = /(?:^|[^.\w])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const resolveSpec = (from, spec) => {
  if (!spec.startsWith(".")) return null; // bare / node: → external
  const base = resolve(dirname(from), spec);
  const cands = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const noJs = base.replace(/\.js$/, ".ts");
  cands.push(noJs, noJs.replace(/\.ts$/, ".tsx"));
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return `UNRESOLVED:${base}`;
};

const edges = new Map(); // file -> Set(dep)
const unresolved = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const deps = new Set();
  for (const re of [importRe, dynRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const r = resolveSpec(f, m[1]);
      if (r === null) continue;
      if (r.startsWith("UNRESOLVED:")) unresolved.push(`${relative(ROOT, f)} -> ${m[1]}`);
      else deps.add(r);
    }
  }
  edges.set(f, deps);
}

const isTest = (f) => /\.test\.tsx?$/.test(f);
const isSmoke = (f) => /src\/cli\/(smoke|real-)[^/]*\.ts$/.test(f) || /src\/cli\/benchmark\.ts$/.test(f);
const PROD_ROOTS = ["src/cli/serve.ts", "desktop/src/main.tsx"].map((p) => join(ROOT, p)).filter(existsSync);
const TEST_ROOTS = files.filter((f) => isTest(f) || isSmoke(f));
const DEV_ROOTS = ["desktop/src/preview.tsx"].map((p) => join(ROOT, p)).filter(existsSync);

function reach(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of edges.get(f) ?? []) stack.push(d);
  }
  return seen;
}

const fromProd = reach(PROD_ROOTS);
const fromTest = reach(TEST_ROOTS);
const fromDev = reach(DEV_ROOTS);

const inDeg = new Map(files.map((f) => [f, 0]));
for (const [, deps] of edges) for (const d of deps) if (inDeg.has(d)) inDeg.set(d, inDeg.get(d) + 1);

const loc = (f) => readFileSync(f, "utf8").split("\n").length;
const rel = (f) => relative(ROOT, f);

const dead = files.filter((f) => !fromProd.has(f) && !fromTest.has(f) && !fromDev.has(f));
const testOnly = files.filter((f) => !fromProd.has(f) && fromTest.has(f));
const devOnly = files.filter((f) => !fromProd.has(f) && !fromTest.has(f) && fromDev.has(f));

console.log(`扫描 ${files.length} 文件 / ${files.reduce((n, f) => n + loc(f), 0)} 行`);
console.log(`入口: prod=${PROD_ROOTS.length} test=${TEST_ROOTS.length} dev=${DEV_ROOTS.length}`);
console.log(`可达: prod=${fromProd.size} (prod∪test∪dev)=${new Set([...fromProd, ...fromTest, ...fromDev]).size}`);
console.log(`无法解析的相对导入: ${unresolved.length}${unresolved.length ? "\n  " + unresolved.join("\n  ") : ""}`);

const dump = (title, list) => {
  console.log(`\n===== ${title} (${list.length}) =====`);
  for (const f of list.sort((a, b) => loc(b) - loc(a))) {
    console.log(`  ${String(loc(f)).padStart(5)} 行  ind=${inDeg.get(f)}  ${rel(f)}`);
  }
};
dump("死代码：prod/test/dev 都到不了", dead);
dump("仅测试可达（生产路径用不到）", testOnly);
dump("仅开发预览可达", devOnly);

const neverImported = files.filter((f) => inDeg.get(f) === 0);
console.log(`\n===== 零入度（没有任何文件 import 它）=====`);
for (const f of neverImported) console.log(`  ${rel(f)}`);
