# MCP Tracked Search

A drop-in replacement for Claude's built-in `web_search` tool that automatically tracks usage and provides multiple search backends.

## Features

- **Drop-in replacement**: Uses the same `web_search` tool name and parameters
- **Dual search engines**: Brave (primary) and DuckDuckGo (fallback/free)
- **Automatic tracking**: Counts daily and monthly usage for Brave API
- **Smart fallback**: Automatically switches to DuckDuckGo when Brave limits are reached
- **Rate limiting**: Prevents exceeding Brave API limits (166/day, 5000/month)
- **Enhanced search**: Optional `tracked_search` tool with API selection and more options
- **Usage stats**: Check current usage with `search_usage` tool

## Setup

1. Install dependencies:
```bash
npm install
```

2. Build:
```bash
npm run build
```

3. Set your Brave API key:
```bash
export BRAVE_API_KEY="your-brave-api-key"
```

4. Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "tracked-search": {
      "command": "node",
      "args": ["/Users/bard/Code/mcp-tracked-search/build/index.js"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key"
      }
    }
  }
}
```

## Usage

Once installed, the tools will be available in Claude:

### web_search (drop-in replacement)
```
<web_search>
  <query>latest AI news</query>
</web_search>
```

### tracked_search (enhanced)
```
<tracked_search>
  <query>latest AI news</query>
  <api>brave</api>  <!-- or "duckduckgo" -->
  <count>20</count>
  <freshness>24h</freshness>
</tracked_search>
```

### search_usage (check stats)
```
<search_usage />
```

## How it works

1. Intercepts search requests before they go to the search API
2. For Brave: Checks usage against daily (166) and monthly (5000) limits
3. If Brave limit reached, automatically falls back to DuckDuckGo (free, no limits)
4. Performs the search with the selected API
5. Returns results in the same format as built-in web_search
6. Stores Brave usage data in `~/.config/mcp-tracked-search/usage.json`

## API Selection Logic

- `web_search` tool: Always tries Brave first, falls back to DuckDuckGo if limits reached
- `tracked_search` tool: Can explicitly choose API with the `api` parameter
- DuckDuckGo: Free, no API key needed, no rate limits (but be respectful)

## Benefits

- Never exceed Brave API limits accidentally
- Track actual usage vs estimated 20/day
- Optimize search usage based on real data
- Automatic fallback to free DuckDuckGo when limits reached
- Choose the best search engine for each query
- Single tool for multiple search backends
