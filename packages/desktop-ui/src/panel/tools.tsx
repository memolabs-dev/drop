/**
 * « Mes outils »: what I publish, connecting my agents (analysis, then a second explicit step), project folders,
 * sharing toggles, linked assistants, who pays the model, and the Internet connection.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, FolderPlus, LogIn, Plus, ScanSearch, Unplug } from 'lucide-react';
import { api } from '../api.ts';
import { Button } from '../components/ui/button.tsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.tsx';
import { Input } from '../components/ui/input.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { cn } from '../lib/utils.ts';
import {
  INTERNET_CHOICES,
  INTERNET_STATES,
  PROJECT_SOURCES,
  emptyFactDraft,
  explain,
  factBody,
  factDraftFrom,
  factMeta,
  factState,
  failureText,
  onboardingMessage,
  safeSignInLink,
  type FactDraft,
} from './logic.ts';
import type {
  FactsData,
  InternetData,
  InternetMode,
  ManualConnector,
  OnboardingData,
  OnboardingPlan,
  OnboardingResult,
  ProjectView,
  ToolsData,
} from './types.ts';
import {
  Empty,
  ErrorText,
  Field,
  Lead,
  List,
  Meta,
  Muted,
  SectionTitle,
  compactInput,
  compactSelect,
  compactTextarea,
  usePanel,
} from './ui.tsx';

export interface ToolsBundle {
  tools: ToolsData;
  /** Null when the fact store cannot be read: the rest of « Mes outils » still shows. */
  facts: FactsData | null;
  internet: InternetData | null;
}

export async function loadTools(): Promise<ToolsBundle> {
  const [tools, facts, internet] = await Promise.all([
    api<ToolsData>('GET', '/ui/admin/tools'),
    api<FactsData>('GET', '/ui/facts').catch(() => null),
    api<InternetData>('GET', '/ui/admin/internet').catch(() => null),
  ]);
  return { tools, facts, internet };
}

interface Analysis {
  plans: OnboardingPlan[];
  manual: ManualConnector | undefined;
  projects: ProjectView[];
}

/** `analyseNow`: « Connecter mes agents » was clicked after « Rejoindre » (T4.31); the analysis starts once. */
export function ToolsTab({
  data,
  reload,
  analyseNow = false,
  onAnalyseStarted,
}: {
  data: ToolsBundle;
  reload: () => void;
  analyseNow?: boolean;
  onAnalyseStarted?: () => void;
}) {
  const panel = usePanel();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [factDraft, setFactDraft] = useState<FactDraft | null>(null);
  const [signInOffer, setSignInOffer] = useState<{ agent: string; server: string } | null>(null);
  const [signInLink, setSignInLink] = useState('');
  return (
    <div className="flex flex-col gap-3">
      {signInOffer ? (
        <div className="panel-surface flex flex-col gap-2.5 rounded-2xl border border-primary/30 bg-card p-3.5">
          <div className="text-[12.5px] leading-snug">
            drop doit se connecter à {signInOffer.server} une fois, en ton nom. Le jeton reste sur ce Mac.
          </div>
          <Button
            size="sm"
            className="self-start"
            data-focus="signin"
            onClick={() => {
              const offer = signInOffer;
              setSignInOffer(null);
              api<{ connected?: boolean; authorizationUrl?: string }>('POST', '/ui/admin/connect', offer).then(
                (result) => {
                  setSignInLink(safeSignInLink(result.authorizationUrl));
                  panel.info(
                    result.connected
                      ? 'drop est déjà connecté à ' + offer.server + ' : partage-le de nouveau.'
                      : 'Termine la connexion dans ton navigateur, puis partage ' + offer.server + ' de nouveau.',
                  );
                },
                (error: unknown) => {
                  panel.fail(failureText(error));
                },
              );
            }}
          >
            <LogIn aria-hidden="true" />
            Se connecter à {signInOffer.server}
          </Button>
        </div>
      ) : null}
      {signInLink ? (
        <a
          href={signInLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-[10px] border border-border bg-card px-3 text-[12px] font-medium text-primary"
          onClick={() => {
            setSignInLink('');
          }}
        >
          Ouvrir la page de connexion
        </a>
      ) : null}
      <FactsSection data={data.facts} draft={factDraft} setDraft={setFactDraft} reload={reload} />
      <ConnectSection
        analysis={analysis}
        setAnalysis={setAnalysis}
        reload={reload}
        analyseNow={analyseNow}
        onAnalyseStarted={onAnalyseStarted}
      />
      <SharingSection
        tools={data.tools}
        reload={reload}
        onSignIn={(offer) => {
          setSignInOffer(offer);
          panel.focusTo('signin');
        }}
      />
      {data.internet ? <InternetSection internet={data.internet} reload={reload} /> : null}
    </div>
  );
}

// ---- « Ce que je publie » (T4.4, D65): facts served as is to their audience, until their end date ----

function FactsSection({
  data,
  draft,
  setDraft,
  reload,
}: {
  data: FactsData | null;
  draft: FactDraft | null;
  setDraft: (draft: FactDraft | null) => void;
  reload: () => void;
}) {
  const panel = usePanel();
  const [retiring, setRetiring] = useState('');
  if (!data)
    return (
      <>
        <SectionTitle>Ce que je publie</SectionTitle>
        <div role="alert" className="rounded-2xl border border-destructive/40 px-3.5 py-3 text-[12px]">
          Impossible de lire tes faits publiés. Ils ne sont plus servis tant que ce n’est pas réglé.
        </div>
      </>
    );
  const names = Object.fromEntries(data.peers.map((peer) => [peer.nodeId, peer.displayName]));
  if (draft)
    return (
      <>
        <SectionTitle>Ce que je publie</SectionTitle>
        <FactForm draft={draft} setDraft={setDraft} peers={data.peers} reload={reload} />
      </>
    );
  return (
    <>
      <SectionTitle>Ce que je publie</SectionTitle>
      {data.facts.length === 0 ? (
        <Empty title="Rien de publié">
          Un fait publié est servi tel quel à ton équipe, sans te redemander, jusqu’à sa date de fin.
        </Empty>
      ) : null}
      {data.facts.map((fact) => {
        const state = factState(fact);
        return (
          <article
            key={fact.factId}
            aria-label={fact.topic + (state ? ' (' + state + ')' : '')}
            data-faded={fact.live ? undefined : 'true'}
            className={cn(
              'panel-surface flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5',
              !fact.live && 'opacity-55',
            )}
          >
            <div className="text-[13px] font-semibold break-words">
              {fact.topic}
              {state ? <span className="font-normal text-muted-foreground"> · {state}</span> : null}
            </div>
            <p className="selectable m-0 rounded-xl bg-muted px-3 py-2 text-[13px] leading-[1.45] break-words">
              {fact.statement}
            </p>
            <Muted className="break-words">
              Source : {fact.source.label}
              {fact.source.url ? ' (' + fact.source.url + ')' : ''}
            </Muted>
            <Meta>{factMeta(fact, names)}</Meta>
            {fact.status === 'active' ? (
              <div className="flex justify-end gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={'Retirer : ' + fact.topic}
                  disabled={retiring === fact.factId}
                  onClick={() => {
                    setRetiring(fact.factId);
                    api('POST', '/ui/facts/' + fact.factId + '/retire', {})
                      .then(() => {
                        panel.info('Fait retiré : il n’est plus servi.');
                        reload();
                      })
                      .catch((error: unknown) => {
                        panel.fail(failureText(error));
                      })
                      .finally(() => {
                        setRetiring('');
                      });
                  }}
                >
                  Retirer
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={'Modifier : ' + fact.topic}
                  onClick={() => {
                    setDraft(factDraftFrom(fact));
                    panel.focusTo('fact:topic');
                  }}
                >
                  Modifier
                </Button>
              </div>
            ) : null}
          </article>
        );
      })}
      <Button
        variant="secondary"
        className="h-10 w-full"
        onClick={() => {
          setDraft(emptyFactDraft());
          panel.focusTo('fact:topic');
        }}
      >
        <Plus aria-hidden="true" />
        Publier un fait
      </Button>
    </>
  );
}

const VALIDITY = [
  { days: 7, label: '7 jours' },
  { days: 30, label: '30 jours' },
  { days: 90, label: '90 jours' },
  { days: 365, label: '1 an' },
];

function FactForm({
  draft,
  setDraft,
  peers,
  reload,
}: {
  draft: FactDraft;
  setDraft: (draft: FactDraft | null) => void;
  peers: { nodeId: string; displayName: string }[];
  reload: () => void;
}) {
  const panel = usePanel();
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const update = (part: Partial<FactDraft>) => {
    setDraft({ ...draft, ...part });
  };
  const choices = VALIDITY.some((item) => item.days === draft.validDays)
    ? VALIDITY
    : [...VALIDITY, { days: draft.validDays, label: String(draft.validDays) + ' jours' }];
  const missing = (value: string) => invalid && !value.trim();
  return (
    <div
      role="group"
      aria-label={draft.factId ? 'Modifier le fait' : 'Publier un fait'}
      className="panel-surface flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5"
    >
      <Field label="Sujet">
        <Input
          type="text"
          maxLength={120}
          data-focus="fact:topic"
          aria-invalid={missing(draft.topic) || undefined}
          className={cn('selectable', compactInput)}
          value={draft.topic}
          onChange={(event) => {
            update({ topic: event.target.value });
          }}
        />
      </Field>
      <Field label="Énoncé">
        <Textarea
          rows={4}
          maxLength={1000}
          aria-invalid={missing(draft.statement) || undefined}
          className={cn('selectable', compactTextarea)}
          value={draft.statement}
          onChange={(event) => {
            update({ statement: event.target.value });
          }}
        />
      </Field>
      <Field label="Mots-clés (séparés par des virgules, 8 au plus)">
        <Input
          type="text"
          maxLength={330}
          placeholder="Ex. déploiement, mise en production"
          className={cn('selectable', compactInput)}
          value={draft.keywords}
          onChange={(event) => {
            update({ keywords: event.target.value });
          }}
        />
      </Field>
      <Field label="Source">
        <Input
          type="text"
          maxLength={200}
          placeholder="Ex. Planning des releases"
          aria-invalid={missing(draft.label) || undefined}
          className={cn('selectable', compactInput)}
          value={draft.label}
          onChange={(event) => {
            update({ label: event.target.value });
          }}
        />
      </Field>
      <Field label="Lien de la source">
        <Input
          type="url"
          maxLength={500}
          placeholder="https://… (facultatif)"
          className={cn('selectable', compactInput)}
          value={draft.url}
          onChange={(event) => {
            update({ url: event.target.value });
          }}
        />
      </Field>
      <Field label="Valable">
        <select
          className={compactSelect}
          value={String(draft.validDays)}
          onChange={(event) => {
            update({ validDays: Number(event.target.value) });
          }}
        >
          {choices.map((choice) => (
            <option key={choice.days} value={String(choice.days)}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0 text-[12px] font-medium">Public</legend>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input
            type="radio"
            name="fact-audience"
            className="accent-primary"
            checked={draft.audience === 'team'}
            onChange={() => {
              update({ audience: 'team' });
            }}
          />
          Tous mes pairs appairés
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input
            type="radio"
            name="fact-audience"
            className="accent-primary"
            checked={draft.audience === 'peers'}
            onChange={() => {
              update({ audience: 'peers' });
            }}
          />
          Des personnes choisies
        </label>
        {draft.audience === 'peers' ? (
          <div className="mt-1 ml-5 flex flex-col gap-1.5">
            {peers.map((peer) => (
              <label key={peer.nodeId} className="flex items-center gap-2 text-[12.5px] break-words">
                <Checkbox
                  checked={draft.nodeIds.includes(peer.nodeId)}
                  onCheckedChange={(value) => {
                    const others = draft.nodeIds.filter((id) => id !== peer.nodeId);
                    update({ nodeIds: value === true ? [...others, peer.nodeId] : others });
                  }}
                />
                {peer.displayName}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <Meta>
        Servi tel quel, sans te redemander, à ce public seulement. Les secrets reconnus bloquent la publication.
      </Meta>
      <div className="flex justify-end gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDraft(null);
          }}
        >
          Annuler
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (!draft.topic.trim() || !draft.statement.trim() || !draft.label.trim()) {
              setInvalid(true);
              panel.announce('Sujet, énoncé et source sont nécessaires.');
              panel.focusTo('fact:topic');
              return;
            }
            setBusy(true);
            api('POST', draft.factId ? '/ui/facts/' + draft.factId : '/ui/facts', factBody(draft))
              .then(() => {
                const edited = Boolean(draft.factId);
                setDraft(null);
                panel.info(
                  edited
                    ? 'Fait modifié : la nouvelle version remplace l’ancienne.'
                    : 'Fait publié : il est servi tel quel jusqu’à sa date de fin.',
                );
                reload();
              })
              .catch((error: unknown) => {
                panel.fail(failureText(error));
                panel.focusTo('fact:topic');
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {draft.factId ? 'Enregistrer' : 'Publier'}
        </Button>
      </div>
    </div>
  );
}

// ---- « Connecter mes agents » (T3.3, T4.5, T4.22): analyse, then confirm; a fallback only when a write is impossible ----

function ConnectSection({
  analysis,
  setAnalysis,
  reload,
  analyseNow,
  onAnalyseStarted,
}: {
  analysis: Analysis | null;
  setAnalysis: (analysis: Analysis | null) => void;
  reload: () => void;
  analyseNow: boolean;
  onAnalyseStarted: (() => void) | undefined;
}) {
  const panel = usePanel();
  const [scanning, setScanning] = useState(false);
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [disconnect, setDisconnect] = useState<OnboardingPlan | null>(null);
  const plans = analysis?.plans.filter((plan) => plan.state !== 'absent') ?? [];
  const ready = plans.filter((plan) => plan.state === 'ready');

  const analyse = () => {
    setScanning(true);
    Promise.all([
      api<OnboardingData>('GET', '/ui/admin/onboarding'),
      api<{ projects?: ProjectView[] }>('GET', '/ui/admin/projects').catch(() => ({ projects: [] })),
    ])
      .then(([onboarding, projects]) => {
        setUnchecked([]);
        setAnalysis({ plans: onboarding.agents, manual: onboarding.manual, projects: projects.projects ?? [] });
        panel.focusTo('connect:results');
      })
      .catch((error: unknown) => {
        panel.fail(failureText(error));
      })
      .finally(() => {
        setScanning(false);
      });
  };

  // Asked from the card shown after « Rejoindre » (T4.31): one local analysis, the request cleared at once, so that a
  // reload of this tab never runs it again. Connecting stays the second click.
  useEffect(() => {
    if (!analyseNow) return;
    onAnalyseStarted?.();
    analyse();
  });

  const apply = (selections: { agent: string; fingerprint: string; action: 'connect' | 'disconnect' }[]) => {
    const action = selections[0]?.action ?? 'connect';
    setConnecting(true);
    api<{ results: OnboardingResult[] }>('POST', '/ui/admin/onboarding', { selections })
      .then((result) => {
        setAnalysis(null);
        panel.info(onboardingMessage(result.results, action));
        reload();
      })
      .catch((error: unknown) => {
        panel.fail(failureText(error));
      })
      .finally(() => {
        setConnecting(false);
        setDisconnect(null);
      });
  };

  return (
    <>
      <SectionTitle className="mt-3">Connecter mes agents</SectionTitle>
      <div className="panel-surface flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5">
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {[
            'Analyse locale des treize clients MCP compatibles, dans leurs fichiers documentés seulement.',
            'Choisis puis confirme les connecteurs à ajouter. Aucun outil ne sera partagé.',
          ].map((step, index) => (
            <li key={step} className="flex gap-2 text-[12px] leading-snug text-muted-foreground">
              <span
                aria-hidden="true"
                className="grid size-[18px] shrink-0 place-items-center rounded-full border border-border bg-muted text-[10.5px] font-semibold text-foreground"
              >
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <Button variant="secondary" className="h-10 w-full" disabled={scanning} onClick={analyse}>
          <ScanSearch aria-hidden="true" />
          {scanning ? 'Analyse en cours…' : '1. Analyser cet ordinateur'}
        </Button>
      </div>
      {plans.length > 0 ? (
        <List label="Résultat de l’analyse">
          <span data-focus="connect:results" tabIndex={-1} className="sr-only">
            Résultat de l’analyse : {plans.length} agents trouvés.
          </span>
          {plans.map((plan) => {
            const selectable = plan.state === 'ready';
            const alert = plan.state === 'error' || plan.state === 'conflict';
            const body = (
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{plan.label}</div>
                {alert ? <ErrorText>{explain(plan.detail)}</ErrorText> : <Muted>{explain(plan.detail)}</Muted>}
                {plan.manual ? (
                  <details className="group mt-1.5 text-[12px]">
                    <summary className="flex cursor-default list-none items-center gap-1 text-primary [&::-webkit-details-marker]:hidden">
                      <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
                      Secours : à faire toi-même
                    </summary>
                    <Muted className="mt-1.5">{plan.manual.steps}</Muted>
                    <code className="selectable mt-1.5 block rounded-xl bg-muted px-3 py-2 font-mono text-[11px] leading-snug break-all whitespace-pre-wrap">
                      {plan.manual.snippet}
                    </code>
                  </details>
                ) : null}
              </div>
            );
            return selectable ? (
              <label key={plan.agent} className="flex items-start gap-2.5 px-3 py-2.5">
                <Checkbox
                  className="mt-0.5"
                  aria-label={'Connecter ' + plan.label}
                  checked={!unchecked.includes(plan.agent)}
                  onCheckedChange={(value) => {
                    setUnchecked((current) =>
                      value === true ? current.filter((agent) => agent !== plan.agent) : [...current, plan.agent],
                    );
                  }}
                />
                {body}
              </label>
            ) : (
              <div key={plan.agent} className="flex items-start gap-2.5 px-3 py-2.5">
                {body}
                {plan.state === 'already_connected' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={connecting}
                    onClick={() => {
                      setDisconnect(plan);
                    }}
                  >
                    <Unplug aria-hidden="true" />
                    Retirer ce connecteur
                  </Button>
                ) : null}
              </div>
            );
          })}
        </List>
      ) : null}
      {ready.length > 0 ? (
        <Button
          className="h-10 w-full"
          disabled={connecting}
          onClick={() => {
            const selections = ready
              .filter((plan) => !unchecked.includes(plan.agent))
              .map((plan) => ({ agent: plan.agent, fingerprint: plan.fingerprint, action: 'connect' as const }));
            if (!selections.length) {
              panel.announce('Coche au moins un agent.');
              return;
            }
            apply(selections);
          }}
        >
          2. Connecter les agents sélectionnés
        </Button>
      ) : null}
      {analysis && analysis.plans.every((plan) => plan.state === 'absent') ? (
        <Empty title="Aucun des treize clients détecté">
          Tu peux ajouter manuellement le connecteur MCP drop dans ton agent.
        </Empty>
      ) : null}
      <Lead>
        Autre agent ? Ajoute manuellement un serveur MCP stdio nommé drop. Aucune permission générale n’est nécessaire.
      </Lead>
      {analysis?.manual ? (
        <div className="panel-surface flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5">
          <div className="text-[13px] font-semibold">Configuration manuelle</div>
          <code className="selectable block rounded-xl bg-muted px-3 py-2 font-mono text-[11px] leading-snug break-all whitespace-pre-wrap">
            {JSON.stringify({ mcpServers: { drop: analysis.manual } }, null, 2)}
          </code>
          <Muted>
            Copie cette entrée dans la configuration MCP de ton agent, puis relance-le. Cela ne partage aucun outil.
          </Muted>
        </div>
      ) : null}
      {analysis ? (
        <ProjectsSection
          projects={analysis.projects}
          setProjects={(projects) => {
            setAnalysis({ ...analysis, projects });
          }}
        />
      ) : null}
      <Dialog
        open={Boolean(disconnect)}
        onOpenChange={(open) => {
          if (!open) setDisconnect(null);
        }}
      >
        <DialogContent className="w-[calc(100%-24px)] rounded-[18px] p-5">
          <DialogHeader className="mb-3">
            <DialogTitle className="text-[16px]">Retirer le connecteur de {disconnect?.label} ?</DialogTitle>
            <DialogDescription className="text-[12.5px]">
              drop retire seulement sa propre entrée. Les autres réglages de l’agent restent inchangés.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDisconnect(null);
              }}
            >
              Annuler
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={connecting}
              onClick={() => {
                if (disconnect)
                  apply([{ agent: disconnect.agent, fingerprint: disconnect.fingerprint, action: 'disconnect' }]);
              }}
            >
              Retirer ce connecteur
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---- Projects (T4.5, D66): read where the agents already work, or in a folder added here; never a scan of the disk ----

function ProjectsSection({
  projects,
  setProjects,
}: {
  projects: ProjectView[];
  setProjects: (projects: ProjectView[]) => void;
}) {
  const panel = usePanel();
  const [dir, setDir] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <SectionTitle className="mt-3">Configurations par projet</SectionTitle>
      {projects.length === 0 ? (
        <Muted className="mx-0.5">
          Aucun projet connu de tes agents. Ajoute un dossier pour lire ses configurations MCP.
        </Muted>
      ) : null}
      {projects.map((project) => (
        <List key={project.dir}>
          <div className="flex items-start gap-2.5 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold break-all">{project.dir}</div>
              <Muted>{project.sources.map((source) => PROJECT_SOURCES[source] ?? source).join(' · ')}</Muted>
            </div>
            {project.sources.includes('added') ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label={'Retirer le dossier ' + project.dir}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api('POST', '/ui/admin/projects/remove', { dir: project.dir })
                    .then(() => {
                      setProjects(projects.filter((item) => item.dir !== project.dir || item.sources.length > 1));
                      panel.info('Dossier retiré de la liste.');
                    })
                    .catch((error: unknown) => {
                      panel.fail(failureText(error));
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                Retirer
              </Button>
            ) : null}
          </div>
          {project.clients.length === 0 ? (
            <Muted className="px-3 py-2.5">Aucune configuration MCP dans ce dossier.</Muted>
          ) : null}
          {project.clients.map((client) => (
            <div key={client.agent} className="px-3 py-2.5">
              <div className="text-[12.5px] font-semibold">
                {client.label}
                {client.dropInstalled ? ' · drop raccordé' : ''}
              </div>
              <Muted className="break-all">
                {client.servers
                  .map((server) => server.name + (server.where ? ' (' + server.where + ')' : ''))
                  .join(', ')}
              </Muted>
            </div>
          ))}
        </List>
      ))}
      <div className="panel-surface flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-3.5">
        <Field label="Ajouter un dossier de projet">
          <Input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="/Users/…/mon-projet"
            aria-label="Chemin complet du dossier de projet"
            data-focus="project:dir"
            aria-invalid={invalid || undefined}
            className={cn('selectable', compactInput)}
            value={dir}
            onChange={(event) => {
              setInvalid(false);
              setDir(event.target.value);
            }}
          />
        </Field>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!dir.trim()) {
                setInvalid(true);
                panel.announce('Indique le chemin complet du dossier.');
                panel.focusTo('project:dir');
                return;
              }
              setBusy(true);
              api('POST', '/ui/admin/projects', { dir: dir.trim() })
                .then(() => api<{ projects: ProjectView[] }>('GET', '/ui/admin/projects'))
                .then((result) => {
                  setProjects(result.projects);
                  setDir('');
                  panel.info('Dossier ajouté.');
                })
                .catch((error: unknown) => {
                  panel.fail(failureText(error));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <FolderPlus aria-hidden="true" />
            Ajouter ce dossier
          </Button>
        </div>
      </div>
    </>
  );
}

// ---- « Mes outils »: a shared tool answers the team's questions after consent; nobody receives access ----

function SharingSection({
  tools,
  reload,
  onSignIn,
}: {
  tools: ToolsData;
  reload: () => void;
  onSignIn: (offer: { agent: string; server: string }) => void;
}) {
  const panel = usePanel();
  const [busy, setBusy] = useState('');
  const installed = tools.agents.filter((agent) => agent.installed);
  const links = tools.links ?? [];
  return (
    <>
      <SectionTitle className="mt-3">Mes outils</SectionTitle>
      <Lead>
        Partager un outil, c’est répondre aux questions de l’équipe avec lui, après ton accord. Personne ne reçoit
        l’accès.
      </Lead>
      {installed.map((agent) => (
        <List key={agent.agent}>
          <div className="px-3 py-2.5">
            <div className="text-[13px] font-semibold">{agent.label}</div>
            <Muted>
              {agent.dropInstalled ? 'drop est installé dans ' + agent.label : 'drop n’est pas encore installé'}
            </Muted>
          </div>
          {agent.servers
            .filter((server) => server.shareable)
            .map((server) => {
              const key = agent.agent + '/' + server.name;
              const shared = tools.shared[key];
              return (
                <div key={key} className="flex items-center gap-2.5 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] break-words">{server.name}</div>
                    <Muted className="break-all">
                      {(server.kind ? server.kind + ' · ' : '') + (server.where ?? '')}
                    </Muted>
                  </div>
                  <Switch
                    checked={Boolean(shared)}
                    disabled={busy === key}
                    aria-label={(shared ? 'Ne plus partager ' : 'Partager ') + server.name}
                    onCheckedChange={() => {
                      setBusy(key);
                      const call = shared
                        ? api('POST', '/ui/admin/unshare', { capabilityId: shared })
                        : api('POST', '/ui/admin/share', { agent: agent.agent, server: server.name });
                      call
                        .then(() => {
                          panel.info(shared ? 'Outil retiré du partage.' : 'Outil partagé après consentement.');
                          reload();
                        })
                        .catch((error: unknown) => {
                          panel.fail(failureText(error));
                          if ((error as { code?: unknown }).code === 'E_SHARE_OAUTH')
                            onSignIn({ agent: agent.agent, server: server.name });
                        })
                        .finally(() => {
                          setBusy('');
                        });
                    }}
                  />
                </div>
              );
            })}
        </List>
      ))}
      {links.length > 0 ? (
        <>
          <SectionTitle className="mt-3">Assistants reliés</SectionTitle>
          <List>
            {links.map((link) => (
              <div key={link.gateway + '/' + link.clientName} className="flex items-center gap-2.5 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold break-words">
                    {link.clientName}
                    {link.redirectHost ? ' (' + link.redirectHost + ')' : ''}
                  </div>
                  <Muted>peut demander à ton équipe en ton nom</Muted>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={'Retirer ' + link.clientName}
                  onClick={() => {
                    api('POST', '/ui/admin/unlink', { gateway: link.gateway, client: link.clientName })
                      .then(() => {
                        panel.info(link.clientName + ' n’est plus relié.');
                        reload();
                      })
                      .catch((error: unknown) => {
                        panel.fail(failureText(error));
                      });
                  }}
                >
                  Retirer
                </Button>
              </div>
            ))}
          </List>
        </>
      ) : null}
      <Lead>Qui paie le modèle : {tools.payer === 'owner' ? 'toi' : 'celui qui demande'}</Lead>
    </>
  );
}

// ---- Internet by iroh (T4.2b, D68): off by default; no relay unless the owner picks one; n0 flagged as a third party ----

function InternetSection({ internet, reload }: { internet: InternetData; reload: () => void }) {
  const panel = usePanel();
  const settings = internet.settings ?? { mode: 'off' as InternetMode };
  const [mode, setMode] = useState<InternetMode>(settings.mode);
  const [relay, setRelay] = useState(settings.mode === 'relay' ? (settings.relay ?? '') : '');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = (INTERNET_STATES[internet.state] ?? '') + (internet.message ? ' ' + internet.message : '');
  return (
    <>
      <SectionTitle className="mt-3">Connexion par Internet</SectionTitle>
      <Lead>
        Pour joindre un collègue hors de ton réseau, sans serveur drop. Le contenu reste chiffré de bout en bout.
      </Lead>
      <div
        role="status"
        className={cn('mx-0.5 text-[12px]', internet.message ? 'text-destructive' : 'text-muted-foreground')}
      >
        {state}
      </div>
      <fieldset className="panel-surface m-0 flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-3.5">
        <legend className="sr-only">Relais</legend>
        <div aria-hidden="true" className="text-[13px] font-semibold">
          Relais
        </div>
        {INTERNET_CHOICES.map((choice) => (
          <label key={choice.mode} className="flex items-start gap-2.5">
            <input
              type="radio"
              name="internet-mode"
              value={choice.mode}
              data-focus={'internet:' + choice.mode}
              className="mt-1 accent-primary"
              checked={mode === choice.mode}
              onChange={() => {
                setMode(choice.mode);
              }}
            />
            <span className="min-w-0">
              <span className="block text-[12.5px]">{choice.label}</span>
              {choice.detail ? <Muted>{choice.detail}</Muted> : null}
            </span>
          </label>
        ))}
        <Field label="Adresse du relais (mon relais ou celui de l’équipe)">
          <Input
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://relais.mon-equipe.fr"
            aria-label="Adresse du relais iroh"
            data-focus="internet:relay"
            aria-invalid={invalid || undefined}
            className={cn('selectable', compactInput)}
            value={relay}
            onChange={(event) => {
              setInvalid(false);
              setRelay(event.target.value);
            }}
          />
        </Field>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (mode === 'relay' && !relay.trim()) {
                setInvalid(true);
                panel.announce('Indique l’adresse du relais.');
                panel.focusTo('internet:relay');
                return;
              }
              setBusy(true);
              api('POST', '/ui/admin/internet', mode === 'relay' ? { mode, relay: relay.trim() } : { mode })
                .then(() => {
                  panel.info('Connexion par Internet mise à jour.');
                  reload();
                })
                .catch((error: unknown) => {
                  panel.fail(failureText(error));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            Enregistrer
          </Button>
        </div>
      </fieldset>
    </>
  );
}
