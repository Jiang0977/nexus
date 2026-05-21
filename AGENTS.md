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

## Preferred Verification Entry Points

- Repository-wide verification entrypoint: `npm run check`.
- If the change only touches frontend source, use `npm run build:frontend` at minimum because production serves `frontend/dist/`, not `frontend/src/`.
- If the change only touches frontend types, `npm run typecheck:frontend` is the narrowest typed check.
- If the change only touches Rust runtime code, use `npm run test:rust`.
- If the change only touches Node/server scripts or tests, use `npm run test:node`.

## Deployment Notes

- Preferred deployment entrypoint: `npm run deploy:service`.
- If frontend source changed, deploy with `npm run deploy:service -- --frontend`.
- If native supervisor binaries must be refreshed and interrupting native sessions is acceptable, deploy with `npm run deploy:service -- --restart-native-pty`.
- `nexus.service` restart does not refresh already-running tmux/Codex channels under `nexus-tmux.service`; when verifying deployment-sensitive Codex behavior, verify with a newly created channel or explicitly account for existing runtime state.
