# Lightweight JDK 21 Alpine image for fast startup and low memory footprint
FROM eclipse-temurin:21-jdk-alpine

WORKDIR /app

# Install Python 3 to run the judge service server
RUN apk add --no-cache python3

# Copy judge microservice
COPY server.py .

# Cloud Run injects PORT environment variable (default: 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["python3", "server.py"]
