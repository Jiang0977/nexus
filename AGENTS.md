# AGENTS.md

## Deployment Constraints

- Deployments require a service restart: restart the **nexus** service after deploying code changes.
- After restart, verify the service is accessible. If the service becomes unreachable after deployment, **rollback** the deployed code to the previous version immediately.
