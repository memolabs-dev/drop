/** Shapes the menu bar panel reads from its own Node (`/ui/*`). Everything here is data, never markup. */
export type ConsentCost = { kind: 'free' } | { kind: 'capped'; maxUsd: number } | { kind: 'unmeasured' };

export interface ConsentCard {
  capabilityId: string;
  title: string;
  receives: string[];
  neverReceives: string[];
  sensitivity: 'low' | 'high';
  executorName: string;
  cost?: ConsentCost;
  paidBy?: 'owner' | 'requester';
}

export interface ApprovalItem {
  kind: 'approval';
  dropId: string;
  card: ConsentCard;
  inputPreview: string;
  purpose: string;
  requestedBy: { displayName: string; agent: string };
  expiresAt: number;
  /** Who receives a hand-written answer first, named from the local peer store (T4.3), never from the card. */
  executorName?: string;
}

export interface ReviewItem {
  kind: 'review';
  dropId: string;
  title: string;
  output: unknown;
  expiresAt: number;
}

export type PendingItem = ApprovalItem | ReviewItem;

export interface OutboundDrop {
  dropId: string;
  title: string;
  ownerName: string;
  state: string;
  createdAt: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface PanelStatus {
  displayName: string;
  relayConnected: boolean;
}

export interface TeamMember {
  nodeId: string;
  displayName: string;
  self: boolean;
  online: boolean;
  agents: string[];
  capabilities: { title: string }[];
}

export interface TeamData {
  team: { name: string } | null;
  members: TeamMember[];
}

export interface ServerInfo {
  name: string;
  kind?: string;
  where?: string;
  shareable: boolean;
}

export interface AgentTools {
  agent: string;
  label: string;
  installed: boolean;
  dropInstalled: boolean;
  servers: ServerInfo[];
}

export interface LinkedAssistant {
  clientName: string;
  gateway: string;
  redirectHost?: string;
}

export interface ToolsData {
  agents: AgentTools[];
  shared: Record<string, string>;
  payer?: string;
  links?: LinkedAssistant[];
  gateways?: string[];
}

export interface OnboardingPlan {
  agent: string;
  label: string;
  state: string;
  fingerprint: string;
  detail?: string;
  manual?: { steps: string; snippet: string };
}

export interface ManualConnector {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface OnboardingData {
  agents: OnboardingPlan[];
  manual?: ManualConnector;
}

export interface OnboardingResult {
  agent: string;
  state?: string;
  detail: string;
}

export interface ProjectClient {
  agent: string;
  label: string;
  dropInstalled: boolean;
  servers: { name: string; where?: string }[];
}

export interface ProjectView {
  dir: string;
  sources: string[];
  clients: ProjectClient[];
}

export interface Fact {
  factId: string;
  topic: string;
  statement: string;
  keywords: string[];
  source: { label: string; url?: string };
  validTo: number;
  publishedAt: number;
  status: string;
  live: boolean;
  served: number;
  audience: { kind: 'team' } | { kind: 'peers'; nodeIds: string[] };
}

export interface FactsData {
  facts: Fact[];
  peers: { nodeId: string; displayName: string }[];
}

export type InternetMode = 'off' | 'direct' | 'relay' | 'n0';

export interface InternetData {
  settings?: { mode: InternetMode; relay?: string };
  state: string;
  message?: string;
}

/** A drop://link request (T2.13): an assistant asks to reach the team in this user's name. */
export interface LinkRequest {
  session: string;
  gateway: string;
  client: string;
  clientId: string;
  redirect: string;
}

/** A drop://pair invitation (T4.14), previewed before anything is sent. */
/** What « Rejoindre » would do to this node's relay (T4.23): `adopt` moves it to the relay the invite names. */
export type RelayOutcome = 'same' | 'adopt' | 'kept';

/** `POST /ui/pair/preview`: who invites, read from a signed invite, and the relay it names. */
export interface InvitePreview {
  displayName: string;
  team?: string;
  relayHost: string;
  relay: RelayOutcome;
}

export interface PendingInvite {
  code: string;
  displayName: string;
  team: string;
  relay: RelayOutcome;
  relayHost: string;
}

/** `POST /ui/pair` after « Rejoindre » (T4.23): `next` says what the owner does next, « Connecter mes agents ». */
export interface PairResult {
  nodeId: string;
  relay: RelayOutcome;
  next?: 'connect_agents';
}

/** What the panel keeps of a join that succeeded, to offer the next step (T4.31). */
export interface JoinedInvite {
  relay: RelayOutcome;
  relayHost: string;
  next?: 'connect_agents';
}
