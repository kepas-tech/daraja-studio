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

  api.registerRouter('fixture', router);
}
