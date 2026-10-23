import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HearthyError } from '../errors.js';

export const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

export interface SourceFile {
  /** Absolute path with forward slashes; the document's identity in the database. */
  path: string;
  content: string;
  sha256: string;
}

/** Normalises a path to an absolute, forward-slash form so the same file always gets the same key. */
export function toDocumentPath(p: string): string {
  return path.resolve(p).replaceAll('\\', '/');
}

/** Shows a stored path relative to the working directory when it lives under it. */
export function displayPath(documentPath: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, documentPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replaceAll('\\', '/')
    : documentPath;
}

/** Lists supported files under `target` (a file or a directory), skipping dependency/VCS folders. */
export async function findFiles(target: string): Promise<string[]> {
  const info = await stat(target).catch(() => {
    throw new HearthyError(`Path not found: ${target}`);
  });

  if (info.isFile()) {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(target).toLowerCase())) {
      throw new HearthyError(
        `Unsupported file type: ${target} (supported: ${[...SUPPORTED_EXTENSIONS].join(', ')})`,
      );
    }
    return [toDocumentPath(target)];
  }

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full);
      } else if (
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(toDocumentPath(full));
      }
    }
  };
  await walk(target);
  return files.sort();
}

export async function loadFile(documentPath: string): Promise<SourceFile> {
  const content = await readFile(documentPath, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { path: documentPath, content, sha256 };
}
