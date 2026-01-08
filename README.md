## Gemini CodeAssist Proxy

This local server provides OpenAI (`/openai`) and Anthropic (`/anthropic`) compatible endpoints through Gemini CodeAssist (Gemini CLI).

- If you have used Gemini CLI before, it will utilize existing Gemini CLI credentials.
- If you have NOT used Gemini CLI before, you will be prompted to log in to Gemini CLI App through browser.

### But why?

Gemini CodeAssist (Gemini CLI) offers a generous free tier. As of [2025-09-01](https://codeassist.google/), the free tier offers 60 requests/min and
1,000 requests/day.

Gemini CodeAssist does not provide direct access to Gemini models which limits your choice to ~~[highly rated CodeAssist plugins](https://plugins.jetbrains.com/plugin/24198-gemini-code-assist)~~

## Quick Start

`npx gemini-cli-proxy`

The server will start on `http://localhost:3000`

- OpenAI compatible endpoint: `http://localhost:3000/openai`
- Anthropic compatible endpoint: `http://localhost:3000/anthropic`

### Usage

```bash
npx gemini-cli-proxy [options]
```

Options:

- `-p, --port <port>` - Server port (default: 3000)
- `-g, --google-cloud-project <project>` - Google Cloud project ID if you have paid/enterprise tier (default: GOOGLE_CLOUD_PROJECT env variable)
- `--disable-browser-auth` - Disables browser auth flow and uses code based auth (default: false)
- `--disable-google-search` - Disables native Google Search tool (default: false)
- `--disable-auto-model-switch` - Disables auto model switching in case of rate limiting (default: false)
- `--oauth-rotation-paths <paths>` - Comma-separated paths to OAuth credential files for automatic rotation on rate limits (default: disabled)

If you have NOT used Gemini CLI before, you will be prompted to log in to Gemini CLI App through browser. Credentials will be saved in the folder (`~/.gemini/oauth_creds.json`) used by Gemini CLI.

### Supported Models

The following Gemini models are supported:

- `auto` - Enables automatic model switching (starts with gemini-3-pro-preview, downgrades on rate limits)
- `gemini-2.5-pro` - Previous generation Pro model
- `gemini-2.5-flash` - Faster, lighter model
- `gemini-3-pro-preview` - Latest Gemini 3 Pro model (preview)
- `gemini-3-flash-preview` - Latest Gemini 3 Flash model (preview)

`gemini-2.5-pro` is the default model when you request a model other than the supported models listed above.

### Intelligent Model Passthrough

When you specify a specific model in your API request (e.g., `gemini-3-pro-preview`), the proxy will use that exact model without applying automatic downgrade/fallback logic.

Auto-switching (Pro → Flash) only occurs when:

- The requested model is `"auto"`, `null`, or missing from the request
- The model hits rate limits and a fallback is available

This ensures that when you explicitly request a model, you get that model.

**Example:**

```bash
# Request auto-switching (recommended for most use cases)
curl http://localhost:3000/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello!"}]}'

# Request specific model (bypasses auto-switching)
curl http://localhost:3000/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-3-flash-preview", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### Use with -insert-your-favorite-agentic-tool-here-

Most agentic tools rely on environment variables, you can export the following variables

```
export OPENAI_API_BASE=http://localhost:3000/openai
export OPENAI_API_KEY=ItDoesNotMatter
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"
export ANTHROPIC_AUTH_TOKEN=ItDoesNotMatter
```

### Use with Claude Code

Add the following env fields to `.claude/settings.json` file

```json
{
  "permissions": {
    ...
  },
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "NotImportant",
    "ANTHROPIC_MODEL": "gemini-2.5-pro"
  }
}
```

### Use with Zed

Add the following to the Zed config file

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:3000/openai",
      "available_models": [
        {
          "name": "gemini-2.5",
          "display_name": "localhost:gemini-2.5",
          "max_tokens": 131072
        }
      ]
    }
  }
}
```

## OAuth Token Rotation

To enable automatic OAuth token rotation when rate limits (HTTP 429) are encountered:

1. Create multiple OAuth credential files by authenticating with different Google accounts
2. Save each credential file (e.g., `~/.gemini/oauth_creds.json`) to different locations
3. Start the server with the `--oauth-rotation-paths` option:

```bash
gemini-cli-proxy --oauth-rotation-paths "/path/to/acc1.json,/path/to/acc2.json,/path/to/acc3.json"
```

When a 429 error is detected:

1. The proxy automatically rotates to the next account in the list (round-robin)
2. The new credentials are copied to `~/.gemini/oauth_creds.json`
3. The failed request is automatically retried once with the new account
4. A log message indicates which account is now active: `[ROTATOR] Rate limit hit. Switched to account: <filename>`

**Note:** OAuth rotation requires at least 2 credential paths to be effective.

## Development

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run lint` - Run ESLint

### Project Structure

```
src/
├── auth/           # Google authentication logic
├── gemini/         # Gemini API client and mapping
├── routes/         # Express route handlers
├── types/          # TypeScript type definitions
└── utils/          # Utility functions
```
