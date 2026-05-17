# AGENTS.md

## Deployment Constraints

- Deployments require a service restart: restart the **nexus** service after deploying code changes.
- After restart, verify the service is accessible. If the service becomes unreachable after deployment, **rollback** the deployed code to the previous version immediately.

## Local Auth Smoke Testing

- Do not ask the user to paste the login password for routine browser smoke tests.
- Preferred test entrypoint: `npm run smoke:login-upload`.
- The script reads `.context/secrets/e2e.env` by default. This directory is git-ignored.
- Required local secret format: `NEXUS_E2E_PASSWORD=<current Nexus login password>`.
- Optional overrides: `NEXUS_E2E_BASE_URL`, `NEXUS_E2E_SESSION`, `NEXUS_E2E_WINDOW`, `NEXUS_E2E_SECRET_FILE`.
- The smoke test logs in through the real login page, uploads a temporary 1px image, verifies the returned path is sent through the terminal WebSocket, and cleans up its temporary upload file.
