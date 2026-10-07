# CodeArena Java Judge Service (Cloud Run)

A dedicated, isolated Java 21 compilation and sandbox execution microservice designed to run on **Google Cloud Run (Free Tier)**.

## How to Deploy to Google Cloud Run (1 Command)

Open Google Cloud Shell (or terminal with `gcloud` CLI installed):

```bash
cd judge-service
gcloud run deploy codearena-java-judge \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --concurrency 4
```

### Result
Google Cloud Run will output your service URL:
```
Service URL: https://codearena-java-judge-xxxx-uc.a.run.app
```

Copy this URL and set it in your CodeArena VM `.env` or environment:
```bash
JAVA_JUDGE_URL="https://codearena-java-judge-xxxx-uc.a.run.app"
```
All Java submissions will now be securely compiled and judged on Cloud Run with 2 GB RAM, keeping your free VM completely free of memory load!
