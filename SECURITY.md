# Security Policy

## Supported Versions

We actively support and release security fixes for the latest version on the `main` branch.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

---

## Reporting a Vulnerability

The security of **AI Copilot** is a top priority. Because this service acts as an authenticated proxy between end users, LLMs, and enterprise APIs, we take credentials handling, authorization enforcement, and network isolation seriously.

If you believe you have found a security vulnerability:

1. **Do NOT open a public GitHub issue.**
2. Report the vulnerability privately via **GitHub Private Vulnerability Reporting** on the repository:
   - Navigate to the repository's **Security** tab.
   - Click **Report a vulnerability**.
3. Alternatively, contact the maintainers directly at:
   - **Email**: `security@the-dave-ops.com` (or through the GitHub organization profile).

### What to Include in Your Report

To help us triage and resolve the issue quickly, please provide:
- A clear description of the vulnerability.
- Steps to reproduce, proof-of-concept code, or HTTP request examples.
- Potential impact (e.g. credential leakage, SSRF, authorization bypass, CSRF).
- Any proposed remediation, if you have one.

---

## What to Expect

- **Acknowledgment**: Within 48 hours of receipt.
- **Triage & Assessment**: Within 5 business days, including a CVSS severity estimate.
- **Fix & Disclosure**: We will collaborate on a coordinated disclosure timeline, typically 30–90 days, allowing users to update before public details are released.

---

## Core Security Invariants

When auditing or contributing to AI Copilot, please respect these non-negotiable security invariants:

1. **Zero Credential Leakage**: Tokens, API keys, basic auth passwords, and OAuth credentials must **never** be sent to the LLM, exposed in browser-visible payloads, written to audit logs, or serialized into model messages.
2. **Cryptographically Signed Human-in-the-Loop**: Every mutating HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) requires explicit user confirmation. Approvals are HMAC-signed with `SESSION_SECRET` and strictly bound to the authenticated user session.
3. **SSRF Guarding**: Direct API login paths are origin-bound to `API_BASE_URL`. OAuth2 token URLs reject private, link-local, and loopback IP ranges unless explicitly allowed by administrators.
4. **Tenant & Session Isolation**: Conversation history, threads, and audit logs stored in Redis are cryptographically partitioned per authenticated credential hash.

See [docs/security.md](./docs/security.md) for the complete security architecture.
