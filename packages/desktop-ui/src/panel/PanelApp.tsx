/**
 * The menu bar panel (T2.4, T4.24), served by the Node at /app and shown by the desktop shell in a 380 × 620 popover
 * under its tray icon. Tabs « Demandes », « Équipe » and « Mes outils ». It talks only to this Node's own API (same
 * origin, bearer token from the address). The Node decides; the panel shows and asks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx';
import { cn } from '../lib/utils.ts';
import { ConnectAgentsCard, InviteCard, LinkCard } from './deep-links.tsx';
import { connectionStatus, failureText } from './logic.ts';
import { RequestsTab, editing, type RequestsData } from './requests.tsx';
import { TeamTab } from './team.tsx';
import { ToolsTab, loadTools } from './tools.tsx';
import type {
  InvitePreview,
  JoinedInvite,
  LinkRequest,
  OutboundDrop,
  PanelStatus,
  PendingInvite,
  PendingItem,
  TeamData,
  ToolsData,
} from './types.ts';
import { Dot, Loading, PanelContext, SectionError, useSection, type PanelActions } from './ui.tsx';

type Tab = 'requests' | 'team' | 'tools';
const TABS: { id: Tab; label: string }[] = [
  { id: 'requests', label: 'Demandes' },
  { id: 'team', label: 'Équipe' },
  { id: 'tools', label: 'Mes outils' },
];

interface Notice {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

/** Deep-link parameters are read once, then leave the address: only the local token stays (T2.13, T4.14). */
function readDeepLink(): { invitation: string | null; link: LinkRequest | null } {
  const params = new URLSearchParams(window.location.search);
  const invitation = params.get('pair');
  const session = params.get('link');
  const link = session
    ? {
        session,
        gateway: params.get('gateway') ?? '',
        client: params.get('client') ?? 'Un assistant',
        clientId: params.get('clientId') ?? '',
        redirect: params.get('redirect') ?? '',
      }
    : null;
  if (invitation || link)
    window.history.replaceState(null, '', '/app?token=' + encodeURIComponent(params.get('token') ?? ''));
  return { invitation, link };
}

export default function PanelApp() {
  const deepLink = useMemo(readDeepLink, []);
  const [tab, setTab] = useState<Tab>('requests');
  const [status, setStatus] = useState<PanelStatus | null | 'down'>(null);
  const [requests, setRequests] = useState<RequestsData | null>(null);
  const [requestsFailed, setRequestsFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [invite, setInvite] = useState<PendingInvite | null>(null);
  // After « Rejoindre »: « Connecter mes agents » (T4.31), which « Mes outils » turns into one analysis, then clears.
  const [joined, setJoined] = useState<JoinedInvite | null>(null);
  const [analyseNow, setAnalyseNow] = useState(false);
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(deepLink.link);
  const [gateways, setGateways] = useState<string[] | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const requestsVersion = useRef(0);
  const pendingRefresh = useRef(false);

  const loadStatus = useCallback(() => {
    api<PanelStatus>('GET', '/ui/admin/status').then(
      (value) => {
        setStatus(value);
      },
      () => {
        setStatus('down');
      },
    );
  }, []);

  const refreshRequests = useCallback(() => {
    const mine = ++requestsVersion.current;
    Promise.all([
      api<{ pending: PendingItem[] }>('GET', '/ui/pending'),
      api<{ drops: OutboundDrop[] }>('GET', '/ui/outbound'),
    ]).then(
      ([pending, outbound]) => {
        if (mine !== requestsVersion.current) return;
        setRequestsFailed(false);
        setRequests({ pending: pending.pending, drops: outbound.drops });
      },
      () => {
        if (mine === requestsVersion.current) setRequestsFailed(true);
      },
    );
    loadStatus();
  }, [loadStatus]);

  const announce = useCallback((text: string) => {
    // Cleared first, so that the same sentence twice is announced twice.
    setAnnouncement('');
    setTimeout(() => {
      setAnnouncement(text);
    }, 30);
  }, []);

  const focusTo = useCallback((key: string) => {
    let tries = 0;
    const attempt = () => {
      const target = document.querySelector<HTMLElement>('[data-focus="' + key + '"]');
      if (target) target.focus();
      else if (++tries < 20) setTimeout(attempt, 25);
    };
    setTimeout(attempt, 0);
  }, []);

  const actions = useMemo<PanelActions>(
    () => ({
      info: (text) => {
        setNotice({ id: Date.now() + Math.random(), kind: 'info', text });
        announce(text);
      },
      fail: (text) => {
        setNotice({ id: Date.now() + Math.random(), kind: 'error', text });
      },
      announce,
      focusTo,
      refreshRequests,
    }),
    [announce, focusTo, refreshRequests],
  );

  // After an action, the result banner takes the focus, so keyboard and VoiceOver users hear the outcome in place.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  useEffect(() => {
    refreshRequests();
  }, [refreshRequests]);

  // Opened from a drop://pair link: show who invites, then pair only after « Rejoindre ». The code stays in memory.
  useEffect(() => {
    const code = deepLink.invitation;
    if (!code) return;
    // A refusal shows the message of its stable code (expired, used, modified, relay not allowed), never one catch-all.
    api<InvitePreview>('POST', '/ui/pair/preview', new URLSearchParams({ code })).then(
      (preview) => {
        setInvite({
          code,
          displayName: preview.displayName,
          team: preview.team ?? '',
          relay: preview.relay,
          relayHost: preview.relayHost,
        });
      },
      (error: unknown) => {
        actions.fail(failureText(error));
      },
    );
  }, [deepLink, actions]);

  useEffect(() => {
    if (!linkRequest || gateways) return;
    api<ToolsData>('GET', '/ui/admin/tools').then(
      (tools) => {
        setGateways(tools.gateways ?? []);
      },
      () => {
        setGateways([]);
      },
    );
  }, [linkRequest, gateways]);

  // Live updates: the Node says « change », the panel reloads the requests unless the owner is typing.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (typeof EventSource === 'undefined' || !token) return;
    const events = new EventSource('/ui/events?token=' + encodeURIComponent(token));
    events.onmessage = () => {
      if (editing()) {
        pendingRefresh.current = true;
        return;
      }
      refreshRequests();
    };
    const resume = () => {
      if (pendingRefresh.current && !editing()) {
        pendingRefresh.current = false;
        refreshRequests();
      }
    };
    document.addEventListener('focusin', resume);
    return () => {
      events.close();
      document.removeEventListener('focusin', resume);
    };
  }, [refreshRequests]);

  const team = useSection(() => api<TeamData>('GET', '/ui/team'), tab === 'team');
  const tools = useSection(loadTools, tab === 'tools');

  const changeTab = (next: string) => {
    const value = TABS.find((item) => item.id === next)?.id ?? 'requests';
    setTab(value);
    setNotice(null);
    if (value === 'requests') refreshRequests();
    else loadStatus();
  };

  const connection = connectionStatus(status);
  const pendingCount = requests?.pending.length ?? 0;
  const exclusive = invite ?? (linkRequest && gateways ? linkRequest : null);

  return (
    <PanelContext.Provider value={actions}>
      <Tabs value={tab} onValueChange={changeTab} className="h-full">
        <div
          className="panel-scroll relative h-full overflow-y-auto"
          onScroll={(event) => {
            setScrolled(event.currentTarget.scrollTop > 2);
          }}
        >
          <header
            className={cn(
              'panel-header sticky top-0 z-10 flex flex-col gap-3 border-b px-4 pt-3.5 pb-3 transition-colors',
              scrolled ? 'border-border' : 'border-transparent',
            )}
          >
            <div className="flex min-h-6 items-center gap-2">
              <span className="text-[21px] leading-none font-bold tracking-[-.075em]">
                drop<span className="text-primary">.</span>
              </span>
              <div className="ml-auto flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                <Dot tone={connection.tone} />
                <span role="status" aria-live="polite" className="truncate">
                  {connection.text}
                </span>
              </div>
            </div>
            <TabsList aria-label="Sections de drop" className="grid h-9 w-full grid-cols-3 rounded-[11px] p-[3px]">
              {TABS.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="h-[30px] justify-center gap-1.5 rounded-[8px] px-2 text-[12px]"
                >
                  {item.label}
                  {item.id === 'requests' && pendingCount > 0 ? (
                    <span className="min-w-4 rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
                      <span className="sr-only">, </span>
                      {pendingCount}
                      <span className="sr-only"> en attente</span>
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </header>
          <div aria-live="polite" role="status" className="sr-only">
            {announcement}
          </div>
          <main id="panel-main" className="flex flex-col gap-3 px-4 pt-3 pb-5">
            {notice ? (
              <div
                ref={noticeRef}
                tabIndex={-1}
                role={notice.kind === 'error' ? 'alert' : undefined}
                className={cn(
                  'flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12px] leading-snug break-words outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  notice.kind === 'error'
                    ? 'border border-destructive/45 text-foreground'
                    : 'bg-[#f0eef9] text-[#3f3a78] dark:bg-[#3b354e] dark:text-[#e3dcff]',
                )}
              >
                <span className="min-w-0 flex-1">{notice.text}</span>
                <button
                  type="button"
                  aria-label="Fermer le message"
                  className="-m-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent"
                  onClick={() => {
                    setNotice(null);
                  }}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </div>
            ) : null}
            {invite ? (
              <InviteCard
                invite={invite}
                onDone={(result) => {
                  setInvite(null);
                  if (!result) return;
                  setTab('team');
                  if (result.next === 'connect_agents') setJoined(result);
                }}
              />
            ) : null}
            {joined && !exclusive ? (
              <ConnectAgentsCard
                joined={joined}
                onLater={() => {
                  setJoined(null);
                }}
                onConnect={() => {
                  setJoined(null);
                  setNotice(null);
                  setTab('tools');
                  setAnalyseNow(true);
                }}
              />
            ) : null}
            {!invite && linkRequest && gateways ? (
              <LinkCard
                request={linkRequest}
                gateways={gateways}
                onDone={() => {
                  setLinkRequest(null);
                }}
              />
            ) : null}
            <div hidden={Boolean(exclusive)}>
              <TabsContent
                value="requests"
                forceMount
                aria-busy={!requests && !requestsFailed}
                className="outline-none data-[state=inactive]:hidden"
              >
                {requestsFailed && !requests ? <SectionError retry={refreshRequests} /> : null}
                <RequestsTab data={requests} failed={requestsFailed} active={tab === 'requests' && !exclusive} />
              </TabsContent>
              <TabsContent
                value="team"
                forceMount
                aria-busy={!team.data && !team.failed}
                className="outline-none data-[state=inactive]:hidden"
              >
                {team.failed && !team.data ? <SectionError retry={team.reload} /> : null}
                {team.data ? <TeamTab data={team.data} reload={team.reload} /> : team.failed ? null : <Loading />}
              </TabsContent>
              <TabsContent
                value="tools"
                forceMount
                aria-busy={!tools.data && !tools.failed}
                className="outline-none data-[state=inactive]:hidden"
              >
                {tools.failed && !tools.data ? <SectionError retry={tools.reload} /> : null}
                {tools.data ? (
                  <ToolsTab
                    data={tools.data}
                    reload={tools.reload}
                    analyseNow={analyseNow}
                    onAnalyseStarted={() => {
                      setAnalyseNow(false);
                    }}
                  />
                ) : tools.failed ? null : (
                  <Loading />
                )}
              </TabsContent>
            </div>
          </main>
        </div>
      </Tabs>
    </PanelContext.Provider>
  );
}
