# Hostinger API MCP Server

This repository configures the [Hostinger API MCP](https://www.npmjs.com/package/hostinger-api-mcp) server for use with Claude Code.

## Setup

The MCP server is configured in `.claude/mcp.json`. It uses the `hostinger-api-mcp` package via `npx`.

### Requirements

- Node.js (with `npx` available)
- A valid [Hostinger API token](https://developers.hostinger.com/)

### Configuration

When starting a Claude Code session, you will be prompted to enter your Hostinger API token. This token is passed securely to the MCP server as an environment variable (`API_TOKEN`).

### What this enables

With the Hostinger MCP server running, Claude Code can interact with your Hostinger account to:
- Manage domains
- Manage hosting plans
- Configure DNS records
- Handle VPS/cloud resources
- And more, depending on the capabilities exposed by the `hostinger-api-mcp` package

## Security Note

The API token is requested at session start via a prompt (`${input:api_token}`) and **never stored** in configuration files. Keep your token secret and do not commit it to version control.
