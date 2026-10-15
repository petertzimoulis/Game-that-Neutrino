# Production deployment

- The canonical live website is **https://gamethatneutrino.com** (also www.gamethatneutrino.com).
- Deploy to the existing DigitalOcean server at `68.183.115.68` using the configured SSH access (`root`). The application is `/opt/neutrino/app`, managed by `neutrino.service`, behind the existing nginx/Certbot HTTPS configuration.
- Do not publish to ChatGPT Sites or treat `.openai/hosting.json` as the production destination unless the user explicitly requests ChatGPT hosting. That file is legacy configuration.
- Preserve the domain, DNS, HTTPS configuration, persistent data, and backups. Stage and check releases before restarting the service. Keep private account databases and credentials outside deployment archives and Git.
- Consult `deploy/live.json` and `DEPLOYMENT.md` for the current deployment and persistent data locations. Report this domain when sharing the live website.
