# Setup notes

## Secrets

| Name | Used for | Where it is stored |
|---|---|---|
| `OPENALEX_API_KEY` | OpenAlex API (journal paper metadata) | GitHub Actions repository secret, encrypted (set 2026-11-10) |

1. Use it in a workflow as `env: OPENALEX_API_KEY: ${{ secrets.OPENALEX_API_KEY }}`.
   GitHub masks the value in logs; still, never print it.
2. Secrets are not passed to workflows triggered by pull requests from forks, so
   outside contributors cannot read the key.
3. Never commit the key. For local runs, put it in `OPENALEX_API_KEY` or in a
   `chmod 600` file outside the repository.
4. To rotate it, create a new key in the OpenAlex account, then run
   `gh secret set OPENALEX_API_KEY -R statgenpapers/statgenpapers.github.io`.
   Paste the key at the prompt, or pipe it from a file.
5. Budget: a keyed account has a free daily budget. A monthly fetch of the
   configured journals costs about $0.001. Keep a hard spend cap in the fetcher.
