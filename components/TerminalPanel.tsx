"use client";

import { useState, useRef, useEffect } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  /** Current workspace directory the terminal runs in. */
  cwd: string | null | undefined;
  /** Fires when the panel switches between fill-to-bottom and an explicit height. */
  onFillChange?: (fill: boolean) => void;
}

// Real PTY terminal: xterm.js front-end talking to a python3 pty bridge
// (spawned bash) via SSE + POST input. Interactive programs (pi, vim, top)
// work because the shell has a real TTY.
export function TerminalPanel({ cwd, onFillChange }: Props) {
  const { t } = useI18n();
  // null = fill the leftover space down to the page bottom.
  const [height, setHeight] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startH: number;
    maxH: number;
    target: HTMLDivElement;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const MIN_HEIGHT = 120;

  const measureMaxHeight = () => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return 220;
    if (height === null) return Math.round(root.getBoundingClientRect().height);
    let others = 0;
    for (const child of Array.from(parent.children)) {
      if (child === root) continue;
      const el = child as HTMLElement;
      if (el.dataset.resizeSpacer != null) continue;
      others += el.offsetHeight;
    }
    return Math.max(MIN_HEIGHT, parent.clientHeight - others);
  };
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Serialize keystroke POSTs — parallel writes to the pty stdin arrive out of
  // order and scramble the command (e.g. "echo x" → "echx").
  const inputQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    onFillChange?.(height === null);
  }, [height, onFillChange]);

  const finishResize = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      if (drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // capture may already be released
    }
  };

  const teardown = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionIdRef.current = null;
    xtermRef.current?.dispose();
    xtermRef.current = null;
    fitRef.current = null;
  };

  const fitSafely = () => {
    const host = containerRef.current;
    const fit = fitRef.current;
    if (!fit || !host || host.clientHeight < 24 || host.clientWidth < 24) return;
    try { fit.fit(); } catch { /* ignore */ }
  };

  const handleClear = () => {
    const term = xtermRef.current;
    if (!term) return;
    // Do not call term.clear(): after a large scrollback it resets the
    // viewport metrics, FitAddon can lock rows to 1, and the helper
    // textarea (keyboard input) sits on a collapsed screen.
    const id = sessionIdRef.current;
    if (id) {
      inputQueueRef.current = inputQueueRef.current
        .then(() => fetch("/api/terminal/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, data: "\x0c" }),
        }))
        .catch(() => {});
    } else {
      term.write("\x1b[2J\x1b[H");
    }
    term.write("\x1b[3J", () => {
      requestAnimationFrame(() => {
        fitSafely();
        term.focus();
      });
    });
  };

  // (Re)start the PTY session when the cwd changes or the panel mounts.
  useEffect(() => {
    if (!containerRef.current || !cwd) return;
    teardown();
    const cancelled = { current: false };
    let themeObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      // Wait for web fonts (Noto Sans Mono) before measuring — if xterm
      // measures with the fallback font it caches wrong glyph widths and
      // characters overlap on screen.
      try { await document.fonts.ready; } catch { /* ignore */ }
      if (cancelled.current || !containerRef.current) return;

      const term = new Terminal({
        // CSS var() is invalid inside canvas font strings — resolve the real
        // stack first or xterm measures with a fallback font and glyphs
        // overlap.
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
        fontSize: 12,
        lineHeight: 1.3,
        letterSpacing: 2,
        cursorBlink: true,
        scrollback: 10000,
        scrollOnUserInput: true,
      });
      // Terminal colors follow the pi-web theme (light/dark toggle adds the
      // `dark` class on <html>). CSS var() does not resolve inside canvas
      // paints, so resolve actual values and re-apply on theme switches.
      const applyTheme = () => {
        const cs = getComputedStyle(document.documentElement);
        const bg = cs.getPropertyValue("--bg-hover").trim() || cs.backgroundColor;
        const fg = cs.getPropertyValue("--text").trim() || "#d4d4d4";
        term.options.theme = { background: bg, foreground: fg, cursor: fg, selectionBackground: `${fg}40` };
      };
      applyTheme();
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      xtermRef.current = term;
      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(containerRef.current);
      // Fit after layout: opening xterm mutates the host; measuring in the
      // same turn can report a collapsed box and lock the viewport height.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled.current) return;
      fitSafely();
      term.focus();

      // Follow live PTY output unless the user scrolled up to read history.
      const followOutput = { current: true };
      const viewport = term.element?.querySelector(".xterm-viewport") as HTMLElement | null;
      const onViewportScroll = () => {
        if (!viewport) return;
        followOutput.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 32;
      };
      viewport?.addEventListener("scroll", onViewportScroll, { passive: true });

      const writeOutput = (data: Uint8Array) => {
        term.write(data, () => {
          if (followOutput.current) term.scrollToBottom();
        });
      };

      term.onData((data) => {
        const id = sessionIdRef.current;
        if (!id) return;
        inputQueueRef.current = inputQueueRef.current
          .then(() => fetch("/api/terminal/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, data }),
          }))
          .catch(() => {});
      });

      // Open the SSE stream; first event carries the session id.
      const abort = new AbortController();
      abortRef.current = abort;
      void (async () => {
        try {
          const res = await fetch(`/api/terminal/session?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`, { signal: abort.signal });
          if (!res.ok || !res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of raw.split("\n")) {
                const payload = line.startsWith("data: ")
                  ? line.slice(6)
                  : line; // tolerate continuation lines lacking the prefix
                if (payload.startsWith("__session__")) {
                  sessionIdRef.current = payload.slice("__session__".length);
                  continue;
                }
                try {
                  const bin = atob(payload);
                  const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
                  writeOutput(arr);
                } catch { /* skip malformed chunk */ }
              }
            }
          }
        } catch {
          // aborted on teardown — expected
        } finally {
          viewport?.removeEventListener("scroll", onViewportScroll);
        }
      })();

      // Keep the PTY size in sync with the panel. Debounce the ioctl so a
      // scrollbar appearing mid-stream does not SIGWINCH the child every frame.
      const host = containerRef.current;
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const ro = new ResizeObserver(() => {
        fitSafely();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const id = sessionIdRef.current;
          if (!id || !xtermRef.current) return;
          fetch("/api/terminal/session", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, cols: xtermRef.current.cols, rows: xtermRef.current.rows }),
          }).catch(() => {});
        }, 80);
      });
      ro.observe(host);
      resizeObserver = ro;
    })();
    return () => {
      cancelled.current = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      teardown();
    };
  }, [cwd]);

  return (
    <div
      ref={rootRef}
      style={{
        background: "var(--bg)",
        padding: "0 16px 8px",
        flex: height === null ? "1 1 auto" : "0 0 auto",
        height: height === null ? undefined : height,
        minHeight: MIN_HEIGHT,
        minWidth: 0,
        width: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{
        maxWidth: "100%",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        width: "100%",
        height: "100%",
      }}>
        {/* Resize divider (drag up/down). Double-click restores fill-to-bottom. */}
        <div
          onPointerDown={(e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const current = Math.round(rootRef.current?.getBoundingClientRect().height ?? 220);
            const maxH = measureMaxHeight();
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            dragRef.current = {
              pointerId: e.pointerId,
              startY: e.clientY,
              startH: current,
              maxH,
              target,
            };
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            e.preventDefault();
            setHeight(Math.min(d.maxH, Math.max(MIN_HEIGHT, d.startH + (d.startY - e.clientY))));
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onDoubleClick={() => setHeight(null)}
          onMouseEnter={(e) => { (e.currentTarget.firstElementChild as HTMLElement).style.background = "var(--accent)"; }}
          onMouseLeave={(e) => { (e.currentTarget.firstElementChild as HTMLElement).style.background = "var(--border)"; }}
          title={t("terminal.resize")}
          style={{ height: 12, cursor: "row-resize", position: "relative", flexShrink: 0, touchAction: "none", zIndex: 2 }}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: 5, height: 2, background: "var(--border)", transition: "background 0.1s" }} />
        </div>
        {/* Header: cwd + clear */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0 4px", fontSize: 10, color: "var(--text-dim)" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cwd ?? t("terminal.noCwd")}
          </span>
          <button
            onClick={handleClear}
            title={t("terminal.clear")}
            style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 10 }}
          >
            {t("terminal.clear")}
          </button>
        </div>

        {/* Chrome (border/padding) is separate from the xterm host so FitAddon
            measures a box with a real height; padding on the host itself
            collapses the viewport and breaks scroll. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: "4px 0 0 6px",
          }}
        >
          <div ref={containerRef} className="pi-terminal-host" style={{ width: "100%", height: "100%" }} />
        </div>
      </div>
    </div>
  );
}
