import { NextResponse } from "next/server";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed } from "@/lib/file-access";

const execAsync = promisify(exec);

// POST /api/terminal  body: { cwd, cmd } → { exitCode, stdout, stderr }
// One-shot shell execution inside the agent workspace (no PTY). cwd is
// validated against the allowed file roots; the command itself runs as the
// shell would — this is a terminal by design, so no injection filtering.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { cwd?: string; cmd?: string } | null;
  const { cwd, cmd } = body ?? {};
  if (!cwd || typeof cwd !== "string" || !cmd || typeof cmd !== "string" || !cmd.trim()) {
    return NextResponse.json({ error: "cwd and cmd are required" }, { status: 400 });
  }
  const roots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, roots) || !isExistingFilePathAllowed(cwd, roots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return NextResponse.json({ exitCode: 0, stdout, stderr });
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return NextResponse.json({
      exitCode: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (err.killed ? "Command timed out" : String(e)),
    });
  }
}
