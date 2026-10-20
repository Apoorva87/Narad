import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const MAX_SLUG = 60;

function baseSlug(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function slugify(title: string, taken: Set<string>): string {
  const base = baseSlug(title).slice(0, MAX_SLUG).replace(/-+$/, '') || 'untitled';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export function mediaName(sourceIndex: number, assetIndex: number, label: string, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const cleanExt = ext.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const slug = baseSlug(label).slice(0, 40).replace(/-+$/, '');
  return `${pad(sourceIndex)}-fig-${pad(assetIndex)}${slug ? `-${slug}` : ''}.${cleanExt}`;
}

export function toServedSrc(slug: string, src: string): string {
  return src.startsWith('media/') ? `/api/library/${slug}/${src}` : src;
}

export function toStoredSrc(slug: string, src: string): string {
  const prefix = `/api/library/${slug}/`;
  return src.startsWith(`${prefix}media/`) ? src.slice(prefix.length) : src;
}

let tempCounter = 0;

export class LibraryFs {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private root: string) {}

  dir(slug: string): string { return this.inside(this.root, slug); }
  exists(slug: string): boolean { return existsSync(this.dir(slug)); }
  slugs(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .map(entry => entry.name).sort();
  }
  readJson<T>(slug: string, file: string): { value?: T; error?: string; mtimeMs: number } {
    const path = this.inside(this.dir(slug), file);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      try { return { value: JSON.parse(readFileSync(path, 'utf8')) as T, mtimeMs }; }
      catch (error) { return { error: (error as Error).message, mtimeMs }; }
    } catch (error) { return { error: (error as Error).message, mtimeMs: 0 }; }
  }
  writeJson(slug: string, file: string, value: unknown): void { this.writeText(slug, file, JSON.stringify(value, null, 2) + '\n'); }
  writeText(slug: string, file: string, text: string): void { this.writeBytes(slug, file, Buffer.from(text, 'utf8')); }
  writeBytes(slug: string, file: string, bytes: Uint8Array): void {
    const path = this.inside(this.dir(slug), file);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${++tempCounter}`;
    const fd = openSync(temp, 'w');
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
  }
  readBytes(slug: string, file: string): Buffer | undefined {
    try { return readFileSync(this.inside(this.dir(slug), file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  rename(from: string, to: string): void { renameSync(this.dir(from), this.dir(to)); }
  remove(slug: string): void { rmSync(this.dir(slug), { recursive: true, force: true }); }
  withLock<T>(slug: string, work: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(slug) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.locks.set(slug, tail);
    void tail.then(() => { if (this.locks.get(slug) === tail) this.locks.delete(slug); });
    return run;
  }

  private inside(base: string, name: string): string {
    const root = resolve(base), path = resolve(root, name);
    if (!name || (path !== root && !path.startsWith(root + sep)) || path === root) throw new Error(`Unsafe path: ${name}`);
    return path;
  }
}
