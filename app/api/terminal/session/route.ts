import { NextResponse } from "next/server";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

// Python PTY bridge: forks a PTY, execs bash in `cwd`, forwards PTY output to
// stdout and stdin to the PTY. Control messages (resize) arrive on fd 3 as
// newline-delimited JSON. Embedded so it ships inside the .next bundle.
const PTY_BRIDGE_PY = String.raw`
import pty, os, sys, select, struct, fcntl, termios, signal, time

cwd, cols, rows, infile = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
os.chdir(cwd)

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    # --noediting: bash's readline silently drops rapid-typed submissions
    # (line echoed, never executed, output missing). Without readline the
    # shell uses the tty's canonical line mode, which submits any complete
    # line regardless of write chunking. Interactive apps (pi/vim) manage
    # their own raw mode and are unaffected.
    os.execvp("bash", ["bash", "--noediting"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

# Input arrives through a temp file the node side appends to (POST). The
# node->python stdin pipe races with the pty fd under rapid typing, so poll
# the file instead. Bytes are written in order; a CR is written alone after a
# short pause so the canonical line mode submits the pending line cleanly.
def read_input():
    try:
        size = os.path.getsize(infile)
    except OSError:
        return
    if size <= read_input.pos:
        return
    with open(infile, "rb") as f:
        f.seek(read_input.pos)
        data = f.read()
        read_input.pos = f.tell()
    chunks = data.split(b"\r")
    for i, c in enumerate(chunks):
        for b in c:
            os.write(fd, bytes([b]))
        if i < len(chunks) - 1:
            # Brief pause before the CR so the shell digests the command text
            # first (rapid writes can otherwise drop the submission).
            time.sleep(0.15)
            os.write(fd, b"\r")

read_input.pos = 0

ctrl = os.fdopen(3, "rb", buffering=0)

def resize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    os.kill(pid, signal.SIGWINCH)

ctrl_buf = b""
while True:
    rl, _, _ = select.select([fd, ctrl], [], [], 0.05)
    for s in rl:
        if s == fd:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                sys.exit(0)
            os.write(1, __import__("base64").b64encode(data) + b"\n")
        elif s == ctrl:
            ctrl_buf += ctrl.read(4096)
            while b"\n" in ctrl_buf:
                line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                try:
                    msg = __import__("json").loads(line)
                    if msg.get("type") == "resize":
                        resize(int(msg["cols"]), int(msg["rows"]))
                except Exception:
                    pass
    read_input()
`;

// In-memory session registry. Single-process next start keeps this stable;
// the platform runs one pi-web process per agent container.
const sessions = new Map<string, { child: ChildProcess; infile: string }>();

async function checkCwd(cwd: string): Promise<NextResponse | null> {
  if (!cwd || typeof cwd !== "string") {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  // ponytail: agent containers are single-tenant — the container is the
  // security boundary and a shell reaches any path anyway. Upstream's
  // file-access allow-list derives from pi sessions, which don't exist before
  // the first chat message (terminal would reject the workspace cwd). Validate
  // existence only.
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return NextResponse.json({ error: "cwd is not a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "cwd is not a directory" }, { status: 400 });
  }
  return null;
}

// GET /api/terminal/session?cwd=&cols=&rows= → SSE stream of PTY output.
// The session id is sent as the first SSE event so the client can POST input.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") ?? "";
  const denied = await checkCwd(cwd);
  if (denied) return denied;

  const cols = Math.max(20, Math.min(400, Number(url.searchParams.get("cols")) || 80));
  const rows = Math.max(5, Math.min(120, Number(url.searchParams.get("rows")) || 24));

  const id = randomUUID();
  const infile = `/tmp/pty-in-${id}.in`;
  const child = spawn("python3", ["-c", PTY_BRIDGE_PY, cwd, String(cols), String(rows), infile], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  sessions.set(id, { child, infile });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Python sends base64 per output chunk (one line per chunk), so each
      // SSE data event carries exactly one atomic write for the terminal.
      const send = (data: Buffer) => {
        const b64 = data.toString("utf8").trimEnd();
        if (b64) controller.enqueue(encoder.encode(`data: ${b64}\n\n`));
      };
      child.stdout.on("data", send);
      child.on("exit", () => {
        try { controller.close(); } catch { /* ignore */ }
      });
      controller.enqueue(encoder.encode(`data: __session__${id}\n\n`));
    },
    cancel() {
      child.kill("SIGKILL");
      sessions.delete(id);
    },
  });

  // Reap on client disconnect.
  req.signal?.addEventListener("abort", () => {
    child.kill("SIGKILL");
    sessions.delete(id);
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// POST /api/terminal/session  body: { id, data } — writes keystrokes to the pty stdin.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: string; data?: string } | null;
  const sess = body?.id ? sessions.get(body.id) : undefined;
  if (!sess || !body?.data) {
    return NextResponse.json({ error: "unknown session" }, { status: 404 });
  }
  try {
    // Input goes to a temp file the pty bridge polls (the direct stdin pipe
    // loses keystrokes under rapid typing). Append synchronously so chunks
    // from separate POSTs stay ordered on disk.
    const fs = await import("node:fs");
    fs.appendFileSync(sess.infile, body.data);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "session closed" }, { status: 410 });
  }
}

// PUT /api/terminal/session  body: { id, cols, rows } — resizes the pty.
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: string; cols?: number; rows?: number } | null;
  if (!body?.id) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  const sess = sessions.get(body.id);
  if (!sess) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  const cols = Math.max(20, Math.min(400, Number(body.cols) || 80));
  const rows = Math.max(5, Math.min(120, Number(body.rows) || 24));
  try {
    (sess.child.stdio[3] as NodeJS.WritableStream | null)?.write(`${JSON.stringify({ type: "resize", cols, rows })}\n`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "session closed" }, { status: 410 });
  }
}
