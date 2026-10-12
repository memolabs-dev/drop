/** « Équipe »: create the team, see who is online and what they share, invite with a one-time https link. */
import { useState } from 'react';
import { Copy, UserPlus } from 'lucide-react';
import { api } from '../api.ts';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { cn } from '../lib/utils.ts';
import { failureText } from './logic.ts';
import type { TeamData } from './types.ts';
import { Avatar, Dot, Field, List, Muted, SectionTitle, compactInput, usePanel } from './ui.tsx';

export function TeamTab({ data, reload }: { data: TeamData; reload: () => void }) {
  const panel = usePanel();
  const [name, setName] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);

  if (!data.team) {
    return (
      <div className="panel-surface flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5">
        <div>
          <SectionTitle className="mx-0 text-[13px] text-foreground">Pas encore d’équipe</SectionTitle>
          <Muted className="mt-1">Crée-la, puis invite tes collègues : chacun verra les outils des autres.</Muted>
        </div>
        <Field label="Nom de l’équipe">
          <Input
            type="text"
            name="team"
            autoComplete="off"
            spellCheck={false}
            placeholder="Ex. Atlas…"
            data-focus="team:name"
            aria-invalid={invalid || undefined}
            className={compactInput}
            value={name}
            onChange={(event) => {
              setInvalid(false);
              setName(event.target.value);
            }}
          />
        </Field>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!name.trim()) {
                setInvalid(true);
                panel.announce('Donne un nom à l’équipe.');
                panel.focusTo('team:name');
                return;
              }
              setBusy(true);
              api('POST', '/ui/admin/team', { name: name.trim() })
                .then(() => {
                  panel.info('Équipe créée.');
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
            Créer l’équipe
          </Button>
        </div>
      </div>
    );
  }

  const online = data.members.filter((member) => member.online).length;
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>
        {data.team.name} · {data.members.length} membres, {online} en ligne
      </SectionTitle>
      <List>
        {data.members.map((member, index) => (
          <div key={member.nodeId} className="flex items-start gap-2.5 px-3 py-2.5">
            <Avatar name={member.displayName} accent={((index % 3) + 1) as 1 | 2 | 3} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold break-words">
                {member.displayName}
                {member.self ? <span className="font-normal text-muted-foreground"> (toi)</span> : null}
              </div>
              <Muted className="break-words">{member.agents.join(', ') || 'aucun agent signalé'}</Muted>
              {member.capabilities.length > 0 ? (
                <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-1 p-0" aria-label="Outils partagés">
                  {member.capabilities.map((capability, i) => (
                    <li key={String(i) + capability.title}>
                      <Badge className="px-2 py-0.5 text-[10.5px] break-all">
                        {capability.title.replace('Répondre à partir de ', '')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <Dot tone={member.online ? 'ok' : 'idle'} />
              {member.online ? 'en ligne' : 'hors ligne'}
            </span>
          </div>
        ))}
      </List>
      <Button
        variant="secondary"
        className="h-10 w-full"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setCopyFailed(false);
          // One https link that works without the app (T4.23, T4.31): the join page installs drop, then opens it.
          api<{ code: string; link: string }>('POST', '/ui/invite')
            .then((result) => {
              setLink(result.link);
              panel.focusTo('team:copy');
            })
            .catch((error: unknown) => {
              panel.fail(failureText(error));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <UserPlus aria-hidden="true" />
        Inviter quelqu’un dans l’équipe
      </Button>
      {link ? (
        <div className="panel-surface flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-3.5">
          <Muted>
            Envoie ce lien, valable 24 h, une seule fois, pour une seule personne. Il ouvre une page pour installer
            drop, puis ouvre drop sur l’invitation.
          </Muted>
          <code className="selectable block rounded-xl bg-muted px-3 py-2 font-mono text-[11px] leading-snug break-all whitespace-pre-wrap">
            {link}
          </code>
          {copyFailed ? (
            <div role="alert" className="rounded-xl border border-destructive/40 px-3 py-2 text-[12px] text-foreground">
              Copie impossible : sélectionne le lien et copie-le à la main.
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              data-focus="team:copy"
              className={cn('text-primary')}
              onClick={() => {
                // Over plain http a web view may expose no clipboard at all: that is a failed copy too.
                const clipboard = (navigator as Partial<Navigator>).clipboard;
                if (!clipboard) {
                  setCopyFailed(true);
                  return;
                }
                clipboard.writeText(link).then(
                  () => {
                    panel.announce('Lien copié.');
                  },
                  () => {
                    setCopyFailed(true);
                  },
                );
              }}
            >
              <Copy aria-hidden="true" />
              Copier le lien
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
