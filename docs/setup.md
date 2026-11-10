# Setup notes

Everything here is done for the live site. The steps are recorded so the setup can be repeated.

## GitHub

1. Public repository `statgenpapers/statgenpapers.github.io`.
2. **Settings → Pages → Source:** GitHub Actions.
3. Actions secret `OPENALEX_API_KEY` (below). The workflow asks for its own write permission, so
   the repository default can stay read-only.

## OpenAlex key

| Name | Used for | Where it is stored |
|---|---|---|
| `OPENALEX_API_KEY` | OpenAlex API (journal paper metadata) | GitHub Actions repository secret, encrypted (set 2026-11-10) |

1. The workflow passes it as `env: OPENALEX_API_KEY: ${{ secrets.OPENALEX_API_KEY }}`.
   GitHub masks the value in logs, and the pipeline removes it from error messages.
2. Secrets are not passed to workflows triggered by pull requests from forks, so
   outside contributors cannot read the key.
3. Never commit the key. For local runs, put it in `OPENALEX_API_KEY` or in
   `~/.config/openalex/api_key` (`chmod 600`).
4. To rotate it, create a new key in the OpenAlex account, then run
   `gh secret set OPENALEX_API_KEY -R statgenpapers/statgenpapers.github.io`.
   Paste the key at the prompt, or pipe it from a file.
5. Budget: a keyed account has a free daily budget. A monthly fetch costs about $0.001. The
   pipeline prints its spend and stops at `OPENALEX_MAX_USD` (default 0.5).

## Firebase

Project `statgenpapers`, Spark plan (free, no card).

1. Create the project in the [Firebase console](https://console.firebase.google.com) and add a
   web app. Copy its configuration into `site/config.js`. These values are public by design.
2. **Authentication → Sign-in method:** enable Anonymous. Leave automatic clean-up off, or
   visitors lose their votes' ownership after 30 days.
3. **Authentication → Settings → Authorized domains:** add `statgenpapers.github.io`.
4. **Firestore Database:** create it in production mode.
5. **Firestore Database → Rules:** paste the content of `firebase/firestore.rules` and publish.
   Repeat this after every change to that file, then run `node firebase/live-check.mjs`.
6. Set `firestore_project` in `config/sources.toml` to the project id.

Data layout:

| Path | Content | Who may write |
|---|---|---|
| `months/YYYY-MM/papers/{paper id}` | `votes`: one entry per browser | Each browser, its own entry |
| `months/YYYY-MM/submissions/{id}` | A paper a visitor added: journal, title, URL, short name | The browser that added it (create and delete) |

Notes:

1. To remove an unwanted added paper, delete its document in the console.
2. The rules still accept a vote of −1. The site only writes upvotes, and the site and the
   pipeline count only votes of +1.
3. `months/2020-01` holds leftovers of the automated checks. The site never lists that month.
