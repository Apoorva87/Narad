export type DiagramNode = { id: string; label: string };
export type DiagramEdge = { from: string; to: string; label: string | null };
export type PlacedNode = DiagramNode & { x: number; y: number; width: number; height: number; lines: string[] };
/** `path` is SVG path data ending at the arrowhead; the label sits at (labelX, labelY). */
export type PlacedEdge = { path: string; labelX: number; labelY: number; label: string | null; bowed: boolean };
export type DiagramLayout = { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] };

const BOX_WIDTH = 184, GAP_X = 72, GAP_Y = 78, LINE = 18, PAD_Y = 15, MARGIN = 16, ROW_MAX = 3, LINE_CHARS = 21, BOW = 54, BOW_STEP = 30, BOW_LABEL = 64;
const round = (value: number) => Math.round(value * 10) / 10;

/** True when the straight line between two points passes through the box (sampled along the line). */
function crosses(node: PlacedNode, x1: number, y1: number, x2: number, y2: number) {
  for (let step = 1; step < 24; step++) {
    const x = x1 + ((x2 - x1) * step) / 24, y = y1 + ((y2 - y1) * step) / 24;
    if (Math.abs(x - node.x) < node.width / 2 + 6 && Math.abs(y - node.y) < node.height / 2 + 6) return true;
  }
  return false;
}

function wrap(label: string): string[] {
  const lines: string[] = [];
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && (last + ' ' + word).length <= LINE_CHARS) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  return lines.length ? lines : [''];
}

/** Where the line from a box's centre towards (towardX, towardY) leaves the box, plus a little clearance for the arrowhead. */
function edgePoint(node: PlacedNode, towardX: number, towardY: number, clearance: number) {
  const dx = towardX - node.x, dy = towardY - node.y;
  if (!dx && !dy) return { x: node.x, y: node.y };
  const scale = Math.min(dx ? (node.width / 2 + clearance) / Math.abs(dx) : Infinity, dy ? (node.height / 2 + clearance) / Math.abs(dy) : Infinity);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

/**
 * Places boxes in rows from top to bottom so arrows mostly point down: a box sits one row below the lowest box that
 * points at it. An arrow that would close a loop is drawn but does not move its target down.
 */
export function layoutDiagram(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramLayout {
  const ids = new Set(nodes.map(node => node.id));
  const valid = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  // Depth-first search marks the arrows that close a loop, so the remaining ones always define a top-to-bottom order.
  const state = new Map<string, 'open' | 'done'>(); const forward: DiagramEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const edge of valid) if (edge.from === id) {
      if (state.get(edge.to) === 'open') continue;
      forward.push(edge);
      if (!state.has(edge.to)) visit(edge.to);
    }
    state.set(id, 'done');
  };
  const targets = new Set(valid.map(edge => edge.to));
  for (const node of [...nodes.filter(node => !targets.has(node.id)), ...nodes]) if (!state.has(node.id)) visit(node.id);
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id); if (known !== undefined) return known;
    depth.set(id, 0);
    const value = Math.max(0, ...forward.filter(edge => edge.to === id).map(edge => depthOf(edge.from) + 1));
    depth.set(id, value); return value;
  };
  const rows: DiagramNode[][] = [];
  for (let level = 0; level <= Math.max(...nodes.map(node => depthOf(node.id))); level++) {
    const members = nodes.filter(node => depthOf(node.id) === level);
    for (let start = 0; start < members.length; start += ROW_MAX) rows.push(members.slice(start, start + ROW_MAX));
  }
  const columns = Math.max(...rows.map(row => row.length));
  const width = columns * BOX_WIDTH + (columns - 1) * GAP_X + MARGIN * 2;
  const placed: PlacedNode[] = []; let top = MARGIN;
  for (const row of rows) {
    const wrapped = row.map(node => wrap(node.label));
    const rowHeight = Math.max(...wrapped.map(lines => lines.length)) * LINE + PAD_Y * 2;
    const rowWidth = row.length * BOX_WIDTH + (row.length - 1) * GAP_X;
    row.forEach((node, index) => placed.push({ ...node, lines: wrapped[index], width: BOX_WIDTH, height: wrapped[index].length * LINE + PAD_Y * 2, x: (width - rowWidth) / 2 + index * (BOX_WIDTH + GAP_X) + BOX_WIDTH / 2, y: top + rowHeight / 2 }));
    top += rowHeight + GAP_Y;
  }
  const byId = new Map(placed.map(node => [node.id, node]));
  let bows = 0;
  const lines = valid.map((edge): PlacedEdge => {
    const from = byId.get(edge.from)!, to = byId.get(edge.to)!;
    // An arrow whose straight line would run through another box (a loop back to the start, or a skipped step) bows around the right side.
    if (placed.some(node => node !== from && node !== to && crosses(node, from.x, from.y, to.x, to.y))) {
      const startX = from.x + from.width / 2 + 2, endX = to.x + to.width / 2 + 7;
      const out = Math.max(startX, endX) + BOW + BOW_STEP * bows++;
      return { path: `M ${round(startX)} ${round(from.y)} C ${round(out)} ${round(from.y)}, ${round(out)} ${round(to.y)}, ${round(endX)} ${round(to.y)}`, labelX: round((startX + endX) / 8 + (out * 3) / 4), labelY: round((from.y + to.y) / 2), label: edge.label, bowed: true };
    }
    // Two arrows between the same pair of boxes are drawn side by side instead of on top of each other.
    const paired = valid.some(other => other.from === edge.to && other.to === edge.from);
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const shiftX = paired ? (-(to.y - from.y) / length) * 9 : 0, shiftY = paired ? ((to.x - from.x) / length) * 9 : 0;
    const start = edgePoint(from, to.x, to.y, 2), end = edgePoint(to, from.x, from.y, 7);
    const x1 = start.x + shiftX, y1 = start.y + shiftY, x2 = end.x + shiftX, y2 = end.y + shiftY;
    return { path: `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`, labelX: round((x1 + x2) / 2), labelY: round((y1 + y2) / 2), label: edge.label, bowed: false };
  });
  // Bowed arrows and their labels need room to the right of the boxes; the same room is added on the left to keep the boxes centred.
  const extra = bows ? BOW + BOW_STEP * (bows - 1) + BOW_LABEL - MARGIN - Math.max(0, (width - MARGIN * 2 - BOX_WIDTH) / 2) : 0;
  const pad = Math.max(0, extra);
  if (pad) {
    for (const node of placed) node.x += pad;
    for (const line of lines) { line.labelX += pad; line.path = line.path.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x: string, y: string) => `${round(Number(x) + pad)} ${y}`); }
  }
  return { width: width + pad * 2, height: top - GAP_Y + MARGIN, nodes: placed, edges: lines };
}
