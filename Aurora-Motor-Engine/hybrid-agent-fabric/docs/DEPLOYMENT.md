# Aurora Motor Engine — Deployment Guide

> Production deployment rehberi.

---

## Docker ile Deployment

### Dockerfile

```dockerfile
# Multi-stage build
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-api/package.json ./apps/control-api/
COPY apps/canvas-web/package.json ./apps/canvas-web/
COPY packages/engine/package.json ./packages/engine/
RUN pnpm install --frozen-lockfile --prod

# Build
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Production
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/control-api/dist ./apps/control-api/dist
COPY --from=build /app/apps/canvas-web/dist ./apps/canvas-web/dist
COPY --from=build /app/packages/engine/dist ./packages/engine/dist

ENV NODE_ENV=production
ENV HAF_HOME=/data
VOLUME /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "apps/control-api/dist/main.js"]
```

### Docker Compose (Production)

```yaml
version: '3.8'

services:
  aurora:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - HAF_HOME=/data
      - HAF_MODEL_PROVIDER=openai-compatible
      - HAF_MODEL_BASE_URL=${HAF_MODEL_BASE_URL}
      - HAF_MODEL_API_KEY=${HAF_MODEL_API_KEY}
      - HAF_MODEL_NAME=${HAF_MODEL_NAME}
      - HAF_API_TOKEN=${HAF_API_TOKEN}
      - HAF_SESSION_SECRET=${HAF_SESSION_SECRET}
      - HAF_CORS_ORIGIN=${HAF_CORS_ORIGIN}
    volumes:
      - aurora-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s

  # Optional: PostgreSQL
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: aurora
      POSTGRES_USER: aurora
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aurora"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Optional: Redis (for rate limiting)
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  aurora-data:
  postgres-data:
```

### Build ve Başlatma

```bash
# Build
docker compose build

# Başlat
docker compose up -d

# Logları izle
docker compose logs -f aurora

# Sağlık kontrolü
curl http://localhost:3000/health
```

---

## Kubernetes ile Deployment

### ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aurora-config
data:
  NODE_ENV: "production"
  HAF_HOME: "/data"
  HAF_MODEL_PROVIDER: "openai-compatible"
  HAF_MODEL_NAME: "gpt-4.1-mini"
  HAF_CORS_ORIGIN: "https://your-domain.com"
```

### Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aurora-secrets
type: Opaque
stringData:
  HAF_MODEL_API_KEY: "your-api-key"
  HAF_API_TOKEN: "your-api-token"
  HAF_SESSION_SECRET: "your-session-secret"
```

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aurora
  labels:
    app: aurora
spec:
  replicas: 2
  selector:
    matchLabels:
      app: aurora
  template:
    metadata:
      labels:
        app: aurora
    spec:
      containers:
        - name: aurora
          image: aurora:latest
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: aurora-config
            - secretRef:
                name: aurora-secrets
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: aurora-data
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: aurora
spec:
  selector:
    app: aurora
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
```

### Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: aurora
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - aurora.your-domain.com
      secretName: aurora-tls
  rules:
    - host: aurora.your-domain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: aurora
                port:
                  number: 80
```

### HPA (Horizontal Pod Autoscaler)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: aurora
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: aurora
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### PDB (Pod Disruption Budget)

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: aurora
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: aurora
```

---

## Bare Metal Deployment

### Systemd Service

```ini
[Unit]
Description=Aurora Motor Engine
After=network.target

[Service]
Type=simple
User=aurora
Group=aurora
WorkingDirectory=/opt/aurora
ExecStart=/usr/bin/node apps/control-api/dist/main.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=HAF_HOME=/var/lib/aurora
EnvironmentFile=/etc/aurora/env

[Install]
WantedBy=multi-user.target
```

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name aurora.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/aurora.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aurora.your-domain.com/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=aurora:10m rate=10r/s;

    location / {
        limit_req zone=aurora burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Monitoring

### Prometheus

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'aurora'
    scrape_interval: 15s
    static_configs:
      - targets: ['aurora:3000']
    metrics_path: '/metrics'
```

### Grafana Dashboard

Dashboard JSON: `docs/grafana-dashboard.json`

---

## Backup

### File-based Persistence

```bash
#!/bin/bash
# backup.sh
BACKUP_DIR="/backups/aurora/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/aurora-data.tar.gz" /var/lib/aurora/
echo "Backup completed: $BACKUP_DIR"
```

### PostgreSQL

```bash
#!/bin/bash
# pg-backup.sh
pg_dump -U aurora -d aurora | gzip > "/backups/aurora/pg_$(date +%Y%m%d_%H%M%S).sql.gz"
```

---

## Troubleshooting

### Yaygı sorunlar

1. **Port conflict**: `lsof -i :3000` ile kontrol edin
2. **Permission denied**: `chown -R aurora:aurora /var/lib/aurora`
3. **Memory limit**: Node.js heap size ayarlayın: `--max-old-space-size=4096`
4. **Database connection**: PostgreSQL bağlantı bilgilerini kontrol edin

### Loglar

```bash
# Docker
docker compose logs -f aurora

# Systemd
journalctl -u aurora -f

# Nginx
tail -f /var/log/nginx/aurora-error.log
```

### Health Check

```bash
curl -s http://localhost:3000/health | jq .
```

```json
{
  "status": "ok",
  "engine": "hybrid-agent-fabric",
  "version": "1.65.0",
  "provider": [...],
  "sandbox": "local",
  "persistence": "file",
  "nats": false
}
```
