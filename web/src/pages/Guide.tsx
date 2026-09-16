import { Link } from 'react-router';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';
import { guide, guideIntro, guideTitle, type GuideLink, type GuideTask } from '../copy/guide';
import logo from '../assets/logo-long.png';

const anchor = (key: string) => `s-${key}`;
const ARROW = ' → ';

/** A button to a Safaricom page and, under it, the clicks once there: a → b → c. */
function SafaricomLink({ l }: { l: GuideLink }) {
  const external = !l.href.startsWith('mailto:');
  return (
    <div className="rounded-md border border-line bg-page p-3">
      <a href={l.href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} className="inline-flex items-center gap-2 font-semibold">
        {l.label}<Icon name="external-link" className="size-4" />
      </a>
      <p className="mt-1 text-sm text-muted">{copy.guidePage.then} {l.trail.join(ARROW)}</p>
    </div>
  );
}

function Task({ t }: { t: GuideTask }) {
  return (
    <Card title={t.title} bodyClassName="space-y-3 p-4">
      {t.safaricom && <p className="text-sm text-muted">{copy.pageHeader.safaricomPrefix}{t.safaricom}</p>}
      {(t.where || t.who) && (
        <p className="text-sm text-muted">
          {t.where && <span>{copy.guidePage.where} {t.where.join(ARROW)}</span>}
          {t.where && t.who && ' · '}
          {t.who && <span>{copy.guidePage.who} {t.who}</span>}
        </p>
      )}
      <ol className="list-decimal space-y-1.5 pl-5 text-base">{t.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {t.notes && <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{t.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {t.links && <div className="grid gap-2 sm:grid-cols-2">{t.links.map((l) => <SafaricomLink key={l.href + l.label} l={l} />)}</div>}
    </Card>
  );
}

function Body() {
  return (
    <div className="space-y-10">
      <nav aria-label={copy.guidePage.contents} className="rounded-md border border-line bg-surface p-4">
        <p className="mb-2 text-sm font-semibold">{copy.guidePage.contents}</p>
        <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {guide.map((s) => <li key={s.key}><a href={`#${anchor(s.key)}`}>{s.title}</a></li>)}
        </ol>
      </nav>
      {guide.map((s) => (
        <section key={s.key} id={anchor(s.key)} className="scroll-mt-4 space-y-4">
          <h2 className="text-xl font-semibold">{s.title}</h2>
          {s.intro && <p className="text-base text-muted">{s.intro}</p>}
          {s.tasks.map((t) => <Task key={t.key} t={t} />)}
        </section>
      ))}
    </div>
  );
}

/** The manual for people: tasks, steps, where each thing is in Studio, and for anything that comes
 * from Safaricom a link plus the clicks. Routes, permission keys and API calls never render here;
 * they live in guide.md, which the server hands only to clients that do not ask for HTML. Inside
 * the app it sits under the layout; `standalone` is the logged-out version reached from Login and setup. */
export function Guide({ standalone = false }: { standalone?: boolean }) {
  if (standalone) {
    return (
      <div className="min-h-screen bg-page px-4 py-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <img src={logo} alt={copy.appName} className="mx-auto h-20 w-auto" />
          <PageHeader title={guideTitle} subtitle={guideIntro}><Link to="/login" className="text-sm">{copy.guidePage.login}</Link></PageHeader>
          <Body />
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={guideTitle} subtitle={guideIntro} />
      <Body />
    </div>
  );
}
