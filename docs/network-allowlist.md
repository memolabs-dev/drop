# Network egress inventory (T4.27)

This describes destinations, not a blanket permission to contact them. Drop's private profile must enforce its own configured network origins; an address appearing here does **not** imply that it is contacted automatically. Ports below are defaults, configurable destinations can use other ports.

| Destination | Transport / port | When used | Code anchor |
| --- | --- | --- | --- |
| `127.0.0.1` | HTTP / configured local API port (default 7781) | Node local API and desktop panel; never Internet egress | `packages/node/src/daemon.ts`, `apps/desktop/src-tauri/src/main.rs` |
| `127.0.0.1` | WebSocket / 7780 | Desktop bootstrap relay default, if no relay configured | `apps/desktop/src-tauri/src/main.rs` (`DEFAULT_RELAY`) |
| `drop.memolabs.dev` | HTTPS / 443 | Default browser invitation/join page, when opening a join link | `packages/protocol/src/invite.ts` (`DEFAULT_JOIN_PAGE`) |
| Owner-selected relay host | WSS / 443 by convention; WS / configured port | Relay connection when enabled/selected, including relay adopted from team invitation | `packages/relay/src/client.ts`, `packages/node/src/daemon.ts` |
| Peer's local network address | WebSocket / negotiated port | Optional LAN discovery and direct peer link | `packages/node/src/lan.ts` |
| Owner/team-selected iroh relay and peers | iroh (QUIC/UDP) / relay-dependent ports | Optional Internet direct path enabled by network policy; exact destinations depend on the iroh configuration and peer connection | `packages/node/src/iroh.ts` |
| Owner-selected model/provider API | HTTPS / provider-dependent port (usually 443) | Only when a configured capability runs a remote model | `packages/runner/`, `packages/node/src/funding.ts` |
| `openrouter.ai` | HTTPS / 443 | Default API base for configured OpenRouter funding, not an unconditional startup call | `packages/node/src/funding.ts` (`baseUrl`) |
| Configured update host | HTTPS / update URL port (usually 443) | Desktop update checks only when configured and enabled | `apps/desktop/src-tauri/` |

The optional gateway component is separately configured: its default public URL is `https://drop.memolabs.dev` and its default upstream relay is `wss://drop.memolabs.dev/v1` (`packages/gateway/src/cli.ts`). This is **not** an additional mandatory connection from a private Node.

No universal fixed host/port list can describe owner-supplied model endpoints, private relays, iroh peers or updates. Operators must add their own destinations to a deployment-specific firewall policy. Check actual network traffic during a private-profile acceptance test before promising strict zero-egress behavior.

## Drift check

`test/network-allowlist.test.ts` verifies the stable repository defaults documented above. Whenever a destination default changes, update the inventory and its test in the same PR; this is a partial guard, **not** a static analysis of every possible dynamically configured URL.
