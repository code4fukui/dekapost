import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./auth.ts";

export type User = {
  id: string;
  is_admin: number;
  must_change_password: number;
};

export async function openDatabase(
  path: string,
  migrationsDirectory: string,
): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
  );

  const applied = db.prepare("SELECT version FROM schema_migrations").all().map((row) =>
    row.version
  );
  const entries = [];
  for await (const entry of Deno.readDir(migrationsDirectory)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isFile || !/^\d+.*\.sql$/.test(entry.name) || applied.includes(entry.name)) continue;
    const sql = await Deno.readTextFile(`${migrationsDirectory}/${entry.name}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        entry.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const admin = db.prepare("SELECT 1 FROM users WHERE id = ?").get("admin");
  if (!admin) {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users(id, password_hash, is_admin, must_change_password, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)",
    ).run("admin", await hashPassword("adminadmin"), now, now);
  }
  return db;
}
