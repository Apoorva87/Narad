import { z } from 'zod';
import { familiarities, type Familiarity } from './lesson';

export const sourceInputSchema = z.object({
  title: z.string().trim().max(180).default(''),
  familiarity: z.enum(familiarities).default('foundational'),
  text: z.string().trim().max(100_000).default(''),
  images: z.array(z.object({ name: z.string().min(1).max(240), data: z.string().max(8_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/) })).max(6).default([]),
}).refine(input => input.text.length > 0 || input.images.length > 0, { message: 'Add an idea, a link, or an image.' });
export type SourceInput = z.input<typeof sourceInputSchema>;
export type SourceAsset = {
  id: string; kind: 'image' | 'inline-svg'; alt: string; caption: string;
  src?: string; originalSrc?: string; originalUrl?: string; widthEm?: number; error?: string;
};
export type CapturedSource = {
  id: string; title: string; kind: 'article' | 'note' | 'image'; url?: string;
  markdown: string; rawHtml?: string; assets: SourceAsset[]; warnings: string[];
  inventory: { images: number; inlineSvg: number; tables: number; savedVisuals: number };
};
export type SourceBundle = {
  id: string; title: string; createdAt: string; text: string;
  lessonId?: string; familiarity?: Familiarity;
  status: 'captured' | 'needs-review'; sources: CapturedSource[];
};
export type BundleSummary = Pick<SourceBundle, 'id' | 'title' | 'createdAt' | 'status' | 'lessonId'> & { sourceCount: number; visualCount: number; warningCount: number };
export type AssetBlob = { id: string; bytes: Buffer; type: string };
