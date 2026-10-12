import { EventEmitter } from 'node:events';
import {
  createAdmission,
  DropError,
  createTeam,
  createInvite,
  encodeInvite,
  inviteCodeFrom,
  verifyInvite,
  isDropError,
  isFactCapabilityId,
  HUMAN_ANSWER_OUTPUT_SCHEMA,
  signFact,
  openEnvelope,
  ReplayCache,
  REPLAY_WINDOW_MS,
  MAX_CLOCK_SKEW_MS,
  sealEnvelope,
  sha256Hex,
  signCard,
  signReceipt,
  uuidv7,
  uuidv7Timestamp,
  verifyCard,
  verifyReceipt,
  type CapabilityCard,
  type ConsentCard,
  type DropErrorCode,
  type DropState,
  type Envelope,
  type Funding,
  type Identity,
  type Invite,
  type Message,
  type MessageOf,
  type NodeId,
  type Owner,
  type OwnerKind,
  type Receipt,
  type RequestedBy,
  type SignedCapabilityCard,
  type TeamMember,
  type UnsignedReceipt,
} from '@drop/protocol';
import { IrohAddrSchema, type IrohAddr } from '@drop/protocol';
import type { Funder } from './funding.ts';
import { irohRelayAllowed } from './iroh.ts';
import { checkHumanAnswer } from './human-answer.ts';
import {
  carriesInvite,
  carriesTag,
  decodeLanKey,
  inviteTag,
  lanEpoch,
  lanTag,
  MAX_INVITE_TAGS,
  newLanKey,
  type LanAnnouncement,
} from './lan-tags.ts';
import {
  draftFact,
  FACT_IMPL,
  FACT_OUTPUT_HASH,
  factCard,
  factResultHolds,
  inAudience,
  isLive,
  type StoredFact,
} from './facts.ts';
import { applyRedactions, buildCard, implFor, runCapability, validateInput, type CapabilityImpl } from '@drop/runner';
import type { AgentLink, InviteState, LinkRequest, Peer, Published, TeamState } from './home.ts';

export const APPROVAL_TTL_MS = 10 * 60_000;
export const REVIEW_TTL_MS = 10 * 60_000;
export const CATALOG_TTL_MS = 60_000;
export const MAX_ACTIVE_EXECUTING_DROPS = 1_024;
export const MAX_COMPLETED_ERRORS = 1_024;
export const MAX_OUTBOUND_DROPS = 1_024;
export const MAX_INBOX_ITEMS = 1_024;
export const MAX_OUTBOX_ENVELOPES = 1_024;

export interface Transport {
  send(envelope: Envelope): Promise<string>;
}

interface QueuedEnvelope {
  envelope: Envelope;
  order: number;
  /** A state message (T4.2e): only the newest of its kind per peer stays in the outbox. */
  kind?: CoalescedKind;
}

/** Messages that describe a whole state, which the next one replaces (T4.2e, D79). Nothing else is ever coalesced. */
const COALESCED_KINDS = ['lan_key', 'iroh_addr', 'team_roster', 'catalog'] as const;
type CoalescedKind = (typeof COALESCED_KINDS)[number];

function coalescedKind(type: Message['type']): CoalescedKind | undefined {
  return (COALESCED_KINDS as readonly string[]).includes(type) ? (type as CoalescedKind) : undefined;
}

/** What the durable replay store answers; 'peer_quota' is a full share for the sending peer (T3.1e). */
export type DropClaim = 'claimed' | 'duplicate' | 'expired' | 'capacity' | 'peer_quota';

const CLAIM_ERRORS: Record<Exclude<DropClaim, 'claimed'>, { code: DropErrorCode; message: string }> = {
  duplicate: { code: 'E_DENIED', message: 'Demande déjà reçue ; créez une nouvelle demande.' },
  expired: { code: 'E_EXPIRED', message: 'Demande expirée ou horloge désynchronisée.' },
  capacity: { code: 'E_RATE', message: 'Trop de demandes reçues ; réessayez plus tard.' },
  peer_quota: { code: 'E_RATE', message: 'Trop de demandes reçues ; réessayez plus tard.' },
};

/** What a requester learns when the transport refuses its drop request for good, by the transport's outcome. */
function sendRefusal(outcome: string): { code: DropErrorCode; message: string } {
  if (outcome === 'E_SCHEMA')
    return { code: 'E_SCHEMA', message: 'Le relais a refusé la demande : destinataire inconnu ou enveloppe invalide.' };
  if (outcome === 'E_TOO_LARGE')
    return { code: 'E_SCHEMA', message: 'Le relais a refusé la demande : enveloppe trop grande.' };
  return { code: 'E_RUNNER', message: 'La demande n’a pas pu être transmise.' };
}

/** Stable log reason for a replay-store failure: our own E_REPLAY_STATE text or the fs error code, never a path. */
function replayFailureReason(error: unknown): string {
  const prefix = 'E_REPLAY_STATE ';
  if (error instanceof Error && error.message.startsWith(prefix)) return error.message.slice(prefix.length);
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'unknown';
}

/** Facts are served without a decision: a peer may ask for this many per minute, no more (T4.4 review). */
const FACT_REQUESTS_PER_MINUTE = 10;
/** The window FACT_REQUESTS_PER_MINUTE counts over. */
const FACT_WINDOW_MS = 60_000;
/** How long peers' local-network keys and iroh addresses read from the store are reused before reading it again. */
const STORE_CACHE_MS = 2000;
/** The longest input preview put on a consent card. */
const PREVIEW_MAX_CHARS = 2000;
/** The longest reply sent back to a linked assistant (T2.13). */
const AGENT_REPLY_MAX_CHARS = 60_000;
/** Executor states in which a drop has not sent its outcome yet; only these are echoed to a duplicate request. */
const UNSETTLED_STATES: readonly DropState[] = ['awaiting_approval', 'approved', 'running', 'in_review'];
/** Requester states after which a drop will not change any more: such a drop may make room for a new one. */
const TERMINAL_STATES: readonly DropState[] = ['denied', 'expired', 'not_now', 'failed', 'delivered', 'receipted'];
/** The requester state an executor's error code leaves a drop in; any other code is a failure. */
const ERROR_STATE: Partial<Record<DropErrorCode, DropState>> = {
  E_EXPIRED: 'expired',
  E_DENIED: 'denied',
  E_NOT_NOW: 'not_now',
};

export interface NodeStore {
  /**
   * Persistent anti-replay: 'duplicate' for a known id, 'expired' outside the freshness window measured against a
   * durable high-water clock, 'capacity' when the bounded store is full, 'peer_quota' when the sending peer holds its
   * full share of it (T3.1e). A throw (lock, corruption, I/O) is treated by the engine as 'capacity', so the request
   * is refused before consent.
   */
  claimDrop?(dropId: string, now: number, peer: NodeId): DropClaim;
  peers(): Peer[];
  savePeer(peer: Peer): void;
  published(): Published[];
  appendReceipt(receipt: Receipt): void;
  team(): TeamState | undefined;
  saveTeam(state: TeamState): void;
  links(): AgentLink[];
  saveLinks(links: AgentLink[]): void;
  /** Published facts (T4.4): absent on stores that predate them, which then publish none. */
  facts?(): StoredFact[];
  saveFacts?(facts: StoredFact[]): void;
  /** Local-network discovery keys of the peers (T4.2c): kept apart, owner-only. */
  lanKeys?(): Record<string, string>;
  saveLanKey?(nodeId: string, key: string): void;
  /** Iroh addresses of the peers (T4.2b): kept apart, owner-only. */
  irohAddrs?(): Record<string, IrohAddr>;
  saveIrohAddr?(nodeId: string, address: IrohAddr): void;
  /** Invites issued and accepted (T4.23): absent on stores that predate them, which then keep them in memory only. */
  inviteState?(): InviteState;
  saveInviteState?(state: InviteState): void;
}

/**
 * What accepting an invite does to this node's relay (T4.23, D95): `same` relay already; `adopt` its relay, since
 * this node has joined nobody yet; `kept` its own relay, the pairing then going through every path it has.
 */
export type RelayOutcome = 'same' | 'adopt' | 'kept';

/** What the confirmation card shows before « Rejoindre » (T4.14, T4.23): nothing is sent to compute it. */
export interface InvitePreview {
  invite: Invite;
  relay: RelayOutcome;
}

/** One member as the team panel shows them (T2.9): who, which agents, online or not, which capabilities. */
export interface TeamMemberView {
  nodeId: NodeId;
  displayName: string;
  ownerKind: OwnerKind;
  agents: string[];
  self: boolean;
  online: boolean;
  capabilities: { id: string; title: string }[];
}

export type Agent = RequestedBy['agent'];

/** Something the local human must decide: an approval or, for high sensitivity, a review before sending. */
export type InboxItem =
  | {
      kind: 'approval';
      dropId: string;
      executor: NodeId;
      card: ConsentCard;
      inputPreview: string;
      purpose: string;
      requestedBy: RequestedBy;
      expiresAt: number;
    }
  | { kind: 'review'; dropId: string; executor: NodeId; title: string; output: unknown; expiresAt: number };

/** A drop this node asked for. */
export interface OutboundDrop {
  dropId: string;
  capabilityId: string;
  title: string;
  ownerName: string;
  executor: NodeId;
  state: DropState;
  createdAt: number;
  result?: { output: unknown; outputSchemaHash: string };
  error?: { code: DropErrorCode; message: string };
}

/** A drop this node executes. */
interface ExecutorDrop {
  dropId: string;
  requester: NodeId;
  card: CapabilityCard;
  impl: CapabilityImpl;
  config: unknown;
  input: unknown;
  purpose: string;
  requestedBy: RequestedBy;
  state: DropState;
  approver: NodeId | undefined;
  expiresAt: number;
  reviewExpiresAt?: number;
  output?: Record<string, unknown> | undefined;
  /** The refusal or failure sent to the requester, replayed verbatim to a duplicate request. */
  error?: { code: DropErrorCode; message: string };
  toolCalls: { name: string; count: number }[];
  costUsd: number;
  reviewed: boolean;
  /** Set when the approver answered by hand instead of running the capability (T4.3). */
  answeredBy?: 'human' | 'fact';
  timestamps: { requested: number; decided?: number; started?: number; finished?: number; delivered?: number };
  /** The requester's capped key, kept in memory until the run ends, then dropped. */
  funding?: Funding | undefined;
}

export interface CatalogEntry {
  card: CapabilityCard;
  /** Who runs it: the card's executorNodeId, which verifyCard requires to be the catalog's sender (T4.17). */
  ownerNodeId: NodeId;
  ownerName: string;
  online: boolean;
}

/** No paired peer publishes this capability id, or not the named owner: nothing was sent. */
export class UnknownCapabilityError extends DropError {
  constructor() {
    super('E_SCHEMA', 'Aucun pair ne publie cette capacité.');
  }
}

/** Several peers publish this capability id and the request named none of them (T4.17, D80): nothing was sent. */
export class AmbiguousCapabilityError extends Error {
  readonly owners: { ownerNodeId: NodeId; ownerName: string }[];

  constructor(capabilityId: string, owners: { ownerNodeId: NodeId; ownerName: string }[]) {
    super(`E_AMBIGUOUS_CAPABILITY ${capabilityId} is published by ${String(owners.length)} peers`);
    this.owners = owners;
  }
}

export interface EngineLogEntry {
  event: string;
  code?: string;
  /** Stable cause behind a code, e.g. which replay-store check failed. Never a path or payload. */
  reason?: string;
  dropId?: string;
  peer?: string;
}

export interface EngineOptions {
  identity: Identity;
  /** Local-network discovery key, 32 bytes base64url (T4.2c); a fresh one per process when absent. */
  lanKey?: string;
  ownerKind: OwnerKind;
  store: NodeStore;
  transport: Transport;
  capabilities: CapabilityImpl[];
  now?: () => number;
  log?: (entry: EngineLogEntry) => void;
  /** Called with the admission ticket of an invite being accepted, so the node can join the relay with it (T2.1). */
  onAdmission?: (ticket: unknown) => void;
  /**
   * The relay an invite would leave this node on (T4.23, D95). `fresh` is true while this node has no peer and no
   * team; the daemon also keeps a relay set by hand (T4.33). Throws E_INVITE_RELAY for a relay this node may not use.
   * Absent: the node keeps its relay.
   */
  relayPlan?: (relayUrl: string, fresh: boolean) => RelayOutcome;
  /** Moves this node to the invite's relay, after « Rejoindre » and before anything is sent (T4.23). */
  adoptRelay?: (relayUrl: string) => Promise<void>;
  /** Requester side: mints a capped key per drop so the requester pays the model (D27). */
  funder?: Funder;
  /** Executor side: who pays the model. 'requester' (default, D27) uses the requester's key when one is sent. */
  payer?: 'requester' | 'owner';
  privateProfile?: boolean;
  /** The coding agents this node's human uses, shared with the team (T2.9). */
  agents?: () => string[];
  /** Runs a call from a linked assistant (T2.13) with the requester tools, in this user's name. */
  onAgentCall?: (call: { tool: string; args: Record<string, unknown> }) => Promise<{ text: string; isError: boolean }>;
  /** False for a gateway the organization policy does not allow (T4.10): even links made before it stop answering. */
  gatewayAllowed?: (gateway: string) => boolean;
  /** False for an iroh relay the organization policy does not allow (T4.10): a peer address through it is refused. */
  irohRelayAllowed?: (relay: string) => boolean;
}

const DECISION_ERRORS: Record<'deny' | 'not_now', DropErrorCode> = { deny: 'E_DENIED', not_now: 'E_NOT_NOW' };

/**
 * The protocol state machine of one node, independent of sockets and HTTP: requester, executor and approver roles.
 * Peer messages are untrusted data: every one is schema-validated by openEnvelope and checked against the sender's role.
 */
export class NodeEngine extends EventEmitter {
  readonly identity: Identity;
  private readonly options: EngineOptions;
  private readonly now: () => number;
  private readonly replay = new ReplayCache();
  private readonly invites = new Map<string, number>();
  /** Invites this node accepted, by the SHA-256 of their token, until they expire (T4.23): a second use is refused. */
  private readonly usedInvites = new Map<string, number>();
  /** This node's local-network discovery key (T4.2c): from DROP_HOME, or one per process in tests. */
  private readonly lanKey: string;
  private readonly lanKeyBytes: Uint8Array;
  private lanKeysCache: { at: number; keys: Record<string, string> } | undefined;
  /** Recent fact requests per peer (T4.4), for FACT_REQUESTS_PER_MINUTE. */
  private readonly factRequests = new Map<NodeId, number[]>();
  private readonly pairing = new Map<NodeId, { token: string; displayName: string; iroh?: IrohAddr }>();
  /** Joins between their checks and their pairing request: they hold the relay as if already paired (T4.23). */
  private joining = 0;
  /** This node's iroh addresses while the Internet mode runs (T4.2b). */
  private irohAddress: IrohAddr | undefined;
  private irohAddrsCache: { at: number; addrs: Record<string, IrohAddr> } | undefined;
  private readonly catalogs = new Map<NodeId, { cards: CapabilityCard[]; at: number }>();
  private readonly executing = new Map<string, ExecutorDrop>();
  /** Minimal duplicate response, without the request input, tools, config or funding. */
  private readonly completedErrors = new Map<
    string,
    { requester: NodeId; error: ExecutorDrop['error']; expiresAt: number }
  >();
  private readonly outbound = new Map<string, OutboundDrop>();
  private readonly inbox = new Map<string, InboxItem>();
  private readonly outbox: QueuedEnvelope[] = [];
  /** The order of the newest state message sent to each peer, per kind, live or queued (T4.2e): older ones are stale. */
  private readonly latestState = new Map<string, number>();
  private outboxInFlight: QueuedEnvelope | undefined;
  private outboxFlush: Promise<void> | undefined;
  private nextOutboxOrder = 0;

  constructor(options: EngineOptions) {
    super();
    this.lanKey = options.lanKey ?? newLanKey();
    const lanKeyBytes = decodeLanKey(this.lanKey);
    // A predictable key would let anyone recognize and knock: refuse it rather than fall back.
    if (!lanKeyBytes) throw new DropError('E_SCHEMA', 'E_LAN_KEY invalid local-network key');
    this.lanKeyBytes = lanKeyBytes;
    this.options = options;
    this.identity = options.identity;
    this.now = options.now ?? Date.now;
    this.loadInvites();
  }

  // ---- queries -----------------------------------------------------------------------------------------------

  peers(): Peer[] {
    return this.options.store.peers();
  }

  pending(): InboxItem[] {
    return [...this.inbox.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  }

  /** Counts only; safe for local diagnostics and bounded-memory tests. */
  memoryStats(): {
    executing: number;
    completedErrors: number;
    outbound: number;
    inbox: number;
    outbox: number;
    replay: number;
    invites: number;
    factRequests: number;
  } {
    return {
      invites: this.invites.size,
      factRequests: [...this.factRequests.values()].reduce((total, window) => total + window.length, 0),
      replay: this.replay.size(),
      executing: this.executing.size,
      completedErrors: this.completedErrors.size,
      outbound: this.outbound.size,
      inbox: this.inbox.size,
      outbox: this.outbox.length + (this.outboxInFlight ? 1 : 0),
    };
  }

  drop(dropId: string): OutboundDrop | undefined {
    return this.outbound.get(dropId);
  }

  /** This node's own questions, newest first: what the panel shows under « Mes questions en cours » (T2.4). */
  outboundDrops(): OutboundDrop[] {
    return [...this.outbound.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  catalog(): CatalogEntry[] {
    const names = new Map(this.peers().map((peer) => [peer.nodeId, peer.displayName]));
    names.set(this.identity.nodeId, this.identity.displayName);
    const fresh = this.now() - CATALOG_TTL_MS;
    return [...this.catalogs.entries()].flatMap(([nodeId, entry]) =>
      entry.cards.map((card) => ({
        card,
        ownerNodeId: nodeId,
        ownerName: names.get(nodeId) ?? card.owner.displayName,
        online: entry.at >= fresh,
      })),
    );
  }

  catalogIsFresh(): boolean {
    const fresh = this.now() - CATALOG_TTL_MS;
    const peers = this.knownNodeIds();
    return peers.length > 0 && peers.every((nodeId) => (this.catalogs.get(nodeId)?.at ?? 0) >= fresh);
  }

  /** Cards this node publishes, signed for its catalog. */
  async ownCards(): Promise<SignedCapabilityCard[]> {
    const cards: SignedCapabilityCard[] = [];
    for (const published of this.options.store.published()) {
      const card = this.cardFor(published);
      if (card) cards.push(await signCard(this.identity, card.card));
    }
    return cards;
  }

  // ---- pairing -----------------------------------------------------------------------------------------------

  /** A pairing code that also carries an admission ticket, so a newcomer can join the relay with it (T2.1). */
  async invite(relayUrl: string): Promise<string> {
    const admission = await createAdmission(this.identity, this.now());
    const invite = await createInvite(
      this.identity,
      relayUrl,
      this.now(),
      admission,
      this.team()?.team,
      this.irohAddress,
    );
    this.invites.set(invite.oneTimeToken, invite.expiresAt);
    this.saveInvites();
    // Direct paths must let the invitee in now, not at their next refresh (T4.2b live run).
    this.emit('access');
    return encodeInvite(invite);
  }

  /**
   * Checks an invite as pasted or opened (code, join link, `drop://join` or `drop://pair`), without sending anything:
   * signature (E_INVITE_SIG), dates (E_INVITE_EXPIRED), not this node's own (E_INVITE), not already accepted here
   * (E_INVITE_USED), and the relay it would leave this node on (E_INVITE_RELAY when that relay is not allowed).
   */
  async previewInvite(input: string): Promise<InvitePreview> {
    const now = this.now();
    const invite = await verifyInvite(inviteCodeFrom(input), now);
    if (invite.nodeId === this.identity.nodeId) throw new DropError('E_INVITE', 'this is your own invite');
    if (this.liveUsedInvites(now).has(sha256Hex(invite.oneTimeToken)))
      throw new DropError('E_INVITE_USED', 'invite already used');
    return { invite, relay: this.relayOutcome(invite.relayUrl) };
  }

  /**
   * Accepts an invite after « Rejoindre » (T4.14, T4.23): the same checks as the preview, then, on a node that has
   * joined nobody yet, the move to the invite's relay, and only then the admission ticket and the pairing request.
   */
  async join(input: string): Promise<{ nodeId: NodeId; relay: RelayOutcome }> {
    const { invite } = await this.previewInvite(input);
    // Nothing else runs until the first await below: a second « Rejoindre » meanwhile finds this invite used, and a
    // second invite finds this node no longer free to move to another relay.
    const used = sha256Hex(invite.oneTimeToken);
    if (this.liveUsedInvites(this.now()).has(used)) throw new DropError('E_INVITE_USED', 'invite already used');
    const relay = this.relayOutcome(invite.relayUrl);
    this.usedInvites.set(used, invite.expiresAt);
    this.joining += 1;
    try {
      if (relay === 'adopt') await this.adopt(invite.relayUrl, used);
    } finally {
      this.joining -= 1;
    }
    this.saveInvites();
    if (invite.admission) this.options.onAdmission?.(invite.admission);
    // Joining a team: the roster arrives from the inviter once paired (T2.9).
    if (invite.team && !this.team()) this.options.store.saveTeam({ team: invite.team, members: [this.selfMember()] });
    this.pairing.set(invite.nodeId, {
      token: invite.oneTimeToken,
      displayName: invite.displayName,
      ...(invite.iroh ? { iroh: invite.iroh } : {}),
    });
    this.emit('access');
    await this.send(invite.nodeId, {
      type: 'pair_request',
      oneTimeToken: invite.oneTimeToken,
      displayName: this.identity.displayName,
      ownerKind: this.options.ownerKind,
    });
    this.log({ event: 'invite_accepted', peer: invite.nodeId, reason: `relay_${relay}` });
    return { nodeId: invite.nodeId, relay };
  }

  async pair(code: string): Promise<NodeId> {
    return (await this.join(code)).nodeId;
  }

  /**
   * A refused move leaves the invite unused, so the owner may try it again once the cause is fixed. The cause is kept
   * when it is a configuration held by another operation (E_LOCKED) or changed meanwhile (E_CONFLICT), T4.33.
   */
  private async adopt(relayUrl: string, used: string): Promise<void> {
    try {
      await this.options.adoptRelay?.(relayUrl);
    } catch (error) {
      this.usedInvites.delete(used);
      const refusal =
        isDropError(error, 'E_INVITE_RELAY') || isDropError(error, 'E_LOCKED') || isDropError(error, 'E_CONFLICT')
          ? error
          : new DropError('E_INVITE_RELAY', 'relay not adopted');
      this.log({ event: 'invite_refused', code: refusal.code, reason: 'relay_not_adopted' });
      throw refusal;
    }
  }

  /**
   * A node that has joined nobody, with no pairing pending or under way, may still move to the relay of the team it
   * joins: once it has asked someone, a second invite never moves it away from the relay that answer will come on.
   */
  private relayOutcome(relayUrl: string): RelayOutcome {
    const fresh = this.peers().length === 0 && !this.team() && this.pairing.size === 0 && this.joining === 0;
    return this.options.relayPlan?.(relayUrl, fresh) ?? 'kept';
  }

  private loadInvites(): void {
    let state: InviteState | undefined;
    try {
      state = this.options.store.inviteState?.();
    } catch {
      // An unreadable file loses the links sent before, never the node: logged, then rewritten at the next invite.
      this.log({ event: 'invite_state_unreadable', code: 'E_INVITE_STATE' });
      return;
    }
    const now = this.now();
    for (const [token, expiresAt] of Object.entries(state?.issued ?? {}))
      if (expiresAt > now) this.invites.set(token, expiresAt);
    for (const [hash, expiresAt] of Object.entries(state?.used ?? {}))
      if (expiresAt > now) this.usedInvites.set(hash, expiresAt);
  }

  private saveInvites(): void {
    if (!this.options.store.saveInviteState) return;
    const now = this.now();
    try {
      this.options.store.saveInviteState({
        issued: Object.fromEntries(this.liveInvites(now)),
        used: Object.fromEntries(this.liveUsedInvites(now)),
      });
    } catch {
      this.log({ event: 'invite_state_unwritable', code: 'E_INVITE_STATE' });
    }
  }

  private liveUsedInvites(now: number): Map<string, number> {
    for (const [hash, expiresAt] of this.usedInvites) if (expiresAt <= now) this.usedInvites.delete(hash);
    return this.usedInvites;
  }

  // ---- linked assistants (T2.13) -----------------------------------------------------------------------------

  /**
   * The links this node honours. Under a policy, a gateway it does not allow is no longer one, even if linked before:
   * its envelopes are not opened and its calls not answered (T4.10). The store keeps the record.
   */
  links(): AgentLink[] {
    const allowed = this.options.gatewayAllowed;
    const links = this.options.store.links();
    return allowed ? links.filter((link) => allowed(link.gateway)) : links;
  }

  /**
   * The user approved, in the app, that this assistant asks the team in their name through this gateway. The grant
   * repeats what the app showed; the gateway refuses it if that is not the session's own client and return domain.
   */
  async linkAssistant(gateway: NodeId, request: LinkRequest): Promise<void> {
    const { sessionId, clientId, clientName, redirectHost } = request;
    const others = this.options.store
      .links()
      .filter((link) => !(link.gateway === gateway && link.clientName === clientName));
    this.options.store.saveLinks([
      ...others,
      { gateway, clientName, clientId, redirectHost, linkedAt: new Date(this.now()).toISOString() },
    ]);
    await this.send(gateway, { type: 'link_grant', sessionId, clientId, clientName, redirectHost });
    this.log({ event: 'assistant_linked', peer: gateway });
    this.changed();
  }

  unlinkAssistant(gateway: NodeId, clientName: string): boolean {
    const links = this.options.store.links();
    const kept = links.filter((link) => !(link.gateway === gateway && link.clientName === clientName));
    this.options.store.saveLinks(kept);
    this.changed();
    return kept.length < links.length;
  }

  private async onAgentCall(from: NodeId, message: MessageOf<'agent_call'>): Promise<void> {
    const viaGateway = this.links().filter((link) => link.gateway === from);
    if (viaGateway.length === 0) return;
    const linked = viaGateway.some((link) => link.clientId === undefined || link.clientId === message.clientId);
    const handler = this.options.onAgentCall;
    const reply = !linked
      ? { text: "Cet assistant n'est plus relié à drop : relie-le de nouveau depuis ses réglages.", isError: true }
      : handler
        ? await handler({ tool: message.tool, args: message.args }).catch(() => ({
            text: 'Erreur du Node.',
            isError: true,
          }))
        : { text: "Ce Node n'accepte pas les assistants reliés.", isError: true };
    await this.send(from, {
      type: 'agent_reply',
      callId: message.callId,
      text: reply.text.slice(0, AGENT_REPLY_MAX_CHARS),
      isError: reply.isError,
    });
  }

  // ---- local network (T4.2c, D67) ----------------------------------------------------------------------------

  /** What this node announces now: a tag of its discovery key, and one per live invite. Never its node id. */
  lanAnnouncement(): LanAnnouncement {
    const now = this.now();
    const epoch = lanEpoch(now);
    const invites = [...this.liveInvites(now).keys()].slice(-MAX_INVITE_TAGS).map((token) => inviteTag(token, epoch));
    return { tag: lanTag(this.lanKeyBytes, epoch), invites };
  }

  /** Whether an announcement is that peer's: from the key it shared, or from the invite this node is using. */
  lanRecognizes(nodeId: string, seen: LanAnnouncement): boolean {
    const now = this.now();
    const shared = this.peerLanKeys()[nodeId];
    const key = shared ? decodeLanKey(shared) : undefined;
    if (key && carriesTag(seen, key, now)) return true;
    const pending = this.pairing.get(nodeId);
    return pending !== undefined && carriesInvite(seen, pending.token, now);
  }

  /** Secrets a dialer may knock with to reach this node: its own key and the tokens of live invites. */
  lanKnockSecrets(): string[] {
    return [this.lanKey, ...this.liveInvites(this.now()).keys()];
  }

  /** The secret to knock with toward a peer: its shared key, or the token of the invite this node is using. */
  lanSecretFor(nodeId: string): string | undefined {
    return this.peerLanKeys()[nodeId] ?? this.pairing.get(nodeId)?.token;
  }

  /** Peers' keys, read from the store at most every 2 s: recognition runs for every announcement and every send. */
  private peerLanKeys(): Record<string, string> {
    const now = this.now();
    if (this.lanKeysCache && now - this.lanKeysCache.at < STORE_CACHE_MS) return this.lanKeysCache.keys;
    let keys: Record<string, string> = {};
    try {
      keys = this.options.store.lanKeys?.() ?? {};
    } catch {
      this.log({ event: 'lan_keys_unreadable', code: 'E_SCHEMA' });
    }
    this.lanKeysCache = { at: now, keys };
    return keys;
  }

  /** Sends this node's discovery key to every peer: at start, so that peers paired before it changed keep up. */
  async announceLanKey(): Promise<void> {
    for (const peer of this.peers()) await this.shareDirectPaths(peer.nodeId);
  }

  /** What a peer needs to reach this node directly: its local-network key and, when it runs, its iroh addresses. */
  private async shareDirectPaths(nodeId: NodeId): Promise<void> {
    await this.send(nodeId, { type: 'lan_key', key: this.lanKey });
    if (this.irohAddress) await this.send(nodeId, { type: 'iroh_addr', ...this.irohAddress });
  }

  /** Only a known peer, for itself: an unknown sender's key would only let it be recognized, never trusted. */
  private onLanKey(from: NodeId, message: MessageOf<'lan_key'>): void {
    if (!this.isPeer(from)) return;
    try {
      this.options.store.saveLanKey?.(from, message.key);
    } catch {
      this.log({ event: 'lan_key_not_saved', code: 'E_SCHEMA', peer: from });
    }
    this.lanKeysCache = undefined;
  }

  // ---- Internet (T4.2b, D68) ---------------------------------------------------------------------------------

  /** Records this node's iroh addresses; when they change, every peer learns them, queued like any message. */
  async setIrohAddress(address: IrohAddr | undefined): Promise<void> {
    if (JSON.stringify(address) === JSON.stringify(this.irohAddress)) return;
    const had = this.irohAddress !== undefined;
    this.irohAddress = address;
    // Off: peers learn there is nothing to dial any more, rather than waiting on a dead address.
    const announced = address ?? (had ? { direct: [] } : undefined);
    if (!announced) return;
    for (const peer of this.peers()) {
      // A newer address is being announced: this one is stale, for the peers not reached yet too.
      if (this.irohAddress !== address) return;
      await this.send(peer.nodeId, { type: 'iroh_addr', ...announced });
    }
  }

  /** Only a known peer, for itself, with a relay this node would accept: https, or http on loopback for tests. */
  private onIrohAddr(from: NodeId, message: MessageOf<'iroh_addr'>): void {
    if (!this.isPeer(from)) return;
    // The schema keeps the address fields only; the message type is dropped.
    const address = IrohAddrSchema.safeParse(message);
    const relay = address.success ? address.data.relay : undefined;
    if (
      !address.success ||
      (relay !== undefined && (!irohRelayAllowed(relay) || this.options.irohRelayAllowed?.(relay) === false))
    ) {
      this.log({ event: 'iroh_addr_refused', code: 'E_SCHEMA', peer: from });
      return;
    }
    try {
      this.options.store.saveIrohAddr?.(from, address.data);
    } catch {
      this.log({ event: 'iroh_addr_not_saved', code: 'E_SCHEMA', peer: from });
    }
    this.irohAddrsCache = undefined;
  }

  /** Where a peer, or the node an invite is being used for, said it can be reached by iroh. */
  irohAddressOf(nodeId: string): IrohAddr | undefined {
    return this.peerIrohAddrs()[nodeId] ?? this.pairing.get(nodeId)?.iroh;
  }

  /** Who may connect by iroh: paired peers and pairings in progress, and anyone while an invite is live (D60). */
  irohAccess(): { peers: string[]; open: boolean } {
    const peers = new Set<string>([...this.peers().map((peer) => peer.nodeId), ...this.pairing.keys()]);
    peers.delete(this.identity.nodeId);
    return { peers: [...peers].sort(), open: this.hasLiveInvite() };
  }

  private peerIrohAddrs(): Record<string, IrohAddr> {
    const now = this.now();
    if (this.irohAddrsCache && now - this.irohAddrsCache.at < STORE_CACHE_MS) return this.irohAddrsCache.addrs;
    let addrs: Record<string, IrohAddr> = {};
    try {
      addrs = this.options.store.irohAddrs?.() ?? {};
    } catch {
      this.log({ event: 'iroh_addrs_unreadable', code: 'E_SCHEMA' });
    }
    this.irohAddrsCache = { at: now, addrs };
    return addrs;
  }

  // ---- team (T2.9) -------------------------------------------------------------------------------------------

  team(): TeamState | undefined {
    return this.options.store.team();
  }

  createTeam(name: string): TeamState {
    if (this.team()) throw new DropError('E_DENIED', 'Ce Node fait déjà partie d’une équipe.');
    const state: TeamState = { team: createTeam(name), members: [this.selfMember()] };
    this.options.store.saveTeam(state);
    this.changed();
    return state;
  }

  /** Every member with their agents, whether they answered a catalog request recently, and what they publish. */
  teamView(): TeamMemberView[] {
    const state = this.team();
    if (!state) return [];
    const fresh = this.now() - CATALOG_TTL_MS;
    const own = this.options.store.published().flatMap((published) => {
      const built = this.cardFor(published);
      return built ? [{ id: built.card.id, title: built.card.title }] : [];
    });
    const others = state.members.filter((member) => member.nodeId !== this.identity.nodeId);
    return [this.selfMember(), ...others].map((member) => {
      const self = member.nodeId === this.identity.nodeId;
      const catalog = this.catalogs.get(member.nodeId);
      return {
        ...member,
        self,
        online: self || (catalog?.at ?? 0) >= fresh,
        capabilities: self ? own : (catalog?.cards ?? []).map((card) => ({ id: card.id, title: card.title })),
      };
    });
  }

  /** Sends the roster to every member: on start, so that agents and names stay current. */
  async announceTeam(): Promise<void> {
    for (const member of this.team()?.members ?? [])
      if (member.nodeId !== this.identity.nodeId) await this.sendRoster(member.nodeId);
  }

  private selfMember(): TeamMember {
    return {
      nodeId: this.identity.nodeId,
      displayName: this.identity.displayName,
      ownerKind: this.options.ownerKind,
      agents: (this.options.agents?.() ?? []).slice(0, 8),
    };
  }

  private async sendRoster(to: NodeId): Promise<void> {
    const state = this.team();
    if (!state) return;
    const members = [this.selfMember(), ...state.members.filter((member) => member.nodeId !== this.identity.nodeId)];
    await this.send(to, { type: 'team_roster', team: state.team, members });
  }

  /**
   * Merges a roster from a paired member of the same team: unknown members become peers (introduced `via` the sender)
   * and get a catalog request. A member's own entry is the only source of its agents. Any change spreads to every
   * member, so the rosters converge; a roster that lacks this node gets ours back.
   */
  private async onTeamRoster(from: NodeId, message: MessageOf<'team_roster'>): Promise<void> {
    const state = this.team();
    if (state?.team.teamId !== message.team.teamId) return;
    const members = new Map(state.members.map((member) => [member.nodeId, member]));
    const introduced: NodeId[] = [];
    let changed = false;
    for (const member of message.members) {
      if (member.nodeId === this.identity.nodeId) continue;
      const known = members.get(member.nodeId);
      if (!known) {
        members.set(member.nodeId, member);
        changed = true;
        if (!this.isPeer(member.nodeId)) {
          this.options.store.savePeer({
            nodeId: member.nodeId,
            displayName: member.displayName,
            ownerKind: member.ownerKind,
            pairedAt: new Date(this.now()).toISOString(),
            via: from,
          });
          introduced.push(member.nodeId);
          await this.shareDirectPaths(member.nodeId);
        }
      } else if (member.nodeId === from && JSON.stringify(known) !== JSON.stringify(member)) {
        members.set(from, member);
      }
    }
    this.options.store.saveTeam({ team: state.team, members: [...members.values()] });
    if (changed) {
      for (const nodeId of members.keys()) if (nodeId !== this.identity.nodeId) await this.sendRoster(nodeId);
    } else if (!message.members.some((member) => member.nodeId === this.identity.nodeId)) {
      await this.sendRoster(from);
    }
    for (const nodeId of introduced) {
      this.log({ event: 'team_introduced', peer: nodeId });
      await this.send(nodeId, { type: 'catalog_request' });
    }
    this.changed();
  }

  // ---- requester ---------------------------------------------------------------------------------------------

  async refreshCatalogs(): Promise<void> {
    for (const nodeId of this.knownNodeIds()) await this.send(nodeId, { type: 'catalog_request' });
  }

  async requestDrop(request: {
    capabilityId: string;
    /** Who should answer, when several peers publish this id (T4.17). */
    ownerNodeId?: string | undefined;
    input: unknown;
    purpose: string;
    agent: Agent;
  }): Promise<OutboundDrop> {
    const matches = this.catalog().filter(
      (candidate) =>
        candidate.card.id === request.capabilityId &&
        (request.ownerNodeId === undefined || candidate.ownerNodeId === request.ownerNodeId),
    );
    const [entry] = matches;
    if (!entry) throw new UnknownCapabilityError();
    // Never the first one found: a share is called the same on every machine (mcp.answer.figma).
    if (matches.length > 1)
      throw new AmbiguousCapabilityError(
        request.capabilityId,
        matches.map((match) => ({ ownerNodeId: match.ownerNodeId, ownerName: match.ownerName })),
      );
    this.reserveOutboundSlot();
    const dropId = uuidv7(this.now());
    const outbound: OutboundDrop = {
      dropId,
      capabilityId: entry.card.id,
      title: entry.card.title,
      ownerName: entry.ownerName,
      executor: entry.card.executorNodeId,
      state: 'proposed',
      createdAt: this.now(),
    };
    this.outbound.set(dropId, outbound);
    let funding: Funding | undefined;
    try {
      // A fact costs nothing: no capped key is minted for it (T4.4 review).
      funding = isFactCapabilityId(entry.card.id) ? undefined : await this.options.funder?.mint(dropId);
    } catch (error) {
      this.outbound.delete(dropId);
      throw error;
    }
    let outcome: string;
    try {
      outcome = await this.send(
        entry.card.executorNodeId,
        {
          type: 'drop_request',
          dropId,
          capabilityId: entry.card.id,
          capabilityVersion: entry.card.version,
          input: request.input,
          purpose: request.purpose,
          requestedBy: { nodeId: this.identity.nodeId, displayName: this.identity.displayName, agent: request.agent },
          ...(funding ? { funding } : {}),
        },
        { queueOffline: false },
      );
    } catch (error) {
      await this.abandonOutbound(dropId, funding);
      throw error;
    }
    if (outcome === 'E_RATE' || outcome === 'E_QUEUE_FULL' || outcome === 'offline') {
      await this.abandonOutbound(dropId, funding);
      throw new DropError('E_RATE', 'Le relais a refusé la demande.');
    }
    if (outcome !== 'delivered' && outcome !== 'queued') {
      // A refusal for good, e.g. a relay that does not admit this owner: the drop fails now instead of waiting in
      // silence until it expires. It stays listed, with its code, like any other failure.
      outbound.state = 'failed';
      outbound.error = sendRefusal(outcome);
      await this.releaseFunding(dropId, funding);
    }
    this.changed();
    return outbound;
  }

  private async abandonOutbound(dropId: string, funding: Funding | undefined): Promise<void> {
    this.outbound.delete(dropId);
    await this.releaseFunding(dropId, funding);
    this.changed();
  }

  private async releaseFunding(dropId: string, funding: Funding | undefined): Promise<void> {
    if (!funding || !this.options.funder) return;
    try {
      await this.options.funder.release(dropId);
    } catch {
      this.log({ event: 'funding', code: 'E_FUNDING_RELEASE', dropId });
    }
  }

  private reserveOutboundSlot(): void {
    if (this.outbound.size < MAX_OUTBOUND_DROPS) return;
    for (const [dropId, drop] of this.outbound) {
      if (drop.result || drop.error || TERMINAL_STATES.includes(drop.state)) {
        this.outbound.delete(dropId);
        break;
      }
    }
    if (this.outbound.size >= MAX_OUTBOUND_DROPS) throw new DropError('E_RATE', 'Trop de demandes actives.');
  }

  // ---- approver ----------------------------------------------------------------------------------------------

  async decide(dropId: string, decision: 'allow_once' | 'deny' | 'not_now'): Promise<boolean> {
    const item = this.inbox.get(dropId);
    if (item?.kind !== 'approval') return false;
    this.inbox.delete(dropId);
    this.changed();
    const message: Message = { type: 'approval_decision', dropId, decision, decidedAt: this.now() };
    if (item.executor === this.identity.nodeId) await this.onApprovalDecision(this.identity.nodeId, message);
    else await this.send(item.executor, message);
    return true;
  }

  /**
   * The approver answers by hand (T4.3, D64): this consents to this request only, and replaces running the
   * capability. The answer is checked here before anything leaves; a refusal throws and leaves the card pending.
   */
  async answer(dropId: string, raw: unknown): Promise<boolean> {
    const item = this.inbox.get(dropId);
    if (item?.kind !== 'approval') return false;
    const answer = checkHumanAnswer(raw);
    this.inbox.delete(dropId);
    this.changed();
    const message: Message = { type: 'human_answer', dropId, answer, decidedAt: this.now() };
    if (item.executor === this.identity.nodeId) await this.onHumanAnswer(this.identity.nodeId, message);
    else await this.send(item.executor, message);
    return true;
  }

  async review(dropId: string, decision: 'send' | 'discard', redactions: string[] = []): Promise<boolean> {
    const item = this.inbox.get(dropId);
    if (item?.kind !== 'review') return false;
    this.inbox.delete(dropId);
    this.changed();
    const message: Message = { type: 'review_decision', dropId, decision, redactions };
    if (item.executor === this.identity.nodeId) await this.onReviewDecision(this.identity.nodeId, message);
    else await this.send(item.executor, message);
    return true;
  }

  // ---- transport ---------------------------------------------------------------------------------------------

  async handleEnvelope(raw: unknown): Promise<void> {
    let opened: Awaited<ReturnType<typeof openEnvelope>>;
    try {
      opened = await openEnvelope(this.identity, raw, {
        isKnownPeer: (nodeId) => this.isKnown(nodeId),
        replay: this.replay,
        now: this.now(),
        ...(this.hasLiveInvite() ? { acceptPairToken: (token: string) => this.hasInvite(token) } : {}),
      });
    } catch (error) {
      this.log({ event: 'envelope_rejected', code: isDropError(error) ? error.code : 'E_RUNNER' });
      return;
    }
    await this.dispatch(opened.envelope.from, opened.message);
  }

  /** Re-sends envelopes that could not leave while the relay was unreachable. */
  async flushOutbox(): Promise<void> {
    if (this.outboxFlush) return this.outboxFlush;
    const operation = this.drainOutbox();
    this.outboxFlush = operation;
    try {
      await operation;
    } finally {
      this.outboxFlush = undefined;
    }
  }

  private async drainOutbox(): Promise<void> {
    // Keep only order numbers: an evicted envelope must not remain retained by this snapshot.
    const pendingOrders = this.outbox.map((queued) => queued.order);
    for (const order of pendingOrders) {
      const index = this.outbox.findIndex((queued) => queued.order === order);
      if (index < 0) continue;
      const [queued] = this.outbox.splice(index, 1);
      if (!queued) continue;
      const { envelope } = queued;
      if (envelope.exp <= this.now() || this.isStale(queued)) continue;
      this.outboxInFlight = queued;
      let outcome: string;
      try {
        outcome = await this.options.transport.send(envelope);
      } catch {
        this.log({ event: 'send_failed', code: 'E_RUNNER', reason: 'transport_exception', peer: envelope.to });
        outcome = 'offline';
      } finally {
        this.outboxInFlight = undefined;
      }
      if (outcome === 'offline' || outcome === 'E_RATE' || outcome === 'E_QUEUE_FULL') {
        if (outcome !== 'offline')
          this.log({ event: 'send_failed', code: outcome, reason: 'flush_refused', peer: envelope.to });
        this.queueOutbox(queued);
      } else if (outcome !== 'delivered' && outcome !== 'queued') {
        this.log({ event: 'send_failed', code: outcome, reason: 'flush_rejected', peer: envelope.to });
      }
    }
  }

  /** Expires undecided approvals, reviews and invites. Called every second by the daemon, or with a simulated clock in tests. */
  async tick(): Promise<void> {
    const now = this.now();
    this.pruneCompletedErrors(now);
    this.liveInvites(now);
    for (const [dropId, item] of this.inbox) if (item.expiresAt <= now) this.inbox.delete(dropId);
    for (const drop of this.executing.values()) {
      if (drop.state === 'awaiting_approval' && drop.expiresAt <= now) {
        drop.state = 'expired';
        drop.funding = undefined;
        await this.fail(drop, 'E_EXPIRED', 'La demande a expiré sans décision.', 'expired');
      } else if (drop.state === 'in_review' && !drop.reviewed && (drop.reviewExpiresAt ?? Infinity) <= now) {
        drop.state = 'failed';
        await this.fail(drop, 'E_EXPIRED', "La relecture a expiré : rien n'a été envoyé.", 'allow_once');
      }
    }
    this.changed();
    try {
      await this.options.funder?.retryPending?.();
    } catch {
      this.log({ event: 'funding', code: 'E_FUNDING_RELEASE' });
    }
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  private async dispatch(from: NodeId, message: Message): Promise<void> {
    switch (message.type) {
      case 'pair_request':
        return this.onPairRequest(from, message);
      case 'pair_accept':
        return this.onPairAccept(from, message);
      case 'team_roster':
        return this.onTeamRoster(from, message);
      case 'agent_call':
        return this.onAgentCall(from, message);
      case 'link_grant':
      case 'agent_reply':
        // Addressed to a gateway, never to a node.
        return;
      case 'lan_key':
        this.onLanKey(from, message);
        return;
      case 'iroh_addr':
        this.onIrohAddr(from, message);
        return;
      case 'catalog_request':
        await this.send(from, {
          type: 'catalog',
          cards: [...(await this.ownCards()), ...(await this.factCards(from))],
        });
        return;
      case 'catalog':
        return this.onCatalog(from, message);
      case 'drop_request':
        return this.onDropRequest(from, message);
      case 'approval_request': {
        this.onApprovalRequest(from, message);
        return;
      }
      case 'approval_decision':
        return this.onApprovalDecision(from, message);
      case 'human_answer':
        return this.onHumanAnswer(from, message);
      case 'review_request': {
        this.onReviewRequest(from, message);
        return;
      }
      case 'review_decision':
        return this.onReviewDecision(from, message);
      case 'drop_status':
      case 'drop_error':
        this.onRequesterUpdate(from, message);
        return;
      case 'drop_result':
        this.onRequesterUpdate(from, await this.screenFactResult(from, message));
        return;
      case 'receipt':
        return this.onReceipt(from, message);
    }
  }

  private async onPairRequest(from: NodeId, message: MessageOf<'pair_request'>): Promise<void> {
    if (!this.hasInvite(message.oneTimeToken)) return;
    this.invites.delete(message.oneTimeToken);
    this.saveInvites();
    this.options.store.savePeer({
      nodeId: from,
      displayName: message.displayName,
      ownerKind: message.ownerKind,
      pairedAt: new Date(this.now()).toISOString(),
    });
    await this.send(from, {
      type: 'pair_accept',
      oneTimeToken: message.oneTimeToken,
      displayName: this.identity.displayName,
      ownerKind: this.options.ownerKind,
    });
    this.log({ event: 'paired', peer: from });
    await this.shareDirectPaths(from);
    const state = this.team();
    if (state && !state.members.some((member) => member.nodeId === from)) {
      const newcomer: TeamMember = {
        nodeId: from,
        displayName: message.displayName,
        ownerKind: message.ownerKind,
        agents: [],
      };
      this.options.store.saveTeam({ team: state.team, members: [...state.members, newcomer] });
      for (const member of [...state.members, newcomer])
        if (member.nodeId !== this.identity.nodeId) await this.sendRoster(member.nodeId);
    }
    this.changed();
  }

  private async onPairAccept(from: NodeId, message: MessageOf<'pair_accept'>): Promise<void> {
    const pending = this.pairing.get(from);
    if (pending?.token !== message.oneTimeToken) return;
    this.pairing.delete(from);
    this.options.store.savePeer({
      nodeId: from,
      displayName: message.displayName,
      ownerKind: message.ownerKind,
      pairedAt: new Date(this.now()).toISOString(),
    });
    this.log({ event: 'paired', peer: from });
    await this.shareDirectPaths(from);
    if (this.team()) await this.sendRoster(from);
    this.changed();
  }

  private async onCatalog(from: NodeId, message: MessageOf<'catalog'>): Promise<void> {
    const cards: CapabilityCard[] = [];
    for (const signed of message.cards) {
      if (!(await verifyCard(signed, from))) continue;
      // One card per id and owner: a duplicate would make the owner's own capability ambiguous (T4.17 review).
      if (cards.some((card) => card.id === signed.card.id)) {
        this.log({ event: 'catalog_duplicate_dropped', code: 'E_SCHEMA', peer: from });
        continue;
      }
      cards.push(signed.card);
    }
    this.catalogs.set(from, { cards, at: this.now() });
    this.changed();
  }

  private async onDropRequest(from: NodeId, message: MessageOf<'drop_request'>): Promise<void> {
    this.pruneCompletedErrors(this.now());
    // Before any other check, freshness included, so a duplicate never fails a drop the owner may have approved.
    const active = this.executing.get(message.dropId);
    if (active) {
      await this.answerDuplicate(from, active);
      return;
    }
    const finished = this.completedErrors.get(message.dropId);
    if (finished) {
      const error = finished.requester === from && finished.error ? finished.error : CLAIM_ERRORS.duplicate;
      await this.refuse(from, message.dropId, error.code, error.message);
      return;
    }
    const requestTime = uuidv7Timestamp(message.dropId);
    const now = this.now();
    if (requestTime === undefined || requestTime < now - REPLAY_WINDOW_MS || requestTime > now + MAX_CLOCK_SKEW_MS) {
      this.log({
        event: 'drop_rejected',
        code: 'E_EXPIRED',
        reason: 'request_clock_skew',
        dropId: message.dropId,
        peer: from,
      });
      await this.refuse(from, message.dropId, CLAIM_ERRORS.expired.code, CLAIM_ERRORS.expired.message);
      return;
    }
    if (isFactCapabilityId(message.capabilityId)) {
      await this.serveFact(from, message, now);
      return;
    }
    if (this.options.privateProfile && this.options.payer === 'owner' && message.funding) {
      await this.refuse(from, message.dropId, 'E_DENIED', 'Financement non accepté par le propriétaire.');
      return;
    }
    const published = this.options.store.published().find((entry) => entry.capabilityId === message.capabilityId);
    const built = published ? this.cardFor(published) : undefined;
    if (!published || !built || built.card.version !== message.capabilityVersion) {
      await this.refuse(from, message.dropId, 'E_SCHEMA', 'Capacité inconnue.');
      return;
    }
    const validated = validateInput(built.impl, message.input);
    if (!validated.ok) {
      await this.refuse(from, message.dropId, 'E_SCHEMA', 'Entrée invalide.');
      return;
    }
    const refusal = this.admission(from, message.dropId, now);
    if (refusal) {
      await this.refuse(from, message.dropId, refusal.code, refusal.message);
      return;
    }
    // No await between the admission above and this insertion: see admission().
    const drop: ExecutorDrop = {
      dropId: message.dropId,
      requester: from,
      card: built.card,
      impl: built.impl,
      config: published.config,
      input: validated.input,
      purpose: message.purpose,
      requestedBy: this.requesterOf(from, message.requestedBy),
      state: 'awaiting_approval',
      approver: undefined,
      expiresAt: now + APPROVAL_TTL_MS,
      toolCalls: [],
      costUsd: 0,
      reviewed: false,
      timestamps: { requested: now },
      funding: this.options.payer === 'owner' ? undefined : message.funding,
    };
    this.executing.set(drop.dropId, drop);
    const ownerCost = built.impl.cost?.(published.config);
    const cost = drop.funding ? { kind: 'capped' as const, maxUsd: drop.funding.maxUsd } : ownerCost;
    const request: Message = {
      type: 'approval_request',
      dropId: drop.dropId,
      card: {
        capabilityId: built.card.id,
        title: built.card.title,
        receives: built.card.receives,
        neverReceives: built.card.neverReceives,
        sensitivity: built.card.sensitivity,
        executorName: this.identity.displayName,
        ...(cost ? { cost, paidBy: drop.funding ? ('requester' as const) : ('owner' as const) } : {}),
      },
      inputPreview: built.impl.preview(validated.input).slice(0, PREVIEW_MAX_CHARS),
      purpose: drop.purpose,
      requestedBy: drop.requestedBy,
      expiresAt: drop.expiresAt,
    };
    for (const approver of built.card.approverNodeIds) {
      if (approver === this.identity.nodeId) this.onApprovalRequest(this.identity.nodeId, request);
      else await this.send(approver, request);
    }
    await this.status(drop);
    this.changed();
  }

  private onApprovalRequest(from: NodeId, message: MessageOf<'approval_request'>): void {
    if (!this.canAcceptInboxCard('approval', from, message.dropId, message.expiresAt, APPROVAL_TTL_MS)) return;
    this.inbox.set(message.dropId, {
      kind: 'approval',
      dropId: message.dropId,
      executor: from,
      card: message.card,
      inputPreview: message.inputPreview,
      purpose: message.purpose,
      requestedBy: this.requesterOf(message.requestedBy.nodeId, message.requestedBy),
      expiresAt: message.expiresAt,
    });
    this.emit('approval', this.inbox.get(message.dropId));
    this.changed();
  }

  /**
   * Anti-replay claim and execution capacity, shared by capabilities and facts: the refusal to send, or undefined when
   * admitted. Synchronous on purpose: the caller must put the drop in `executing` before its next await, so that
   * envelopes handled concurrently can never all pass the capacity check and overshoot the cap (T3.1c review).
   */
  private admission(from: NodeId, dropId: string, now: number): { code: DropErrorCode; message: string } | undefined {
    if (this.options.store.claimDrop) {
      let claim: DropClaim;
      try {
        claim = this.options.store.claimDrop(dropId, now, from);
      } catch (error) {
        this.log({
          event: 'drop_rejected',
          code: 'E_REPLAY_STATE',
          reason: replayFailureReason(error),
          dropId,
          peer: from,
        });
        return CLAIM_ERRORS.capacity;
      }
      if (claim === 'expired') {
        // The id passed the wall-clock window above, so only a persisted replay clock ahead of it can refuse it.
        this.log({
          event: 'drop_rejected',
          code: 'E_EXPIRED',
          reason: 'replay_clock_ahead',
          dropId,
          peer: from,
        });
      }
      if (claim === 'capacity' || claim === 'peer_quota') {
        this.log({
          event: 'drop_rejected',
          code: 'E_RATE',
          reason: claim === 'peer_quota' ? 'replay_peer_quota' : 'replay_capacity',
          dropId,
          peer: from,
        });
      }
      if (claim !== 'claimed') return CLAIM_ERRORS[claim];
    }
    if (this.executing.size >= MAX_ACTIVE_EXECUTING_DROPS) {
      this.log({
        event: 'drop_rejected',
        code: 'E_RATE',
        reason: 'execution_capacity',
        dropId,
        peer: from,
      });
      return CLAIM_ERRORS.capacity;
    }
    return undefined;
  }

  // ---- published facts (T4.4, D65) ---------------------------------------------------------------------------

  /** What the owner publishes, with how many times each fact was served and whether it can still be served. */
  facts(): (StoredFact['signed']['fact'] & { served: number; live: boolean })[] {
    const now = this.now();
    return this.storedFacts().map(({ signed, served }) => ({ ...signed.fact, served, live: isLive(signed.fact, now) }));
  }

  async publishFact(raw: unknown): Promise<StoredFact['signed']['fact']> {
    const fact = draftFact(raw, {
      factId: uuidv7(this.now()),
      revision: 1,
      owner: this.ownerOf(),
      now: this.now(),
      peers: this.peers().map((peer) => peer.nodeId),
    });
    const signed = await signFact(this.identity, fact);
    this.updateFacts((facts) => [...facts, { signed, served: 0 }]);
    this.changed();
    return signed.fact;
  }

  /** A new signed revision of an active fact; the previous one is no longer served. */
  async editFact(factId: string, raw: unknown): Promise<StoredFact['signed']['fact'] | undefined> {
    const current = this.readFacts().find((entry) => entry.signed.fact.factId === factId)?.signed.fact;
    if (current?.status !== 'active') return undefined;
    const fact = draftFact(raw, {
      factId,
      revision: current.revision + 1,
      owner: this.ownerOf(),
      now: this.now(),
      peers: this.peers().map((peer) => peer.nodeId),
    });
    const signed = await signFact(this.identity, fact);
    return this.replaceRevision(current, signed) ? signed.fact : undefined;
  }

  /** Stops serving a fact and keeps it, signed as retired, for the record. */
  async retireFact(factId: string): Promise<boolean> {
    const current = this.readFacts().find((entry) => entry.signed.fact.factId === factId)?.signed.fact;
    if (current?.status !== 'active') return false;
    const signed = await signFact(this.identity, { ...current, status: 'retired' });
    return this.replaceRevision(current, signed);
  }

  /**
   * Swaps a fact for its new signed version only if nothing changed it meanwhile (same revision, still active):
   * signing awaits, so a concurrent edit or retire must never be overwritten by a stale copy (T4.4 review).
   */
  private replaceRevision(current: StoredFact['signed']['fact'], signed: StoredFact['signed']): boolean {
    const outcome = { replaced: false };
    this.updateFacts((facts) =>
      facts.map((entry) => {
        const fact = entry.signed.fact;
        if (fact.factId !== current.factId || fact.revision !== current.revision || fact.status !== 'active')
          return entry;
        outcome.replaced = true;
        return { ...entry, signed };
      }),
    );
    if (outcome.replaced) this.changed();
    return outcome.replaced;
  }

  /** Facts as stored; an unreadable store serves no fact and is reported, without taking the catalog down with it. */
  private storedFacts(): StoredFact[] {
    try {
      return this.readFacts();
    } catch {
      this.log({ event: 'facts_unreadable', code: 'E_FACT_STORE' });
      return [];
    }
  }

  private readFacts(): StoredFact[] {
    return this.options.store.facts?.() ?? [];
  }

  /** Read, change and write with no await in between, so that concurrent actions never undo one another. */
  private updateFacts(change: (facts: StoredFact[]) => StoredFact[]): void {
    if (!this.options.store.saveFacts) throw new DropError('E_RUNNER', 'Ce Node ne sait pas garder de faits.');
    this.options.store.saveFacts(change(this.readFacts()));
  }

  private ownerOf(): Owner {
    return { kind: this.options.ownerKind, displayName: this.identity.displayName, nodeId: this.identity.nodeId };
  }

  /** The facts one peer may see: live ones whose audience includes it. Topics and keywords only, never statements. */
  private async factCards(nodeId: NodeId): Promise<SignedCapabilityCard[]> {
    const now = this.now();
    const peers = this.peers().map((peer) => peer.nodeId);
    const cards: SignedCapabilityCard[] = [];
    for (const { signed } of this.storedFacts())
      if (isLive(signed.fact, now) && inAudience(signed.fact, nodeId, peers))
        cards.push(await signCard(this.identity, factCard(signed.fact, this.identity.nodeId)));
    return cards;
  }

  /** The fact a request names, if this peer may have it now: live, in its audience, at the current revision. */
  private servableFact(from: NodeId, message: MessageOf<'drop_request'>, now: number): StoredFact | undefined {
    const peers = this.peers().map((peer) => peer.nodeId);
    return this.storedFacts().find(({ signed }) => {
      const card = factCard(signed.fact, this.identity.nodeId);
      return (
        card.id === message.capabilityId &&
        card.version === message.capabilityVersion &&
        isLive(signed.fact, now) &&
        inAudience(signed.fact, from, peers)
      );
    });
  }

  /** At most FACT_REQUESTS_PER_MINUTE per peer: served without a decision, facts must not drain the owner's sends. */
  private factRateExceeded(from: NodeId, now: number): boolean {
    const recent = (this.factRequests.get(from) ?? []).filter((at) => at > now - FACT_WINDOW_MS);
    // A refused request is not recorded: the window stays at most the limit long, whatever the peer's rate.
    if (recent.length >= FACT_REQUESTS_PER_MINUTE) {
      this.factRequests.set(from, recent);
      return true;
    }
    recent.push(now);
    this.factRequests.set(from, recent);
    return false;
  }

  /** Served without a consent card: publishing was the owner's consent (D65). Same refusal whatever the reason. */
  private async serveFact(from: NodeId, message: MessageOf<'drop_request'>, now: number): Promise<void> {
    const { dropId } = message;
    if (!this.servableFact(from, message, now)) return this.refuse(from, dropId, 'E_SCHEMA', 'Fait indisponible.');
    if (!FACT_IMPL.input.safeParse(message.input).success)
      return this.refuse(from, dropId, 'E_SCHEMA', 'Entrée invalide.');
    if (this.factRateExceeded(from, now))
      return this.refuse(from, dropId, 'E_RATE', 'Trop de demandes de faits : réessaie dans une minute.');
    const refusal = this.admission(from, dropId, now);
    if (refusal) return this.refuse(from, dropId, refusal.code, refusal.message);
    // Read again after the claim, still before any await: a retire or an edit already stored wins.
    const entry = this.servableFact(from, message, this.now());
    if (!entry) return this.refuse(from, dropId, 'E_SCHEMA', 'Fait indisponible.');
    const { fact } = entry.signed;
    const drop: ExecutorDrop = {
      dropId: message.dropId,
      requester: from,
      card: factCard(fact, this.identity.nodeId),
      impl: FACT_IMPL,
      config: {},
      input: {},
      purpose: message.purpose,
      requestedBy: this.requesterOf(from, message.requestedBy),
      state: 'approved',
      approver: this.identity.nodeId,
      expiresAt: now,
      toolCalls: [],
      costUsd: 0,
      reviewed: true,
      answeredBy: 'fact',
      timestamps: { requested: now, decided: now, finished: now },
    };
    this.executing.set(drop.dropId, drop);
    await this.deliver(drop, { kind: 'fact', fact, sig: entry.signed.sig }, FACT_OUTPUT_HASH);
    // The counter is a convenience for the owner: counted by id and revision, and its failure never blocks delivery.
    try {
      this.updateFacts((facts) =>
        facts.map((item) =>
          item.signed.fact.factId === fact.factId && item.signed.fact.revision === fact.revision
            ? { ...item, served: item.served + 1 }
            : item,
        ),
      );
      this.changed();
    } catch {
      this.log({ event: 'fact_counter', code: 'E_FACT_STORE', dropId: drop.dropId });
    }
  }

  /**
   * Requester side: a fact that does not hold (signature, card, validity) is refused, never shown (T4.4); so is a
   * result that claims the fact schema for a capability that is not a fact.
   */
  private async screenFactResult(
    from: NodeId,
    message: MessageOf<'drop_result'>,
  ): Promise<MessageOf<'drop_result' | 'drop_error'>> {
    const drop = this.outbound.get(message.dropId);
    if (drop?.executor !== from) return message;
    const isFact = isFactCapabilityId(drop.capabilityId);
    if (!isFact && message.outputSchemaHash !== FACT_OUTPUT_HASH) return message;
    const holds =
      isFact &&
      (await factResultHolds(message.output, message.outputSchemaHash, {
        capabilityId: drop.capabilityId,
        executor: from,
        now: this.now(),
      }));
    if (holds) return message;
    this.log({ event: 'fact_rejected', code: 'E_OUTPUT_INVALID', dropId: message.dropId, peer: from });
    return { type: 'drop_error', dropId: message.dropId, code: 'E_OUTPUT_INVALID', message: 'Fait reçu invalide.' };
  }

  private async onApprovalDecision(from: NodeId, message: MessageOf<'approval_decision'>): Promise<void> {
    const drop = this.executing.get(message.dropId);
    if (drop?.state !== 'awaiting_approval' || !drop.card.approverNodeIds.includes(from)) return;
    drop.approver = from;
    drop.timestamps.decided = this.now();
    if (message.decision !== 'allow_once') {
      drop.funding = undefined;
      drop.state = message.decision === 'deny' ? 'denied' : 'not_now';
      const text =
        message.decision === 'deny'
          ? 'Le propriétaire a refusé.'
          : 'Pas maintenant : vous pourrez redemander plus tard.';
      await this.fail(drop, DECISION_ERRORS[message.decision], text, message.decision);
      return;
    }
    drop.state = 'approved';
    await this.status(drop);
    drop.state = 'running';
    drop.timestamps.started = this.now();
    await this.status(drop);
    const result = await runCapability(drop.impl, drop.input, {
      config: drop.config,
      ...(drop.funding ? { funding: drop.funding } : {}),
    });
    drop.funding = undefined;
    drop.toolCalls = result.toolCalls;
    drop.costUsd = result.costUsd;
    drop.timestamps.finished = this.now();
    if (!result.ok) {
      drop.state = 'failed';
      await this.fail(drop, result.code, result.message, 'allow_once');
      return;
    }
    drop.output = result.output;
    if (drop.card.sensitivity === 'high') {
      drop.state = 'in_review';
      drop.reviewExpiresAt = this.now() + REVIEW_TTL_MS;
      await this.status(drop);
      const review: Message = {
        type: 'review_request',
        dropId: drop.dropId,
        output: result.output,
        expiresAt: drop.reviewExpiresAt,
      };
      if (from === this.identity.nodeId) this.onReviewRequest(from, review);
      else await this.send(from, review);
      return;
    }
    await this.deliver(drop, result.output);
  }

  private async onHumanAnswer(from: NodeId, message: MessageOf<'human_answer'>): Promise<void> {
    const drop = this.executing.get(message.dropId);
    if (drop?.state !== 'awaiting_approval' || !drop.card.approverNodeIds.includes(from)) return;
    drop.approver = from;
    drop.timestamps.decided = this.now();
    drop.funding = undefined;
    drop.state = 'approved';
    let answer: ReturnType<typeof checkHumanAnswer>;
    try {
      // Checked again here: the executor never trusts the approver's node to have done it.
      answer = checkHumanAnswer(message.answer);
    } catch (error) {
      drop.state = 'failed';
      const code = isDropError(error, 'E_SECRET_DETECTED') ? 'E_SECRET_DETECTED' : 'E_OUTPUT_INVALID';
      this.log({ event: 'human_answer_refused', dropId: drop.dropId, code });
      // The requester learns that the answer was refused, never what the owner's draft contained.
      await this.fail(
        drop,
        code,
        'Le propriétaire a répondu, mais sa réponse n’a pas passé les contrôles.',
        'allow_once',
      );
      return;
    }
    await this.status(drop);
    drop.reviewed = true;
    drop.answeredBy = 'human';
    drop.timestamps.finished = this.now();
    await this.deliver(drop, answer, sha256Hex(HUMAN_ANSWER_OUTPUT_SCHEMA));
  }

  private onReviewRequest(from: NodeId, message: MessageOf<'review_request'>): void {
    if (!this.canAcceptInboxCard('review', from, message.dropId, message.expiresAt, REVIEW_TTL_MS)) return;
    this.inbox.set(message.dropId, {
      kind: 'review',
      dropId: message.dropId,
      executor: from,
      title: this.titleOf(message.dropId),
      output: message.output,
      expiresAt: message.expiresAt,
    });
    this.emit('review', this.inbox.get(message.dropId));
    this.changed();
  }

  private async onReviewDecision(from: NodeId, message: MessageOf<'review_decision'>): Promise<void> {
    const drop = this.executing.get(message.dropId);
    if (drop?.state !== 'in_review' || drop.reviewed || drop.approver !== from || !drop.output) return;
    drop.reviewed = true;
    if (message.decision === 'discard') {
      drop.state = 'failed';
      await this.fail(
        drop,
        'E_DENIED',
        "Le propriétaire a relu le résultat et choisi de ne pas l'envoyer.",
        'allow_once',
      );
      return;
    }
    await this.deliver(drop, applyRedactions(drop.output, message.redactions ?? []));
  }

  private onRequesterUpdate(from: NodeId, message: MessageOf<'drop_status' | 'drop_result' | 'drop_error'>): void {
    const drop = this.outbound.get(message.dropId);
    if (drop?.executor !== from) return;
    // A result settles the drop for good. A recorded error yields only to a real result: a duplicate refusal may
    // overtake it. Status updates never claim an outcome; only drop_result, drop_error and receipt do.
    if (drop.result) return;
    const settled = drop.error !== undefined;
    if (message.type === 'drop_status') {
      if (!settled && UNSETTLED_STATES.includes(message.state)) {
        drop.state = message.state;
        this.changed();
      }
      return;
    }
    if (message.type === 'drop_error' && settled) return;
    // The drop is over: delete the capped key minted for it (D27), once.
    if (!settled && this.options.funder) {
      this.options.funder.release(drop.dropId).catch(() => {
        this.log({ event: 'funding', code: 'E_FUNDING_RELEASE', dropId: drop.dropId });
      });
    }
    if (message.type === 'drop_result') {
      drop.state = 'delivered';
      drop.result = { output: message.output, outputSchemaHash: message.outputSchemaHash };
      delete drop.error;
    }
    if (message.type === 'drop_error') {
      drop.state = ERROR_STATE[message.code] ?? 'failed';
      drop.error = { code: message.code, message: message.message };
    }
    this.changed();
  }

  private async onReceipt(from: NodeId, message: MessageOf<'receipt'>): Promise<void> {
    if (message.receipt.executor !== from || !(await verifyReceipt(message.receipt))) return;
    this.options.store.appendReceipt(message.receipt);
    const drop = this.outbound.get(message.receipt.dropId);
    if (drop?.state === 'delivered') drop.state = 'receipted';
    this.changed();
  }

  private async deliver(
    drop: ExecutorDrop,
    output: Record<string, unknown>,
    outputSchemaHash = sha256Hex(drop.card.outputSchema),
  ): Promise<void> {
    // The state moves only once the result is handed to the transport, so a duplicate answered meanwhile can only
    // learn the unsettled state, never a refusal that would overtake the result.
    drop.timestamps.delivered = this.now();
    try {
      await this.send(drop.requester, {
        type: 'drop_result',
        dropId: drop.dropId,
        output,
        outputSchemaHash,
      });
      drop.state = 'delivered';
      await this.writeReceipt(drop, 'allow_once', sha256Hex(output));
      drop.state = 'receipted';
    } finally {
      drop.output = undefined;
      this.executing.delete(drop.dropId);
      this.changed();
    }
  }

  private async fail(
    drop: ExecutorDrop,
    code: DropErrorCode,
    text: string,
    decision: Receipt['decision'],
  ): Promise<void> {
    drop.error = { code, message: text };
    try {
      await this.send(drop.requester, { type: 'drop_error', dropId: drop.dropId, ...drop.error });
      await this.writeReceipt(drop, decision, undefined, code);
    } finally {
      drop.output = undefined;
      this.rememberCompletedError(drop);
      this.executing.delete(drop.dropId);
      this.changed();
    }
  }

  private rememberCompletedError(drop: ExecutorDrop): void {
    const timestamp = uuidv7Timestamp(drop.dropId);
    if (timestamp === undefined || !drop.error) return;
    const expiresAt = Math.min(timestamp + REPLAY_WINDOW_MS, this.now() + REPLAY_WINDOW_MS);
    if (expiresAt <= this.now()) return;
    this.pruneCompletedErrors(this.now());
    if (this.completedErrors.size >= MAX_COMPLETED_ERRORS) {
      const oldest = this.completedErrors.keys().next().value;
      if (oldest !== undefined) this.completedErrors.delete(oldest);
    }
    this.completedErrors.set(drop.dropId, { requester: drop.requester, error: drop.error, expiresAt });
  }

  private pruneCompletedErrors(now: number): void {
    for (const [dropId, summary] of this.completedErrors)
      if (summary.expiresAt <= now) this.completedErrors.delete(dropId);
  }

  private async writeReceipt(
    drop: ExecutorDrop,
    decision: Receipt['decision'],
    outputHash?: string,
    errorCode?: string,
  ): Promise<void> {
    const unsigned: UnsignedReceipt = {
      dropId: drop.dropId,
      capabilityId: drop.card.id,
      capabilityVersion: drop.card.version,
      requester: drop.requester,
      executor: this.identity.nodeId,
      approver: drop.approver ?? drop.card.approverNodeIds[0] ?? this.identity.nodeId,
      inputHash: sha256Hex(drop.input),
      decision,
      reviewed: drop.reviewed,
      ...(drop.answeredBy ? { answeredBy: drop.answeredBy } : {}),
      toolCalls: drop.toolCalls,
      timestamps: drop.timestamps,
      ...(drop.costUsd > 0 ? { costUsd: drop.costUsd } : {}),
      ...(outputHash ? { outputHash } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
    const receipt = await signReceipt(this.identity, unsigned);
    this.options.store.appendReceipt(receipt);
    const recipients = new Set([drop.requester, unsigned.approver]);
    recipients.delete(this.identity.nodeId);
    for (const nodeId of recipients) await this.send(nodeId, { type: 'receipt', receipt });
  }

  /**
   * Never leaves a requester waiting in silence. An unsettled drop reports its current state; a refused or failed
   * one replays the same error; a delivered one gets the duplicate refusal, which its real result overrides
   * (see onRequesterUpdate). Another peer reusing the id learns nothing about the drop.
   */
  private async answerDuplicate(from: NodeId, drop: ExecutorDrop): Promise<void> {
    if (drop.requester === from && UNSETTLED_STATES.includes(drop.state)) return this.status(drop);
    const error = drop.requester === from && drop.error ? drop.error : CLAIM_ERRORS.duplicate;
    await this.refuse(from, drop.dropId, error.code, error.message);
  }

  /** Answers a drop request with an error: a refusal before anything runs, or an outcome replayed to a duplicate. */
  private async refuse(to: NodeId, dropId: string, code: DropErrorCode, message: string): Promise<void> {
    await this.send(to, { type: 'drop_error', dropId, code, message });
  }

  private async status(drop: ExecutorDrop): Promise<void> {
    await this.send(drop.requester, { type: 'drop_status', dropId: drop.dropId, state: drop.state });
  }

  private canAcceptInboxCard(
    kind: InboxItem['kind'],
    from: NodeId,
    dropId: string,
    expiresAt: number,
    ttlMs: number,
  ): boolean {
    if (this.inbox.has(dropId)) {
      this.log({ event: `${kind}_rejected`, code: 'E_REPLAY', reason: 'inbox_duplicate', dropId, peer: from });
      return false;
    }
    const now = this.now();
    if (expiresAt <= now || expiresAt > now + ttlMs + MAX_CLOCK_SKEW_MS) {
      this.log({ event: `${kind}_rejected`, code: 'E_EXPIRED', reason: `${kind}_expiry`, dropId, peer: from });
      return false;
    }
    if (this.inbox.size >= MAX_INBOX_ITEMS) {
      this.log({ event: `${kind}_rejected`, code: 'E_RATE', reason: 'inbox_capacity', dropId, peer: from });
      return false;
    }
    return true;
  }

  /** A state message older than the last one of its kind sent to the same peer (T4.2e, D79). */
  private isStale(queued: QueuedEnvelope): boolean {
    if (!queued.kind) return false;
    return (this.latestState.get(`${queued.envelope.to}|${queued.kind}`) ?? -1) > queued.order;
  }

  private queueOutbox(queued: QueuedEnvelope): void {
    const now = this.now();
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const entry = this.outbox[index];
      if (entry && entry.envelope.exp <= now) this.outbox.splice(index, 1);
    }
    // One state message per peer and kind: the newest wins, by send order, even against a failed send coming back or a
    // newer one already delivered live.
    if (queued.kind) {
      const same = (entry: QueuedEnvelope) => entry.kind === queued.kind && entry.envelope.to === queued.envelope.to;
      if (this.isStale(queued)) return;
      for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
        const entry = this.outbox[index];
        if (entry && same(entry)) this.outbox.splice(index, 1);
      }
    }
    const insertAt = this.outbox.findIndex((entry) => entry.order > queued.order);
    if (insertAt === -1) this.outbox.push(queued);
    else this.outbox.splice(insertAt, 0, queued);
    if (this.outbox.length + (this.outboxInFlight ? 1 : 0) > MAX_OUTBOX_ENVELOPES) {
      this.outbox.shift();
      this.log({ event: 'send_failed', code: 'E_RATE', reason: 'outbox_capacity' });
    }
  }

  private async send(to: NodeId, message: Message, options: { queueOffline?: boolean } = {}): Promise<string> {
    // The order is taken before any wait, so that it follows the order of the calls.
    const order = this.nextOutboxOrder++;
    const kind = coalescedKind(message.type);
    if (kind) this.latestState.set(`${to}|${kind}`, order);
    const envelope = await sealEnvelope(this.identity, to, message, { now: this.now() });
    let outcome: string;
    try {
      outcome = await this.options.transport.send(envelope);
    } catch {
      this.log({ event: 'send_failed', code: 'E_RUNNER', reason: 'transport_exception', peer: to });
      outcome = 'offline';
    }
    if (outcome === 'offline' && options.queueOffline !== false)
      this.queueOutbox({ envelope, order, ...(kind ? { kind } : {}) });
    else if (outcome !== 'delivered' && outcome !== 'queued')
      this.log({ event: 'send_failed', code: outcome, peer: to });
    return outcome;
  }

  private cardFor(published: Published): { card: CapabilityCard; impl: CapabilityImpl } | undefined {
    const impl = implFor(this.options.capabilities, published.capabilityId);
    if (!impl) return undefined;
    const card = buildCard(impl, {
      owner: { kind: this.options.ownerKind, displayName: this.identity.displayName, nodeId: this.identity.nodeId },
      executorNodeId: this.identity.nodeId,
      approverNodeIds: published.approverNodeIds,
      capabilityId: published.capabilityId,
      config: published.config,
    });
    return { card, impl };
  }

  private titleOf(dropId: string): string {
    return this.executing.get(dropId)?.card.title ?? 'Résultat à relire';
  }

  private knownNodeIds(): NodeId[] {
    return [this.identity.nodeId, ...this.peers().map((peer) => peer.nodeId)];
  }

  /** Local network (T4.2, D60): a direct session may only be opened toward a paired peer or the inviter being joined. */
  canReachDirectly(nodeId: string): boolean {
    return nodeId !== this.identity.nodeId && (this.pairing.has(nodeId) || this.isPeer(nodeId));
  }

  /** Local network (T4.2, D60): a direct session may only come from a paired peer, a pairing in progress, or anyone while an invite is live. */
  canAcceptDirectly(nodeId: string): boolean {
    return nodeId !== this.identity.nodeId && (this.canReachDirectly(nodeId) || this.hasLiveInvite());
  }

  /**
   * Who asked, as the owner will see it on the consent card. A paired peer is shown under the name this node
   * stored at pairing, never under the name its request claims: a peer could otherwise sign as "Alice (CTO)".
   */
  private requesterOf(nodeId: NodeId, claimed: RequestedBy): RequestedBy {
    const known = this.peers().find((peer) => peer.nodeId === nodeId);
    return { ...claimed, nodeId, displayName: known?.displayName ?? claimed.displayName };
  }

  private isPeer(nodeId: NodeId): boolean {
    return this.peers().some((peer) => peer.nodeId === nodeId);
  }

  private isKnown(nodeId: NodeId): boolean {
    return (
      nodeId === this.identity.nodeId ||
      this.pairing.has(nodeId) ||
      this.isPeer(nodeId) ||
      this.links().some((link) => link.gateway === nodeId)
    );
  }

  private hasInvite(token: string): boolean {
    return (this.invites.get(token) ?? 0) > this.now();
  }

  private hasLiveInvite(): boolean {
    return this.liveInvites(this.now()).size > 0;
  }

  /** The invites still valid at `now`, by token; expired ones are forgotten on the way. */
  private liveInvites(now: number): Map<string, number> {
    for (const [token, expiresAt] of this.invites) if (expiresAt <= now) this.invites.delete(token);
    return this.invites;
  }

  private changed(): void {
    this.emit('change');
  }

  private log(entry: EngineLogEntry): void {
    this.options.log?.(entry);
  }
}
