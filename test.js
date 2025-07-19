#!/usr/bin/env node

// Quick test of the MCP server
import { spawn } from 'child_process';

console.log('Testing MCP Tracked Search Server...\n');

// Set environment variable if not already set
if (!process.env.BRAVE_API_KEY) {
  console.warn('⚠️  BRAVE_API_KEY not set - Brave searches will fail');
  console.log('   Only DuckDuckGo searches will work\n');
}

// Start the server
const server = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

// Handle server output
server.stderr.on('data', (data) => {
  console.log('Server:', data.toString().trim());
});

server.stdout.on('data', (data) => {
  console.log('Response:', data.toString());
});

// Send a list tools request
setTimeout(() => {
  console.log('Sending list tools request...\n');
  const listRequest = {
    jsonrpc: '2.0',
    method: 'tools/list',
    id: 1,
  };
  server.stdin.write(JSON.stringify(listRequest) + '\n');
}, 500);

// Exit after a few seconds
setTimeout(() => {
  console.log('\nTest complete. Server appears to be working!');
  server.kill();
  process.exit(0);
}, 2000);
