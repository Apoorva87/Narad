export function passageFraction(chunks:string[],chunk:number,elapsed:number,duration:number) {
  const total=chunks.reduce((sum,text)=>sum+text.length,0);
  const before=chunks.slice(0,chunk).reduce((sum,text)=>sum+text.length,0);
  const within=Number.isFinite(duration)&&duration>0?Math.max(0,Math.min(1,elapsed/duration)):0;
  return total?Math.min(1,(before+(chunks[chunk]?.length??0)*within)/total):0;
}

/** Approximate passage travel, not word alignment. Keep content above the sticky player. */
export function playbackScrollTop({top,height,viewport,controlsHeight,fraction}:{top:number;height:number;viewport:number;controlsHeight:number;fraction:number}) {
  const margin=32;
  const available=Math.max(80,viewport-controlsHeight-40-margin);
  return Math.max(0,height<=available
    ?top-margin-(available-height)/2
    :top-margin+Math.max(0,Math.min(1,fraction))*(height-available));
}
