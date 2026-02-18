FROM denoland/deno:2.6.4

WORKDIR /app

# Cache dependencies first
COPY deno.json deno.lock ./
RUN deno install

# Copy source (.dockerignore excludes data.db, .env, .git)
COPY . .

# Cache/compile all modules
RUN deno cache main.ts

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", "main.ts"]
