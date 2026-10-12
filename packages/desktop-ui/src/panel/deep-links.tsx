/**
 * Cards opened by a deep link. Nothing happens until the owner clicks: `drop://pair` and `drop://join` (T4.14, T4.23)
 * pair only after « Rejoindre », then offer « Connecter mes agents » (T4.31); `drop://link` (T2.13) links an assistant
 * only after « Autoriser ».
 */
import { useState } from 'react';
import { PlugZap, TriangleAlert } from 'lucide-react';
import { api } from '../api.ts';
import { Button } from '../components/ui/button.tsx';
import { failureText, linkWarnings } from './logic.ts';
import type { JoinedInvite, LinkRequest, PairResult, PendingInvite } from './types.ts';
import { Muted, usePanel } from './ui.tsx';

/** `onDone` receives what « Rejoindre » did, or null when the owner refused or the Node did. */
export function InviteCard({
  invite,
  onDone,
}: {
  invite: PendingInvite;
  onDone: (joined: JoinedInvite | null) => void;
}) {
  const panel = usePanel();
  const [busy, setBusy] = useState(false);
  return (
    <article
      aria-labelledby="invite-title"
      className="panel-surface motion-arrive flex flex-col gap-3 rounded-2xl border border-primary/30 bg-card p-3.5"
    >
      <h2 id="invite-title" className="m-0 text-[14px] leading-snug font-semibold break-words">
        {invite.team
          ? invite.displayName + ' t’invite dans l’équipe ' + invite.team
          : 'Invitation de ' + invite.displayName}
      </h2>
      <Muted>
        Nom et équipe annoncés par le lien : si tu ne l’attendais pas, vérifie avec la personne avant de rejoindre.
      </Muted>
      {invite.relay === 'adopt' ? (
        // Any page can open drop://join with an invite signed by its own key: say when « Rejoindre » changes relay.
        <Muted className="break-words">
          En rejoignant, ton app passera par le relais {invite.relayHost}, celui de la personne qui t’invite. Si tu ne
          connais pas ce relais, refuse.
        </Muted>
      ) : null}
      <Muted>
        En rejoignant, vous verrez les outils partagés l’un de l’autre. Chaque question reste soumise à ton accord ;
        personne ne reçoit d’accès.
      </Muted>
      <div className="flex justify-end gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          autoFocus
          onClick={() => {
            panel.info('Invitation refusée.');
            onDone(null);
          }}
        >
          Refuser
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api<PairResult>('POST', '/ui/pair', new URLSearchParams({ code: invite.code })).then(
              (result) => {
                panel.info('Invitation acceptée : tu rejoins l’équipe dans quelques secondes.');
                onDone({
                  relay: result.relay,
                  relayHost: invite.relayHost,
                  ...(result.next ? { next: result.next } : {}),
                });
              },
              (error: unknown) => {
                panel.fail(failureText(error));
                onDone(null);
              },
            );
          }}
        >
          Rejoindre
        </Button>
      </div>
    </article>
  );
}

/**
 * After « Rejoindre », the third step of the one link (D84, T4.31): connect this computer's agents. « Connecter mes
 * agents » only analyses, locally; connecting stays the second, explicit action of « Mes outils ».
 */
export function ConnectAgentsCard({
  joined,
  onConnect,
  onLater,
}: {
  joined: JoinedInvite;
  onConnect: () => void;
  onLater: () => void;
}) {
  return (
    <article
      aria-labelledby="next-step-title"
      className="panel-surface motion-arrive flex flex-col gap-3 rounded-2xl border border-primary/30 bg-card p-3.5"
    >
      <h2 id="next-step-title" className="m-0 text-[14px] leading-snug font-semibold">
        Prochaine étape : connecter tes agents
      </h2>
      {joined.relay === 'adopt' ? (
        <Muted className="break-words">
          Ton app passe maintenant par le relais {joined.relayHost}, celui de ton équipe.
        </Muted>
      ) : null}
      <Muted>
        Tes agents pourront poser leurs questions à l’équipe. drop regarde d’abord quels agents sont installés sur cet
        ordinateur, sans rien modifier ; tu choisis ensuite ceux à connecter.
      </Muted>
      <div className="flex justify-end gap-1.5">
        <Button variant="secondary" size="sm" onClick={onLater}>
          Plus tard
        </Button>
        <Button size="sm" data-focus="next:connect" onClick={onConnect}>
          <PlugZap aria-hidden="true" />
          Connecter mes agents
        </Button>
      </div>
    </article>
  );
}

export function LinkCard({
  request,
  gateways,
  onDone,
}: {
  request: LinkRequest;
  gateways: readonly string[];
  onDone: () => void;
}) {
  const panel = usePanel();
  const [busy, setBusy] = useState(false);
  const { complete, warnings } = linkWarnings(request, gateways);
  const who = request.client + (request.redirect ? ' (' + request.redirect + ')' : '');
  return (
    <article
      aria-labelledby="link-title"
      className="panel-surface motion-arrive flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5"
    >
      <h2 id="link-title" className="m-0 text-[14px] leading-snug font-semibold break-words">
        Autoriser {who} à demander à ton équipe ?
      </h2>
      <p className="m-0 text-[12.5px] leading-relaxed break-words">
        {request.client} pourra poser des questions à tes collègues en ton nom. Chacun continue d’accepter ou de refuser
        chaque question ; personne ne reçoit d’accès.
      </p>
      {warnings.map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-2 rounded-xl border border-destructive/35 px-3 py-2 text-[12px] leading-snug break-words text-destructive"
        >
          <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {warning}
        </div>
      ))}
      <div className="flex justify-end gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          autoFocus
          onClick={() => {
            panel.info('Raccordement refusé.');
            onDone();
          }}
        >
          Refuser
        </Button>
        {complete ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api('POST', '/ui/admin/link', {
                gateway: request.gateway,
                session: request.session,
                client: request.client,
                clientId: request.clientId,
                redirect: request.redirect,
              }).then(
                () => {
                  panel.info(request.client + ' est relié. Tu peux revenir dans ta conversation.');
                  onDone();
                },
                (error: unknown) => {
                  setBusy(false);
                  panel.fail(failureText(error));
                },
              );
            }}
          >
            Autoriser
          </Button>
        ) : null}
      </div>
    </article>
  );
}
