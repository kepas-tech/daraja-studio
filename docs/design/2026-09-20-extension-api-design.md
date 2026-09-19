# The extension api, version 1

Step four, part two of the tiers-and-modules design. Written 2026-09-20. Owner: Nelson Lemein.

## Why it exists

A private package has to be able to stand beside the studio without the studio knowing what it
does. Step two left the smallest possible seam for that: a package could declare a part of the
studio and own a second migrations directory, and nothing else. That was enough to hold tables and
to be listed, and not enough to do anything with them — a package had no database, no settings, no
way to make an organisation through the studio's own service, and no way to answer a request.

This widens that seam by exactly those four things and no more. It is written as an api with a
version, because everything in it is a promise the studio keeps for ever.

## What a package is handed

```ts
export interface ExtensionApi {
  readonly version: number;                    // EXTENSION_API_VERSION, 1 today
  readonly db: Db;                             // the database handle the rest of the studio uses
  readonly settings: Settings;                 // the settings reader
  readonly orgs: Pick<OrgService, 'create'>;   // making an organisation, through the studio's own service
  registerModule(decl: ModuleDecl): void;      // declare a part of the studio (step two, unchanged)
  registerRouter(name: string, router: Router): void;  // mount one router of its own
}
```

A package exports `register(api)` and is loaded once at boot. The three handles come from the
running studio: the same pool every route uses, the same settings store, and the studio's own
organisation service, so a package never writes an organisation with its own SQL. `register(api)`
runs in the boot, before the app is built, so what it declares and mounts is in place before the
first request.

`version` is a number a package reads and may refuse to load against if it does not know it. It
goes up when something in the api changes in a way a package has to know about — a part removed, a
part whose shape changes, or a part whose meaning moves. It does not go up for an addition, because
an older package simply does not use what it does not know about.

## The router

One router per package, at one address:

    /api/x/<name>

`x` is reserved for this and for nothing else. No part of the product answers under `/api/x`,
and none ever may: a package's address must not be able to collide with the studio's own, and a test
in the core proves the namespace is empty until a package takes it. A package picks a **name**, never
a path — lower-case letters, digits and hyphens, two to thirty of them, starting with a letter — and
the studio builds the address from it. A name that is not one plain segment is refused, so nothing
a package writes can put its router anywhere else, and a second router from the same package is
refused too.

**What the router carries, whatever the package does.** It is mounted inside the studio's own
`/api` chain, which already puts the caller's organisation and the organisation's status in front of
every route: the organisation context (`orgContext`), the password-change gate
(`requirePasswordChanged`) and the suspended-or-closed rule (`requireOrgActive`). On top of that the
studio mounts the session (`requireAuth`) and the CSRF check (`requireCsrf`) **in front of the
package's router**, rather than leaving them to the package to remember. A route under this
namespace therefore always has a signed-in person and, for anything that is not a GET, a valid CSRF
token, and a package has no way to serve without either.

Every request through the package's router is already inside the caller's organisation, so a
package's queries are scoped exactly as the studio's own are, with the row-level policies behind
them.

## What is deliberately not in the api

- **Permissions.** The catalogue is the studio's, and the layer a package adds is the operator's own:
  it is reached by the owner and needs no permission of its own.
- **Menu entries.** The web's menu keys are the studio's. A package's page is not part of the product
  a tenant sees.
- **Tiers.** Tiers are the studio's own lists, and a package cannot put itself into one.

Each of those would be another promise to keep for ever, and none of them is needed for the job this
api was widened for.

## What is still impossible, and stays so

- **No address outside the namespace.** A package cannot mount at `/api/anything-else`, and cannot
  name its own path.
- **No public route.** Everything under the namespace is behind a session and CSRF. A package that
  needs an unauthenticated endpoint — a webhook receiver, say — cannot have one through this api.
  That would be a new promise and a new decision.
- **No page in the studio's own web app.** The studio's single-page app is built from the core's own
  routes; a package serves JSON and nothing else.
- **No tenant path routing for the web.** One host, one path per tenant, remains a change to the
  studio's web app, and this api does not make it.
- **Absent is still silence, broken still stops the boot.** A package that is not installed changes
  nothing at all; one that is installed and throws, or asks for something the api does not give,
  stops the boot with the package named and the error kept.

## How it is tested

`server/test/extension.test.ts`, against a fixture package that declares a part and mounts one
router: the router is reachable and reads the database, the settings and the caller's organisation
back through the studio's own gate; a write without a CSRF token is refused by the studio's check; a
second router is refused; a name that is not one segment is refused; an absent package still boots
and the namespace stays empty; and both broken fixtures still stop the boot with the package named.
`docs/design/` holds this file; the tests are the promise.
