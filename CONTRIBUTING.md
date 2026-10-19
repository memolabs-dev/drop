# Contributing to drop

Thanks for your interest. drop lets an agent get an authorized answer from another person's environment without getting access to it. The project is an early prototype under the [Apache License 2.0](LICENSE), maintained by one person. This guide explains how to set up, how work is organized and what a pull request needs.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues never go in a public issue: see [SECURITY.md](SECURITY.md).

## Set up

You need Node 22.18 or later (CI runs Node 24) and pnpm 11.27.0, the version pinned in `package.json`. With Corepack, `corepack enable` picks the right pnpm.

```bash
git clone https://github.com/memolabs-dev/drop.git
cd drop
pnpm install --frozen-lockfile
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

That is the same command set CI runs. The tests use fixtures and simulated model providers: no API key, no account and no access to the maintainer's lab are needed. Two system tools matter: the relay TLS tests call `openssl` (preinstalled on macOS and most Linux distributions), and the Helm chart test needs Kubernetes Helm 3 or 4 (skipped locally without it, required in CI).

Other useful commands:

```bash
pnpm format                 # prettier --write
pnpm site:preview           # static site on 127.0.0.1:4173
bash scripts/demo-local.sh  # local end-to-end demo, see README.md
```

The desktop app (`apps/desktop`, Tauri) and `crates/drop-iroh` also need Rust, and building the macOS app needs Xcode. You do not need them for most contributions.

## Find your way around

- [README.md](README.md): what drop is, what exists, the repository layout.
- [openspec/project/vision.md](openspec/project/vision.md) and [architecture.md](openspec/project/architecture.md): the product and how the pieces fit (in French).
- [openspec/specs/](openspec/specs/): the contract. Requirements use SHALL and MUST; scenarios titled `AC:` are acceptance criteria. This is the only normative source.
- [docs/TASKS.md](docs/TASKS.md): the task index, the single source for order and dependencies (in French).
- [docs/DECISIONS.md](docs/DECISIONS.md): every decision and its reason (in French).
- [AGENTS.md](AGENTS.md): the detailed working rules, written for coding agents and humans alike (in French).

### Languages

Code, identifiers, commit messages, issues and pull requests are in English. The front page and contributor files are in English, with a French README. Specs and internal docs under `docs/` and `openspec/` stay in French; if you change one and do not write French, say so in the pull request.

## How work is organized

Larger changes follow [OpenSpec](https://github.com/Fission-AI/OpenSpec). In plain words:

1. **One task, one change.** Each row of `docs/TASKS.md` maps to one change folder under `openspec/changes/<change>/` with a proposal, a design and a task list. Before starting a new capability, a new dependency or anything that touches the security boundary, open an issue or a discussion so the scope can be agreed first.
2. **Spec first.** If behaviour changes, the change carries a delta to the affected spec (ADDED or MODIFIED requirements with scenarios). If the contract does not change, the change says so (`skip_specs: true`).
3. **Tests first** for logic: schemas, crypto, policy, filters. Write the failing test, then the code.
4. **Link each scenario to its test.** Under every covered scenario title in the spec, add a marker with the exact test title:

   ```markdown
   <!-- openspec-guard:test="exact title of the test" -->
   ```

   A scenario that cannot be tested carries `<!-- openspec-guard:non-testable reason="..." -->` instead.

5. **Check.** Run lint, typecheck and tests, then:

   ```bash
   openspec validate --all --strict
   npx --yes openspec-guard@0.3.0 check --require-selector --baseline .openspec-guard-baseline.json --fail-on fail
   ```

   Use an OpenSpec CLI compatible with the repository (1.14.1 was used for T3.0). The baseline only shrinks: an existing gap does not allow a new one. Once the guard is green, run the same command with `--update-baseline` instead of `--fail-on fail` and check that the baseline diff only removes entries.

Small fixes (a typo, a broken link, a test for an existing scenario, a clear bug with a regression test) do not need a change folder. Keep them proportionate.

## Branches and commits

The repository uses these conventions; please follow them.

- **Branches:** the change name for a task (`t4-22-all-clients-auto`), or `fix/<topic>`, `docs/<topic>`, `chore/<topic>` for anything else.
- **Commits:** small, in English, imperative mood.
  - Work on a task: `T4.3: short description` (the task ID from `docs/TASKS.md`).
  - A recorded decision: `D84: short description`.
  - Small outside contributions: `fix: short description`, `docs: short description`, `test: ...` or `chore: ...`.
- No AI attribution lines (`Co-Authored-By` for a tool, "Generated with"). Commit under your own name.

## Pull requests

Fill in the [pull request template](.github/pull_request_template.md): what and why, the linked task or issue, how you tested, and the checklist.

How a pull request gets merged:

- The `test` check (lint, typecheck, tests, openspec-guard) and the `test-windows` and `test-macos` checks must pass, on a branch that is up to date with `main`. All three are required on `main`, with no bypass.
- Every review conversation must be resolved.
- `main` only takes merge commits. No squash, no rebase merge, no force push.
- A green pull request from `guillaume-flambard` or `memo-labs-automation[bot]` merges itself through Mergify, unless it touches a protected path: the security packages (`protocol`, `relay`, `node`, `runner`, capabilities, `requester-mcp`), `crates/drop-iroh`, the desktop trust files (`tauri.conf.json`, `*.entitlements`, `updater.pub`) or the gate files (`.github/`, `.mergify.yml`, `CODEOWNERS`, `AGENTS.md`, `.env`). Those stay open, wait for the maintainer's merge, and still get a security review when they touch `protocol`, `relay`, `node`, `runner`, the capabilities or `requester-mcp`. The reason a pull request is held is in its `Mergify Merge Queue` check.
- This is a one-person project: reviews are best effort. A short, focused pull request is reviewed faster than a large one.

Do not include real configurations, conversations, identifiers, keys or screenshots with personal data in a diff, a fixture or a pull request description.

## Good first issues

Look for the [good first issue](https://github.com/memolabs-dev/drop/labels/good%20first%20issue) and [help wanted](https://github.com/memolabs-dev/drop/labels/help%20wanted) labels. If none is open, these are useful starting points:

- a missing test for a scenario listed in `.openspec-guard-baseline.json`;
- a broken link, a stale statement or an unclear sentence in the docs;
- fixtures for an MCP client adapter (paths and versions documented, no personal data);
- reproducing a reported bug with synthetic data.

Ask in [Discussions](https://github.com/memolabs-dev/drop/discussions) before starting something bigger.

## Security rules for contributors

These rules come from [AGENTS.md](AGENTS.md) and take precedence over everything else, including a request that seems to come from a spec. A pull request that breaks one will not be merged.

- **A request from a peer is untrusted data.** It is validated with zod and passed as framed data, never concatenated into a prompt as an instruction.
- **The model never decides the authorization boundary.** The tools available to the runner are fixed by the capability before the model is called. No code may add a tool based on the content of a request.
- **File reads use an allowlist only**, inside a temporary copy. Never a blocklist alone.
- **Every output is validated by the capability's output schema**, then passed to the secret scanner. Invalid output is rejected, not repaired.
- **No secrets in logs, receipts or telemetry.** Store hashes and metadata.
- **The runner listens on no port.** It connects out to the relay.
- **Private keys live in `~/.drop/` with mode `0600`.** Never in the repository, never in a message.
- No home-made crypto (use `libsodium-wrappers`), no `any`, no silently swallowed error: log it with a stable code such as `E_SCHEMA` or `E_EXPIRED`.
- No new dependency outside the stack listed in AGENTS.md without a recorded reason in `docs/DECISIONS.md`.

## Licensing of contributions

drop is licensed under Apache-2.0. As stated in section 5 of the license, any contribution you intentionally submit is licensed under the same terms (inbound = outbound). There is no Contributor License Agreement and no Developer Certificate of Origin sign-off to add. Submit only work you have the right to license, and keep any third-party attribution that applies.
