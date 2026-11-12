# Security reporting and safe use

LeadDesk is a local reference application, not a production-hardened hosted service. No response-time or security guarantee is provided.

Passing tests and secret scans do not constitute an exhaustive vulnerability audit. Dependency updates are not automatic; review current upstream advisories and provider terms before use beyond an isolated local environment.

Do not post API keys, database URLs/passwords, OAuth files, visitor/admin cookies, customer records, raw provider responses or exploitable private details in public issues or pull requests.

If GitHub's **Security → Report a vulnerability** option is available on this repository, use that private channel. Otherwise contact the maintainer through their GitHub profile to arrange a private channel, or open an issue asking for a private contact without disclosing the vulnerability itself. Do not assume a public issue is private.

When reporting ordinary bugs, use synthetic examples, explain expected/actual behavior and include relevant software versions. Redact logs and screenshots before sharing.

For local use:

- Supply your own separately authorized test accounts and keep `.env.local` / `.local/` out of Git.
- Keep backend credentials server-side. Never embed subscription/OAuth tokens in browser code.
- Preserve certificate verification, ownership/admin checks, explicit consent and unknown-outcome recovery.
- Do not treat model prose or a UI fixture as evidence of a real CRM/calendar write.
- Audit provider terms, authentication, retention, abuse controls, billing limits and load before considering a public deployment.

The original internal history, operational receipts and private runtime state are intentionally not published in this clean source snapshot.
