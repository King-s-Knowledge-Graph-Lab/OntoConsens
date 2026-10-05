import {
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence, type Transition } from "framer-motion";
import {
  useGetProject,
  getGetProjectQueryKey,
  useListProperties,
  getListPropertiesQueryKey,
  useCreateProperty,
  useRetractProperty,
  useAgreeProperty,
} from "@workspace/api-client-react";
import type { OntologyClass, OntologyRelation, Property } from "@workspace/api-client-react";
import { colorForSlot } from "@/lib/memberColors";
import type { RemoteCursor } from "@/hooks/useProjectSocket";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface GraphCanvasProps {
  projectId: number;
  currentUserId: number;
  cursors: Map<number, RemoteCursor>;
  sendCursor: (x: number, y: number) => void;
  /** True once every project member has marked ready — the merged consensus
   * space (shared properties + live cursors) only appears then. */
  sharedModeEnabled: boolean;
  /** True once the current user has marked themselves ready but the shared
   * space hasn't opened yet (still waiting on others) — their own private
   * space is frozen as a one-way commitment, so add/edit/remove on their
   * own proposals must be disabled client-side too (the server also
   * rejects them, but this avoids a round-trip error). */
  ownSpaceLocked: boolean;
  /** The class/property the AI moderator's last summary popup was about,
   * briefly highlighted here right after that popup disappears — gives its
   * takeaway somewhere to land. Null the rest of the time. */
  highlightedProperty?: { classId: number; propertyId: number } | null;
}

interface LaidOutClass extends OntologyClass {
  depth: number;
  x: number;
  y: number;
}

// Each class renders as a circular badge (class label) surrounded by a ring
// of tilted, petal-like tabs — one per property — radiating outward, similar
// to flower petals / gear teeth. Every petal's *center point* is placed by
// trigonometry at a fixed distance from the badge's center, then the petal
// is rotated in place (plain `rotate()`, default center origin) to face
// outward — this is deliberate: combining `translate()` and `rotate()` in a
// single transform with a custom transform-origin does NOT pivot around the
// translated position (the origin applies to the whole composed matrix, not
// sequentially), so that approach silently flings rotated petals away from
// the circle instead of anchoring them to it. Positioning by trig first and
// rotating in place afterward sidesteps that trap entirely.
const CIRCLE_SIZE = 128;
const CIRCLE_RADIUS = CIRCLE_SIZE / 2;
// The largest square that fits entirely inside the circle's inner (border-
// excluded) diameter -- side = diameter / sqrt(2). Constraining the label's
// wrapping box to this size, rather than the circle's full bounding box,
// guarantees every corner of a multi-line label stays inside the circle
// instead of being clipped by its curve or covered by the border frame.
const CLASS_LABEL_BOX_SIZE = (CIRCLE_SIZE - 8) / Math.SQRT2;
const PETAL_WIDTH = 56;
const PETAL_LENGTH = 64;
// Clear space between the circle's edge and the nearest petal — the shape
// must never touch the badge.
const GAP_TO_NODE = 14;

/** Distance from the circle's center to the middle of a floating (not yet
 * fully agreed) petal. */
const PETAL_CENTER_DIST = CIRCLE_RADIUS + GAP_TO_NODE + PETAL_LENGTH / 2;
/** Outer edge of the whole petal ring — used to anchor connecting lines and
 * property-name labels outside the ring instead of guessing a fixed offset. */
const RING_OUTER_RADIUS = CIRCLE_RADIUS + GAP_TO_NODE + PETAL_LENGTH;
const LABEL_DIST = RING_OUTER_RADIUS + 14;
// A fixed footprint for the label box itself. Positioning it via plain
// arithmetic (anchor minus half of these fixed dimensions, computed in JS)
// rather than a CSS percentage `translate(-50%,-50%)` removes any ambiguity
// from how a browser/framer composes translate+rotate on the same element —
// rotating a box of KNOWN width/height around its own default center origin
// cannot move that center, full stop, no percentage-transform math involved.
// Bound to the petal's own width (not a wider arbitrary box) so a long
// property name wraps onto extra lines instead of ever reading wider than
// the petal it belongs to — true for both the floating label and the
// docked in-petal text. Height is intentionally not fixed: a wrapped label
// grows from a pinned edge (see `PropertyLabel`), not a fixed box.
const LABEL_WIDTH = PETAL_WIDTH;

// Once every project member has agreed on a property, its petal "docks"
// directly onto the node: same petal shape and outward tilt as before, just
// pulled inward so a real chunk of its base slides underneath the circle
// (which is drawn on top, z-index 20, same as it already hides every
// floating petal's inner pivot end) — reads as the petal being plugged
// into the node, not just touching its edge.
const DOCK_OVERLAP = 22;
const DOCK_DIST = CIRCLE_RADIUS + PETAL_LENGTH / 2 - DOCK_OVERLAP;

// How far past the label ring a connecting line must stop so it clears the
// property-name badges instead of running underneath them. Comfortably
// beyond LABEL_DIST (which already sits at the petal ring's outer edge) to
// leave a clear visual gap before the line reaches either node.
const LINE_CLEARANCE = LABEL_DIST + 40;

// The project-wide property budget (see getPropertyQuota on the backend:
// 7 for a solo project, 4+3 for two members, 3+2+2 for three) always sums
// to this. Used as a FIXED wedge count for every class's property ring so
// that adding or removing a property never reshuffles the angle of any
// other already-placed petal or the add button.
const TOTAL_PROPERTY_SLOTS = 7;

// Mirrors the backend's PROPERTY_QUOTAS_BY_MEMBER_COUNT / getPropertyQuota
// (see artifacts/api-server/src/routes/properties.ts) exactly, so the "at
// cap" check can be computed instantly from the properties already sitting
// in the local (optimistic) query cache instead of waiting on a project
// refetch — the add/remove of a property is otherwise already reflected in
// this component immediately, so the affordance that depends on it must be
// too, or there's a visible lag between the two.
const PROPERTY_QUOTAS_BY_MEMBER_COUNT: Record<number, number[]> = {
  1: [7],
  2: [4, 3],
  3: [3, 2, 2],
};

function getPropertyQuota(memberCount: number, colorSlot: number): number {
  const quotas = PROPERTY_QUOTAS_BY_MEMBER_COUNT[memberCount] ?? PROPERTY_QUOTAS_BY_MEMBER_COUNT[3];
  return quotas[colorSlot] ?? quotas[quotas.length - 1];
}

/** Square footprint big enough to fit the full ring of petals plus label
 * overhang, without clipping into neighboring nodes. */
function computeNodeSize(): number {
  return Math.round((LABEL_DIST + 60) * 2);
}
const NODE_SIZE = computeNodeSize();

/** Center point of a petal placed at `angle` degrees (0 = straight up,
 * clockwise) and `dist` px from a circle centered at (originX, originY). */
function petalCenter(angle: number, originX: number, originY: number, dist: number) {
  const rad = (angle * Math.PI) / 180;
  return {
    x: originX + Math.sin(rad) * dist,
    y: originY - Math.cos(rad) * dist,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// A label rotated to exactly match its petal's outward angle would read
// upside-down on the lower half of the circle — this folds any angle by
// exactly +-180 degrees when needed so the text always reads upright,
// landing the result in [-90, 90]. That's the ONLY adjustment: no
// additional amplitude clamp on top of it, because a fold of exactly 180
// degrees is visually invisible on the box itself (a rectangle has 180-
// degree rotational symmetry), while clamping the amplitude beyond that
// (e.g. capping to +-55) would visibly rotate the box away from the
// petal's true outward angle for anything near horizontal -- which is
// exactly the anchor-following-my-rule bug reported for near-horizontal
// petals. The box's anchor point itself is computed elsewhere from the
// raw (unfolded) angle and never depends on this function.
function labelRotation(petalAngle: number): number {
  let a = ((petalAngle % 360) + 360) % 360; // 0..360
  if (a > 180) a -= 360; // -180..180
  if (a > 90) a -= 180;
  else if (a < -90) a += 180;
  return a;
}

// A property's name label. The box itself is rotated by the exact same raw,
// continuous `angle` as its petal (never a folded/clamped copy) — that's
// what the petal's own frame already does, so giving the label the identical
// value guarantees the two move in perfect lockstep, with no separate spin
// of its own, no matter how a sibling deletion reshuffles indices.
//
// Rotating by the true (unclamped) outward angle also means the box's local
// "up" edge always ends up pointing away from the node, for every angle
// around the full circle, with no left/right-side special case: pin the
// anchor to that edge (i.e. position via `bottom`, growing upward) and it's
// simultaneously correct everywhere and a single continuous value for
// Framer to tween, exactly like `left` and `rotate`.
//
// The one thing raw rotation doesn't give you for free is upright text —
// for roughly half the circle it would read upside-down. That's corrected
// on a separate, un-animated inner wrapper that just counter-rotates by
// whatever exact multiple of 180 degrees keeps the text legible (the same
// `labelAngle - angle` trick already used for the docked in-petal label,
// see below). Since that correction lives outside the `animate` object
// entirely, it pops instantly rather than tweening — but it only ever
// flips a small text element in place, not the whole box's position, so it
// never produces the "extra spin" the outer box+petal apparently show.
function PropertyLabel({
  name,
  angle,
  labelAngle,
  left,
  labelCenterY,
  nodeSize,
  transition,
}: {
  name: string;
  angle: number;
  labelAngle: number;
  left: number;
  labelCenterY: number;
  nodeSize: number;
  transition: Transition;
}) {
  return (
    <motion.div
      initial={false}
      animate={{ left, bottom: nodeSize - labelCenterY, rotate: angle }}
      transition={transition}
      className="pointer-events-none absolute flex flex-col justify-end"
      style={{ width: LABEL_WIDTH, zIndex: 30, transformOrigin: "50% 100%" }}
    >
      <div style={{ transform: `rotate(${labelAngle - angle}deg)` }}>
        <span
          className="line-clamp-3 w-full text-center text-[10px] font-medium leading-tight text-foreground [overflow-wrap:anywhere]"
          style={{
            textShadow:
              "0 0 3px hsl(var(--background)), 0 0 3px hsl(var(--background)), 0 0 5px hsl(var(--background))",
          }}
        >
          {name}
        </span>
      </div>
    </motion.div>
  );
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

function distanceBetween(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpointOf(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

// Left-to-right pyramid layout: depth (generation) maps to the horizontal
// axis instead of the vertical one, so the hierarchy narrows toward the root
// on the left and fans out toward its leaves on the right. This is an
// adaptive tidy-tree placement, not a fixed grid — each node's vertical slot
// is derived from how many leaves its subtree contains, so it resolves into
// a clean pyramid for any mix of branching and depth, not just one
// pre-tuned case.
function layoutClasses(
  classes: OntologyClass[],
  relations: OntologyRelation[],
  nodeSize: number,
): LaidOutClass[] {
  const rowHeight = nodeSize + 50;
  const colGap = 160;
  const idSet = new Set(classes.map((c) => c.id));
  const parentOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  for (const rel of relations) {
    if (!idSet.has(rel.childId) || !idSet.has(rel.parentId)) continue;
    parentOf.set(rel.childId, rel.parentId);
    const list = childrenOf.get(rel.parentId) ?? [];
    list.push(rel.childId);
    childrenOf.set(rel.parentId, list);
  }

  const positions = new Map<number, { x: number; y: number; depth: number }>();
  const visited = new Set<number>();
  let leafCursor = 0;

  // Returns the vertical slot (in leaf units) this node's subtree is
  // centered on, so a parent with several children centers over their span.
  function place(id: number, depth: number): number {
    if (visited.has(id)) return leafCursor;
    visited.add(id);
    const kids = (childrenOf.get(id) ?? []).filter((k) => !visited.has(k));
    let slot: number;
    if (kids.length === 0) {
      slot = leafCursor;
      leafCursor += 1;
    } else {
      const childSlots = kids.map((k) => place(k, depth + 1));
      slot = (Math.min(...childSlots) + Math.max(...childSlots)) / 2;
    }
    positions.set(id, { x: depth * (nodeSize + colGap), y: slot * rowHeight, depth });
    return slot;
  }

  const roots = classes.filter((c) => !parentOf.has(c.id));
  for (const root of roots) place(root.id, 0);
  // Anything unreachable (orphaned by a cycle, defensively) still needs a
  // slot so it isn't silently dropped from the canvas.
  for (const cls of classes) {
    if (!positions.has(cls.id)) {
      positions.set(cls.id, { x: 0, y: leafCursor * rowHeight, depth: 0 });
      leafCursor += 1;
    }
  }

  return classes.map((cls) => ({ ...cls, ...positions.get(cls.id)! }));
}

export function GraphCanvas({
  projectId,
  currentUserId,
  cursors,
  sendCursor,
  sharedModeEnabled,
  ownSpaceLocked,
  highlightedProperty,
}: GraphCanvasProps) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  // The transformed content layer's own DOM node — pan/zoom writes to its
  // `style.transform` directly on every raw pointer/wheel event, bypassing
  // React entirely, so the board tracks the input device with zero frames
  // of latency. `view` (React state) still exists and is committed at most
  // once per animation frame — it's what everything else (this file only
  // reads `view` for one thing: the very same transform, so nothing else
  // needs to re-render mid-gesture) eventually settles on, but the pixels
  // on screen never wait for a React re-render to move.
  const contentLayerRef = useRef<HTMLDivElement>(null);
  const [addingToClass, setAddingToClass] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");

  // The board never uses native scrolling — panning and zooming are handled
  // entirely by this transform, driven by explicit gestures (right-click
  // drag, trackpad two-finger slide, touch drag, wheel/pinch to zoom) so the
  // page itself never scrolls or bounces.
  const [view, setView] = useState<ViewTransform>({ x: 40, y: 20, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pendingViewCommit = useRef(false);

  const applyViewToDom = useCallback((v: ViewTransform) => {
    const node = contentLayerRef.current;
    if (node) {
      node.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    }
  }, []);

  // Every gesture step calls this: update the ref + DOM synchronously (so
  // the visual result is never behind the input), then coalesce the
  // React-state commit to once per animation frame instead of once per
  // pointermove/wheel tick, since a drag or a trackpad zoom can fire far
  // more often than the screen can even repaint.
  const commitView = useCallback(
    (next: ViewTransform) => {
      viewRef.current = next;
      applyViewToDom(next);
      if (pendingViewCommit.current) return;
      pendingViewCommit.current = true;
      requestAnimationFrame(() => {
        pendingViewCommit.current = false;
        setView(viewRef.current);
      });
    },
    [applyViewToDom],
  );

  const panDragRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const touchPanRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);

  // Every pan/zoom gesture funnels through zoomAt/panBy, so marking
  // "interacting" there (rather than in each individual gesture handler)
  // covers wheel, drag, touch-drag, and pinch alike. While this is true,
  // every motion element below renders with a zero-duration transition
  // instead of its normal spring/ease — the shapes, labels, and fill bands
  // must track the view transform rigidly, with no catch-up animation, and
  // only resume animating once a real state change happens after the user
  // stops touching the canvas.
  const [isViewInteracting, setIsViewInteracting] = useState(false);
  const interactionEndTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const markViewInteracting = useCallback(() => {
    setIsViewInteracting(true);
    if (interactionEndTimer.current) clearTimeout(interactionEndTimer.current);
    interactionEndTimer.current = setTimeout(() => setIsViewInteracting(false), 120);
  }, []);

  useEffect(() => {
    return () => {
      if (interactionEndTimer.current) clearTimeout(interactionEndTimer.current);
    };
  }, []);

  const zoomAt = useCallback((screenX: number, screenY: number, factor: number) => {
    markViewInteracting();
    const prev = viewRef.current;
    const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = newZoom / prev.zoom;
    commitView({
      x: screenX - (screenX - prev.x) * ratio,
      y: screenY - (screenY - prev.y) * ratio,
      zoom: newZoom,
    });
  }, [markViewInteracting, commitView]);

  const panBy = useCallback((dx: number, dy: number) => {
    markViewInteracting();
    const prev = viewRef.current;
    commitView({ ...prev, x: prev.x + dx, y: prev.y + dy });
  }, [markViewInteracting, commitView]);

  const stateTransition = { type: "spring", stiffness: 260, damping: 28 } as const;
  const activeTransition = isViewInteracting ? { duration: 0 } : stateTransition;
  const fillTransition = { duration: isViewInteracting ? 0 : 0.25 };

  // Same safety-net polling as the project page: the socket push should make
  // this a no-op in practice, but it guarantees eventual consistency if a
  // broadcast is ever missed.
  const { data: project } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId), refetchInterval: 10_000 },
  });
  const { data: properties } = useListProperties(projectId, {
    query: { queryKey: getListPropertiesQueryKey(projectId), refetchInterval: 10_000 },
  });

  const invalidateProperties = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey(projectId) });
    // The project query also carries each class's server-computed
    // `propertyCount`/`atPropertyCap`, which is otherwise unused by this
    // component (the add-property affordance derives its own "at cap" check
    // straight from the properties cache above, so it updates the instant
    // the optimistic write lands, with no round trip) — refreshed here only
    // so the two stay in sync for anything else that reads them.
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
  }, [queryClient, projectId]);

  const membersById = useMemo(() => {
    const map = new Map<number, { username: string; colorSlot: number }>();
    for (const m of project?.members ?? []) {
      map.set(m.userId, { username: m.username, colorSlot: m.colorSlot });
    }
    return map;
  }, [project]);

  // Clicking a petal (or submitting the add-property form) must repaint
  // instantly — the fill level, docking, and gauge all read straight off
  // the properties query cache, so the visual result can only be immediate
  // if that cache itself is updated synchronously, before the request
  // round-trips. Each `onMutate` below writes the optimistic add/agreement/
  // retraction directly into the cache (a plain `setQueryData`, no network
  // wait); the real response then reconciles it (invalidate-and-refetch for
  // create, since that also handles the "merge into an existing property by
  // name" server behavior a client can't predict), and `onError` rolls the
  // optimistic write back if the request actually fails.
  // Uses the project's SPECIFIED member count, not just however many have
  // joined so far — matches the backend's `agreedByAll` calculation, which
  // requires every expected member (not just current joiners) to agree.
  const totalMembers = Math.max(1, project?.maxMembers ?? 1);

  // A temporary property (with the proposer's own agreement already on it,
  // matching what the backend does on create) appears the moment you hit
  // enter. The temp row never needs its id reconciled by hand — the call
  // site's own `onSuccess` (below) invalidates and refetches the list
  // regardless, which replaces the whole array with the server's real data
  // and naturally drops the temporary entry in the same pass.
  const createProperty = useCreateProperty({
    mutation: {
      onMutate: async ({ data }) => {
        const queryKey = getListPropertiesQueryKey(projectId);
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<Property[]>(queryKey);
        const me = membersById.get(currentUserId);
        const optimistic: Property = {
          id: -Date.now(),
          classId: data.classId,
          name: data.name.trim(),
          proposedByUserId: currentUserId,
          proposedByUsername: me?.username ?? "",
          proposedByColorSlot: me?.colorSlot ?? 0,
          createdAt: new Date().toISOString(),
          agreements: [{ userId: currentUserId, username: me?.username ?? "", colorSlot: me?.colorSlot ?? 0 }],
          agreedByAll: totalMembers <= 1,
        };
        queryClient.setQueryData<Property[]>(queryKey, (old) => [...(old ?? []), optimistic]);
        return { previous, queryKey };
      },
      onError: (_err, _vars, context) => {
        if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      },
    },
  });

  const retractProperty = useRetractProperty({
    mutation: {
      onMutate: async ({ propertyId }) => {
        const queryKey = getListPropertiesQueryKey(projectId);
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<Property[]>(queryKey);
        // Mirrors the backend exactly: retracting your only remaining
        // agreement on a property (typically one you proposed yourself)
        // deletes the row outright, not just your slot in it — so the
        // optimistic write must remove the property from the list, not
        // leave an empty husk behind, or the petal would visibly linger
        // until the refetch caught up.
        queryClient.setQueryData<Property[]>(queryKey, (old) =>
          (old ?? [])
            .map((p) =>
              p.id !== propertyId
                ? p
                : {
                    ...p,
                    agreements: p.agreements.filter((a) => a.userId !== currentUserId),
                    agreedByAll: false,
                  },
            )
            .filter((p) => p.id !== propertyId || p.agreements.length > 0),
        );
        return { previous, queryKey };
      },
      onError: (_err, _vars, context) => {
        if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      },
    },
  });

  const agreeProperty = useAgreeProperty({
    mutation: {
      onMutate: async ({ propertyId }) => {
        const queryKey = getListPropertiesQueryKey(projectId);
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<Property[]>(queryKey);
        const me = membersById.get(currentUserId);
        queryClient.setQueryData<Property[]>(queryKey, (old) =>
          (old ?? []).map((p) => {
            if (p.id !== propertyId || p.agreements.some((a) => a.userId === currentUserId)) return p;
            const agreements = [
              ...p.agreements,
              { userId: currentUserId, username: me?.username ?? "", colorSlot: me?.colorSlot ?? 0 },
            ];
            return { ...p, agreements, agreedByAll: agreements.length >= totalMembers };
          }),
        );
        return { previous, queryKey };
      },
      onError: (_err, _vars, context) => {
        if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      },
    },
  });

  const nodeSize = NODE_SIZE;

  const laidOut = useMemo(
    () => layoutClasses(project?.classes ?? [], project?.relations ?? [], nodeSize),
    [project, nodeSize],
  );

  // The root class/classes (no incoming parent relation) -- used to reset
  // the view whenever the member enters (or re-enters) either the
  // individual or the shared workspace, so they always land on the same
  // starting point instead of wherever their pan/zoom happened to be left.
  const rootClassIds = useMemo(() => {
    const childIds = new Set((project?.relations ?? []).map((rel) => rel.childId));
    return new Set((project?.classes ?? []).filter((cls) => !childIds.has(cls.id)).map((cls) => cls.id));
  }, [project]);

  // Tracks which "workspace" (individual vs shared) the view was last
  // centered for, so centering only fires once per entry into a workspace
  // rather than on every re-render. `pendingCenterModeRef` holds a mode
  // that still needs centering because the canvas wasn't visible/measurable
  // yet (e.g. hidden behind another mobile tab) -- the ResizeObserver below
  // retries it once the canvas actually gets a size.
  const centeredModeRef = useRef<string | null>(null);
  const pendingCenterModeRef = useRef<string | null>(null);

  const centerOnRoot = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const roots = laidOut.filter((cls) => rootClassIds.has(cls.id));
    if (roots.length === 0) return false;
    const centerX = roots.reduce((sum, cls) => sum + cls.x + 40 + nodeSize / 2, 0) / roots.length;
    const centerY = roots.reduce((sum, cls) => sum + cls.y + 40 + nodeSize / 2, 0) / roots.length;
    commitView({ x: rect.width / 2 - centerX, y: rect.height / 2 - centerY, zoom: 1 });
    return true;
  }, [laidOut, rootClassIds, nodeSize, commitView]);

  const propertiesByClass = useMemo(() => {
    const map = new Map<number, Property[]>();
    for (const property of properties ?? []) {
      const list = map.get(property.classId) ?? [];
      list.push(property);
      map.set(property.classId, list);
    }
    // Oldest first: index i is always the i-th property ever created in the
    // class, and the render loop below always draws the "add" petal at
    // index `classProperties.length` — i.e. the very next slot after the
    // last one filled. Sorting ascending means a newly created property
    // always sorts to the END of the array, landing in exactly that slot
    // (rather than snapping to slot 0 and shoving every already-placed
    // petal clockwise by one), so the new property visibly appears right
    // where the add button was, the add button then reappears one slot
    // further clockwise, and no already-placed petal ever moves. Without
    // this ordering (the API has no ORDER BY, so raw array order isn't
    // guaranteed) a freshly added property could land anywhere. Retracting
    // a property still shifts every later-created one down by one slot,
    // closing the gap instead of leaving a permanent hole in the ring — the
    // same rule applies whether classProperties holds just this viewer's
    // own proposals (private, pre-ready) or the full shared list
    // (post-ready consensus mode), since both are ordered by this same
    // ascending sort.
    // `id` breaks ties deterministically. Two properties can land on the
    // exact same millisecond `createdAt` (e.g. two members submitting at
    // nearly the same instant in shared mode) — without a tiebreaker,
    // Array.sort only guarantees ties keep whatever order the array already
    // had, which is whatever order this particular API response happened to
    // return them in (there's no ORDER BY on the backend), and that can
    // differ between one fetch/poll and the next. That flips which of the
    // two tied properties lands at index i vs i+1 from render to render,
    // which visibly looks like two petals swapping places/colors with each
    // other for no reason. `id` is a monotonically increasing, permanently
    // stable tiebreaker, so a tie always resolves the same way every time.
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id);
    }
    return map;
  }, [properties]);

  // Cursor coordinates are sent in content-local space (i.e. as if zoom=1,
  // pan=0) so every viewer renders them correctly regardless of their own
  // individual pan/zoom state. Raw mousemove can fire far more often than
  // the socket (or anyone receiving it) needs — coalesced to at most once
  // per animation frame, same pattern as the pan/zoom commit above, so a
  // fast mouse can't flood the connection or force extra re-renders on
  // every other viewer's cursor overlay.
  const pendingCursorSend = useRef<{ x: number; y: number } | null>(null);
  const cursorSendScheduled = useRef(false);
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!sharedModeEnabled) return;
      if (panDragRef.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const { x, y, zoom } = viewRef.current;
      const contentX = (event.clientX - rect.left - x) / zoom;
      const contentY = (event.clientY - rect.top - y) / zoom;
      pendingCursorSend.current = { x: contentX, y: contentY };
      if (cursorSendScheduled.current) return;
      cursorSendScheduled.current = true;
      requestAnimationFrame(() => {
        cursorSendScheduled.current = false;
        if (pendingCursorSend.current) sendCursor(pendingCursorSend.current.x, pendingCursorSend.current.y);
      });
    },
    [sendCursor, sharedModeEnabled],
  );

  // Mouse wheel: notches (an actual scroll wheel) zoom; ctrl/cmd+wheel
  // (trackpad pinch, which browsers synthesize as ctrl+wheel) also zooms.
  // A plain wheel event carrying a horizontal component, or with the small
  // continuous deltas trackpads produce for a two-finger slide, pans instead
  // — there's no perfect way to tell a mouse wheel from a trackpad scroll at
  // the DOM event level, so this mirrors the heuristic other canvas apps use.
  //
  // This is attached as a native (not React synthetic) listener with
  // { passive: false } below — React/the browser treats delegated
  // wheel/touch listeners as passive by default for scroll-performance
  // reasons, which silently makes event.preventDefault() a no-op. Without
  // that, the page behind the canvas (and, on trackpads, the browser's own
  // pinch-zoom/back-forward swipe gesture) would move along with — or
  // instead of — the canvas whenever the pointer is over it.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      if (event.ctrlKey || event.metaKey) {
        zoomAt(screenX, screenY, Math.exp(-event.deltaY * 0.01));
        return;
      }
      const looksLikeTrackpad = event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 40;
      if (looksLikeTrackpad) {
        panBy(-event.deltaX, -event.deltaY);
      } else {
        zoomAt(screenX, screenY, Math.exp(-event.deltaY * 0.002));
      }
    },
    [panBy, zoomAt],
  );

  // Right mouse button drag pans the board; left button is reserved for
  // interacting with classes/properties, so panning never fights with them.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    panDragRef.current = { lastX: event.clientX, lastY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = panDragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      panDragRef.current = { lastX: event.clientX, lastY: event.clientY };
      panBy(dx, dy);
    },
    [panBy],
  );

  const stopPointerPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panDragRef.current) {
      panDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  // Touch: a single finger drags to pan; two fingers pinch to zoom (anchored
  // at the midpoint between them) — no native touch scrolling, page bounce,
  // or browser pinch-zoom is involved. Native listener, same passive-default
  // reasoning as the wheel handler above.
  const handleTouchStart = useCallback((event: TouchEvent) => {
    if (event.touches.length === 1) {
      touchPanRef.current = { lastX: event.touches[0]!.clientX, lastY: event.touches[0]!.clientY };
      pinchRef.current = null;
    } else if (event.touches.length === 2) {
      touchPanRef.current = null;
      pinchRef.current = { distance: distanceBetween(event.touches[0]!, event.touches[1]!), zoom: viewRef.current.zoom };
    }
  }, []);

  const handleTouchMove = useCallback(
    (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.touches.length === 1 && touchPanRef.current) {
        const touch = event.touches[0]!;
        const dx = touch.clientX - touchPanRef.current.lastX;
        const dy = touch.clientY - touchPanRef.current.lastY;
        touchPanRef.current = { lastX: touch.clientX, lastY: touch.clientY };
        panBy(dx, dy);
      } else if (event.touches.length === 2 && pinchRef.current) {
        const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
        const distance = distanceBetween(event.touches[0]!, event.touches[1]!);
        const mid = midpointOf(event.touches[0]!, event.touches[1]!);
        const factor = (distance / pinchRef.current.distance) * (pinchRef.current.zoom / viewRef.current.zoom);
        zoomAt(mid.x - rect.left, mid.y - rect.top, factor);
      }
    },
    [panBy, zoomAt],
  );

  const handleTouchEnd = useCallback((event: TouchEvent) => {
    if (event.touches.length === 0) {
      touchPanRef.current = null;
      pinchRef.current = null;
    } else if (event.touches.length === 1) {
      pinchRef.current = null;
      touchPanRef.current = { lastX: event.touches[0]!.clientX, lastY: event.touches[0]!.clientY };
    }
  }, []);

  useEffect(() => {
    setAddingToClass(null);
    setDraftName("");
    // A fresh project means a fresh view -- forget whatever workspace
    // mode was previously centered so the very first render of this
    // project's individual workspace gets centered too.
    centeredModeRef.current = null;
    pendingCenterModeRef.current = null;
  }, [projectId]);

  // Re-center on the root class whenever the member enters a workspace
  // mode they haven't been centered for yet: the very first time this
  // canvas mounts (individual workspace), and again the moment the shared
  // workspace opens (sharedModeEnabled flips true). If the canvas can't be
  // measured yet (e.g. it's hidden behind the Guide/Chat tab on a narrow
  // screen), the attempt is remembered and retried by the ResizeObserver
  // below as soon as the canvas actually gets laid out with a real size.
  useEffect(() => {
    const modeKey = sharedModeEnabled ? "shared" : "individual";
    if (centeredModeRef.current === modeKey) return;
    if (centerOnRoot()) {
      centeredModeRef.current = modeKey;
      pendingCenterModeRef.current = null;
    } else {
      pendingCenterModeRef.current = modeKey;
    }
  }, [sharedModeEnabled, centerOnRoot]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const pending = pendingCenterModeRef.current;
      if (!pending || pending === centeredModeRef.current) return;
      if (centerOnRoot()) {
        centeredModeRef.current = pending;
        pendingCenterModeRef.current = null;
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [centerOnRoot]);

  // React (and browsers generally) treat delegated wheel/touchstart/
  // touchmove listeners as passive by default for scroll-performance
  // reasons — calling event.preventDefault() inside a React onWheel/
  // onTouchMove prop silently does nothing under that default. Attaching
  // these natively with { passive: false } is the only reliable way to stop
  // a gesture over the canvas from also scrolling/zooming the page behind
  // it or triggering the browser's own pinch-zoom / swipe-navigation.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.addEventListener("wheel", handleWheel, { passive: false });
    node.addEventListener("touchstart", handleTouchStart, { passive: false });
    node.addEventListener("touchmove", handleTouchMove, { passive: false });
    node.addEventListener("touchend", handleTouchEnd, { passive: false });
    node.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    return () => {
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", handleTouchEnd);
      node.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  if (!project) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        Loading graph…
      </div>
    );
  }

  const width = Math.max(
    800,
    (Math.max(1, ...laidOut.map((c) => c.x + nodeSize)) || nodeSize) + 80,
  );
  const height = Math.max(400, (Math.max(0, ...laidOut.map((c) => c.y)) || 0) + nodeSize + 80);

  const relations = project.relations;
  const positionById = new Map(laidOut.map((c) => [c.id, c]));

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPointerPan}
      onPointerLeave={stopPointerPan}
      onPointerCancel={stopPointerPan}
      onContextMenu={(e) => e.preventDefault()}
      // touchAction: "none" + overscrollBehavior: "contain" belt-and-braces
      // the native non-passive listeners above — even if a gesture ever
      // slipped past preventDefault, the browser has nothing left to hand
      // it off to (no native scroll/zoom action, no rubber-band handoff to
      // an ancestor scroller), so the page never moves.
      style={{ touchAction: "none", overscrollBehavior: "contain" }}
      className="relative h-full w-full overflow-hidden"
    >
      <div
        ref={contentLayerRef}
        className="absolute left-0 top-0"
        style={{
          width,
          height,
          padding: "40px",
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={width}
          height={height}
        >
          <defs>
            <marker
              id="arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--muted-foreground))" />
            </marker>
          </defs>
          {relations.map((rel, i) => {
            const child = positionById.get(rel.childId);
            const parent = positionById.get(rel.parentId);
            if (!child || !parent) return null;
            // Straight lines drawn along the true center-to-center axis
            // between the two nodes (not a fixed horizontal offset), then
            // pulled back from each end by LINE_CLEARANCE along that same
            // direction — this generalizes correctly even when a parent and
            // child aren't at the same vertical slot (e.g. a parent
            // centered over several children), stopping just past each
            // node's label ring instead of cutting through the badge or
            // running underneath a property label.
            const centerA = { x: parent.x + 40 + nodeSize / 2, y: parent.y + 40 + nodeSize / 2 };
            const centerB = { x: child.x + 40 + nodeSize / 2, y: child.y + 40 + nodeSize / 2 };
            const dx = centerB.x - centerA.x;
            const dy = centerB.y - centerA.y;
            const dist = Math.hypot(dx, dy) || 1;
            const ux = dx / dist;
            const uy = dy / dist;
            const x1 = centerA.x + ux * LINE_CLEARANCE;
            const y1 = centerA.y + uy * LINE_CLEARANCE;
            const x2 = centerB.x - ux * LINE_CLEARANCE;
            const y2 = centerB.y - uy * LINE_CLEARANCE;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="hsl(var(--muted-foreground) / 0.7)"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            );
          })}
        </svg>

        {laidOut.map((cls) => {
          const classProperties = propertiesByClass.get(cls.id) ?? [];
          const isAdding = addingToClass === cls.id;
          // `atCap` must reflect the total proposed across ALL members, not
          // just the ones this viewer can currently see — before everyone is
          // ready, each member only sees their own proposals (plus ones
          // they've agreed to), so `classProperties.length` alone could
          // under-count a class another member has already filled. The
          // server tracks the true total and sends it as `atPropertyCap` on
          // every class; that's what actually decides whether the "add"
          // affordance shows, in both private and shared mode. Computed
          // straight from the (optimistic) properties cache — the same one
          // that already drives the petals themselves — rather than the
          // separate project query's `atPropertyCap` field, which only
          // updates on its own refetch/poll and would otherwise leave a
          // visible lag between adding/removing a property and the "+"
          // affordance reacting to it. The backend still enforces the cap
          // independently on create (a rejected property surfaces as a
          // plain error toast) — this is purely about not showing an
          // affordance that would just fail anyway.
          // The per-member quota only protects fairness during the private
          // phase, before anyone can see anyone else's proposals. Once the
          // shared space is open, proposals are visible to everyone and
          // same-name duplicates merge instead of competing (see the
          // backend's cross-member merge-on-create), so the per-member split
          // goes away — but the class as a whole is still capped at the same
          // TOTAL_PROPERTY_SLOTS (7) total, now shared collectively across
          // all members instead of divided into fixed per-member slices.
          const myPropertyCountInClass = classProperties.filter((p) => p.proposedByUserId === currentUserId).length;
          const myQuota = getPropertyQuota(totalMembers, membersById.get(currentUserId)?.colorSlot ?? 0);
          const atCap = sharedModeEnabled
            ? classProperties.length >= TOTAL_PROPERTY_SLOTS
            : myPropertyCountInClass >= myQuota;
          // The ring is divided into a FIXED number of wedges (the global
          // 7-property budget every project shares, split across members),
          // never into `classProperties.length + 1` — that would recompute
          // angleStep on every add/remove and visibly rotate every existing
          // petal (including the add button) around the node each time.
          // With a fixed wedge count, property i always lands in wedge i, so
          // adding a new one only ever fills the next wedge in place; nothing
          // already placed ever moves, and the add button always sits in the
          // very next wedge after the last filled one — i.e. immediately
          // "to the right" of wherever it currently is.
          // The "+1" only reserves room for the add button when it will
          // actually render — once a class is at cap (no add button at
          // all), reserving that extra wedge anyway would spread the filled
          // petals out to leave a visible empty gap where the button isn't.
          // Wedge count stays fixed at 7 for the normal case (matches every
          // prior private-mode layout, no rotation on add/remove there) and
          // only grows past 7 once a class actually needs more slots than
          // that while still showing an add button — an edge case shared
          // mode newly allows before its own cap kicks in.
          const showAddButton = !atCap && !ownSpaceLocked;
          const slotCount = Math.max(TOTAL_PROPERTY_SLOTS, classProperties.length + (showAddButton ? 1 : 0));
          const angleStep = 360 / slotCount;
          // A fixed offset keeps petals from landing on the cardinal
          // directions (which, for even slot counts, would make them look
          // like plain horizontal/vertical bars instead of tilted petals).
          const angleOffset = 25;

          const agreedCount = classProperties.filter((p) => p.agreedByAll).length;
          const consensusFraction = classProperties.length > 0 ? agreedCount / classProperties.length : 0;
          const isClassHighlighted = highlightedProperty?.classId === cls.id;

          return (
            <div
              key={cls.id}
              className="absolute"
              style={{ left: cls.x + 40, top: cls.y + 40, width: nodeSize, height: nodeSize }}
            >
              {classProperties.map((property, i) => {
                const angle = angleStep * i - 90 + angleOffset;
                const docked = property.agreedByAll;
                const dist = docked ? DOCK_DIST : PETAL_CENTER_DIST;
                const center = petalCenter(angle, nodeSize / 2, nodeSize / 2, dist);
                // Same footprint and outward tilt whether docked or not —
                // docking only pulls the petal inward, it never reshapes it.
                const w = PETAL_WIDTH;
                const h = PETAL_LENGTH;
                const rotate = angle;
                const hasMyAgreement = property.agreements.some((a) => a.userId === currentUserId);
                // Fills stack from the petal's base (nearest the node) up to
                // its tip, in the order members agreed — a new agreement
                // always appends at the top of the stack, and if one in the
                // middle is retracted, the ones above it settle downward to
                // close the gap. Since the backend already returns
                // `agreements` oldest-first, indexing straight into that
                // array (rather than a fixed per-member slot) gives exactly
                // that "gravity" behavior for free.
                const totalLevels = Math.max(1, project.maxMembers);
                const emptyLevels = Math.max(0, totalLevels - property.agreements.length);
                // The box's anchor is strictly centrifugal — computed below
                // from the raw `angle`, never from this. Only the text's
                // own tilt inside that box adapts for legibility.
                const labelAngle = labelRotation(angle);
                const labelCenter = petalCenter(angle, nodeSize / 2, nodeSize / 2, LABEL_DIST);
                // The optimistic entry written by createProperty's onMutate
                // (see above) is given a negative temp id as a placeholder
                // until the real row comes back from the server. If a click
                // lands on it before that reconciliation happens, agree/
                // retract would fire against that fake id — the backend has
                // no row with a negative id, so the request just errors out
                // with nothing to show for it. Petals rendered from a temp
                // id are inert until the real id replaces them.
                const isOptimistic = property.id < 0;
                const isHighlighted = highlightedProperty?.propertyId === property.id;

                return (
                  <div key={property.id}>
                  <motion.div
                    initial={false}
                    animate={{ left: center.x - w / 2, top: center.y - h / 2, width: w, height: h, rotate }}
                    transition={activeTransition}
                    className="absolute"
                    style={{ zIndex: 5 + i }}
                  >
                    <button
                      type="button"
                      disabled={isOptimistic || ownSpaceLocked}
                      title={
                        isOptimistic
                          ? `${property.name} — saving…`
                          : ownSpaceLocked
                            ? `${property.name} — your space is locked; you marked ready`
                            : docked
                              ? `${property.name} — fully agreed`
                              : hasMyAgreement
                                ? "Click to remove your agreement"
                                : "Click to agree"
                      }
                      onClick={() => {
                        if (isOptimistic || ownSpaceLocked) return;
                        if (hasMyAgreement) {
                          retractProperty.mutate(
                            { id: projectId, propertyId: property.id },
                            { onSuccess: invalidateProperties },
                          );
                        } else {
                          agreeProperty.mutate(
                            { id: projectId, propertyId: property.id },
                            { onSuccess: invalidateProperties },
                          );
                        }
                      }}
                      // outline-none/tap-highlight: a click must only ever
                      // change which levels are filled — it must never leave
                      // a black default browser focus/active outline on the
                      // petal frame.
                      className={`relative flex h-full w-full flex-col-reverse overflow-hidden border shadow-sm outline-none transition-[background-color,border-color,box-shadow] duration-300 hover:z-30 hover:scale-105 focus:outline-none focus-visible:outline-none ${
                        isHighlighted ? "animate-pulse" : ""
                      }`}
                      style={{
                        ...(docked
                          ? {
                              // Same color the node's own name label is
                              // rendered in — a docked property visually
                              // "belongs" to the node's identity now.
                              background: "hsl(var(--card-foreground))",
                              borderColor: "hsl(var(--card-foreground))",
                              borderRadius: "16px 16px 4px 4px",
                              borderWidth: 1.5,
                              WebkitTapHighlightColor: "transparent",
                            }
                          : {
                              borderColor: "hsl(var(--border))",
                              borderRadius: "16px 16px 4px 4px",
                              borderWidth: 1.5,
                              WebkitTapHighlightColor: "transparent",
                            }),
                        // Ontology-discussion highlight: the AI moderator's
                        // last summary was about this exact property.
                        // Layered on top of (not replacing) the
                        // docked/floating styling above.
                        ...(isHighlighted
                          ? {
                              boxShadow: "0 0 0 3px hsl(var(--primary)), 0 0 16px 2px hsl(var(--primary) / 0.6)",
                              zIndex: 40,
                            }
                          : {}),
                      }}
                    >
                      {docked ? (
                        // The petal frame itself keeps the full true
                        // outward `angle` (rotate, above) so its shape and
                        // tilt stay identical to the floating state. The
                        // text counter-rotates by the same readability
                        // correction used for floating labels, so its
                        // absolute on-screen angle is always `labelAngle`
                        // (never upside-down) while still fundamentally
                        // tied to this petal's own centrifugal direction.
                        //
                        // Only the top `h - DOCK_OVERLAP` px of the petal are
                        // actually visible outside the node circle (the
                        // bottom DOCK_OVERLAP px are the pivot end sitting
                        // under it) — centering this box on that visible
                        // span, not the full petal height, keeps the label
                        // centered in what the user can actually see instead
                        // of drifting toward the hidden half.
                        <div
                          className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center"
                          style={{ height: Math.max(0, h - DOCK_OVERLAP) }}
                        >
                          <div style={{ transform: `rotate(${labelAngle - angle}deg)` }}>
                            {/* `leading-none` (line-height 1) clips the second
                                line's glyphs against `line-clamp-2`'s
                                overflow:hidden, since real glyph height at
                                this font size exceeds a 1x line box —
                                `leading-tight` gives enough headroom for both
                                lines to render fully. */}
                            <span className="line-clamp-2 px-1 text-center text-[9px] font-semibold leading-tight text-white [overflow-wrap:anywhere]">
                              {property.name}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <AnimatePresence initial={false}>
                          {property.agreements.map((a) => (
                            <motion.div
                              key={a.userId}
                              // Layout tracking (and its animation) is only
                              // ever needed for a real gravity-fill reorder;
                              // suspending it while the view is being
                              // panned/zoomed stops the ancestor's CSS scale
                              // from being misread as a position change that
                              // needs to animate.
                              layout={!isViewInteracting}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={fillTransition}
                              className="min-h-0 flex-1"
                              style={{ background: colorForSlot(a.colorSlot).solid }}
                            />
                          ))}
                        </AnimatePresence>
                      )}
                      {!docked &&
                        Array.from({ length: emptyLevels }, (_, idx) => (
                          <div
                            key={`empty-${idx}`}
                            className="min-h-0 flex-1"
                            style={{ background: "hsl(var(--muted) / 0.35)" }}
                          />
                        ))}
                    </button>
                  </motion.div>

                  {/* Rendered as a sibling of the (rotated) petal, not a
                      child of it — nesting it inside would compose the
                      label's own rotation with the petal's, which is the
                      translate+rotate trap: the label needs its own
                      independent position and tilt in the same world-space
                      coordinate frame the petal itself is placed in. */}
                  {!docked && (
                    // `labelCenter` is the box's fixed INNER edge (nearest
                    // the node), not its center — a wrapped label must grow
                    // by adding lines on the outward side only, or the extra
                    // lines creep back toward the node and under the petal.
                    // `PropertyLabel` rotates by the same raw `angle` as the
                    // petal itself (not the folded `labelAngle`), so it
                    // always moves in lockstep with its petal with no
                    // separate spin, correcting the text's own orientation
                    // separately and without animation.
                    <PropertyLabel
                      name={property.name}
                      angle={angle}
                      labelAngle={labelAngle}
                      left={labelCenter.x - LABEL_WIDTH / 2}
                      labelCenterY={labelCenter.y}
                      nodeSize={nodeSize}
                      transition={activeTransition}
                    />
                  )}
                  </div>
                );
              })}

              {/* Add-property slot: one more petal in the same fixed ring,
                  dashed and neutral until clicked — hidden entirely once
                  this member has used their own property budget for this
                  class (see atPropertyCap), in both private and shared
                  mode. The backend still owns the actual limit check; this
                  is just the affordance disappearing so there's nothing to
                  click that could only ever fail. */}
              {showAddButton && (() => {
                const angle = angleStep * classProperties.length - 90 + angleOffset;
                const center = petalCenter(angle, nodeSize / 2, nodeSize / 2, PETAL_CENTER_DIST);
                return (
                  <motion.div
                    initial={false}
                    animate={{
                      left: center.x - PETAL_WIDTH / 2,
                      top: center.y - PETAL_LENGTH / 2,
                      width: PETAL_WIDTH,
                      height: PETAL_LENGTH,
                      rotate: angle,
                    }}
                    transition={activeTransition}
                    className="absolute"
                    style={{ zIndex: 5 + classProperties.length }}
                  >
                    {isAdding ? (
                      <div className="absolute left-1/2 top-3 -translate-x-1/2">
                       <div style={{ transform: `rotate(${-angle}deg)` }}>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const name = draftName.trim();
                            setAddingToClass(null);
                            setDraftName("");
                            if (name) {
                              createProperty.mutate(
                                { id: projectId, data: { classId: cls.id, name } },
                                {
                                  onSuccess: invalidateProperties,
                                  onError: (err: any) => {
                                    console.error("Couldn't add property", err);
                                  },
                                },
                              );
                            }
                          }}
                        >
                          <input
                            autoFocus
                            value={draftName}
                            placeholder="Property name"
                            onChange={(e) => setDraftName(e.target.value)}
                            onBlur={(e) => {
                              // Same rationale as the edit form: clicking
                              // away must commit a non-empty draft rather
                              // than silently drop it. The submit handler
                              // itself no-ops on empty input and still
                              // closes the form.
                              e.currentTarget.form?.requestSubmit();
                            }}
                            className="h-7 w-24 rounded-full border border-primary bg-background px-2.5 text-center text-[11px] outline-none shadow-md"
                          />
                        </form>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setAddingToClass(cls.id);
                          setDraftName("");
                        }}
                        className="flex h-full w-full items-center justify-center border border-dashed transition-colors hover:bg-muted/60"
                        style={{
                          borderRadius: "16px 16px 4px 4px",
                          borderColor: "hsl(var(--muted-foreground) / 0.5)",
                          color: "hsl(var(--muted-foreground))",
                        }}
                      >
                        <span
                          className="text-base font-semibold leading-none"
                          style={{ transform: `rotate(${-angle}deg)`, display: "inline-block" }}
                        >
                          +
                        </span>
                      </button>
                    )}
                  </motion.div>
                );
              })()}

              {/* The class badge sits on top, hiding the inner (pivot) end
                  of every petal so they read as radiating from its edge. */}
              <div
                className={`absolute overflow-hidden rounded-full border-4 bg-card text-center shadow-md transition-shadow duration-300 ${
                  isClassHighlighted ? "animate-pulse" : ""
                }`}
                style={{
                  width: CIRCLE_SIZE,
                  height: CIRCLE_SIZE,
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  borderColor: "hsl(var(--muted-foreground) / 0.5)",
                  zIndex: 20,
                  ...(isClassHighlighted
                    ? { boxShadow: "0 0 0 4px hsl(var(--primary)), 0 0 24px 4px hsl(var(--primary) / 0.6)" }
                    : {}),
                }}
              >
                {/* Consensus gauge: a bottom-anchored fill that grows with
                    the share of this class's properties that have reached
                    full agreement, animating smoothly as that changes. */}
                <motion.div
                  className="pointer-events-none absolute inset-x-0 bottom-0"
                  style={{ background: "hsl(var(--primary) / 0.16)" }}
                  animate={{ height: `${consensusFraction * 100}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        lang="en"
                        className="line-clamp-4 text-sm font-semibold text-card-foreground"
                        style={{
                          width: CLASS_LABEL_BOX_SIZE,
                          maxHeight: CLASS_LABEL_BOX_SIZE,
                          // Each word of the label gets its own line (see the
                          // \n join below) rather than flowing together like
                          // normal wrapped text; whiteSpace: "pre-line" is
                          // what makes those \n characters actually break the
                          // line instead of collapsing like regular
                          // whitespace. A word that's too wide on its own
                          // still wraps mid-word with a hyphen (hyphens:
                          // "auto" needs the `lang` attribute above to know
                          // which language's hyphenation rules to use).
                          whiteSpace: "pre-line",
                          overflowWrap: "break-word",
                          wordBreak: "break-word",
                          hyphens: "auto",
                        }}
                      >
                        {cls.label.split(/\s+/).filter(Boolean).join("\n")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64 break-words">{cls.label}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          );
        })}

        {sharedModeEnabled &&
          Array.from(cursors.values())
            .filter((c) => Date.now() - c.updatedAt < 8000 && c.userId !== currentUserId)
            .map((cursor) => {
              const member = membersById.get(cursor.userId);
              const color = colorForSlot(member?.colorSlot ?? 0);
              return (
                <div
                  key={cursor.userId}
                  className="pointer-events-none absolute z-50 transition-all duration-150 ease-out"
                  style={{ left: cursor.x, top: cursor.y }}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path
                      d="M1 1L7 16L9.5 9.5L16 7L1 1Z"
                      fill={color.solid}
                      stroke="white"
                      strokeWidth="1"
                    />
                  </svg>
                  <span
                    className="ml-3 -mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium text-white shadow"
                    style={{ background: color.solid }}
                  >
                    {member?.username ?? "member"}
                  </span>
                </div>
              );
            })}
      </div>
    </div>
  );
}
