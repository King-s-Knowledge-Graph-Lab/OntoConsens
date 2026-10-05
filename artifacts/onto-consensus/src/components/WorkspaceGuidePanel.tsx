import { ArrowDown } from "lucide-react";

interface GuideStep {
  title: string;
  description: string;
}

interface WorkspaceGuidePanelProps {
  /** Has the current member marked themselves ready yet. */
  isReady: boolean;
  /** Has the whole project reached full membership with everyone ready. */
  allReady: boolean;
  /** Every property in the shared workspace has full agreement. */
  workspaceFullyAgreed: boolean;
  className?: string;
}

const STEPS: GuideStep[] = [
  {
    title: "Propose your properties",
    description:
      "In your individual workspace, add the properties you think each class should have. Nobody else can see these yet. Once you're happy with your proposals, mark yourself ready in the top right bar.",
  },
  {
    title: "Wait for everyone to be ready",
    description:
      "When everyone is ready, the shared workspace will open and you'll see everyone's proposals together.",
  },
  {
    title: "Reach agreement together",
    description:
      "The shared workspace is open. Proposals are color-coded by member (see the top-right bar). Shared proposals show as a stack of the colors of everyone who proposed them. Open the microphone at the bottom right, and discuss with your group members to reach agreement on all properties that haven't been agreed yet. Click a proposal to agree, click again to remove your agreement. Once agreement has been made on all properties, the export button will be enabled.",
  },
  {
    title: "Export",
    description:
      "Click the export button at the bottom center of the page, where the current shared workspace along with the discussion history will be downloaded into 2 independent JSON files that can be reused for later tasks.",
  },
];

/** Which of the four steps above is the member's current focus, given where
 *  the project and this member currently stand. */
function currentStepIndex(isReady: boolean, allReady: boolean, workspaceFullyAgreed: boolean): number {
  if (workspaceFullyAgreed) return 3;
  if (allReady) return 2;
  if (isReady) return 1;
  return 0;
}

/**
 * Persistent left-hand panel that reminds the current member what their
 * current task is and what comes next -- a straight top-to-bottom list of
 * the four steps to finish the workflow, connected by down arrows. Distinct
 * from the canvas (what the workspace currently looks like) and the
 * discussion panel (what's being said). Purely derived from state already
 * tracked on the project page.
 */
export function WorkspaceGuidePanel({
  isReady,
  allReady,
  workspaceFullyAgreed,
  className,
}: WorkspaceGuidePanelProps) {
  const current = currentStepIndex(isReady, allReady, workspaceFullyAgreed);

  return (
    <aside
      className={`shrink-0 h-full flex-col border rounded-2xl shadow-sm bg-card overflow-hidden ${className ?? "w-full hidden xl:flex xl:w-96"}`}
    >
      <div className="flex items-center justify-center h-14 px-4 border-b shrink-0">
        <span className="font-semibold text-sm">User Guide</span>
      </div>

      {/* pt-3 matches the top padding of the Discussion panel's own
          scrollable message area, so step 1 lines up with its first
          "AI moderator" message label. pb-3 matches the bottom padding
          of that panel's mic-toggle footer, so the last step's bottom
          lines up with the bottom of the microphone toggle. The gaps
          between steps are the flex-1 spacer divs below (holding the
          arrows), not the step blocks themselves, so all three gaps
          share the leftover vertical space equally regardless of how
          long each step's description is. */}
      {/* The scrolling and the centering are split across two nested divs
          on purpose: a flex container with justify-center that is also the
          overflow-y-auto element can't be scrolled up to its own start in
          most browsers once content is taller than it (the "centered
          overflow" trap). Making the outer div a plain block scroll
          container, with an inner flex container that's only as tall as
          its own content (min-h-full, not h-full), sidesteps that --
          justify-center still centers the steps when there's extra room,
          but once content overflows the inner flex box just sizes to fit
          it exactly (nothing left to center), so normal top-to-bottom
          scrolling reaches every step including the first. */}
      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin]">
        <div className="min-h-full flex flex-col justify-center px-4 pt-3 pb-3">
          {STEPS.map((step, i) => {
            const isCurrent = i === current;
            return (
              <div key={step.title} className="contents">
                <div className="px-3 shrink-0">
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                        isCurrent ? "bg-foreground text-background" : "bg-muted/60 text-muted-foreground/40"
                      }`}
                    >
                      {i + 1}
                    </div>
                    <p
                      className={`text-sm font-semibold leading-tight ${
                        isCurrent ? "text-foreground" : "text-muted-foreground/40"
                      }`}
                    >
                      {step.title}
                    </p>
                  </div>
                  <p
                    className={`text-xs leading-snug pl-7 text-justify ${
                      isCurrent ? "text-muted-foreground" : "text-muted-foreground/30"
                    }`}
                  >
                    {step.description}
                  </p>
                </div>

                {i < STEPS.length - 1 && (
                  <div className="h-16 shrink-0 flex items-center justify-center">
                    <ArrowDown className="w-4 h-4 text-muted-foreground/25" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
