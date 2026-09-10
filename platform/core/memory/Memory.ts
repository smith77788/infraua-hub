import * as fs from 'fs';
import * as path from 'path';

export type MemoryCategory = 'decisions' | 'architecture' | 'tasks' | 'agent_reports' | 'failures';

const CATEGORIES: MemoryCategory[] = ['decisions', 'architecture', 'tasks', 'agent_reports', 'failures'];

/**
 * Project memory: a plain directory of markdown/JSON notes agents can
 * read before acting and write to when they produce a decision, report,
 * or failure record. Deliberately not a vector DB for the MVP - a
 * handful of categorized files is enough to give agents continuity,
 * and it is trivial to inspect and diff in Git.
 */
export class Memory {
  constructor(private readonly baseDir: string) {
    for (const category of CATEGORIES) {
      fs.mkdirSync(path.join(this.baseDir, category), { recursive: true });
    }
  }

  write(category: MemoryCategory, name: string, content: string): string {
    const filePath = path.join(this.baseDir, category, `${name}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  read(category: MemoryCategory, name: string): string | null {
    const filePath = path.join(this.baseDir, category, `${name}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  list(category: MemoryCategory): string[] {
    const dir = path.join(this.baseDir, category);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
  }

  readAll(category: MemoryCategory): { name: string; content: string }[] {
    return this.list(category).map((name) => ({
      name,
      content: fs.readFileSync(path.join(this.baseDir, category, name), 'utf-8'),
    }));
  }
}
