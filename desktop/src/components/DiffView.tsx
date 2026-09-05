/** Parse and render a unified diff (git style) with per-file, per-line coloring. */

export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk"; oldNo: number | null; newNo: number | null; text: string };
export type DiffFile = { path: string; oldPath: string; lines: DiffLine[]; adds: number; dels: number; binary: boolean };

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  // Line numbers are corrected by the first @@ hunk header; start at 1 so
  // synthesized diffs (no hunks) number naturally.
  let oldNo = 1;
  let newNo = 1;

  const flush = () => {
    if (cur) files.push(cur);
    cur = null;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      flush();
      cur = { path: "", oldPath: "", lines: [], adds: 0, dels: 0, binary: false };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("--- ")) {
      cur.oldPath = cleanPath(raw.slice(4));
    } else if (raw.startsWith("+++ ")) {
      cur.path = cleanPath(raw.slice(4));
    } else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      cur.binary = true;
    } else if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      cur.lines.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
      cur.adds++;
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
      cur.dels++;
    } else if (raw.startsWith(" ") || raw === "") {
      cur.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    }
    // other headers (index, ---, +++, @@ handled; \ No newline etc. ignored)
  }
  flush();
  return files;
}

function cleanPath(p: string): string {
  return p.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

/** Render parsed diff files. Falls back to a plain <pre> for anything unparsable. */
export function DiffView({ diff }: { diff: string }) {
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) return <pre className="diff-raw">{diff}</pre>;
  return (
    <div>
      {files.map((f, i) => (
        <div className="diff-file" key={i}>
          <div className="diff-file-header">
            <span>{f.path || f.oldPath || "(unknown file)"}</span>
            {!f.binary && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span className="diff-stat-add">+{f.adds}</span>{" "}
                <span className="diff-stat-del">−{f.dels}</span>
              </span>
            )}
          </div>
          {f.binary ? (
            <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--text-muted)" }}>Binary file</div>
          ) : (
            <div className="diff-file-body">
              {f.lines.map((l, j) => (
                <div className={`diff-line ${l.kind}`} key={j}>
                  <span className="ln">{l.oldNo ?? l.newNo ?? ""}</span>
                  <span>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
