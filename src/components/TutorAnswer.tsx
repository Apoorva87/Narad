import type { Lesson } from '../../shared/lesson';
import type { TutorAnswerBlock } from '../../shared/tutor';
import { Markdown } from './Markdown';
import { ConceptDiagram } from './ConceptDiagram';

function Plot({block}:{block:Extract<TutorAnswerBlock,{kind:'plot'}>}) {
  const points=block.series.flatMap(series=>series.points),xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const x=(v:number)=>64+(v-minX)/(maxX-minX||1)*500,y=(v:number)=>210-(v-minY)/(maxY-minY||1)*160;
  const colors=['#244fc5','#cc613b','#2c8b73','#7b5ab7','#b58c20','#44758f'];
  return <figure className="tutor-visual tutor-plot"><div className="teaching-label">Teaching plot</div><svg viewBox="0 0 620 260" role="img" aria-label={block.caption}><line x1="64" y1="210" x2="580" y2="210"/><line x1="64" y1="35" x2="64" y2="210"/><text x="320" y="247" textAnchor="middle">{block.xLabel}</text><text x="18" y="125" textAnchor="middle" transform="rotate(-90 18 125)">{block.yLabel}</text><text x="64" y="228" textAnchor="middle">{minX}</text><text x="580" y="228" textAnchor="middle">{maxX}</text><text x="54" y="214" textAnchor="end">{minY}</text><text x="54" y="40" textAnchor="end">{maxY}</text>{block.series.map((series,index)=><g key={series.label}><polyline points={series.points.map(point=>`${x(point.x)},${y(point.y)}`).join(' ')} fill="none" stroke={colors[index]} strokeWidth="4"/>{series.points.map((point,i)=><circle key={i} cx={x(point.x)} cy={y(point.y)} r="5" fill={colors[index]}/>)}</g>)}</svg><div className="plot-legend">{block.series.map((series,index)=><span key={series.label}><i style={{background:colors[index]}}/>{series.label}</span>)}</div><details className="plot-data"><summary>Plot data</summary><div className="table-scroll"><table><thead><tr><th>Series</th><th>{block.xLabel}</th><th>{block.yLabel}</th></tr></thead><tbody>{block.series.flatMap(series=>series.points.map((point,index)=><tr key={series.label+index}><td>{series.label}</td><td>{point.x}</td><td>{point.y}</td></tr>))}</tbody></table></div></details><figcaption>{block.caption}</figcaption></figure>;
}
export function TutorAnswer({block,lesson}:{block:TutorAnswerBlock;lesson:Lesson}) {
  if(block.kind==='diagram')return <ConceptDiagram title={block.title} caption={block.caption} nodes={block.nodes} edges={block.edges}/>;
  if(block.kind==='plot')return <Plot block={block}/>;
  if(block.kind==='existing-figure'){const asset=lesson.assets.find(item=>item.id===block.assetId);return <div>{asset&&<figure className="tutor-visual"><div className="teaching-label">Original lesson figure</div><img src={asset.src} alt={asset.alt}/><figcaption>{asset.caption}</figcaption></figure>}<Markdown>{block.markdown}</Markdown></div>}
  return <div className={block.kind==='equation'?'tutor-equation':undefined}>{block.kind==='equation'&&<Markdown>{`$$\n${block.latex}\n$$`}</Markdown>}<Markdown>{block.markdown}</Markdown></div>;
}
