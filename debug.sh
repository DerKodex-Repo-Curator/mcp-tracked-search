#!/bin/bash
cd /Users/bard/Code/mcp-tracked-search
node build/index.js 2>&1 | tee debug.log
