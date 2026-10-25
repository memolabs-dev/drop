# Drop offline proof: consent before the capability (25 October 2026)

**Status:** actual **local scripted integration test**, not a new-user UI acceptance, security certification, or production relay check.

[![Verification receipt excerpt generated from real CLI output](offline-consent-poster-20261025.png)](offline-consent-e2e-20261025.mp4)

[42-second captioned video](offline-consent-e2e-20261025.mp4) - a **graphical reconstruction of the actual CLI outputs**. Not a live-screen recording, and the video does not claim interactive human approval.

## Reproduce

Requires Node 22.18+ and the repository's pinned pnpm.

```bash
git clone https://github.com/memolabs-dev/drop.git
cd drop
pnpm install --frozen-lockfile
bash scripts/demo-local.sh --offline
```

The script starts one relay plus three nodes on **127.0.0.1:7790-7793** using a disposable temporary directory. Make sure those ports are free. It uses fixture data, and the owner's allow-once decision is scripted. Offline mode does not read Keychain or contact a model provider. Temporary daemons are stopped on script exit.

## Observed result

Run on a clean clone based on commit `e043eb4b9db3f6ceb0d10af464bfe1f008f40128` with the demo change in this PR, macOS ARM64, 25 October 2026.

| Step | Observed |
| --- | --- |
| Start local relay / three fixture nodes | OK |
| Discover declared capabilities | `production.error_summary`, `repo.answer` shown |
| Invalid `window=3d` request | Refused before sending |
| Valid `window=1h` request | `awaiting_approval` |
| Owner approves once | `allow_once sent` |
| Execute deterministic capability | `status: degraded`, `errorLines: 4` |
| Verify signed result receipt | CLI reports verified |
| Log leak check (known fixture fragments) | `no leak` |
| CLI process | Exit code 0; no external LLM invoked |

Limitations: the leak check scans for a **known fixture set**, not all possible exfiltration channels. The local fixture auto-approves once, so it does not prove that a real human understood the consent screen. The run does not test an independent machine, the native app, hardware key storage, real network restrictions or enterprise operation. See [acceptance gates](../ACCEPTANCE.md) and [pilot with actual UI screenshots](README.md).
