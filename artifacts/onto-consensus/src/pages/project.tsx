import { useParams, Link, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { 
  useGetProject, 
  useSetReady, 
  useExportProject, 
  useExportConversation,
  useGetMe,
  useListProperties,
  useGetModeratorStatus,
  useDisableModerator,
  getGetProjectQueryKey,
  getListPropertiesQueryKey,
  getExportProjectQueryKey,
  getExportConversationQueryKey,
  getListProjectsQueryKey,
  getGetModeratorStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { GraphCanvas } from "@/components/GraphCanvas";
import { 
  Check, 
  Download, 
  ChevronLeft, 
  Loader2, 
  Network, 
  Sparkles,
  ListChecks,
} from "lucide-react";
import { useProjectSocket, type ModeratorChatMessage } from "@/hooks/useProjectSocket";
import { ModeratorChatPanel } from "@/components/ModeratorChatPanel";
import { WorkspaceGuidePanel } from "@/components/WorkspaceGuidePanel";

export default function ProjectWorkspace() {
  const { id: idStr } = useParams();
  const projectId = parseInt(idStr || "0", 10);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: me } = useGetMe();
  // The WebSocket push is the primary sync mechanism, but a slow background
  // poll runs alongside it as a safety net: if a socket message is ever
  // dropped (or a reconnect races a broadcast), this guarantees everyone
  // converges on the same state within seconds without needing to refresh.
  const { data: project, isLoading, error } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId), refetchInterval: 10_000 },
  });
  
  const setReady = useSetReady();
  const exportQuery = useExportProject(projectId, { 
    query: { enabled: false, queryKey: getExportProjectQueryKey(projectId) } 
  });
  // Second file the same Export click downloads: the full moderator
  // conversation log in a flat, analysis-ready schema (see
  // /projects/:id/export-conversation on the server) -- a separate query
  // from the ontology export above since it has its own gate (none) and
  // shape entirely unrelated to the agreed-ontology payload.
  const exportConversationQuery = useExportConversation(projectId, {
    query: { enabled: false, queryKey: getExportConversationQueryKey(projectId) },
  });
  
  const meMember = project?.members.find(m => m.userId === me?.id);
  const isReady = meMember?.ready || false;
  // The shared space only opens once exactly the project's specified member
  // count has joined and everyone has marked ready — not just however many
  // happen to be in the project right now.
  const allReady = Boolean(
    project && project.members.length === project.maxMembers && project.members.every(m => m.ready),
  );

  // Reuses the same query (and cache) GraphCanvas is already fetching, just
  // to derive whether the whole workspace has reached full consensus. This
  // recalculates on every render, so the moment any agreement is reached or
  // broken anywhere, the Export button's enabled state updates immediately.
  const { data: allProperties } = useListProperties(projectId, {
    query: { queryKey: getListPropertiesQueryKey(projectId), refetchInterval: 10_000, enabled: Boolean(project && meMember) },
  });
  const workspaceFullyAgreed = allReady && Boolean(allProperties) && allProperties!.length > 0 && allProperties!.every(p => p.agreedByAll);

  // A single socket connection per project page: it stays open the whole time
  // a member is in the workspace (not just once they're ready) so that ready
  // status, joins, and property changes all show up live for everyone without
  // needing a page refresh.
  const isOwner = Boolean(project && me && project.ownerId === me.id);
  // Fetched only once the shared space is open (the moderator only exists
  // there) — this is the single source of truth for on/off state; socket
  // events below just invalidate it so all members converge immediately
  // instead of waiting on the 10s poll below.
  const { data: moderatorStatus } = useGetModeratorStatus(projectId, {
    query: {
      queryKey: getGetModeratorStatusQueryKey(projectId),
      enabled: Boolean(project && meMember && allReady),
      refetchInterval: 10_000,
    },
  });
  // "Quitting" the project (heading back to the dashboard) should never
  // leave this member's mic marked active server-side -- otherwise everyone
  // else keeps seeing them as mic-on even though no audio/captions are
  // coming from them anymore, and the moderator's silence tracking keeps
  // treating their mic as "open".
  const disableModerator = useDisableModerator();
  const handleQuitProject = (e: React.MouseEvent) => {
    e.preventDefault();
    if (moderatorStatus?.active) {
      disableModerator.mutate(
        { id: projectId },
        {
          // Write the server's response straight into the cache rather than
          // just invalidating it. Invalidating only marks the query stale --
          // React Query still returns the old cached "active: true" value
          // synchronously on the next mount while it refetches in the
          // background, so rejoining moments later would still flash the
          // mic toggle ON before the refetch resolves and flips it OFF.
          // Seeding the cache with the known-correct value up front means
          // there's no stale reading to flash in the first place.
          onSuccess: (data) => {
            queryClient.setQueryData(getGetModeratorStatusQueryKey(projectId), data);
          },
          onSettled: () => navigate("/"),
        },
      );
    } else {
      navigate("/");
    }
  };
  const [liveMessages, setLiveMessages] = useState<ModeratorChatMessage[]>([]);
  const [moderatorErrorMessage, setModeratorErrorMessage] = useState<string | null>(null);
  // Set true the instant the backend confirms all three intervention
  // conditions (silence, a new finalized message, genuinely new content)
  // and has already durably committed the message -- it's exactly
  // INTERVENTION_TYPING_DELAY_MS away, guaranteed. Cleared the moment that
  // real "intervention" message actually arrives.
  const [moderatorTyping, setModeratorTyping] = useState(false);
  // The instant a matched "stalled discussion" intervention arrives,
  // briefly highlight the class/property it was actually about in the
  // shared graph -- gives the moderator's message somewhere to land in the
  // workspace instead of only living in the chat panel.
  const [highlightedProperty, setHighlightedProperty] = useState<{ classId: number; propertyId: number } | null>(
    null,
  );
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HIGHLIGHT_DURATION_MS = 4_000;
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const {
    cursors,
    sendCursor,
    status: syncStatus,
    onlineUserIds,
    speakerVolumes,
    sendVolume,
    liveCaptions,
    sendAudioChunk,
    sendMicStart,
    sendMicStop,
    clearLiveCaption,
  } = useProjectSocket({
    projectId,
    enabled: Boolean(project && meMember),
    onProjectChanged: () => queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) }),
    onPropertiesChanged: () => queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey(projectId) }),
    // The owner deleting the project removes it for everyone — every other
    // member's socket gets this the moment it happens, so they're bounced
    // back to the dashboard instead of being left staring at a project that
    // no longer exists (which would otherwise only surface as confusing
    // 404s on their next action).
    onProjectDeleted: () => {
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.removeQueries({ queryKey: getGetProjectQueryKey(projectId) });
      navigate("/");
    },
    onModeratorChatMessage: (message) => {
      // The moderator keeps running (and this message is still recorded for
      // the conversation export) even when the project has its live display
      // disabled -- liveMessages always collects everything, and
      // ModeratorChatPanel is the one place that filters "intro"/
      // "intervention" out of what's actually rendered.
      setLiveMessages((prev) => [...prev, message]);
      if (message.type === "intervention") {
        // The real content just arrived -- it's itself the signal to swap
        // out the typing indicator.
        setModeratorTyping(false);
      }
      // Highlighting a property is itself a visible trace of what the
      // moderator flagged -- suppress it right alongside the chat messages
      // when this project has moderator display turned off.
      if (
        project?.moderatorEnabled &&
        message.type === "intervention" &&
        message.matched &&
        message.classId !== null &&
        message.propertyId !== null
      ) {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        setHighlightedProperty({ classId: message.classId, propertyId: message.propertyId });
        highlightTimerRef.current = setTimeout(() => setHighlightedProperty(null), HIGHLIGHT_DURATION_MS);
      }
    },
    onModeratorError: (message) => {
      setModeratorErrorMessage(message);
      setModeratorTyping(false);
    },
    onModeratorInterventionTyping: () => {
      setModeratorTyping(true);
    },
  });

  // "Live" is only meaningful as a brief confirmation right after connecting —
  // showing it permanently would just be persistent chrome sitting on the
  // workspace. Reconnecting/disconnected states stay visible the whole time
  // since those need the user's attention.
  const [showLive, setShowLive] = useState(false);
  // Below the lg breakpoint the graph and the moderator chat can't fit
  // side by side (the chat panel alone needs a real minimum width to stay
  // usable) -- so on narrow screens only one of them is shown at a time,
  // switched via a small tab control, instead of the two-pane desktop
  // layout. Both panes stay mounted; only visibility (via CSS) toggles,
  // so switching back to a pane never loses its scroll position or state.
  const [mobileView, setMobileView] = useState<"guide" | "graph" | "chat">("graph");
  const prevSyncStatus = useRef(syncStatus);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (syncStatus === "connected" && prevSyncStatus.current !== "connected") {
      setShowLive(true);
      timer = setTimeout(() => setShowLive(false), 2500);
    }
    prevSyncStatus.current = syncStatus;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [syncStatus]);

  const handleMarkReady = () => {
    if (isReady) return;
    setReady.mutate(
      { id: projectId, data: { ready: true } },
      {
        onSuccess: (updatedMember) => {
          queryClient.setQueryData(getGetProjectQueryKey(projectId), (old: any) => {
            if (!old) return old;
            return {
              ...old,
              members: old.members.map((m: any) => 
                m.userId === updatedMember.userId ? updatedMember : m
              )
            };
          });
        },
        onError: (err: any) => {
          console.error("Failed to update ready state", err);
        }
      }
    );
  };

  // Triggers a browser download of a JSON blob -- shared by both files this
  // button produces so the two downloads behave identically (same
  // pretty-printing, same object-URL lifecycle).
  const downloadJson = (data: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    const slug = project?.name.replace(/\s+/g, '-').toLowerCase() || 'project';
    try {
      const { data } = await exportQuery.refetch();
      if (data) downloadJson(data, `ontology-export-${slug}.json`);
    } catch (e) {
      console.error("Ontology export failed", e);
    }
    // Independent of the ontology export above -- the conversation log has
    // no agreement gate, so it's fetched and downloaded as a second file
    // regardless of whether the ontology export itself succeeded.
    try {
      const { data } = await exportConversationQuery.refetch();
      if (data) downloadJson(data, `conversation-export-${slug}.json`);
    } catch (e) {
      console.error("Conversation export failed", e);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 text-center">
        <Network className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-bold mb-2">Project not found</h2>
        <p className="text-muted-foreground mb-6 max-w-md">
          The project you're looking for doesn't exist or you don't have access to it.
        </p>
        <Button asChild>
          <Link href="/">Back to Dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden">
      {/* Top Bar */}
      <header className="flex items-center justify-between h-14 px-2 sm:px-4 border-b bg-card shrink-0 shadow-sm z-10 relative gap-2">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0 -ml-2" onClick={handleQuitProject}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="flex flex-col min-w-0">
            <h1 className="font-semibold text-sm leading-tight truncate">{project.name}</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4 md:gap-6 shrink-0">
          {/* Member Chips */}
          <div className="flex items-center gap-1.5 sm:gap-2 bg-muted/50 p-1.5 rounded-full border">
            {project.members.map(member => {
              // The green ring means "in this project right now" (has an open
              // socket connection) — independent of readiness, so someone can
              // be ready but not currently present, or present but not ready.
              const isOnline = onlineUserIds.has(member.userId);
              return (
                <div key={member.userId} className="relative">
                  <Avatar 
                    className={`w-8 h-8 border-2 transition-transform duration-200 ${isOnline ? 'scale-105 border-green-500 ring-2 ring-green-500/20' : 'border-transparent'}`}
                  >
                    <AvatarFallback 
                      className="text-white text-xs font-semibold shadow-inner"
                      style={{ backgroundColor: `hsl(var(--member-${member.colorSlot}))` }}
                    >
                      {member.username.substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  {member.ready && (
                    <div className="absolute -bottom-1 -right-1 bg-green-500 text-white rounded-full p-0.5 border-2 border-card">
                      <Check className="w-2.5 h-2.5" />
                    </div>
                  )}
                </div>
              );
            })}
            
            {/* Empty slots placeholders -- hidden on the narrowest screens
                since the top bar is already tight there and they're purely
                decorative (no actionable state). */}
            {Array.from({ length: project.maxMembers - project.members.length }).map((_, i) => (
              <div 
                key={`empty-${i}`} 
                className="hidden sm:flex w-8 h-8 rounded-full border-2 border-dashed border-muted-foreground/30 items-center justify-center"
              >
                <span className="text-[10px] text-muted-foreground/50 font-medium">--</span>
              </div>
            ))}
          </div>

          {/* Ready Toggle - one-way: once ready you cannot mark yourself unready */}
          <Button 
            variant={isReady ? "default" : "outline"}
            className={`shrink-0 sm:min-w-[140px] shadow-sm transition-all duration-300 ${isReady ? 'bg-green-600 hover:bg-green-700 text-white cursor-default opacity-100' : ''}`}
            onClick={handleMarkReady}
            disabled={setReady.isPending || isReady}
          >
            {isReady ? (
              <>
                <Check className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Ready</span>
              </>
            ) : (
              <>
                <span className="hidden sm:inline">Mark as Ready</span>
                <span className="sm:hidden">Ready?</span>
              </>
            )}
          </Button>
        </div>
      </header>

      {/* Mobile pane switcher -- once the shared workspace canvas would be
          squeezed narrower than the fixed-width guide panel, the panes
          can no longer fit side by side, so only one is shown at a time
          here instead. That crossover point is 384px (the guide's width)
          plus the row's own padding/gaps, computed separately for whether
          the moderator chat pane is in the mix (it only ever appears once
          the shared workspace is open) -- see min-[816px] / min-[1184px]
          below. All panes stay mounted underneath; this only toggles
          which one is visible. */}
      <div
        className={`flex flex-wrap items-center justify-center gap-1.5 px-4 py-3 shrink-0 ${
          allReady ? "min-[1184px]:hidden" : "min-[816px]:hidden"
        }`}
      >
        <button
          type="button"
          onClick={() => setMobileView("guide")}
          className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
            mobileView === "guide" ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground"
          }`}
        >
          <ListChecks className="w-3.5 h-3.5" />
          Guide
        </button>
        <button
          type="button"
          onClick={() => setMobileView("graph")}
          className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
            mobileView === "graph" ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground"
          }`}
        >
          <Network className="w-3.5 h-3.5" />
          Graph
        </button>
        {allReady && (
          <button
            type="button"
            onClick={() => setMobileView("chat")}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              mobileView === "chat" ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Chat
          </button>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex min-h-0 relative gap-4 px-4 py-4 bg-muted">
        {/* Guide panel -- tells the current member what to do next to
            finish their task on this page. */}
        <WorkspaceGuidePanel
          isReady={isReady}
          allReady={allReady}
          workspaceFullyAgreed={workspaceFullyAgreed}
          className={
            mobileView === "guide"
              ? "w-full flex"
              : allReady
                ? "w-full hidden min-[1184px]:flex min-[1184px]:w-96"
                : "w-full hidden min-[816px]:flex min-[816px]:w-96"
          }
        />

        {/* Canvas Area */}
        <main
          className={`flex-1 min-w-0 bg-card relative rounded-2xl border shadow-sm overflow-hidden flex flex-col ${
            mobileView === "graph" ? "flex" : allReady ? "hidden min-[1184px]:flex" : "hidden min-[816px]:flex"
          }`}
        >
          <div className="flex items-center justify-center h-14 px-4 border-b shrink-0">
            <span className="font-semibold text-sm">{allReady ? "Shared Workspace" : "Individual Workspace"}</span>
          </div>

          <div className="flex-1 min-h-0 relative">
            {me && (
              <GraphCanvas
                projectId={projectId}
                currentUserId={me.id}
                cursors={cursors}
                sendCursor={sendCursor}
                sharedModeEnabled={allReady}
                ownSpaceLocked={isReady && !allReady}
                highlightedProperty={highlightedProperty}
              />
            )}

            {/* Sync status - plain text floating on the workspace, no bar/box */}
            {(syncStatus !== "connected" || showLive) && (
              <span
                className={`pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-30 text-xs font-semibold tracking-wide transition-opacity duration-500 ${
                  syncStatus === "connected"
                    ? "text-green-600 dark:text-green-400"
                    : syncStatus === "reconnecting"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-destructive"
                }`}
              >
                {syncStatus === "connected" ? "Live" : syncStatus === "reconnecting" ? "Reconnecting" : "Disconnected"}
              </span>
            )}
          </div>
        </main>

        {/* Persistent AI moderator chat panel -- appears once the shared
            space is open, visible to every member regardless of their own
            mic state. */}
        {allReady && (
          <ModeratorChatPanel
            projectId={projectId}
            moderatorEnabled={project.moderatorEnabled}
            moderatorActive={moderatorStatus?.active ?? false}
            moderatorConfigured={moderatorStatus?.configured ?? false}
            liveMessages={liveMessages}
            onVolume={sendVolume}
            speakerVolumes={speakerVolumes}
            liveCaptions={liveCaptions}
            sendAudioChunk={sendAudioChunk}
            sendMicStart={sendMicStart}
            sendMicStop={sendMicStop}
            clearLiveCaption={clearLiveCaption}
            members={project.members}
            moderatorErrorMessage={moderatorErrorMessage}
            onDismissError={() => setModeratorErrorMessage(null)}
            moderatorTyping={moderatorTyping}
            className={
              mobileView === "chat"
                ? "w-full flex"
                : "w-full hidden min-[1184px]:flex min-[1184px]:w-[28vw] min-[1184px]:min-w-[22rem]"
            }
          />
        )}
      </div>

      {/* Bottom Export Bar */}
      <footer className="h-16 shrink-0 bg-card border-t flex items-center justify-center px-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-20">
        <Button
          onClick={handleExport}
          disabled={!workspaceFullyAgreed || exportQuery.isFetching || exportConversationQuery.isFetching}
          title={workspaceFullyAgreed ? "Download the fully agreed ontology and the full conversation history" : "Export unlocks once every property has full agreement"}
          className="gap-2 bg-foreground text-background hover:bg-foreground/90 shadow-md transition-opacity disabled:opacity-40"
        >
          {exportQuery.isFetching || exportConversationQuery.isFetching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export
        </Button>
      </footer>
    </div>
  );
}
