import { useId } from 'react';
import { layoutDiagram, type DiagramEdge, type DiagramNode } from '../lib/diagram-layout';

/** A teaching diagram drawn from named boxes and labelled arrows. Narad draws it; agents only supply the data. */
export function ConceptDiagram({ title, caption, nodes, edges }: { title: string; caption: string; nodes: DiagramNode[]; edges: DiagramEdge[] }) {
  const arrow = useId();
  const layout = layoutDiagram(nodes, edges);
  return <figure className="concept-diagram">
    <div className="teaching-label">Teaching diagram</div>
    <strong className="concept-title">{title}</strong>
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ maxWidth: layout.width * 1.25 }} role="img" aria-label={title + '. ' + caption}>
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      {layout.edges.map((edge, index) => <path key={index} className="concept-arrow" d={edge.path} markerEnd={`url(#${arrow})`} />)}
      {layout.nodes.map(node => <g key={node.id}>
        <rect x={node.x - node.width / 2} y={node.y - node.height / 2} width={node.width} height={node.height} rx="12" />
        <text className="concept-node" x={node.x} y={node.y - ((node.lines.length - 1) * 18) / 2} textAnchor="middle" dominantBaseline="central">{node.lines.map((line, index) => <tspan key={index} x={node.x} dy={index ? 18 : 0}>{line}</tspan>)}</text>
      </g>)}
      {layout.edges.map((edge, index) => edge.label && <text key={index} className="concept-edge" x={edge.labelX} y={edge.labelY} textAnchor="middle" dominantBaseline="central">{edge.label}</text>)}
    </svg>
    <figcaption>{caption}</figcaption>
  </figure>;
}
