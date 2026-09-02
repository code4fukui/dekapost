import { openDatabase } from "../src/db.ts";

Deno.test("database initialization creates admin without resetting it", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const databasePath = `${directory}/test.sqlite`;
    const migrations = new URL("../migrations", import.meta.url).pathname;
    const db = await openDatabase(databasePath, migrations);
    const admin = db.prepare("SELECT is_admin, must_change_password FROM users WHERE id = ?").get(
      "admin",
    ) as { is_admin: number; must_change_password: number };
    if (admin.is_admin !== 1 || admin.must_change_password !== 1) {
      throw new Error("initial admin is invalid");
    }
    const fileColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    if (!fileColumns.some((column) => column.name === "expires_at")) {
      throw new Error("file expiration migration was not applied");
    }
    const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (!userColumns.some((column) => column.name === "total_file_count")) {
      throw new Error("user file total migration was not applied");
    }
    db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run("admin");
    db.close();

    const reopened = await openDatabase(databasePath, migrations);
    const existing = reopened.prepare("SELECT must_change_password FROM users WHERE id = ?").get(
      "admin",
    ) as { must_change_password: number };
    reopened.close();
    if (existing.must_change_password !== 0) throw new Error("existing admin was reset");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
