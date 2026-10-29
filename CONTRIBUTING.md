# Contributing to AI Copilot

Thank you for your interest in contributing to **AI Copilot**! We welcome bug reports, feature requests, documentation improvements, and code contributions.

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free environment for everyone. Please be respectful, constructive, and kind in all interactions across issues, pull requests, and discussions.

---

## Ways to Contribute

- **Report a Bug**: Open an issue describing what happened, steps to reproduce, and your environment.
- **Suggest an Enhancement**: Open an issue detailing the use case, why it’s useful, and any API examples.
- **Submit a Pull Request**: Fix a bug, add a feature, or improve docs / tests.

---

## Development Setup

### Prerequisites

- **Node.js**: 22 or newer (`node --version`)
- **npm**: 10 or newer
- **Docker & Docker Compose**: for running Redis (and optionally Keycloak)

### Clone & Install

```bash
git clone https://github.com/the-dave-ops/ai-copilot.git
cd ai-copilot

# Install root, server, and web dependencies
npm install
npm run install:all
```

### Run Locally

1. **Start Redis**:
   ```bash
   docker compose up -d redis
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with:
   # - API_BASE_URL (defaults to https://fakerestapi.azurewebsites.net for instant testing)
   # - LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (e.g. OpenAI, OpenRouter, Ollama)
   # - SESSION_SECRET=$(openssl rand -hex 32)
   ```

3. **Build & Start**:
   ```bash
   npm run build
   npm start
   ```

   For active development with hot-reload:
   ```bash
   npm run dev       # in terminal 1 (NestJS server with nodemon)
   npm run dev:web   # in terminal 2 (Vite dev server)
   ```

4. **Run with Docker Compose (Full Stack)**:
   ```bash
   docker compose up --build
   ```

---

## Testing

Always verify that tests pass before opening a PR:

```bash
npm test            # runs unit & e2e test suites
npm run build       # verifies frontend and backend compile cleanly
```

---

## Pull Request Guidelines

1. **Branch Naming**: Use descriptive names like `fix/ssrf-token-url`, `feat/anthropic-tools`, `docs/helm-guide`.
2. **Commit Messages**: Follow standard conventional commits when possible (`feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`).
3. **Keep PRs Focused**: One bug or feature per PR. Large architectural changes should be discussed in an issue first.
4. **Security-First**: Never log, transmit, or expose session secrets, bearer tokens, or user credentials to the client or the LLM.

---

## Security Vulnerabilities

If you discover a security vulnerability, please **do not** open a public issue. See [SECURITY.md](./SECURITY.md) for instructions on confidential reporting.

---

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
