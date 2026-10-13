# PandaAI Sovereign Backend Deployment Guide

This folder contains the **Sovereign Lite Architecture** blueprint for deploying the PostgreSQL backend on your Aliyun server (2C/4G).

## 📂 Structure
- `docker-compose.yml`: One-click deployment script for the database.
- `prisma/schema.prisma`: The master database definition, perfectly synced with frontend types.
- `.env.example`: Configuration template.

## 🚀 Deployment Instructions (On Aliyun)

### 1. Prerequisites (On Server)
Ensure **Docker** and **Docker Compose** are installed.

```bash
# Install Docker (Ubuntu example)
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
```

### 2. Setup
Upload this `server` folder to your server (e.g., `/opt/panda-server`).

```bash
cd /opt/panda-server
cp .env.example .env
# EDIT THE PASSWORD IN .env!
nano .env
```

### 3. Ignite the Database
Start the specialized PostgreSQL container.

```bash
docker compose up -d
```

### 4. Initialize Schema (From your Development Machine)
You can apply the schema from your local machine if you have SSH tunneling or port forwarded, OR run this on the server if Node is installed.

```bash
# Install dependencies
npm install -g dotenv-cli prisma

# Push the schema to the live DB
npx prisma db push
```

## 🛡️ Maintenance
- **Backup**: The data is mapped to `./pg_data`. Simply back up this folder.
- **Logs**: `docker compose logs -f`
