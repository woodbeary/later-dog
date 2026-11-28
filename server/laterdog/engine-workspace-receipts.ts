import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../atomic.ts";
import {
  sameEngineFile,
  type EngineFile,
  type EngineFileRoot,
} from "./engine-files.ts";

export type PreviousWorkspaceFile = EngineFile & { uncertain?: true };
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function checkedFiles(raw: string, root: EngineFileRoot): EngineFile[] {
  const files: EngineFile[] = JSON.parse(raw);
  const paths = new Set<string>();
  if (
    !Array.isArray(files) ||
    !files.every((file) => {
      if (
        !file ||
        file.root !== root.id ||
        typeof file.path !== "string" ||
        !file.path.length ||
        paths.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !Number.isSafeInteger(file.mode) ||
        file.path.startsWith("/") ||
        file.path
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        return false;
      paths.add(file.path);
      return true;
    })
  )
    throw Error("Invalid shared working folder checkpoint");
  return files;
}

export class WorkspaceReceipts {
  private readonly root: EngineFileRoot;
  private readonly db: DatabaseSync;
  private readonly folder: string;
  private readonly suffix: string;
  private readonly legacyName: string;
  private parents: number[] = [];
  private savedDigest?: string;
  constructor(root: EngineFileRoot, stateFile: string) {
    this.root = root;
    this.folder = dirname(stateFile);
    const key = digest(root.path);
    this.suffix = ".workspace-" + key + ".json";
    this.legacyName = basename(stateFile) + this.suffix;
    const directory = join(this.folder, "workspace-receipts");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, key + ".sqlite"));
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS heads (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS legacy (name TEXT PRIMARY KEY, signature TEXT NOT NULL, head INTEGER NOT NULL)",
    );
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private remember(name: string, signature: string, head: number) {
    this.db
      .prepare(
        "INSERT INTO legacy VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET signature=excluded.signature,head=excluded.head",
      )
      .run(name, signature, head);
  }
  private store(raw: string) {
    return Number(
      this.db.prepare("INSERT INTO heads(body) VALUES(?)").run(raw)
        .lastInsertRowid,
    );
  }
  private importLegacy(name: string) {
    const fd = openSync(
      join(this.folder, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw Error("Invalid working folder receipt file");
      const signature = [stat.dev, stat.ino, stat.ctimeNs, stat.size].join(":");
      const old = this.db
        .prepare("SELECT signature,head FROM legacy WHERE name=?")
        .get(name);
      if (old?.signature === signature) return;
      const raw = readFileSync(fd, "utf8");
      checkedFiles(raw, this.root);
      if (old) this.db.prepare("DELETE FROM heads WHERE id=?").run(old.head);
      this.remember(name, signature, this.store(raw));
    } finally {
      closeSync(fd);
    }
  }
  read(): PreviousWorkspaceFile[] {
    this.savedDigest = undefined;
    return this.transaction(() => {
      for (const name of readdirSync(this.folder)) {
        if (
          name === this.legacyName ||
          (name.endsWith(this.suffix) &&
            /^[a-f0-9]{24,64}\.json$/.test(name.slice(0, -this.suffix.length)))
        )
          this.importLegacy(name);
      }
      const observed = new Map<
        string,
        { file: EngineFile; count: number; different: boolean }
      >();
      this.parents = [];
      for (const head of this.db
        .prepare("SELECT id,body FROM heads ORDER BY id")
        .iterate()) {
        this.parents.push(Number(head.id));
        for (const file of checkedFiles(String(head.body), this.root)) {
          const before = observed.get(file.path);
          if (before) {
            before.count++;
            if (!sameEngineFile(before.file, file)) before.different = true;
          } else observed.set(file.path, { file, count: 1, different: false });
        }
      }
      return [...observed.values()].map(({ file, count, different }) =>
        different || count !== this.parents.length
          ? { ...file, uncertain: true }
          : file,
      );
    });
  }
  save(files: EngineFile[]) {
    const raw = JSON.stringify(files);
    const hash = digest(raw);
    if (this.savedDigest === hash) return;
    const head = this.transaction(() => {
      writeFileAtomic(join(this.folder, this.legacyName), raw, { mode: 0o600 });
      const drop = this.db.prepare("DELETE FROM heads WHERE id=?");
      for (const parent of this.parents) drop.run(parent);
      const id = this.store(raw);
      const fd = openSync(
        join(this.folder, this.legacyName),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const st = fstatSync(fd, { bigint: true });
        this.remember(
          this.legacyName,
          [st.dev, st.ino, st.ctimeNs, st.size].join(":"),
          id,
        );
      } finally {
        closeSync(fd);
      }
      return id;
    });
    this.parents = [head];
    this.savedDigest = hash;
  }
  close() {
    this.db.close();
  }
}
