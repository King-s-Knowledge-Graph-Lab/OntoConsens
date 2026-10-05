import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  useConfigureModerator,
  useDisableModerator,
  useListModeratorChatMessages,
  getGetModeratorStatusQueryKey,
  getListModeratorChatMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Sparkles, AlertTriangle, X, Mic, MicOff, ArrowDown } from "lucide-react";
import { useModeratorAudio } from "@/hooks/useModeratorAudio";
import { colorForSlot } from "@/lib/memberColors";
import type { LiveCaption, ModeratorChatMessage, SpeakerVolume } from "@/hooks/useProjectSocket";

// One flag per project, per browser -- flips to "seen" the first time this
// member's panel finishes loading history for that project. Lets the intro
// bullets (which are already sitting in "history" by the time the panel
// mounts, since they're posted synchronously when the shared space opens)
// still play through the one-message-at-a-time typing effect on that very
// first load, instead of being dumped onto the screen all at once the way
// ordinary history replay works.
const introSeenStorageKey = (projectId: number) => `onto-consensus-moderator-intro-seen-${projectId}`;

interface ModeratorChatPanelProps {
  projectId: number;
  /** Chosen once at project creation and fixed afterward. The moderator
   *  itself keeps running in the background either way (still listens,
   *  transcribes, and generates interventions) -- when this is false, its
   *  "intro" and "intervention" messages are simply never rendered here.
   *  They still appear normally in the conversation export. */
  moderatorEnabled: boolean;
  /** Whether the CURRENT user has turned the moderator on for themselves --
   *  purely per-person, independent of every other member. */
  moderatorActive: boolean;
  /** True once the project creator's account has an OpenAI API key saved --
   *  without one, nobody can turn the moderator on. */
  moderatorConfigured: boolean;
  /** New messages received live over the socket since this page mounted --
   *  appended to (not replacing) the persisted history fetched below. */
  liveMessages: ModeratorChatMessage[];
  onVolume: (level: number) => void;
  /** Live per-member mic volume, broadcast by everyone with their mic on --
   *  used to show a "so-and-so is speaking" indicator the instant someone
   *  starts talking, well before their transcript can possibly be
   *  transcribed and posted. */
  speakerVolumes: Map<number, SpeakerVolume>;
  /** Live, word-by-word speech-to-text as each member talks -- a real-time
   *  caption (Teams-style), not the final persisted transcript. Only
   *  populated for members whose browser supports the Web Speech API. */
  liveCaptions: Map<number, LiveCaption>;
  /** Streams this member's mic audio to the server for live transcription
   *  (see useModeratorAudio). */
  sendAudioChunk: (chunk: Int16Array) => void;
  sendMicStart: () => void;
  sendMicStop: () => Promise<void>;
  clearLiveCaption: (userId: number, utteranceId: number) => void;
  members: { userId: number; username: string; colorSlot: number }[];
  moderatorErrorMessage: string | null;
  onDismissError: () => void;
  /** True once the backend has confirmed all three intervention conditions
   *  (silence, a new finalized message, genuinely new content) and already
   *  durably committed the message -- it's exactly INTERVENTION_TYPING_DELAY_MS
   *  away, guaranteed. Cleared the moment that real message arrives. */
  moderatorTyping: boolean;
  /** Extra classes for the root <aside> -- used by the project workspace to
   *  toggle visibility for the mobile graph/chat pane switcher (this
   *  component has no concept of "mobile view" itself, it just accepts
   *  whatever display it's told to use). */
  className?: string;
}

// Every message (transcript, intro/system, and AI-moderator intervention
// alike) carries a server-assigned createdAt, so this is the single place
// that turns it into the exact "HH:MM:SS" wall-clock string shown next to
// each bubble's sender name -- local time, always zero-padded/24h so it
// sorts and reads unambiguously regardless of locale.
function formatTimestamp(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Deduplicate by id: the persisted-history fetch and live socket messages can
// legitimately overlap (e.g. a message arrives over the socket just before
// the history query resolves) -- id is the one stable identity both sides
// agree on.
function mergeMessages(history: ModeratorChatMessage[], live: ModeratorChatMessage[]): ModeratorChatMessage[] {
  const byId = new Map<number, ModeratorChatMessage>();
  for (const m of history) byId.set(m.id, m);
  for (const m of live) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

export function ModeratorChatPanel({
  projectId,
  moderatorEnabled,
  moderatorActive,
  moderatorConfigured,
  liveMessages,
  onVolume,
  speakerVolumes,
  liveCaptions,
  sendAudioChunk,
  sendMicStart,
  sendMicStop,
  clearLiveCaption,
  members,
  moderatorErrorMessage,
  onDismissError,
  moderatorTyping,
  className,
}: ModeratorChatPanelProps) {
  const queryClient = useQueryClient();
  const configure = useConfigureModerator();
  const disable = useDisableModerator();

  const { data: history } = useListModeratorChatMessages(projectId, {
    query: { queryKey: getListModeratorChatMessagesQueryKey(projectId) },
  });

  const messages = useMemo(() => {
    const merged = mergeMessages(
      (history?.messages as ModeratorChatMessage[] | undefined) ?? [],
      liveMessages,
    );
    // The moderator keeps running (still listens, transcribes, and
    // generates interventions) regardless of this project's display
    // setting -- both the persisted history and the live socket feed
    // contain its "intro"/"intervention" messages either way. This is the
    // single point that hides them from the live chat UI when disabled;
    // they remain untouched in the separate conversation export.
    if (moderatorEnabled) return merged;
    // "export_notice" (the one-time "consensus reached, AI moderator
    // stopped" message) is meaningless in an AI-disabled project -- there
    // was no AI moderator to stop. It's still always recorded (see
    // postConsensusReachedMessage) so it appears in the separate
    // conversation-export file either way; this is what keeps it out of
    // the live chat UI here specifically.
    return merged.filter((m) => m.type !== "intro" && m.type !== "intervention" && m.type !== "export_notice");
  }, [history, liveMessages, moderatorEnabled]);

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: getGetModeratorStatusQueryKey(projectId) });

  // Turning the moderator on for yourself is the same click that starts
  // capturing your mic. The browser's own permission prompt is the only
  // thing the user sees the first time; if they've already granted it, the
  // mic just opens.
  // Transcription itself now happens server-side (see useModeratorAudio and
  // realtimeTranscription.ts): this hook just captures and streams the raw
  // audio. Live captions and finalized transcript messages both arrive back
  // over the same project socket as before (liveCaptions / liveMessages),
  // so the rest of this component's rendering is unchanged. The
  // transcription model handles whatever language each member speaks on
  // its own, so there's no per-member language picker to manage.
  const { micError } = useModeratorAudio({
    projectId,
    active: moderatorActive,
    onVolume,
    sendAudioChunk,
    sendMicStart,
    sendMicStop,
  });

  // The instant a real transcript message lands, drop its speaker's interim
  // caption -- but only if it's still showing the utterance that message
  // carries. Storing a finalized utterance and capturing a new one the
  // speaker has already resumed are parallel, independent processes (see
  // useModeratorAudio's onFinalize), so this confirmation can easily arrive
  // after the speaker is already partway through their next sentence --
  // clearLiveCaption itself no-ops in that case rather than wiping out that
  // in-progress caption.
  const lastMessageIdRef = useRef<number | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.id === lastMessageIdRef.current) return;
    lastMessageIdRef.current = last.id;
    if (last.type === "transcript" && last.userId !== null && last.utteranceId !== undefined) {
      clearLiveCaption(last.userId, last.utteranceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // "If the user at any point closes the mic, the AI moderator is closed as
  // well" -- so losing mic access (denied/revoked permission, device
  // disappearing mid-session) always turns the moderator back off for this
  // user, rather than leaving it in a state that claims to be on but isn't
  // actually capturing anything.
  useEffect(() => {
    if (moderatorActive && micError) {
      disable.mutate({ id: projectId }, { onSuccess: invalidateStatus });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moderatorActive, micError]);

  const handleToggleClick = () => {
    if (moderatorActive) {
      // Pull out whatever's mid-utterance (if anything) and wait for its
      // submission to settle BEFORE deactivating this member server-side.
      // Deactivating first (the old order) would often win the race: the
      // disable request reaches the server, flips this member inactive,
      // and only *then* does turning the mic off trigger the audio hook's
      // own "mic_stop" round trip (which persists whatever OpenAI was still
      // transcribing) -- whose write the server now rejects as coming from
      // an inactive participant, silently dropping whatever was said right
      // before the mic closed. Awaiting sendMicStop's ack first guarantees
      // that last utterance is fully accepted or rejected before the
      // deactivation request is even sent.
      sendMicStop().finally(() => {
        disable.mutate({ id: projectId }, { onSuccess: invalidateStatus });
      });
    } else {
      configure.mutate(
        { id: projectId },
        {
          onSuccess: () => {
            invalidateStatus();
            queryClient.invalidateQueries({ queryKey: getListModeratorChatMessagesQueryKey(projectId) });
          },
        },
      );
    }
  };

  // Reveal messages one at a time with a short "typing..." pause in front of
  // each one, so the AI moderator's own messages feel like they're actually
  // being typed out rather than dumped onto the screen all at once. Messages
  // from real members (transcript/system) don't need this -- they already
  // happened live -- so only "intro" and "intervention" messages get the
  // pause; everything else reveals immediately.
  //
  // This ONLY applies to messages that arrive live while the panel is open.
  // Reopening the shared space and re-fetching history that already
  // happened should never replay that history through the typing animation
  // one bubble at a time -- it should all just be there already, scrolled
  // straight to the bottom, the moment history loads.
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set());
  const [typingMessageId, setTypingMessageId] = useState<number | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  // Whether this browser has EVER finished loading this project's history
  // before -- read once, synchronously, at first render (a plain localStorage
  // read has no side effects, so this is safe outside an effect). Read once
  // and cached in a ref so a later history update (see below) can't flip
  // this mid-session and re-trigger the one-time intro animation.
  const introAlreadySeenRef = useRef<boolean | null>(null);
  if (introAlreadySeenRef.current === null) {
    introAlreadySeenRef.current = localStorage.getItem(introSeenStorageKey(projectId)) === "1";
  }
  const introSeenWrittenRef = useRef(false);
  useEffect(() => {
    if (!introAlreadySeenRef.current && !introSeenWrittenRef.current) {
      introSeenWrittenRef.current = true;
      localStorage.setItem(introSeenStorageKey(projectId), "1");
    }
  }, [projectId]);
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);
  // Every time the persisted history query (re)resolves -- not just the
  // first time -- mark every message it currently contains as already
  // revealed, all in one update. This intentionally reruns on a background
  // refetch too: rejoining a project after being away often serves a STALE
  // cached history response first (missing whatever happened while gone,
  // e.g. this member's own "turned off their microphone" message), which
  // React Query then quietly replaces with a fresh one a moment later. If
  // only the very first history response got this bulk treatment, that
  // fresh refetch's newly-appeared messages would fall through to the
  // per-message effect below and trickle in one at a time -- exactly the
  // "already-existing messages replaying" bug this guards against,
  // regardless of how many times the query re-resolves before settling.
  useEffect(() => {
    if (!history) return;
    const historyMessages = (history.messages as ModeratorChatMessage[] | undefined) ?? [];
    setRevealedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const m of historyMessages) {
        if (next.has(m.id)) continue;
        // The very first time this member's browser ever loads this
        // project's history, leave "intro" messages out of the instant
        // bulk-reveal -- the per-message effect below will then pick them
        // up one at a time through the normal typing-pause path, exactly
        // as if the moderator were live-typing them right now. Every
        // subsequent load (or any message type besides "intro") reveals
        // instantly as before.
        if (!introAlreadySeenRef.current && m.type === "intro") continue;
        next.add(m.id);
        changed = true;
      }
      return changed ? next : prev;
    });
    setHistoryReady(true);
  }, [history]);
  useEffect(() => {
    if (!historyReady) return; // wait for the instant initial reveal above
    if (revealTimerRef.current) return; // a reveal is already in flight
    const next = messages.find((m) => !revealedIds.has(m.id) && m.id !== typingMessageId);
    if (!next) return;
    // Transcript/system messages reveal in the very same render, with no
    // timer at all -- they already just sat there fully visible as a live
    // caption bubble a moment ago (or, for system messages, never needed a
    // typing pause to begin with). The moderator's own "intro" and
    // "intervention" messages used to get an EXTRA client-side typing-pause
    // hold here on top of that -- but the backend already shows its own
    // "moderator is typing" indicator (moderatorTyping prop) for the whole
    // stretch between the message being ready and it being broadcast, so
    // this second hold was pure redundant latency stacked on top of the
    // backend's: the message is fully generated and already sitting in
    // `messages` by the time this effect runs. Reveal it immediately, same
    // as every other message type, to keep the visible delay down to just
    // the backend's own (now much shorter) typing-indicator window.
    setRevealedIds((prev) => new Set(prev).add(next.id));
  }, [messages, revealedIds, historyReady]);
  const visibleMessages = messages.filter((m) => revealedIds.has(m.id));
  const isTyping = typingMessageId !== null;

  // One in-progress bubble per member who currently has actual recognized
  // text coming in -- nothing else. No separate "someone is speaking"
  // indicator, animation, or volume-based trigger; the bubble exists purely
  // to hold the live transcript text as it's captured.
  const speakingMembers = members.filter((m) => !!liveCaptions.get(m.userId)?.text);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is currently parked at the bottom of the panel. Kept
  // as a ref (not just state) so the content-driven scroll effect below can
  // read the latest value without re-running every time it changes --  it
  // should only fire on new content, never merely because the user scrolled.
  const isNearBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // Our own scroll-into-view calls also fire native "scroll" events -- this
  // distinguishes those from a real user gesture so they don't get
  // misread as "the user scrolled up" or flash the custom scrollbar.
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showNewMessagePill, setShowNewMessagePill] = useState(false);

  // Custom scrollbar thumb -- the native one is hidden (see className below)
  // so we can control exactly when it's visible: only while the user is
  // actively scrolling, never just because new content pushed the track
  // height around.
  const [thumb, setThumb] = useState({ heightPct: 100, topPct: 0, canScroll: false });
  const updateThumbMetrics = (el: HTMLDivElement) => {
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    if (!canScroll) {
      setThumb({ heightPct: 100, topPct: 0, canScroll: false });
      return;
    }
    const heightPct = Math.max((el.clientHeight / el.scrollHeight) * 100, 10);
    const maxScrollTop = el.scrollHeight - el.clientHeight;
    const scrollRatio = maxScrollTop > 0 ? el.scrollTop / maxScrollTop : 0;
    setThumb({ heightPct, topPct: scrollRatio * (100 - heightPct), canScroll: true });
  };
  useEffect(() => {
    const contentEl = scrollContentRef.current;
    const containerEl = scrollContainerRef.current;
    if (!contentEl || !containerEl) return;
    const observer = new ResizeObserver(() => updateThumbMetrics(containerEl));
    observer.observe(contentEl);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [scrollbarVisible, setScrollbarVisible] = useState(false);
  const scrollbarHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showScrollbarBriefly = () => {
    setScrollbarVisible(true);
    if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);
    scrollbarHideTimeoutRef.current = setTimeout(() => setScrollbarVisible(false), 800);
  };
  // Live captions can retrigger our own smooth scrollToBottom() every time a
  // few characters come in -- while that's happening, "programmaticScrollRef"
  // stays true almost continuously, so the resulting native "scroll" events
  // can't be trusted to tell a real user gesture apart from our own call.
  // Reading intent straight off the wheel/touch gesture instead sidesteps
  // that race entirely: these events are never fired by our own JS-driven
  // scrollIntoView, only by the user's hands, so they're a reliable signal
  // no matter what our own in-flight scroll animation is doing.
  const touchStartYRef = useRef<number | null>(null);
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    showScrollbarBriefly();
    if (e.deltaY < 0) {
      // Scrolling up, however slightly -- immediately break auto-follow and
      // stop treating any in-flight smooth scroll as still "ours to finish".
      isNearBottomRef.current = false;
      programmaticScrollRef.current = false;
    }
  };
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  };
  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    showScrollbarBriefly();
    const startY = touchStartYRef.current;
    const currentY = e.touches[0]?.clientY;
    if (startY !== null && currentY !== undefined) {
      // Finger moving down the screen reveals earlier content -- i.e. the
      // view is scrolling up.
      if (currentY - startY > 0) {
        isNearBottomRef.current = false;
        programmaticScrollRef.current = false;
      }
      touchStartYRef.current = currentY;
    }
  };
  useEffect(() => {
    return () => {
      if (scrollbarHideTimeoutRef.current) clearTimeout(scrollbarHideTimeoutRef.current);
      if (programmaticScrollTimeoutRef.current) clearTimeout(programmaticScrollTimeoutRef.current);
    };
  }, []);

  const handlePanelScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    updateThumbMetrics(el);
    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    const scrolledDown = el.scrollTop > lastScrollTopRef.current;
    if (scrolledUp) {
      // Any upward movement at all immediately breaks auto-follow -- no
      // threshold, no minimum distance, no grace window.
      isNearBottomRef.current = false;
    } else if (scrolledDown && distanceFromBottom < 4) {
      // Resume auto-follow only when a genuine downward scroll is what
      // landed the view at the bottom -- merely sitting near the bottom
      // (e.g. because content above shrank, or the position never moved)
      // must not silently re-arm it.
      isNearBottomRef.current = true;
      setShowNewMessagePill(false);
    }
    lastScrollTopRef.current = el.scrollTop;
  };
  const scrollToBottom = (behavior: ScrollBehavior) => {
    programmaticScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior });
    isNearBottomRef.current = true;
    setShowNewMessagePill(false);
    if (programmaticScrollTimeoutRef.current) clearTimeout(programmaticScrollTimeoutRef.current);
    programmaticScrollTimeoutRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, behavior === "smooth" ? 600 : 50);
  };
  // The initial backlog jumps straight to the bottom instantly -- it's not
  // new activity, so an animated scroll through everything that already
  // happened would feel like a slow replay instead of just reopening the
  // panel where it left off. Only messages/activity from here on scroll in
  // smoothly.
  useEffect(() => {
    if (!historyReady) return;
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyReady]);
  // Live caption text itself -- not just a box appearing/disappearing --
  // has to be a scroll trigger too. Without it, a box that grows past one
  // line while someone keeps talking silently overflows the bottom of the
  // panel (the scroll position never moves while it's just this box getting
  // taller), and then the eventual finalize-triggered scroll has to jump
  // several lines at once, which reads as a sudden change of location. Once
  // this keeps the box's growth followed smoothly line by line, finalizing
  // it into a permanent message doesn't change the panel's total height and
  // this same effect is a no-op then -- no extra jump at the end.
  //
  // But only while the user is already parked near the bottom -- someone
  // scrolled up to reread earlier messages should never get yanked back
  // down by new content; they instead get a "new messages" pill they can
  // tap once they're ready to catch up.
  const liveCaptionsKey = speakingMembers.map((m) => `${m.userId}:${liveCaptions.get(m.userId)?.text ?? ""}`).join("|");
  useEffect(() => {
    if (!historyReady) return;
    if (isNearBottomRef.current) {
      scrollToBottom("smooth");
    } else {
      setShowNewMessagePill(true);
    }
  }, [historyReady, visibleMessages.length, isTyping, moderatorTyping, speakingMembers.length, liveCaptionsKey]);

  return (
    <aside
      className={`shrink-0 h-full flex-col border rounded-2xl shadow-sm bg-card overflow-hidden ${className ?? "w-full flex xl:w-[28vw] xl:min-w-[22rem]"}`}
    >
      <div className="flex items-center justify-center h-14 px-4 border-b shrink-0">
        <span className="font-semibold text-sm">Discussion</span>
      </div>

      {moderatorErrorMessage && (
        <div className="flex items-start gap-2 bg-destructive/10 border-b border-destructive/30 text-destructive text-xs font-medium px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{moderatorErrorMessage}</span>
          <button onClick={onDismissError} className="opacity-70 hover:opacity-100 shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handlePanelScroll}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          className="h-full overflow-y-auto px-3 py-3 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          <div ref={scrollContentRef} className="flex flex-col gap-3">
            {visibleMessages.length === 0 && !isTyping && !(moderatorEnabled && moderatorTyping) && (
              <p className="text-xs text-muted-foreground text-center mt-6">
                {moderatorEnabled
                  ? "The AI moderator's messages will appear here once the shared workspace is open."
                  : "Messages will appear here"}
              </p>
            )}
            {visibleMessages.map((message) => (
              <ChatMessageBubble key={message.id} message={message} members={members} />
            ))}
            {/* The backend only ever sends this once it has already
                confirmed all 3 intervention conditions and durably
                committed the message -- so this indicator is a guarantee,
                not a guess, that real content follows shortly. Suppressed
                along with the messages themselves when this project has
                moderator display turned off: showing "typing..." would
                still tip members off that the moderator is about to weigh
                in, even with the eventual message itself hidden. */}
            {(isTyping || (moderatorEnabled && moderatorTyping)) && <TypingIndicatorBubble />}
            {speakingMembers.map((m) => (
              <LiveTranscriptBubble
                key={m.userId}
                username={m.username}
                colorSlot={m.colorSlot}
                caption={liveCaptions.get(m.userId)?.text ?? ""}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
        {thumb.canScroll && (
          <div
            aria-hidden
            className="absolute right-1 w-1.5 rounded-full bg-foreground/25 pointer-events-none transition-opacity duration-300"
            style={{ height: `${thumb.heightPct}%`, top: `${thumb.topPct}%`, opacity: scrollbarVisible ? 1 : 0 }}
          />
        )}
        {showNewMessagePill && (
          <button
            onClick={() => scrollToBottom("smooth")}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-medium pl-3 pr-3.5 py-1.5 rounded-full shadow-md hover:opacity-90 transition-opacity"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            New messages
          </button>
        )}
      </div>

      <div className="border-t shrink-0 p-3 flex flex-col gap-2">
        {configure.isError && !moderatorActive && (
          <p className="text-[11px] font-medium text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-2.5 py-1.5">
            {(configure.error as any)?.data?.error || "Could not turn on the AI moderator."}
          </p>
        )}
        <div className="flex items-center gap-2 bg-muted/50 border rounded-full pl-3 pr-2.5 py-2 min-w-0">
          {moderatorActive ? (
            <Mic className="w-4 h-4 text-primary shrink-0" />
          ) : (
            <MicOff className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
          <span className="flex-1 text-xs font-medium text-muted-foreground truncate">Microphone</span>
          <Switch
            checked={moderatorActive}
            onCheckedChange={handleToggleClick}
            disabled={disable.isPending || configure.isPending || (!moderatorActive && !moderatorConfigured)}
          />
        </div>
      </div>
    </aside>
  );
}

function TypingIndicatorBubble() {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <Sparkles className="w-3 h-3 text-muted-foreground" />
        AI moderator
      </div>
      <div className="rounded-xl rounded-tl-sm px-3 py-2.5 bg-muted w-fit flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.3s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
      </div>
    </div>
  );
}

// The in-progress message box for whoever is currently talking -- styled
// identically to a real, persisted ChatMessageBubble (same colors, same
// shape) so the transition from "still talking" to "said it" is seamless,
// with a blinking cursor as the one visual cue that it's still live. This
// growing text IS what becomes the permanent transcript message once
// silence finalizes it (see useModeratorAudio's onFinalize) -- it is never
// replaced by a separately-transcribed version. It only exists once there
// is actual recognized text to show -- no separate "someone is speaking"
// indicator or animation of any kind.
// Memoized: with multiple speakers active at once, each one's caption
// updates on its own throttled cadence (see CAPTION_SEND_INTERVAL_MS in
// useModeratorAudio.ts) and triggers a state update in the parent's
// liveCaptions map. Without memoizing, that re-renders every OTHER
// speaker's bubble and the entire persisted message list too, even though
// their props didn't change -- multiplying the render cost by however many
// people are talking. Memoizing means only the bubble whose own caption
// text actually changed re-renders.
const LiveTranscriptBubble = memo(function LiveTranscriptBubble({
  username,
  colorSlot,
  caption,
}: {
  username: string;
  colorSlot: number;
  caption: string;
}) {
  const color = colorForSlot(colorSlot);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: color.solid }}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color.solid }} />
        {username}
      </div>
      {/* Same container classes/box model AND colors as ChatMessageBubble's
          transcript case below -- no w-fit, no flex row -- so finalizing
          this into a real message swaps text content only, with the box
          never resizing, recoloring, or re-laying-out at the transition
          point. The blinking cursor is just one more inline character at
          the end of the text, not a layout-affecting flex child. */}
      <div className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-primary/10 text-foreground">
        {caption}
        <span className="inline-block w-[2px] h-3 ml-0.5 align-middle animate-pulse bg-foreground" />
      </div>
    </div>
  );
});

// Memoized for the same reason as LiveTranscriptBubble above: a persisted
// message's props never change once rendered, so it should never
// re-render just because some other speaker's live caption ticked.
const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  members,
}: {
  message: ModeratorChatMessage;
  members: { userId: number; username: string; colorSlot: number }[];
}) {
  // A matched intervention with an actual pro/con breakdown gets the
  // supporter-pill visualization instead of a wall of text -- see
  // InterventionSummary below. Everything else the moderator says (intro,
  // mic on/off announcements, an unmatched "couldn't tell what this was
  // about" reminder) keeps the plain bubble.
  if (
    message.type === "intervention" &&
    message.matched &&
    ((message.examples?.length ?? 0) > 0 || (message.counterexamples?.length ?? 0) > 0)
  ) {
    return (
      <InterventionSummary
        className={message.className}
        propertyName={message.propertyName}
        examples={message.examples ?? []}
        counterexamples={message.counterexamples ?? []}
        members={members}
        createdAt={message.createdAt}
      />
    );
  }

  // The one-time "consensus reached, AI moderator stopped" notice -- a
  // permanent record of what happened, not something the moderator is
  // "saying", so it gets its own centered, quieter treatment rather than
  // the AI-moderator speech bubble used for intro/intervention messages.
  if (message.type === "export_notice") {
    return (
      <div className="flex items-center gap-2 py-1 px-2">
        <div className="flex-1 h-px bg-border" />
        <p className="text-[11px] font-medium text-muted-foreground text-center whitespace-pre-wrap">
          {message.content}
        </p>
        <div className="flex-1 h-px bg-border" />
      </div>
    );
  }

  // Intro / mic on-off announcements / stalled-discussion interventions are
  // all things the AI moderator itself is saying -- same title, icon, and
  // color regardless of which member the announcement is about.
  if (message.type === "intro" || message.type === "system" || message.type === "intervention") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <Sparkles className="w-3 h-3 text-primary" />
          AI moderator
          <span className="font-normal opacity-70">{formatTimestamp(message.createdAt)}</span>
        </div>
        <div className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-primary/10 text-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  // transcript -- same neutral bubble as the AI moderator's own messages
  // (so the panel isn't a wall of clashing per-member tints), but the
  // username keeps its workspace color plus a small colored dot -- the
  // same dot size used for supporters in the intervention pro/con cards
  // (InterventionEntryCard below) -- so who said what is still identifiable
  // at a glance.
  const color = colorForSlot(message.colorSlot ?? 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: color.solid }}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color.solid }} />
        {message.username ?? "unknown"}
        <span className="font-normal opacity-70">{formatTimestamp(message.createdAt)}</span>
      </div>
      <div className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-primary/10 text-foreground">
        {message.content}
      </div>
    </div>
  );
});

// A stalled-discussion intervention that resolved to a real class/property:
// two stacked "supporter pill" cards -- green for reasons to keep the
// property, red for reasons to remove it -- instead of a wall of prose.
// Each row is one distinct point, weighted by how many members
// independently made it: more supporters means a more saturated pill and
// more colored dots (one per supporter, in that member's own workspace
// color) stacked to its left, mirroring the reference design's "darker and
// more dots = more agreement" visual language.
function InterventionSummary({
  className,
  propertyName,
  examples,
  counterexamples,
  members,
  createdAt,
}: {
  className: string | null;
  propertyName: string | null;
  examples: { text: string; by: string[] }[];
  counterexamples: { text: string; by: string[] }[];
  members: { userId: number; username: string; colorSlot: number }[];
  createdAt: string;
}) {
  const membersByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) map.set(m.username.trim().toLowerCase(), m.colorSlot);
    return map;
  }, [members]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <Sparkles className="w-3 h-3 text-primary" />
        AI moderator
        <span className="font-normal opacity-70">{formatTimestamp(createdAt)}</span>
      </div>
      <div className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed bg-primary/10 text-foreground">
        <span className="font-semibold">
          Discussion may have stalled – {className}.{propertyName}
        </span>
        <p className="mt-1 text-muted-foreground">Here's where things stand:</p>
      </div>
      <InterventionEntryCard label="For keeping it" tone="positive" entries={examples} membersByName={membersByName} />
      <InterventionEntryCard label="For removing it" tone="negative" entries={counterexamples} membersByName={membersByName} />
      <div className="rounded-xl px-3 py-2 text-xs leading-relaxed bg-primary/10 text-foreground">
        Would you like to continue discussing, or move to a vote?
      </div>
    </div>
  );
}

const INTERVENTION_TONE_STYLES = {
  positive: {
    border: "border-emerald-500/70",
    label: "text-emerald-600 dark:text-emerald-400",
    // Index 0 = fewest supporters (lightest) -> last = all members (darkest).
    // Only three members can ever back a point in this app, so three shades
    // is always enough -- entries with more supporters than shades defined
    // here just clamp to the darkest one.
    shades: ["bg-emerald-100 text-emerald-900", "bg-emerald-300 text-emerald-950", "bg-emerald-500 text-white"],
  },
  negative: {
    border: "border-red-500/70",
    label: "text-red-600 dark:text-red-400",
    shades: ["bg-red-100 text-red-900", "bg-red-300 text-red-950", "bg-red-500 text-white"],
  },
} as const;

function InterventionEntryCard({
  label,
  tone,
  entries,
  membersByName,
}: {
  label: string;
  tone: "positive" | "negative";
  entries: { text: string; by: string[] }[];
  membersByName: Map<string, number>;
}) {
  const styles = INTERVENTION_TONE_STYLES[tone];
  return (
    <div className={`rounded-2xl border-2 ${styles.border} p-2.5 flex flex-col gap-2`}>
      <div className={`text-[11px] font-semibold ${styles.label}`}>{label}</div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic px-1">(none given yet)</div>
      ) : (
        entries.map((entry, i) => {
          const shadeIndex = Math.min(Math.max(entry.by.length, 1), styles.shades.length) - 1;
          return (
            <div key={i} className="flex items-center gap-2">
              <div className="flex flex-col items-center gap-0.5 w-2 shrink-0">
                {(entry.by.length > 0 ? entry.by : ["?"]).map((name, j) => {
                  const slot = membersByName.get(name.trim().toLowerCase());
                  const dotColor = slot !== undefined ? colorForSlot(slot).solid : "hsl(var(--muted-foreground))";
                  return <span key={j} className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />;
                })}
              </div>
              <div className={`flex-1 rounded-full px-3 py-1.5 text-xs leading-tight ${styles.shades[shadeIndex]}`}>
                {entry.text}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
