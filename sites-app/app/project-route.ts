import type { Milestone } from "./project-types";

// Legacy candidates have no declared dependencies; anchor them to the last completed checkpoint.
export function routeParents(nodes: Milestone[]): Map<string, string[]> {
  const ordered = [...nodes].filter((node) => node.status !== "superseded").sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const completed = ordered.filter((node) => node.status === "completed");
  return new Map(ordered.map((node) => {
    const previous = node.status === "completed" ? completed[completed.indexOf(node) - 1] : completed.at(-1);
    return [node.id, node.predecessorIds ?? (previous ? [previous.id] : [])];
  }));
}

export function routeLayers(nodes: Milestone[]): Milestone[][] {
  const parents = routeParents(nodes);
  const remaining = nodes.filter((node) => node.status !== "superseded").sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const placed = new Set<string>();
  const layers: Milestone[][] = [];
  while (remaining.length) {
    const layer = remaining.filter((node) => parents.get(node.id)!.every((id) => placed.has(id) || !parents.has(id)));
    if (!layer.length) throw new Error("节点连接不能形成循环，请调整前置节点。");
    layers.push(layer);
    for (const node of layer) { placed.add(node.id); remaining.splice(remaining.indexOf(node), 1); }
  }
  return layers;
}

export function routeDescendants(nodes: Milestone[], nodeId: string): Set<string> {
  const parents = routeParents(nodes);
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidateId, candidateParents] of parents) {
      if (candidateId === nodeId || descendants.has(candidateId)) continue;
      if (candidateParents.some((parentId) => parentId === nodeId || descendants.has(parentId))) {
        descendants.add(candidateId);
        changed = true;
      }
    }
  }
  return descendants;
}

export function validateRoute(nodes: Milestone[]) {
  const ids = new Set(nodes.filter((node) => node.status !== "superseded").map((node) => node.id));
  for (const node of nodes.filter((node) => node.status !== "superseded")) {
    if (node.predecessorIds?.some((id) => id === node.id || !ids.has(id))) throw new Error("前置节点必须是同一项目中的其他有效节点。");
  }
  routeLayers(nodes);
}
