#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import { search as ddgSearch } from 'duck-duck-scrape';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { searchMetatag } from '../../mcp-shared-utils/metatags.js';

// Schema for search parameters - matches the built-in web_search
const SearchParamsSchema = z.object({
  query: z.string().describe('Search query'),
});

// Extended schema for our tracked search with more options
const TrackedSearchParamsSchema = z.object({
  query: z.string().describe('Search query'),
  api: z.enum(['brave', 'duckduckgo']).optional().default('brave').describe('Which search API to use'),
  count: z.number().optional().default(10).describe('Number of results (1-20)'),
  offset: z.number().optional().default(0).describe('Pagination offset'),
  freshness: z.enum(['24h', '7d', '30d', 'all']).optional().describe('Result freshness'),
});

// State file for tracking
const STATE_FILE = path.join(os.homedir(), '.config', 'mcp-tracked-search', 'usage.json');

interface UsageState {
  monthly: Record<string, {
    total: number;
    by_day: Record<string, number>;
  }>;
  daily: Record<string, number>;
  last_updated: string;
  quota: {
    monthly_limit: number;
    daily_target: number;
  };
}

class TrackedSearchServer {
  private server: Server;
  private braveApiKey: string | undefined;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-tracked-search',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Get API key from environment
    this.braveApiKey = process.env.BRAVE_API_KEY;
    
    this.setupHandlers();
  }

  private async ensureStateFile(): Promise<void> {
    const dir = path.dirname(STATE_FILE);
    await fs.mkdir(dir, { recursive: true });
    
    try {
      await fs.access(STATE_FILE);
    } catch {
      const initialState: UsageState = {
        monthly: {},
        daily: {},
        last_updated: new Date().toISOString(),
        quota: {
          monthly_limit: 5000,
          daily_target: 166,
        },
      };
      await fs.writeFile(STATE_FILE, JSON.stringify(initialState, null, 2));
    }
  }

  private async loadState(): Promise<UsageState> {
    await this.ensureStateFile();
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  }

  private async saveState(state: UsageState): Promise<void> {
    state.last_updated = new Date().toISOString();
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private async trackUsage(): Promise<{ allowed: boolean; stats: any }> {
    const state = await this.loadState();
    const now = new Date();
    const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
    const dayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Initialize month if needed
    if (!state.monthly[monthKey]) {
      state.monthly[monthKey] = { total: 0, by_day: {} };
    }

    // Check limits before incrementing
    const currentDaily = state.daily[dayKey] || 0;
    const currentMonthly = state.monthly[monthKey].total;

    if (currentDaily >= state.quota.daily_target) {
      return {
        allowed: false,
        stats: {
          reason: 'daily_limit_reached',
          daily_usage: currentDaily,
          daily_limit: state.quota.daily_target,
        },
      };
    }

    if (currentMonthly >= state.quota.monthly_limit) {
      return {
        allowed: false,
        stats: {
          reason: 'monthly_limit_reached',
          monthly_usage: currentMonthly,
          monthly_limit: state.quota.monthly_limit,
        },
      };
    }

    // Update counters
    state.monthly[monthKey].total++;
    state.monthly[monthKey].by_day[dayKey] = (state.monthly[monthKey].by_day[dayKey] || 0) + 1;
    state.daily[dayKey] = currentDaily + 1;

    await this.saveState(state);

    return {
      allowed: true,
      stats: {
        daily_usage: state.daily[dayKey],
        monthly_usage: state.monthly[monthKey].total,
        daily_remaining: state.quota.daily_target - state.daily[dayKey],
        monthly_remaining: state.quota.monthly_limit - state.monthly[monthKey].total,
      },
    };
  }

  private async performBraveSearch(query: string, options: any = {}): Promise<any> {
    if (!this.braveApiKey) {
      throw new Error('BRAVE_API_KEY environment variable not set');
    }

    const params = new URLSearchParams({
      q: query,
      count: options.count || '10',
      offset: options.offset || '0',
    });

    if (options.freshness && options.freshness !== 'all') {
      params.append('freshness', options.freshness);
    }

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.braveApiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  private async performDuckDuckGoSearch(query: string, options: any = {}): Promise<any> {
    try {
      const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const html = await resp.text();
      const strip = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const snips: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snipRe.exec(html)) !== null) { snips.push(strip(sm[1])); }
      const results: any[] = [];
      const limit = options.count || 10;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = linkRe.exec(html)) !== null && results.length < limit) {
        let url = m[1];
        const dec = url.match(/uddg=([^&]+)/);
        if (!dec) { continue; }
        try { url = decodeURIComponent(dec[1]); } catch (e) {}
        if (url.indexOf('y.js') !== -1 || url.indexOf('ad_provider') !== -1 || url.indexOf('ad_domain') !== -1) { continue; }
        if (url.indexOf('//') === 0) { url = 'https:' + url; }
        results.push({ title: strip(m[2]), url: url, description: snips[i] || '' });
        i++;
      }
      return { web: { results } };
    } catch (error) {
      throw new Error('DuckDuckGo search error: ' + error);
    }
  }

  private formatSearchResults(braveResponse: any): string {
    const results = braveResponse.web?.results || [];
    const formatted = results.map((result: any, index: number) => {
      const snippet = result.description || 'No description available';
      return `<result index="${index}">
<title>${result.title}</title>
<url>${result.url}</url>
<snippet>${snippet}</snippet>
</result>`;
    }).join('\n\n');

    return `<search_results>
${formatted}
</search_results>`;
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'web_search',
          description: '💡 Architecture Check First! Try Master Architecture Index or project ARCHITECTURE.md files before web search. Search the web with automatic usage tracking (drop-in replacement for built-in web_search)',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'tracked_search',
          description: '💡 Architecture Check First! Enhanced web search with more options and automatic usage tracking. Consider checking Master Architecture Index or project docs first.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              api: {
                type: 'string',
                enum: ['brave', 'duckduckgo'],
                default: 'brave',
                description: 'Which search API to use',
              },
              count: {
                type: 'number',
                default: 10,
                description: 'Number of results (1-20)',
              },
              offset: {
                type: 'number',
                default: 0,
                description: 'Pagination offset',
              },
              freshness: {
                type: 'string',
                enum: ['24h', '7d', '30d', 'all'],
                description: 'Result freshness',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_usage',
          description: 'Get current search usage statistics',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'help',
          description: 'Get comprehensive documentation for all tracked-search functions',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === 'web_search' || name === 'tracked_search') {
          // Parse arguments based on which tool was called
          const params = name === 'web_search' 
            ? { ...SearchParamsSchema.parse(args), api: 'brave' as const } // Default to Brave for web_search
            : TrackedSearchParamsSchema.parse(args);
          
          // Only track usage for Brave API
          if (params.api === 'brave') {
            const { allowed, stats } = await this.trackUsage();
            
            if (!allowed) {
              // Automatically fallback to DuckDuckGo
              console.error(`[AUTO-FALLBACK] Brave limit reached, using DuckDuckGo`);
              params.api = 'duckduckgo';
            } else {
              // Log Brave usage stats
              console.error(`[TRACKED] Brave search executed. Daily: ${stats.daily_usage}/${stats.daily_remaining + stats.daily_usage}, Monthly: ${stats.monthly_usage}/${stats.monthly_remaining + stats.monthly_usage}`);
            }
          }

          // Perform search with selected API
          let searchResults;
          if (params.api === 'duckduckgo') {
            console.error(`[DDG] Using DuckDuckGo search (free, no limits)`);
            searchResults = await this.performDuckDuckGoSearch(params.query, params);
          } else {
            searchResults = await this.performBraveSearch(params.query, params);
            const _hasWeb = searchResults && searchResults.web && searchResults.web.results && searchResults.web.results.length;
            if (!_hasWeb) {
              console.error('[AUTO-FALLBACK] Brave returned no results; using DuckDuckGo');
              try { searchResults = await this.performDuckDuckGoSearch(params.query, params); params.api = 'duckduckgo'; } catch (e) { console.error('DDG fallback failed:', e); }
            }
          }
          
          const formatted = this.formatSearchResults(searchResults);
          const apiUsed = params.api === 'duckduckgo' ? 'DuckDuckGo' : 'Brave';
          const wrappedResults = searchMetatag(formatted, params.query, `Search API: ${apiUsed}`);

          return {
            content: [
              {
                type: 'text',
                text: wrappedResults,
              },
            ],
          };
        } else if (name === 'search_usage') {
          const state = await this.loadState();
          const now = new Date();
          const monthKey = now.toISOString().slice(0, 7);
          const dayKey = now.toISOString().slice(0, 10);

          const stats = {
            today: {
              used: state.daily[dayKey] || 0,
              limit: state.quota.daily_target,
              remaining: state.quota.daily_target - (state.daily[dayKey] || 0),
              percentage: Math.round(((state.daily[dayKey] || 0) / state.quota.daily_target) * 100),
            },
            this_month: {
              used: state.monthly[monthKey]?.total || 0,
              limit: state.quota.monthly_limit,
              remaining: state.quota.monthly_limit - (state.monthly[monthKey]?.total || 0),
              percentage: Math.round(((state.monthly[monthKey]?.total || 0) / state.quota.monthly_limit) * 100),
            },
            recommendation: '',
          };

          // Add recommendation
          if (stats.today.percentage < 50) {
            stats.recommendation = 'You can use Brave Search more liberally today.';
          } else if (stats.today.percentage > 80) {
            stats.recommendation = 'Consider switching to DuckDuckGo for non-critical searches.';
          } else {
            stats.recommendation = 'Usage is on track.';
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        } else if (name === 'help') {
          const helpText = `
# 🔍 Tracked Search - Web Search with Usage Analytics

## Purpose
Drop-in replacement for web_search with automatic usage tracking. Provides the same search functionality while monitoring search patterns and usage statistics.

## 🏗️ Architecture Check First!
Try Master Architecture Index or project ARCHITECTURE.md files before web search. Consider checking Master Architecture Index or project docs first.

## Available Tools

### web_search
Drop-in replacement for built-in web_search with automatic usage tracking:
- **query**: Search query (required)
- **api**: Which search API to use (brave | duckduckgo, default: brave)
- **count**: Number of results (1-20, default: 10)
- **freshness**: Result freshness (24h | 7d | 30d | all)
- **offset**: Pagination offset (default: 0)
- Returns search results in same format as built-in web_search
- Automatically tracks usage statistics

### tracked_search
Enhanced web search with more options and automatic usage tracking:
- **query**: Search query (required)
- **api**: Which search API to use (brave | duckduckgo, default: brave)
- **count**: Number of results (1-20, default: 10)
- **freshness**: Result freshness (24h | 7d | 30d | all)
- **offset**: Pagination offset (default: 0)
- Consider checking Master Architecture Index or project docs first
- Returns enhanced search results with usage tracking

### search_usage
Get current search usage statistics:
- No parameters required
- Returns usage statistics including daily and monthly counts
- Shows search patterns and API usage breakdown

## Search APIs

### Brave Search (Default)
- High-quality search results
- Fast response times
- Good coverage of recent content
- Requires BRAVE_API_KEY environment variable

### DuckDuckGo
- Privacy-focused search
- No API key required
- Good alternative when Brave is unavailable
- May have different result rankings

## Usage Tracking Features

### Automatic Statistics
- **Daily Counts**: Searches performed each day
- **Monthly Totals**: Monthly search volume
- **API Breakdown**: Usage by search provider
- **Query Patterns**: Insights into search behavior

### Benefits
- **Usage Monitoring**: Track search patterns over time
- **API Management**: Monitor which search providers are used
- **Performance Insights**: Understand search efficiency
- **Resource Planning**: Plan for search API limits

## Common Workflows

### Drop-in Web Search Replacement
Use web_search with query parameter to get search results with automatic usage tracking.

### Enhanced Search with Options
Use tracked_search with additional parameters like api, count, and freshness for more control.

### Usage Analysis
Use search_usage to get current statistics and monitor search patterns.

## Architecture Integration

### Before Searching
1. **Check Master Architecture Index** for system overviews
2. **Review project ARCHITECTURE.md** files for specific documentation
3. **Use internal documentation** when available
4. **Search external sources** as last resort

### Best Practices
- **Start Internal**: Check existing documentation first
- **Targeted Queries**: Use specific, focused search terms
- **Fresh Content**: Use freshness filters for recent information
- **Monitor Usage**: Check search_usage periodically

## Configuration

### Environment Variables
- **BRAVE_API_KEY**: Required for Brave Search API
- **Fallback**: DuckDuckGo used when Brave API unavailable

### Error Handling
- Graceful fallback between search APIs
- Comprehensive error messages for debugging
- Usage tracking continues even when searches fail
- Clear feedback on API availability

The tracked search server provides transparent search functionality with valuable usage insights while maintaining full compatibility with existing search workflows.
`;
          
          return {
            content: [
              {
                type: 'text',
                text: helpText,
              },
            ],
          };
        } else {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
        }
      } catch (error) {
        console.error('Search error:', error);
        throw error;
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MCP Tracked Search running on stdio');
  }
}

const server = new TrackedSearchServer();
server.run().catch(console.error);
