import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import * as d3 from "d3";
import { formatDate, stripFathomMarker } from "./utils";
import { ACT_TYPES } from "./constants";

// Network Map node styling (independent of the app badge colors).
const MAP_NODE_STYLES = {
  target: { r: 22, fill: "#3B82F6", label: "Target" },
  enabler: { r: 18, fill: "#F5A623", label: "Enabler" },
  competitor: { r: 16, fill: "#EF4444", label: "Competitor" },
  payer: { r: 14, fill: "#8B5CF6", label: "Payer" },
  government: { r: 16, fill: "#06B6D4", label: "Government" },
  association: { r: 14, fill: "#F97316", label: "Association" },
  research: { r: 14, fill: "#14B8A6", label: "Research" },
  hospital: { r: 14, fill: "#059669", label: "Hospital" },
  institution: { r: 13, fill: "#64748B", label: "Institution" },
  internal_institution: { r: 18, fill: "#8B5CF6", label: "Internal Team" },
  person: { r: 8, fill: "#E8ECF1", label: "Person" },
  internal_person: { r: 10, fill: "#10B981", label: "Internal Team" },
};
const styleOf = (type) => MAP_NODE_STYLES[type] || MAP_NODE_STYLES.institution;
const isInstitutionType = (type) => !["person", "internal_person"].includes(type);
const isPersonType = (type) => ["person", "internal_person"].includes(type);

// Filter buttons in the top bar map to these node types (other institution
// types like Payer/Government are always visible).
const FILTER_DEFS = [
  { id: "targets", label: "Targets", types: ["target"] },
  { id: "enablers", label: "Enablers", types: ["enabler"] },
  { id: "competitors", label: "Competitors", types: ["competitor"] },
  { id: "people", label: "People", types: ["person"] },
  { id: "internal", label: "Internal", types: ["internal_person", "internal_institution"] },
];
const typeToFilter = (type) => FILTER_DEFS.find(f => f.types.includes(type))?.id || null;

const STRENGTH_RANK = { strong: 3, medium: 2, weak: 1 };
const truncate = (s, n = 15) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const DAY = 86400000;

function nodeTypeForInstitution(inst) {
  if (inst.isInternal) return "internal_institution";
  if (inst.isTarget) return "target";
  if (inst.isEnabler) return "enabler";
  const t = inst.type;
  if (t === "regulator") return "government";
  if (MAP_NODE_STYLES[t]) return t;
  return "institution";
}

// Builds the graph (nodes + deduplicated edges) from the app's relationship
// tables. Institutions are deduped by name (already done upstream); their
// backing deal/enabler/organization ids all resolve to the same node.
function buildGraph({ institutions, contacts, contactRoles, dealEnablers, enablerContacts, dealContacts, networkEdges, activities }) {
  const nodes = [];
  const nodeById = new Map();
  const entityToNode = new Map(); // "deal:id" / "enabler:id" / "organization:id" -> node id
  const now = Date.now();

  const add = (node) => { nodes.push(node); nodeById.set(node.id, node); return node; };

  institutions.forEach((inst) => {
    const id = `inst:${inst.key}`;
    const entities = [];
    if (inst.dealId) { entityToNode.set(`deal:${inst.dealId}`, id); entities.push({ type: "deal", id: inst.dealId }); }
    if (inst.enablerId) { entityToNode.set(`enabler:${inst.enablerId}`, id); entities.push({ type: "enabler", id: inst.enablerId }); }
    if (inst.orgId) { entityToNode.set(`organization:${inst.orgId}`, id); entities.push({ type: "organization", id: inst.orgId }); }
    const primary = inst.dealId ? { type: "deal", id: inst.dealId } : inst.enablerId ? { type: "enabler", id: inst.enablerId } : inst.orgId ? { type: "organization", id: inst.orgId } : null;
    add({ id, label: inst.name, type: nodeTypeForInstitution(inst), city: inst.city || "", entity_type: primary?.type, entity_id: primary?.id, name: inst.name, entities, isInstitution: true, lastActivityAt: inst.lastActivity ? new Date(inst.lastActivity).getTime() : 0 });
  });

  contacts.forEach((c) => {
    add({ id: `contact:${c.id}`, label: c.name, type: c.is_internal ? "internal_person" : "person", city: "", entity_type: "contact", entity_id: c.id, name: c.name, warmth: c.warmth, lastContacted: c.last_contacted_at, isInstitution: false, lastActivityAt: c.last_contacted_at ? new Date(c.last_contacted_at).getTime() : 0 });
  });

  const resolve = (type, id) => (type === "contact" ? (nodeById.has(`contact:${id}`) ? `contact:${id}` : null) : (entityToNode.get(`${type}:${id}`) || null));

  // Fold every activity into its nodes' most-recent-activity timestamp.
  activities.forEach((a) => {
    const ts = new Date(a.created_at).getTime();
    [resolve("deal", a.deal_id), resolve("enabler", a.enabler_id), resolve("organization", a.organization_id), a.contact_id ? `contact:${a.contact_id}` : null]
      .filter(Boolean).forEach((nid) => { const n = nodeById.get(nid); if (n && ts > n.lastActivityAt) n.lastActivityAt = ts; });
  });

  // Collect raw edges from every relationship source, then dedupe by pair.
  const raw = [];
  const push = (aType, aId, bType, bId, label, strength, gold) => {
    const a = resolve(aType, aId), b = resolve(bType, bId);
    if (a && b && a !== b) raw.push({ a, b, label: label || "", strength: strength || "medium", gold: !!gold });
  };
  contactRoles.forEach((r) => push("contact", r.contact_id, r.entity_type, r.entity_id, r.role_title, "medium", false));
  dealContacts.forEach((dc) => push("contact", dc.contact_id, "deal", dc.deal_id, dc.role_in_deal, "medium", false));
  enablerContacts.forEach((ec) => push("contact", ec.contact_id, "enabler", ec.enabler_id, ec.role_in_org, "medium", false));
  dealEnablers.forEach((de) => push("enabler", de.enabler_id, "deal", de.deal_id, de.relationship, de.strength, true));
  networkEdges.forEach((ne) => push(ne.source_type, ne.source_id, ne.target_type, ne.target_id, ne.relationship, ne.strength, false));

  const linkMap = new Map();
  raw.forEach((e) => {
    const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    const existing = linkMap.get(key);
    if (!existing) linkMap.set(key, { source: e.a, target: e.b, label: e.label, strength: e.strength, gold: e.gold });
    else {
      if ((STRENGTH_RANK[e.strength] || 2) > (STRENGTH_RANK[existing.strength] || 2)) existing.strength = e.strength;
      if (e.gold) existing.gold = true;
      if (!existing.label && e.label) existing.label = e.label;
    }
  });
  const links = [...linkMap.values()];

  // Freshness flags for pulse/stale rendering.
  nodes.forEach((n) => {
    const age = n.lastActivityAt ? now - n.lastActivityAt : Infinity;
    n.fresh = age <= 7 * DAY;
    n.stale = age > 30 * DAY;
  });

  // Adjacency for hover highlighting and path finding.
  const adjacency = new Map();
  nodes.forEach((n) => adjacency.set(n.id, []));
  links.forEach((l) => { adjacency.get(l.source)?.push({ id: l.target, link: l }); adjacency.get(l.target)?.push({ id: l.source, link: l }); });

  return { nodes, links, nodeById, adjacency };
}

// Depth-limited search for all simple paths (<= 4 hops) to the selected target
// institution node. Paths originate from our own team: internal people are the
// roots. If no one is marked internal yet, fall back to every known person so
// the feature still works.
function findPaths(graph, targetId) {
  const internalRoots = graph.nodes.filter(n => n.type === "internal_person").map(n => n.id);
  const roots = internalRoots.length ? internalRoots : graph.nodes.filter(n => isPersonType(n.type)).map(n => n.id);
  const results = [];
  const maxHops = 4;
  const dfs = (nodeId, path, visited) => {
    if (results.length > 40) return;
    if (nodeId === targetId) { results.push([...path]); return; }
    if (path.length - 1 >= maxHops) return;
    for (const nb of graph.adjacency.get(nodeId) || []) {
      if (visited.has(nb.id)) continue;
      visited.add(nb.id);
      dfs(nb.id, [...path, nb.id], visited);
      visited.delete(nb.id);
    }
  };
  roots.forEach((r) => dfs(r, [r], new Set([r])));
  // Dedupe identical chains, sort by length.
  const seen = new Set();
  const unique = results.filter((p) => { const k = p.join(">"); if (seen.has(k)) return false; seen.add(k); return true; });
  unique.sort((a, b) => a.length - b.length);
  return unique.slice(0, 10);
}

export default function MapTab({ institutions, contacts, contactRoles, dealEnablers, enablerContacts, dealContacts, networkEdges, activities, onOpenInstitution, onOpenPerson }) {
  const graph = useMemo(
    () => buildGraph({ institutions, contacts, contactRoles, dealEnablers, enablerContacts, dealContacts, networkEdges, activities }),
    [institutions, contacts, contactRoles, dealEnablers, enablerContacts, dealContacts, networkEdges, activities]
  );

  const canvasRef = useRef(null);
  const svgRef = useRef(null);
  const zoomLayerRef = useRef(null);
  const simRef = useRef(null);
  const zoomRef = useRef(null);
  const nodeSelRef = useRef(null);
  const linkSelRef = useRef(null);
  const hoverRef = useRef(null);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [mode, setMode] = useState("orbit"); // orbit | pathfinder
  const [filters, setFilters] = useState({ targets: true, enablers: true, competitors: true, people: true, internal: true });
  const [pathTarget, setPathTarget] = useState("");
  const [paths, setPaths] = useState([]);
  const [activePathIdx, setActivePathIdx] = useState(-1); // -1 = all paths
  const [panelNodeId, setPanelNodeId] = useState(null);
  const [tooltip, setTooltip] = useState(null);

  // Keep the latest reactive state in refs so D3 event handlers stay current.
  const stateRef = useRef({});
  stateRef.current = { mode, filters, paths, activePathIdx };

  const scale = size.w < 700 ? 0.8 : 1;

  // Measure the canvas and keep it in sync with the viewport.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: Math.max(600, rect.width), h: Math.max(400, rect.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const targetOptions = useMemo(() => graph.nodes.filter(n => n.type === "target").sort((a, b) => a.label.localeCompare(b.label)), [graph]);

  // Which nodes/links belong to the currently highlighted path(s).
  const pathHighlight = useMemo(() => {
    const nodeSet = new Set();
    const linkSet = new Set();
    const chains = activePathIdx >= 0 ? [paths[activePathIdx]].filter(Boolean) : paths;
    chains.forEach((chain) => {
      chain.forEach((id) => nodeSet.add(id));
      for (let i = 0; i < chain.length - 1; i++) { const a = chain[i], b = chain[i + 1]; linkSet.add(a < b ? `${a}|${b}` : `${b}|${a}`); }
    });
    return { nodeSet, linkSet };
  }, [paths, activePathIdx]);
  const pathHighlightRef = useRef(pathHighlight);
  pathHighlightRef.current = pathHighlight;

  const linkKey = (l) => { const s = l.source.id || l.source, t = l.target.id || l.target; return s < t ? `${s}|${t}` : `${t}|${s}`; };

  // Recompute the resting opacity/size of every node and link from the current
  // filters, mode, and path highlight. Called after any state change and on
  // hover-out to restore.
  const applyStyles = useCallback(() => {
    const nodeSel = nodeSelRef.current, linkSel = linkSelRef.current;
    if (!nodeSel || !linkSel) return;
    const { mode: m, filters: f } = stateRef.current;
    const ph = pathHighlightRef.current;
    const nodeOpacity = (d) => {
      if (m === "pathfinder") return ph.nodeSet.size ? (ph.nodeSet.has(d.id) ? 1 : 0.15) : 0.15;
      const fid = typeToFilter(d.type);
      if (fid && !f[fid]) return 0.05;
      return d.stale ? 0.4 : 1;
    };
    const nodeScaleV = (d) => (m === "pathfinder" && ph.nodeSet.has(d.id) ? 1.15 : 1);
    nodeSel.attr("opacity", nodeOpacity).select(".map-node-circle").attr("transform", (d) => `scale(${nodeScaleV(d)})`);
    linkSel
      .attr("opacity", (d) => {
        const key = linkKey(d);
        if (m === "pathfinder") return ph.linkSet.has(key) ? 1 : 0.08;
        const s = d.source, t = d.target;
        const fs = typeToFilter(s.type), ft = typeToFilter(t.type);
        if ((fs && !f[fs]) || (ft && !f[ft])) return 0.05;
        return d.strength === "strong" ? 0.6 : d.strength === "weak" ? 0.25 : 0.4;
      })
      .attr("stroke", (d) => (m === "pathfinder" && pathHighlightRef.current.linkSet.has(linkKey(d)) ? "#F5A623" : d.gold ? "#F5A623" : "#475569"))
      .attr("stroke-width", (d) => (m === "pathfinder" && pathHighlightRef.current.linkSet.has(linkKey(d)) ? 3 : d.strength === "strong" ? 2.5 : d.strength === "weak" ? 1 : 1.5));
  }, []);

  // Main effect: build the SVG scene and run the force simulation. Re-runs when
  // the graph, size, or mode changes (mode swaps the layout forces).
  useEffect(() => {
    if (!svgRef.current || graph.nodes.length === 0) return;
    const { w, h } = size;
    const svg = d3.select(svgRef.current);
    const root = d3.select(zoomLayerRef.current);
    root.selectAll("*").remove();

    const linkG = root.append("g").attr("class", "map-links");
    const nodeG = root.append("g").attr("class", "map-nodes");

    const nodes = graph.nodes.map((n) => ({ ...n }));
    const links = graph.links.map((l) => ({ ...l, source: l.source, target: l.target }));

    // On touch/mobile viewports, enforce a minimum radius so small person nodes
    // stay comfortably tappable (spec: min 16px radius for people).
    const isTouch = size.w < 700;
    const radiusOf = (d) => {
      const rr = styleOf(d.type).r * scale;
      return isTouch && isPersonType(d.type) ? Math.max(rr, 16) : rr;
    };

    const linkSel = linkG.selectAll("line").data(links).join("line")
      .attr("class", "map-link")
      .attr("stroke-linecap", "round")
      .attr("stroke-dasharray", (d) => (d.strength === "weak" ? "4 4" : null));
    linkSelRef.current = linkSel;

    const nodeSel = nodeG.selectAll("g.map-node").data(nodes).join("g").attr("class", "map-node").style("cursor", "pointer");
    nodeSelRef.current = nodeSel;

    nodeSel.each(function (d) {
      const g = d3.select(this);
      const st = styleOf(d.type);
      const r = radiusOf(d);
      const dark = d3.color(st.fill).darker(0.9).formatHex();
      if (d.fresh) g.append("circle").attr("class", "map-pulse-ring").attr("r", r).attr("fill", "none").attr("stroke", st.fill).attr("stroke-width", 2);
      const circle = g.append("circle").attr("class", "map-node-circle").attr("r", r).attr("stroke", dark).attr("stroke-width", 1);
      // Person nodes are near-white by design (spec #E8ECF1, which is --text in
      // dark mode); use the theme text color so they stay visible in light mode.
      if (d.type === "person") circle.style("fill", "var(--text)"); else circle.attr("fill", st.fill);
      const showLabel = isInstitutionType(d.type) || d.type === "internal_person";
      // Label fill comes from CSS (.map-node-label -> var(--text)) so it flips with the theme.
      const label = g.append("text").attr("class", "map-node-label").attr("text-anchor", "middle").attr("dy", r + 12)
        .attr("font-size", isPersonType(d.type) ? 10 : 11).attr("opacity", showLabel ? 1 : 0).text(truncate(d.label));
      // Full name on hover when the label is truncated (L7).
      if (d.label && d.label.length > 15) label.append("title").text(d.label);
    });

    // Hover: emphasize the node and its neighbors, dim the rest.
    const neighborsOf = (id) => new Set([id, ...(graph.adjacency.get(id) || []).map((n) => n.id)]);
    nodeSel
      .on("mouseover", function (event, d) {
        hoverRef.current = d.id;
        const near = neighborsOf(d.id);
        nodeSel.attr("opacity", (n) => (near.has(n.id) ? 1 : 0.1));
        nodeSel.select(".map-node-label").attr("opacity", (n) => (near.has(n.id) ? 1 : (isInstitutionType(n.type) || n.type === "internal_person") ? 0.1 : 0));
        d3.select(this).select(".map-node-circle").attr("transform", "scale(1.25)");
        linkSel.attr("opacity", (l) => ((l.source.id === d.id || l.target.id === d.id) ? 1 : 0.06))
          .attr("stroke-width", (l) => ((l.source.id === d.id || l.target.id === d.id) ? (l.strength === "strong" ? 3 : 2) : 1));
        const conns = (graph.adjacency.get(d.id) || []).length;
        setTooltip({ x: event.clientX, y: event.clientY, name: d.label, type: styleOf(d.type).label, city: d.city, connections: conns });
      })
      .on("mousemove", (event) => setTooltip((t) => (t ? { ...t, x: event.clientX, y: event.clientY } : t)))
      .on("mouseout", function () {
        hoverRef.current = null;
        setTooltip(null);
        nodeSel.select(".map-node-label").attr("opacity", (n) => (isInstitutionType(n.type) || n.type === "internal_person") ? 1 : 0);
        applyStyles();
      })
      .on("click", (event, d) => { event.stopPropagation(); setPanelNodeId(d.id); });

    // Drag
    nodeSel.call(d3.drag()
      .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    // Forces differ by mode.
    const cx = w / 2, cy = h / 2;
    const sim = d3.forceSimulation(nodes)
      .force("charge", d3.forceManyBody().strength((d) => (d.isInstitution ? -300 : -100)))
      .force("link", d3.forceLink(links).id((d) => d.id).distance((l) => (l.strength === "strong" ? 80 : l.strength === "weak" ? 250 : 150)))
      .force("collide", d3.forceCollide().radius((d) => radiusOf(d) + 6));

    if (mode === "pathfinder") {
      const targetId = stateRef.current && pathTarget;
      sim.force("x", d3.forceX((d) => {
        if (d.type === "internal_person") return w * 0.12;
        if (d.id === targetId) return w * 0.88;
        if (d.type === "person") return w * 0.3;
        return w * 0.55;
      }).strength(0.25))
        .force("y", d3.forceY(cy).strength(0.06))
        .force("center", null);
    } else {
      sim.force("center", d3.forceCenter(cx, cy))
        .force("radial", d3.forceRadial((d) => {
          if (d.type === "target") return 70;
          if (d.type === "enabler") return 200;
          if (isPersonType(d.type)) return 260;
          return 300;
        }, cx, cy).strength((d) => (isPersonType(d.type) ? 0 : 0.25)));
    }

    sim.on("tick", () => {
      linkSel.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y).attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
    // Cap the simulation so it does not run forever.
    let ticks = 0;
    sim.on("tick.cap", () => { if (++ticks > 300) sim.stop(); });
    simRef.current = sim;

    // Zoom + pan on the whole SVG.
    const zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (event) => root.attr("transform", event.transform));
    zoomRef.current = zoom;
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("click", () => setPanelNodeId(null));

    applyStyles();
    return () => sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, size.w, size.h, mode, scale, pathTarget]);

  // Re-apply resting styles whenever filters / mode / path highlight change.
  useEffect(() => { applyStyles(); }, [filters, mode, paths, activePathIdx, applyStyles]);

  // Compute paths when a target is picked in Path Finder mode.
  useEffect(() => {
    if (mode === "pathfinder" && pathTarget) { setPaths(findPaths(graph, pathTarget)); setActivePathIdx(-1); }
    else if (mode !== "pathfinder") { setPaths([]); setPathTarget(""); setActivePathIdx(-1); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pathTarget, graph]);

  const zoomBy = (k) => { if (zoomRef.current && svgRef.current) d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, k); };
  const resetView = () => {
    if (zoomRef.current && svgRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.transform, d3.zoomIdentity);
    if (simRef.current) simRef.current.alpha(0.6).restart();
  };

  const panelNode = panelNodeId ? graph.nodeById.get(panelNodeId) : null;
  const panelData = useMemo(() => {
    if (!panelNode) return null;
    const neighbors = (graph.adjacency.get(panelNode.id) || []).map((n) => ({ node: graph.nodeById.get(n.id), link: n.link })).filter((x) => x.node);
    const people = neighbors.filter((x) => isPersonType(x.node.type));
    const connections = neighbors.filter((x) => x.node.isInstitution);
    let recent = [];
    if (panelNode.isInstitution) {
      const eset = new Set((panelNode.entities || []).map((e) => `${e.type}:${e.id}`));
      recent = activities.filter((a) => eset.has(`deal:${a.deal_id}`) || eset.has(`enabler:${a.enabler_id}`) || eset.has(`organization:${a.organization_id}`));
    } else {
      recent = activities.filter((a) => a.contact_id === panelNode.entity_id);
    }
    recent = recent.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
    return { people, connections, recent };
  }, [panelNode, graph, activities]);

  const openPanelNode = () => {
    if (!panelNode) return;
    if (panelNode.isInstitution) onOpenInstitution(panelNode.name);
    else onOpenPerson(panelNode.entity_id);
  };

  const pathLabel = (chain) => {
    const first = graph.nodeById.get(chain[0]);
    const prefix = first && first.type === "person" ? "You > " : "";
    const names = chain.map((id) => graph.nodeById.get(id)?.label || "?");
    return `${prefix}${names.join(" > ")}`;
  };

  return (
    <div className="map-view">
      <div className="map-topbar">
        <div className="map-topbar-left">
          <div className="map-mode-toggle">
            <button onClick={() => setMode("orbit")} className={`map-mode-btn ${mode === "orbit" ? "active" : ""}`}>Orbit Map</button>
            <button onClick={() => setMode("pathfinder")} className={`map-mode-btn ${mode === "pathfinder" ? "active" : ""}`}>Path Finder</button>
          </div>
          {mode === "pathfinder" && (
            <div className="map-pathpick">
              <span className="map-pathpick-label">Find paths to:</span>
              <select className="input map-target-select" value={pathTarget} onChange={(e) => setPathTarget(e.target.value)}>
                <option value="">Select target...</option>
                {targetOptions.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="map-topbar-right">
          <div className="map-filters">
            {FILTER_DEFS.map((f) => (
              <button key={f.id} onClick={() => setFilters((prev) => ({ ...prev, [f.id]: !prev[f.id] }))} className={`map-filter-btn ${filters[f.id] ? "active" : ""}`}>{f.label}</button>
            ))}
          </div>
          <div className="map-zoom-controls">
            <button onClick={() => zoomBy(1.3)} className="map-zoom-btn" title="Zoom in">+</button>
            <button onClick={() => zoomBy(1 / 1.3)} className="map-zoom-btn" title="Zoom out">-</button>
            <button onClick={resetView} className="map-zoom-btn map-reset-btn">Reset</button>
          </div>
        </div>
      </div>

      <div className="map-canvas" ref={canvasRef}>
        <svg ref={svgRef} width={size.w} height={size.h} className="map-svg">
          <g ref={zoomLayerRef} />
        </svg>

        {graph.nodes.length === 0 && <div className="map-empty">No institutions or people to map yet.</div>}

        {mode === "pathfinder" && pathTarget && (
          <div className="map-paths-panel">
            <div className="map-paths-title">{paths.length > 0 ? `${paths.length} path${paths.length === 1 ? "" : "s"} found` : "No paths"}</div>
            {paths.length === 0 ? (
              <div className="map-paths-empty">No paths found to {graph.nodeById.get(pathTarget)?.label}. Consider adding enabler connections.</div>
            ) : (
              <div className="map-paths-list">
                <button onClick={() => setActivePathIdx(-1)} className={`map-path-item ${activePathIdx === -1 ? "active" : ""}`}>Show all paths</button>
                {paths.map((chain, i) => (
                  <button key={i} onClick={() => setActivePathIdx(i)} className={`map-path-item ${activePathIdx === i ? "active" : ""}`}>
                    <span className="map-path-hops">Path {i + 1} ({chain.length - 1} hop{chain.length - 1 === 1 ? "" : "s"}):</span> {pathLabel(chain)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tooltip && (
          <div className="map-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}>
            <div className="map-tooltip-name">{tooltip.name}</div>
            <div className="map-tooltip-meta">{tooltip.type}{tooltip.city ? ` . ${tooltip.city}` : ""}</div>
            <div className="map-tooltip-meta">{tooltip.connections} connection{tooltip.connections === 1 ? "" : "s"}</div>
          </div>
        )}

        {panelNode && panelData && (
          <div className="map-side-panel">
            <div className="map-panel-header">
              <div>
                <div className="map-panel-name">{panelNode.label}</div>
                <div className="map-panel-badges">
                  <span className="badge" style={{ background: styleOf(panelNode.type).fill + "22", color: panelNode.type === "person" ? "var(--text)" : styleOf(panelNode.type).fill, border: `1px solid ${styleOf(panelNode.type).fill}44` }}>{styleOf(panelNode.type).label}</span>
                  {panelNode.city && <span className="city-pin">📍 {panelNode.city}</span>}
                </div>
              </div>
              <button onClick={() => setPanelNodeId(null)} className="close-btn">✕</button>
            </div>

            {panelNode.isInstitution && (
              <div className="map-panel-section">
                <div className="map-panel-label">People ({panelData.people.length})</div>
                {panelData.people.length === 0 ? <div className="empty-small">No people linked.</div> : panelData.people.map((p) => (
                  <div key={p.node.id} className="map-panel-row" onClick={() => setPanelNodeId(p.node.id)}>
                    <span className="map-panel-row-name">{p.node.label}</span>
                    {p.link.label && <span className="map-panel-row-sub">{p.link.label}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="map-panel-section">
              <div className="map-panel-label">Connections ({panelData.connections.length})</div>
              {panelData.connections.length === 0 ? <div className="empty-small">No connected institutions.</div> : panelData.connections.map((c) => (
                <div key={c.node.id} className="map-panel-row" onClick={() => setPanelNodeId(c.node.id)}>
                  <span className="map-panel-row-name">{c.node.label}</span>
                  {c.link.label && <span className="map-panel-row-sub">{c.link.label}</span>}
                </div>
              ))}
            </div>

            <div className="map-panel-section">
              <div className="map-panel-label">Recent Activity</div>
              {panelData.recent.length === 0 ? <div className="empty-small">No activity yet.</div> : panelData.recent.map((a) => (
                <div key={a.id} className="map-panel-activity">
                  <span className="map-panel-act-icon">{ACT_TYPES.find((t) => t.id === a.type)?.icon || "."}</span>
                  <div><div className="map-panel-act-desc">{stripFathomMarker(a.description)}</div><div className="map-panel-act-date">{formatDate(a.created_at)}</div></div>
                </div>
              ))}
            </div>

            <button onClick={openPanelNode} className="btn-primary map-panel-open">Open Sheet</button>
          </div>
        )}
      </div>
    </div>
  );
}
