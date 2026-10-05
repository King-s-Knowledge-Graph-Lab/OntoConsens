import { useEffect, useRef } from "react";
import { useCreateUserWsTicket } from "@workspace/api-client-react";

type ServerEvent =
  | { type: "project_deleted"; projectId?: number }
  | { type: "member_count_changed"; projectId: number; memberCount: number };

interface UseDashboardSocketOptions {
  enabled: boolean;
  onProjectDeleted: (projectId: number) => void;
  onMemberCountChanged: (projectId: number, memberCount: number) => void;
}

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;

// A user-scoped (not project-scoped) realtime connection kept open while on
// the dashboard, so that if another member deletes a shared project, its
// card disappears here immediately, and if someone joins one of the user's
// projects, its member count updates immediately -- both without waiting
// for a manual refresh.
export function useDashboardSocket({
  enabled,
  onProjectDeleted,
  onMemberCountChanged,
}: UseDashboardSocketOptions) {
  const createTicket = useCreateUserWsTicket();
  const callbacksRef = useRef({ onProjectDeleted, onMemberCountChanged });
  callbacksRef.current = { onProjectDeleted, onMemberCountChanged };

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    function scheduleReconnect() {
      if (stopped) return;
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    async function connect() {
      if (stopped) return;
      let ticket: string;
      try {
        ticket = (await createTicket.mutateAsync()).ticket;
      } catch {
        scheduleReconnect();
        return;
      }
      if (stopped) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?ticket=${ticket}`);

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
      });

      socket.addEventListener("message", (event) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "project_deleted" && typeof data.projectId === "number") {
          callbacksRef.current.onProjectDeleted(data.projectId);
        } else if (data.type === "member_count_changed") {
          callbacksRef.current.onMemberCountChanged(data.projectId, data.memberCount);
        }
      });

      socket.addEventListener("close", () => {
        if (!stopped) scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
