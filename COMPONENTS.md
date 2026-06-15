# AutoClaw — Component Classification

This file is the authoritative **Open / Restricted** manifest required by
Section 22 of the [Zippy Technologies Source-Available Commercial License](LICENSE).

- **Open Materials** — listed below. You may review, modify, and create
  Derivative Works of these per License §6 (subject to the disclosure terms in
  §8). Community contributions to these areas are welcomed and encouraged.
- **Restricted Materials** — **everything not listed below.** Per License §1.5,
  any file or directory not expressly designated here is Restricted Material:
  proprietary and confidential, exposed for inspection only (License §7). It may
  not be modified, ported, reimplemented, or built into a separate product.

> Inclusion here designates a path as **ZIPPY OPEN MATERIAL**. Absence does not
> imply a path is unimportant — it means it is Restricted by default.

---

## Open Materials (community-contributable)

These are the integration surface and presentation layers — the parts where
community contribution helps everyone without giving away the core engine.

| Path | What it is |
|------|-----------|
| `adapters/**` | Per-IDE adapter skill files (Claude Code, Cursor, Cline, Continue, Kilo, Kiro, Windsurf, Antigravity, ZippyMesh). The glue that wires AutoClaw skills into each host IDE. |
| `skills/**` | User-facing skill definitions (markdown skill specs). |
| `src/skills/**` | Skill loading / dispatch glue. |
| `src/hooks/**` | Event-hook trigger surface (the public hook contract other tools integrate against). |
| `src/support/**` | Donation / review / support UI (this monetization surface itself is open). |
| `src/licensing/**` | Offline license-key verification + BYO-key glue. Open by design — it only verifies; the signing private key is held by Zippy Technologies and never shipped. |
| `docs/**` | Documentation. |
| `media/**`, `resources/**` | Icons and static assets. |
| `scripts/**` | Build and developer tooling scripts. |

Want a directory opened for contribution that isn't listed? Open an issue or
email **Support@GoZippy.com** — we'd rather grow the community surface than
keep it small.

---

## Restricted Materials (proprietary — inspection only)

Everything else, including but not limited to the following directories, is
Restricted Material. These contain the proprietary engine and the highest-value
logic that differentiates AutoClaw:

| Path | Why it's restricted |
|------|--------------------|
| `src/intelligence/**` | Session-learning, RAG, effectiveness mining, the intelligence layer. |
| `src/reputation/**` | Reputation scoring / routing. |
| `src/fabric/**`, `src/orchestrator/**`, `src/fleet/**` | Multi-agent orchestration, DAG planning, fleet coordination. |
| `src/cloud/**`, `src/relay-server/**`, `src/bridge/**`, `src/comms/**` | Cross-machine routing, relay, and the agent message bus. |
| `src/llm/**`, `src/lmd/**` | Model oracle, router, and model-selection logic. |
| `src/memory/**`, `src/program/**`, `src/voidspec/**`, `src/evidence/**`, `src/budget/**` | Memory consolidation, program/spec management, cost ledger. |
| `src/daemon/**`, `src/keepalive/**`, `src/runners/**`, `src/personas/**`, `src/mcp/**`, `src/cli/**` | Background daemon, runner execution, persona engine, MCP tooling, CLI. |
| `src/extension.ts`, `src/views/**`, `src/panel/**`, `src/webview/**`, `src/statusbar/**` | Extension host wiring and the UI that renders restricted subsystems. |
| any path not listed under **Open Materials** | Restricted by default (License §1.5). |

---

## Notes for contributors

- Contributions to **Open Materials** are accepted under License §9 (you grant
  Zippy Technologies LLC a license to include them in the Product).
- **Personal and educational use of the entire Product is free** (License §4).
- **Commercial use requires a paid license** — see [PRICING.md](PRICING.md) and
  License §5.
- This manifest is kept current with each release. Last reviewed against the
  tree at the time of the v3.4.x series.
