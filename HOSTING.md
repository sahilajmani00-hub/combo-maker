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

## Deploy on your Hostinger VPS

The selected host is the existing **Hostinger VPS**. No new hosting subscription is
needed. Deployment is waiting for the VPS SSH connection details and the dashboard's
domain or subdomain. Do not replace an existing site or reinstall the VPS operating system.

The Dockerfile and `compose.hostinger.yaml` run the invite-only server with a persistent
account volume. Hostinger supports Docker on VPS; see its
[Docker Manager guide](https://www.hostinger.com/support/12040815-how-to-deploy-your-first-container-with-hostinger-docker-manager/).

### Server setup

1. Connect to the VPS through SSH and inspect its existing Docker services, web server,
   available ports, disk space, and domain configuration.
2. Use an isolated checkout of this repository, branch `add-github-pages-docs`.
3. Set `APP_URL` to the exact HTTPS origin users will visit. For example:

   ```sh
   export APP_URL=https://combos.example.com
   docker compose -f compose.hostinger.yaml up -d --build
   ```

4. Configure that domain's HTTPS reverse proxy to `http://127.0.0.1:4174`, using the
   server's existing hosting panel or web server. The domain's DNS must point to the
   VPS. Configure TLS before opening the login page.
5. Create your invitation in the app container:

   ```sh
   docker compose -f compose.hostinger.yaml exec app node tools/invite.mjs person@example.com
   ```

Replace the example origin and email. Keep `APP_URL` exported for subsequent Compose
commands, including `exec`; on a new SSH session, export it again. Docker retains it
inside the created container for restarts. Use the same origin for invitations and login.

The application listens on port 10000 inside Docker and is exposed **only on
127.0.0.1:4174** on the VPS. The existing HTTPS proxy handles public traffic. If that
local port is occupied, choose an unused port in the Compose mapping and proxy together.
The `/healthz` endpoint is available for health checks.

### Account storage and updates

The Compose project name is fixed as `combo-maker-private`; changing the checkout
folder will not silently select another account volume. SQLite lives in
`/data/accounts.sqlite` in the `combo_accounts` named volume. Keep that volume across
updates. **Do not use `docker compose down -v`**, which deletes stored accounts.
This deployment uses one app instance. Back up SQLite before moving its volume.

To deploy an update from the same checkout after reviewing the incoming changes:

```sh
git pull --ff-only origin add-github-pages-docs
docker compose -f compose.hostinger.yaml up -d --build
```

### Verify before sharing

Check that `/` and a real `/assets/...js` URL redirect to `/login` without a session.
Activate a test invitation, sign in, create and download a combo, sign out, and verify
access is rejected. Restart and redeploy once to confirm accounts persist. Revoke the
test user and verify their session no longer works. Desktop and mobile browser checks
remain part of the live deployment verification.

## Alternative: Render

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

Run in the **deployed server's shell** with the same `APP_URL` and `DATA_DIR` as the app,
so it uses the deployed account database (for Docker, use the container command above):

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
