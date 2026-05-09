/**
 * Smoke test: start the daemon on an ephemeral port + tmp DB, post a
 * thought, search for it, traverse, export. Asserts the round-trip
 * works *even when ZippyMesh is unreachable* — the embed module
 * returns null on failure and the KG falls back to FTS / LIKE.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../server.js";

let handle: DaemonHandle;
let tmpDir: string;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kg-daemon-smoke-"));
  // Force ZMLR to a guaranteed-dead port so the test always exercises
  // the no-embedding path. The daemon must still serve.
  process.env.ZIPPYMESH_URL = "http://127.0.0.1:1";
  handle = await startDaemon({
    dbPath: join(tmpDir, "smoke.db"),
    host: "127.0.0.1",
    port: 0, // OS picks
  });
  baseUrl = `http://127.0.0.1:${handle.port}/api/v1`;
});

afterAll(async () => {
  if (handle) await handle.close();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("kg-daemon smoke", () => {
  it("reports health with sqlite=true and zippymesh=false", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sqlite).toBe(true);
    expect(body.zippymesh).toBe(false);
    // vec / fts are environment-dependent; just confirm they're booleans.
    expect(typeof body.vec).toBe("boolean");
    expect(typeof body.fts).toBe("boolean");
  });

  it("rejects malformed thought POSTs with 400 + bridge-style error", async () => {
    const r = await fetch(`${baseUrl}/thoughts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "x" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(400);
    expect(typeof body.error?.message).toBe("string");
  });

  it("round-trips a thought through POST + search + filter + export", async () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const post = await fetch(`${baseUrl}/thoughts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "smoke-proj",
        agent: "claude-code",
        kind: "thought",
        text,
        meta: { source: "smoke" },
      }),
    });
    expect(post.status).toBe(201);
    const created = await post.json() as { id: string };
    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);

    // search — works via FTS or LIKE even with no embeddings
    const sr = await fetch(
      `${baseUrl}/thoughts/search?q=${encodeURIComponent("quick fox")}&k=5&project=smoke-proj`,
    );
    expect(sr.status).toBe(200);
    const sBody = await sr.json() as { thoughts: Array<{ id: string; text: string }> };
    expect(Array.isArray(sBody.thoughts)).toBe(true);
    expect(sBody.thoughts.length).toBeGreaterThan(0);
    expect(sBody.thoughts[0].id).toBe(created.id);

    // forProject filter
    const fp = await fetch(`${baseUrl}/thoughts?project=smoke-proj`);
    expect(fp.status).toBe(200);
    const fpBody = await fp.json() as { thoughts: Array<{ id: string }> };
    expect(fpBody.thoughts.some((t) => t.id === created.id)).toBe(true);

    // export jsonl
    const ex = await fetch(`${baseUrl}/thoughts/export?project=smoke-proj&format=jsonl`);
    expect(ex.status).toBe(200);
    const exText = await ex.text();
    expect(exText).toContain(created.id);
    expect(exText).toContain("smoke-proj");
  });

  it("records and traverses an edge", async () => {
    const mk = async (text: string) => {
      const r = await fetch(`${baseUrl}/thoughts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: "edge-proj",
          agent: "claude-code",
          kind: "thought",
          text,
        }),
      });
      const j = await r.json() as { id: string };
      return j.id;
    };
    const a = await mk("alpha node");
    const b = await mk("beta node");
    const c = await mk("gamma node");

    const link = async (from: string, to: string, kind: string) => {
      const r = await fetch(`${baseUrl}/relations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, kind }),
      });
      expect(r.status).toBe(201);
    };
    await link(a, b, "mentions");
    await link(b, c, "mentions");

    const tr = await fetch(
      `${baseUrl}/thoughts/traverse?seed=${a}&kinds=mentions&depth=2`,
    );
    expect(tr.status).toBe(200);
    const tBody = await tr.json() as { thoughts: Array<{ id: string }> };
    const ids = tBody.thoughts.map((t) => t.id);
    expect(ids).toContain(b);
    expect(ids).toContain(c);
  });

  it("returns 400 when /thoughts has no filters", async () => {
    const r = await fetch(`${baseUrl}/thoughts`);
    expect(r.status).toBe(400);
  });

  it("returns 404 for unknown routes with bridge-style error", async () => {
    const r = await fetch(`${baseUrl}/does-not-exist`);
    expect(r.status).toBe(404);
    const body = await r.json() as { error?: { code?: number } };
    expect(body.error?.code).toBe(404);
  });
});
