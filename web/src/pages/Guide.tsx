import { Link } from 'react-router';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';
import { agentSection, guide, guideIntro, guideMachineLine, guideTitle, type GuideTask } from '../copy/guide';
import logo from '../assets/logo-long.png';

const anchor = (key: string) => `s-${key}`;

function Task({ t }: { t: GuideTask }) {
  const meta = [t.path && `Page: ${t.path}`, t.who && `Who: ${t.who}`].filter(Boolean).join(' · ');
  return (
    <Card title={t.title} bodyClassName="space-y-3 p-4">
      {(t.safaricom || meta) && (
        <p className="text-sm text-muted">
          {t.safaricom && <span>{copy.pageHeader.safaricomPrefix}{t.safaricom}</span>}
          {t.safaricom && meta && ' · '}
          {meta}
        </p>
      )}
      <ol className="list-decimal space-y-1.5 pl-5 text-base">{t.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {t.notes && <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{t.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {t.api && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">{copy.guidePage.api}</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="text-muted"><th className="pr-3 font-medium">{copy.guidePage.apiMethod}</th><th className="pr-3 font-medium">{copy.guidePage.apiPath}</th><th className="font-medium">{copy.guidePage.apiWho}</th></tr></thead>
              <tbody>{t.api.map((a) => <tr key={a.method + a.path} className="border-t border-line align-top"><td className="py-1 pr-3 font-mono">{a.method}</td><td className="py-1 pr-3 font-mono">{a.path}</td><td className="py-1">{a.who}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
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
          <li><a href={`#${anchor('agents')}`}>{agentSection.title}</a></li>
        </ol>
        <p className="mt-3 text-sm text-muted">{guideMachineLine}</p>
      </nav>
      {guide.map((s) => (
        <section key={s.key} id={anchor(s.key)} className="scroll-mt-4 space-y-4">
          <h2 className="text-xl font-semibold">{s.title}</h2>
          {s.intro && <p className="text-base text-muted">{s.intro}</p>}
          {s.tasks.map((t) => <Task key={t.key} t={t} />)}
        </section>
      ))}
      <section id={anchor('agents')} className="scroll-mt-4 space-y-4">
        <h2 className="text-xl font-semibold">{agentSection.title}</h2>
        <p className="text-base text-muted">{agentSection.intro}</p>
        <Card title={copy.guidePage.session} bodyClassName="p-4"><ol className="list-decimal space-y-1.5 pl-5">{agentSection.session.map((s, i) => <li key={i}>{s}</li>)}</ol></Card>
        <Card title={copy.guidePage.rules} bodyClassName="p-4"><ol className="list-decimal space-y-1.5 pl-5">{agentSection.rules.map((s, i) => <li key={i}>{s}</li>)}</ol></Card>
      </section>
    </div>
  );
}

/** The manual. Inside the app it sits under the layout; `standalone` is the logged-out version reached from Login and setup. */
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
