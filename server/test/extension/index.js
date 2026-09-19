import express from 'express';

/**
 * A package installed beside Studio, for the seam's own test.
 *
 * Plain JavaScript, importing nothing of Studio's own: at boot the app loads it and hands it the
 * extension api, and everything below uses only what that api gives. It declares one part and
 * mounts one router, which is all a package may do, and the router reads back the three things the
 * api hands over — the database, the settings and the organisation service — so the seam's test can
 * prove each one arrived.
 */
export function register(api) {
  api.registerModule({
    key: 'fixture_notes',
    name: 'Fixture notes',
    sentence: 'A part of Studio that an installed package declares, used only to prove the seam.',
    permissions: [],
    menu: [],
    hides: 'nothing: it is a fixture',
    needs: [],
    built: true,
  });

  const router = express.Router();

  /** What the api handed over, read back through a request that went through the studio's own gate. */
  router.get('/notes', async (req, res, next) => {
    try {
      const [row] = await api.db.query('SELECT count(*)::int AS n FROM modules');
      res.json({
        apiVersion: api.version,
        org: req.org ? req.org.slug : null,
        modules: row.n,
        setting: await api.settings.get('public.url'),
      });
    } catch (e) { next(e); }
  });

  /** An organisation made through the studio's own service, never by the package's own SQL. */
  router.post('/org', async (req, res, next) => {
    try {
      const made = await api.orgs.create({ name: String((req.body && req.body.name) || 'A tenant'), signupIp: null });
      res.status(201).json({ id: made.org.id, status: made.org.status, secretReturned: typeof made.secret === 'string' });
    } catch (e) { next(e); }
  });

  /**
   * An organisation and its first owner together, through the studio's own service. The password is
   * handed over plain and hashed by the studio, because a package never hashes one and never writes
   * the people table itself.
   */
  router.post('/provision', async (req, res, next) => {
    try {
      const body = req.body || {};
      const made = await api.orgs.provision({
        name: String(body.name || 'A tenant'),
        owner: { username: String(body.username || ''), displayName: String(body.displayName || 'The owner'), password: String(body.password || '') },
        signupIp: null,
      });
      if (!made.ok) {
        return res.status(made.problem === 'username_taken' ? 409 : 400).json({ error: { code: made.problem, message: made.message } });
      }
      res.status(201).json({
        org: { id: made.org.id, status: made.org.status },
        person: { id: made.person.id, username: made.person.username, isOwner: made.person.is_owner },
      });
    } catch (e) { next(e); }
  });

  api.registerRouter('fixture', router);
}
