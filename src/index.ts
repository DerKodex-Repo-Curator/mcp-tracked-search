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
      const searchResults = await ddgSearch(query, {
        safeSearch: 0, // 0 = moderate, 1 = strict, -1 = off
      });
      
      // Take only the requested number of results
      const limitedResults = searchResults.results.slice(0, options.count || 10);
      
      // Convert DuckDuckGo format to match Brave format for consistency
      return {
        web: {
          results: limitedResults.map((result: any) => ({
            title: result.title,
            url: result.url,
            description: result.description,
          }))
        }
      };
    } catch (error) {
      throw new Error(`DuckDuckGo search error: ${error}`);
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
          description: 'Search the web with automatic usage tracking (drop-in replacement for built-in web_search)',
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
          description: 'Enhanced web search with more options and automatic usage tracking',
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
          }
          
          const formatted = this.formatSearchResults(searchResults);

          return {
            content: [
              {
                type: 'text',
                text: formatted,
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
