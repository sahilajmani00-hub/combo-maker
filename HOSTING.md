# Invite-only Combo Maker

This implementation is ready to deploy but is not live yet. GitHub stores the source;
a Node.js server enforces access. GitHub Pages cannot run this server. The existing
Pages information and OAuth privacy pages remain unchanged.

## What users can do

Invited users choose a password, sign in, compose product photos, and download images
or ZIPs from a phone, tablet, or computer. Each browser keeps its own photos in memory.
There is no public signup and no shared photo library.

AI, Google Drive, Cloudinary, and saved disk templates remain in the local app.
The hosted server does not expose any of the local app's APIs or credentials.

## Deploy on Render

The repository includes `render.yaml` and a Dockerfile. The proposed service uses
Render's **Starter paid web service and a 1 GB persistent disk**. Review the charges
shown in Render before creating the service. No paid service has been created by this change.

1. Sign in at https://dashboard.render.com and choose **New → Blueprint**.
2. Connect `sahilajmani00-hub/combo-maker` and select branch `add-github-pages-docs`.
3. Review the service and disk cost, then create the Blueprint.
4. Wait for the deployment to pass `/healthz`. Open the HTTPS URL Render assigns.
   The app automatically uses `RENDER_EXTERNAL_URL` for same-origin login checks.
5. Open the service's **Shell** and create your own invitation using the command below.

The image includes only the hosted build, login pages, and authentication code.
The account database lives at `/data/accounts.sqlite` on the persistent disk. Keep this
disk attached across deployments. This SQLite configuration is for one service instance.
Back up the database using a SQLite-aware backup before moving or deleting the disk.

For a custom domain, set `APP_URL` to its exact HTTPS origin, without a path, and use
that domain for invitations and login. Always terminate public traffic over HTTPS.
See [Render Blueprints](https://render.com/docs/blueprint-spec) for hosting configuration.

## Invite someone

Run in the **deployed service's Shell**, so it uses the deployed account database:

```sh
node tools/invite.mjs person@example.com
```

Copy the private link and share it with that person yourself. The app sends no email.
The link is a bearer invitation: whoever holds it and the invited email can activate
that account. It expires after **24 hours** and works **once**. The invited user chooses
a password of 12–128 characters. Invite links place the token in a URL fragment, so it
is not sent in HTTP request paths or referrers.

Running this command again replaces the previous invitation, clears the old password,
and invalidates all existing sessions. Use it for a forgotten password or to re-invite
a revoked user. The person must activate the new link before signing in again.

Revoke access immediately:

```sh
node tools/invite.mjs person@example.com --revoke
```

Revocation blocks login and invalidates active sessions and invitations. Account records
are retained; delete them through database administration if an account-deletion request
is received. Never commit or share the database, passwords, or private invitation links.

## Test locally

Requires Node.js 24 or newer:

```sh
npm ci
npm run test:auth
npm run build:hosted
APP_URL=http://localhost:4174 HOST=127.0.0.1 npm run start:hosted
```

In another terminal:

```sh
APP_URL=http://localhost:4174 npm run invite -- person@example.com
```

Open the invitation URL, activate the account, and create a combo. Sign out, then check
that opening `/` redirects to `/login`. Local accounts live in the gitignored `data/`
directory. A local invite does not create an account on the deployed server.

`npm start` continues to run the original local app. `npm run build` and
`npm run build:hosted` use separate output directories, so they do not overwrite each other.

## Authentication behavior

- Scrypt password hashes with a unique random salt; no plain-text passwords.
- Random session tokens stored only as SHA-256 hashes; seven-day expiry.
- HttpOnly, Secure, SameSite=Strict cookies in HTTPS deployments.
- Exact-origin checks for login, invitation activation, and logout.
- Login/activation throttling: ten attempts per email and 120 total per 15 minutes
  per process. Counters reset on restart; place an edge rate limiter in front of a
  high-traffic deployment.
- Protected HTML and asset routes; no public local APIs or configuration endpoints.
- Sessions and accounts persist across restarts; revoked users immediately lose access
  to server requests. Already downloaded client code or exported photos cannot be recalled.
