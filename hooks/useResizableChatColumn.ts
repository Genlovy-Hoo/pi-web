"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  CHAT_COLUMN_DEFAULT_WIDTH,
  CHAT_COLUMN_MAX_WIDTH,
  CHAT_COLUMN_MIN_WIDTH,
  CHAT_COLUMN_STORAGE_KEY,
  clampPanelWidth,
} from "@/lib/panel-layout";

type GrowthDirection = "left" | "right";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  target: HTMLDivElement;
  growthDirection: GrowthDirection;
  previousCursor: string;
  previousUserSelect: string;
}

function readStoredWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(CHAT_COLUMN_STORAGE_KEY);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(CHAT_COLUMN_STORAGE_KEY, String(width));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

export function useResizableChatColumn(options: {
  ariaLabel: string;
  enabled: boolean;
  getMaxWidth: () => number;
}) {
  const { ariaLabel, enabled, getMaxWidth } = options;
  const columnRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(CHAT_COLUMN_DEFAULT_WIDTH);
  const dragRef = useRef<DragState | null>(null);
  const restoredRef = useRef(false);
  const [width, setWidth] = useState(CHAT_COLUMN_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const effectiveMaxWidth = useCallback(
    () => Math.min(CHAT_COLUMN_MAX_WIDTH, Math.max(CHAT_COLUMN_MIN_WIDTH, getMaxWidth())),
    [getMaxWidth],
  );

  const clampWidth = useCallback(
    (candidate: number) => clampPanelWidth(candidate, CHAT_COLUMN_MIN_WIDTH, effectiveMaxWidth()),
    [effectiveMaxWidth],
  );

  const applyLiveWidth = useCallback((nextWidth: number) => {
    widthRef.current = nextWidth;
    columnRef.current?.style.setProperty("--chat-column-width", `${nextWidth}px`);
  }, []);

  const commitWidth = useCallback((candidate: number, persist = true) => {
    const nextWidth = clampWidth(candidate);
    applyLiveWidth(nextWidth);
    setWidth(nextWidth);
    if (persist) writeStoredWidth(nextWidth);
    return nextWidth;
  }, [applyLiveWidth, clampWidth]);

  const restoreBodyState = useCallback((drag: DragState) => {
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
  }, []);

  const finishResize = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    restoreBodyState(drag);
    setIsResizing(false);
    commitWidth(widthRef.current);
    try {
      if (drag.target.hasPointerCapture(pointerId)) {
        drag.target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have already released capture after pointer cancellation.
    }
  }, [commitWidth, restoreBodyState]);

  const onPointerDown = useCallback((growthDirection: GrowthDirection) => {
    return (event: PointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const activeDrag = dragRef.current;
      if (activeDrag) finishResize(activeDrag.pointerId);

      const target = event.currentTarget;
      target.focus({ preventScroll: true });
      target.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: widthRef.current,
        target,
        growthDirection,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setIsResizing(true);
    };
  }, [enabled, finishResize]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishResize(event.pointerId);
      return;
    }
    event.preventDefault();
    const direction = drag.growthDirection === "right" ? 1 : -1;
    const nextWidth = clampWidth(drag.startWidth + ((event.clientX - drag.startX) * direction));
    applyLiveWidth(nextWidth);
    event.currentTarget.setAttribute("aria-valuenow", String(nextWidth));
    event.currentTarget.setAttribute("aria-valuetext", `${nextWidth} px`);
  }, [applyLiveWidth, clampWidth, finishResize]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const resetWidth = useCallback(() => {
    commitWidth(CHAT_COLUMN_DEFAULT_WIDTH);
  }, [commitWidth]);

  const reclampWidth = useCallback(() => {
    commitWidth(widthRef.current);
  }, [commitWidth]);

  const onKeyDown = useCallback((growthDirection: GrowthDirection) => {
    return (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 12;
      const growKey = growthDirection === "right" ? "ArrowRight" : "ArrowLeft";
      const shrinkKey = growthDirection === "right" ? "ArrowLeft" : "ArrowRight";
      if (event.key === growKey) {
        event.preventDefault();
        commitWidth(widthRef.current + step);
      } else if (event.key === shrinkKey) {
        event.preventDefault();
        commitWidth(widthRef.current - step);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(CHAT_COLUMN_MIN_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(effectiveMaxWidth());
      } else if (event.key === "Enter") {
        event.preventDefault();
        resetWidth();
      }
    };
  }, [commitWidth, effectiveMaxWidth, resetWidth]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const storedWidth = readStoredWidth();
    const restoredWidth = commitWidth(storedWidth ?? CHAT_COLUMN_DEFAULT_WIDTH, false);
    if (storedWidth !== null && storedWidth !== restoredWidth) {
      writeStoredWidth(restoredWidth);
    }
  }, [commitWidth]);

  useEffect(() => {
    if (!restoredRef.current) return;
    commitWidth(widthRef.current);
    const onResize = () => commitWidth(widthRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [commitWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const cancelResize = () => {
      const drag = dragRef.current;
      if (drag) finishResize(drag.pointerId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelResize();
    };
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [finishResize, isResizing]);

  const sharedSeparator = {
    "aria-label": ariaLabel,
    "aria-orientation": "vertical" as const,
    "aria-valuemax": mounted ? effectiveMaxWidth() : CHAT_COLUMN_MAX_WIDTH,
    "aria-valuemin": CHAT_COLUMN_MIN_WIDTH,
    "aria-valuenow": width,
    "aria-valuetext": `${width} px`,
    onDoubleClick: resetWidth,
    onLostPointerCapture: onPointerUp,
    onPointerCancel: onPointerUp,
    onPointerMove,
    onPointerUp,
    role: "separator" as const,
    tabIndex: enabled ? 0 : -1,
  };

  return {
    columnRef,
    isResizing,
    reclampWidth,
    width,
    leftSeparatorProps: {
      ...sharedSeparator,
      onKeyDown: onKeyDown("left"),
      onPointerDown: onPointerDown("left"),
    },
    rightSeparatorProps: {
      ...sharedSeparator,
      onKeyDown: onKeyDown("right"),
      onPointerDown: onPointerDown("right"),
    },
  };
}
