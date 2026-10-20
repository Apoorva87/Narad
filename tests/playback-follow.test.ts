import { expect,it } from 'vitest';
import { playbackScrollTop, passageFraction } from '../src/lib/playback-follow';

it('follows chunk progress in spoken-text order, weighted by chunk length',()=>{
 expect(passageFraction(['one','three'],0,0,10)).toBe(0);
 expect(passageFraction(['one','three'],1,5,10)).toBe(5.5/8);
 expect(passageFraction(['one','three'],1,10,10)).toBe(1);
});
it('shows the beginning of a tall passage before advancing, above the player',()=>{
 expect(playbackScrollTop({top:1000,height:2000,viewport:800,controlsHeight:160,fraction:0})).toBe(968);
 expect(playbackScrollTop({top:1000,height:2000,viewport:800,controlsHeight:160,fraction:1})).toBe(2400);
});
it('keeps a whole short figure in the readable area without moving through it',()=>{
 const input={top:1000,height:300,viewport:800,controlsHeight:160};
 expect(playbackScrollTop({...input,fraction:0})).toBe(playbackScrollTop({...input,fraction:1}));
 expect(playbackScrollTop({...input,fraction:0})).toBe(834);
});
