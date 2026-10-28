# Configuration

One file, one data directory, and a short list of environment overrides.

Outpost reads one file: **`outpost.config.json`** in the directory you start it from, or the path in `OUTPOST_CONFIG`. It doesn't read any other tool's config. Without the file, defaults apply. Start from the example:

```bash
cp outpost.config.example.json outpost.config.json
```

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "dataDir": "./data",                       // relative to the config file
  "models": {
    "default": "anthropic/claude-sonnet-4-5",  // for new chats; workspaces can override
    "providers": {                             // keyed by pi provider id
      "anthropic": { "apiKey": "$ANTHROPIC_API_KEY" },        // "$VAR" reads the env; literals work too
      "azure": { "apiKey": "$AZURE_OPENAI_API_KEY", "env": { "AZURE_OPENAI_BASE_URL": "https://…" } },
      "groq": { "enabled": false }                          // hide a provider
    },
    "ambientEnv": true,                        // also accept providers' standard env vars
    "demo": true                               // offer the offline demo model
  },
  "airlocks": { "github": { "token": "$GITHUB_TOKEN" } }
}
```

## Models and keys

Outpost can use every provider pi-ai supports: Anthropic, OpenAI, Google, Azure, Bedrock, OpenRouter, Groq, Mistral, DeepSeek, xAI, and more. Each provider's key comes from the first of these that is set:

1. **`models.providers.<id>.apiKey`** in the config file. Keys set here are read-only in the UI.
2. **Settings → Model providers → Add key.** These are stored in `<dataDir>/credentials.enc.json`, encrypted with AES-256-GCM using the instance secret (`<dataDir>/secret.key`, or `OUTPOST_SECRET`).
3. The provider's **standard env var** (`ANTHROPIC_API_KEY`, …). Set `models.ambientEnv: false` to turn this off.

**GitHub Copilot** uses a subscription sign-in instead of a key. Go to **Settings → Model providers → Sign in with GitHub**, copy the code, and approve it at github.com/login/device. Leave the domain prompt blank for github.com, or enter your GitHub Enterprise domain. The flow runs on the server (device code, so the browser doesn't need to be on the same machine). The token is stored in the encrypted credential store and refreshed automatically. The model picker shows only the models your Copilot plan allows. Other subscription logins aren't offered; those providers take API keys.

Unknown provider IDs and `$VAR`s that aren't set produce warnings at startup.

New chats use `models.default`, unless the workspace sets its own, falling back to the first available model. You can change the model per chat. With no keys at all, an offline **Demo** model follows a few scripts ("make a todo list", "make slides", …).

## Environment overrides

| Variable | Overrides |
|---|---|
| `OUTPOST_CONFIG` | config file path |
| `PORT`, `HOST` | `server.port`, `server.host` |
| `OUTPOST_DATA` | `dataDir`, which holds the system DB, one `workspaces/<id>.sqlite` per workspace, the secret, and stored credentials |
| `OUTPOST_SECRET` | the generated `secret.key` (32 bytes, as hex or base64) |
| `OUTPOST_PREVIEW_BIND`, `OUTPOST_PREVIEW_PORTS` | `preview.bind`, `preview.ports` — where browsers reach live previews (`0.0.0.0`, `"3100-3199"` in a container) |
